# Jobs Algorithm

A predictive, learning job scheduler that wraps **intent-network-mission-control** as an abstraction layer — profiling jobs by signature, packing them for parallel execution under resource budgets, chaining them as DAGs, and pushing cached results to a frontend graph cache layer.

## Architecture

```
                    Frontend Cache Layer
                    (signature-keyed, in-memory)
                           push
                    Queue Sink (entry point)
                           |
                     Scheduler (algorithm)
                    /       |        \
               Slot 0   Slot 1   Slot N    ← worker threads
                    \       |        /
                Mission Control (executor)
                    via MCAdapter
```

**The algorithm owns WHEN and HOW jobs execute. Mission Control owns WHAT the job does.**

## Core Concepts

### Job Signature
A deterministic hash of the job's structural identity (type + entity + arg schema shape, not values). Jobs with the same signature share a resource profile even if called with different inputs.

### Profile Store
Per-signature EWMA of observed CPU ticks, peak memory, wall time, and failure rate. Cold signatures start with conservative defaults; profiles warm after 5 runs. The scheduler trusts warm profiles for bin-packing decisions.

### Packing Algorithm
Best-fit decreasing bin packing with urgency-based priority:
1. Sort queued jobs: soonest-expiry first, then cost-descending within the same urgency band
2. For each job, find the slot with the smallest remaining capacity that still fits
3. Cold-start jobs get their own slot (don't stack with others)
4. If no slot fits, open a new one (up to max parallelism)

### Urgency-Based Priority
Jobs are sorted by `expiresAt` (configured per job type via `cacheExpiryMs` / `refreshRateMs`). Jobs about to expire get scheduled first so their cached results don't go stale before being refreshed. Minimum refresh rate: 1 second.

### Graph API (DAG Chaining)
Jobs can be chained as directed acyclic graphs. The graph engine:
- Validates acyclicity on submission (Kahn's algorithm)
- Advances downstream nodes when upstream completes
- Kills the entire graph on any node failure (no partial results, no silent errors)

### File-Based Cache
Signature-sharded files with header/footer conventions:
```
.cache/
  profiles/{sig[:2]}/{sig}.profile    ← learned resource profiles
  profiles/{sig[:2]}/{sig}.meta       ← expiry metadata
  results/{sig[:2]}/{jobId}.result    ← job outputs
  graphs/{graphId}/{nodeId}.result    ← graph node outputs
```

Auto-expiry via file watchers + proactive timers + periodic sweep. Meta files carry `cacheExpiryMs` and `refreshRateMs`.

### Client-Aware Cache Eviction
When a cache entry expires:
- **Has active clients?** Push the cached result to the frontend in-memory graph cache layer and schedule a refresh
- **No clients?** Evict the entry cleanly

### Mission Control Integration
The `MCAdapter` bridges the algorithm to MC:
1. Submits jobs via `mc submit` CLI
2. Polls MC's file-system job markers for state transitions
3. Reads `status.json` for iteration/phase/summary metrics
4. Feeds completion/failure back into the algorithm's profile store

## Quick Start

### Standalone (without MC)

```typescript
import { QueueSink } from 'jobs-algo';

const sink = new QueueSink({ maxParallelism: 4 });
sink.setWorkerScript('./worker.js');

const unsub = sink.subscribe('my-sig', (event) => {
  console.log(event);
});

const jobId = sink.push('my-sig', Buffer.from('payload'), {
  cacheExpiryMs: 60_000,    // cache TTL
  refreshRateMs: 5_000,     // auto-refresh interval
});
```

### With Mission Control

```typescript
import { createMCBridge, mcJobSignature, buildMCJobPayload } from 'jobs-algo';

const sink = createMCBridge({
  projectRoot: 'C:\\Users\\Bryan\\Source\\intent-network-mission-control',
  projectId: 'mc-platform',
});

const sig = mcJobSignature('implement', 'story', { story_id: 'string' });
const payload = buildMCJobPayload({ type: 'implement', story_id: 'S-001' });

const jobId = sink.push(sig, payload, {
  cacheExpiryMs: 300_000,
  refreshRateMs: 30_000,
});
```

### Graph (DAG) Execution

```typescript
import { GraphDefinition } from 'jobs-algo';

const graph: GraphDefinition = {
  id: 'plan-implement-validate',
  nodes: [
    { id: 'plan', signature: planSig, payload: planPayload, dependsOn: [] },
    { id: 'implement', signature: implSig, payload: implPayload, dependsOn: ['plan'] },
    { id: 'validate', signature: valSig, payload: valPayload, dependsOn: ['implement'] },
  ],
};

const graphId = sink.pushGraph(graph);
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxParallelism` | auto (CPU count) | Max worker threads |
| `slotBudgetCpuTicks` | 1,000,000 | Per-slot CPU budget |
| `slotBudgetMemBytes` | 512 MB | Per-slot memory budget |
| `ewmaAlpha` | 0.3 | EWMA smoothing factor |
| `coldStartSamples` | 5 | Runs before profile is trusted |
| `overBudgetFactor` | 2.0 | Threshold for over-budget detection |
| `defaultRefreshRateMs` | 5,000 | Auto-refresh interval (min 1000) |
| `defaultCacheExpiryMs` | 60,000 | Default cache TTL |
| `cacheDir` | `.cache` | File cache root |
| `graphMaxNodes` | 10,000 | Safety limit on graph size |

## Project Structure

```
src/
  algorithm/       scheduler, profile-store, slot-manager, signature
  graph/           graph-engine (DAG), graph-job-tracker
  cache/           file-cache (headers/footers, sharding, expiry)
  integration/     jobs-algorithm (main impl), mc/ (MC adapter)
  metrics/         ewma, collector
  push/            event-bus (pub/sub, frontend cache layer)
  queue/           sink (entry point)
  types/           all type definitions
  worker/          executor, default-worker
test/              vitest suite
docs/design/       SYSTEM_DESIGN.md
```