# Jobs Algorithm — System Design

## 1. Problem Statement

Build a predictive, learning job scheduler that:
- Profiles jobs by structural signature and learns resource costs from historical runs
- Packs jobs for parallel execution using isolated worker threads under resource budgets
- Sorts jobs by urgency (expiry/refresh_rate) within execution windows
- Supports DAG-structured job graphs with all-or-nothing failure semantics
- Persists profiles and cached results to a file-based store with auto-expiry via file watching
- Wraps intent-network-mission-control via a thin integration adapter
- Pushes results to subscribers and a frontend cache layer, with client-aware eviction

## 2. Architecture Overview

```
                    Frontend Cache Layer
                    (signature-keyed, in-memory)
                           push  /  expire
                    Queue Sink (entry point)
                           |
                     Scheduler (algorithm)
                   urgency sort + bin-pack
                    /       |        \
               Slot 0   Slot 1   Slot N    ← worker threads / MC adapter
                    \       |        /
          Mission Control (MCAdapter)     ← integration kit
                    |
              MC Daemon + MCP Server       ← job execution
```

The algorithm owns WHEN and HOW jobs execute. Mission Control owns WHAT the job does.

## 3. Core Concepts

### 3.1 Job Signature
A deterministic hash of the job's structural identity (type + entity + arg schema shape, not values). Two jobs with the same type/entity/schema share a profile.

### 3.2 Profile (Learned Resource Model)
Per-signature EWMA of observed CPU ticks, peak memory, wall time, and failure rate. Plus:
- `refreshRateMs`: how often to re-execute (min 1000ms / 1 second)
- `cacheExpiryMs`: when the cached result goes stale

Cold signatures start with conservative defaults; profiles warm after 5 runs.

### 3.3 Urgency-Based Priority
Jobs within a parallel execution window are sorted by urgency (time until expiry):
- Primary sort: `expiresAt` ascending (soonest-expiry first)
- Secondary sort: cost descending (expensive jobs first within the same urgency band)
- This ensures time-critical results are refreshed before they go stale

### 3.4 Auto-Refresh Scheduling
After a job completes, the scheduler sets a timer at the profile's `refreshRateMs` to automatically re-enqueue the job. This keeps the cache warm as long as there are active clients.

### 3.5 Graph API (DAG Chaining)
Jobs can be chained as DAGs:
- Acyclicity validated on submission (Kahn's algorithm)
- Downstream nodes advance when upstream completes
- On any node failure: the entire graph is killed, all running jobs cancelled
- No partial results, no silent errors

## 4. File-Based Cache

### 4.1 Directory Layout
```
.cache/
  profiles/{sig[:2]}/{sig}.profile     ← profile data
  profiles/{sig[:2]}/{sig}.meta        ← expiry + metadata
  results/{sig[:2]}/{jobId}.result     ← job outputs
  results/{sig[:2]}/{jobId}.meta       ← expiry, created, headers
  graphs/{graphId}/{nodeId}.result     ← graph node outputs
  graphs/{graphId}/graph.meta          ← graph expiry metadata
```

### 4.2 File Format (Headers/Footers)
```
---JOBS-ALGO-PROFILE-v1---
{"signature":"abc123","cpuTicksEWMA":5000,...}
---END---
```

### 4.3 Expiry Mechanisms (three-layer safety net)
1. **Proactive timers**: On save, schedule a setTimeout for exactly `createdAt + cacheExpiryMs`. Fires the expiry handler that emits an event and deletes the files.
2. **File watchers**: `fs.watch` on cache directories. When a `.meta` file changes, re-evaluate expiry and schedule/delete accordingly.
3. **Periodic sweep**: Every `sweepIntervalMs`, scan all `.meta` files and expire any that slipped through.

### 4.4 Client-Aware Cache Eviction
When a cache entry expires:
- **Has active clients** (subscribers with ref count > 0)? → Push the cached result to the frontend in-memory graph cache layer, schedule a refresh
- **No clients**? → Evict the entry and emit `cache_expire`

The frontend cache is signature-keyed and serves as the graph caching layer. Results are pushed to it on completion and on expiry-with-clients.

## 5. Mission Control Integration

### 5.1 MCAdapter
Bridges the algorithm to MC's execution layer:
- Submits via `mc --project <id> submit --type <type> [opts]`
- Polls MC's file-system job markers: `<id>.queued.job → <id>.running.job → <id>.completed.job`
- Reads `status.json` for iteration/phase/summary
- Feeds completion/failure back into the algorithm's profile store
- Supports cancellation via `mc cancel <jobId>`

### 5.2 MCBridge
Wiring layer: `createMCBridge(config)` returns a `QueueSink` with `MCAdapter` pre-registered as the executor.

### 5.3 MC Data Shapes
The adapter models MC's key types:
- `MCJobSpec`: submission format (type, story_id, feature_id, chain_id, etc.)
- `MCJobTypeDefinition`: YAML schema (loop config, prompt_template, gates)
- `MCWorkflow` / `MCChain`: DAG workflow definitions
- `MCIntegrationManifest`: .mc/integration.yaml schema

## 6. The Packing Algorithm

### 6.1 Best-Fit Decreasing with Urgency Priority
1. Sort queued jobs: soonest-expiry first, then cost-descending
2. For each job, find the slot with the smallest remaining capacity that still fits (minimize waste)
3. Cold-start jobs get their own slot (isolation)
4. If no slot fits, open a new one (up to `maxParallelism`)
5. Jobs that can't fit stay in the queue for the next tick

### 6.2 Over-Budget Detection
When a job's actual metrics exceed its prediction by >`overBudgetFactor` (default 2x), the slot is marked over-budget. No more jobs stack onto it until all current jobs finish and the slot resets.

### 6.3 Profile Feedback Loop
After each job completes, actual metrics feed back into the profile store via EWMA (alpha = 0.3 by default). Recent runs weight higher than old ones.

## 7. Events

```typescript
type AlgorithmEvent =
  | { type: 'job_complete'; jobId; signature; result }
  | { type: 'job_failed'; jobId; signature; error }
  | { type: 'graph_complete'; graphId; results }
  | { type: 'graph_failed'; graphId; failedNodeId; error }
  | { type: 'profile_updated'; signature; profile }
  | { type: 'cache_push'; signature; result; expiresAt }   // NEW: push to frontend
  | { type: 'cache_expire'; signature }                     // NEW: evict cleanly
```

## 8. Error Handling

**No silent errors.** Every failure surface:
1. Job fails → `job_failed` event, profile failure rate updated
2. Graph node fails → entire graph cancelled, `graph_failed` event with full context
3. Profile store I/O fails → logged at error, algorithm continues with in-memory profile
4. Worker thread crashes → slot marked failed, all jobs get `job_failed`, slot recycled
5. Cache corruption → file deleted, treated as cache miss, profile rebuilt from next run
6. MC submission fails → `job_failed` event with MC error message
7. MC job cancelled → `job_failed` event

No try/catch that swallows. Every error propagates or emits.