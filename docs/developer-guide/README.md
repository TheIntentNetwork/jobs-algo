# Developer's Guide: Full Integration with Mission Control

This guide walks you through installing `@intent-network/jobs-algo`, wiring it to your Mission Control instance, and running your first scheduled jobs. Every step has a shell command you can paste.

---

## Prerequisites

- **Node.js 18+** (the package is ESM-only)
- **Git** (for cloning the repo)
- **Mission Control** installed and configured (the `mc` CLI on your PATH)
- A **registered MC project** (`mc project list` shows at least one entry)

---

## Step 1: Clone and install

```powershell
# Clone the repo
cd C:\Users\Bryan\Documents
git clone https://github.com/TheIntentNetwork/jobs-algo.git
cd jobs-algo

# Install dependencies
npm install

# Verify build + tests pass
npm run build
npm test
```

Expected output: `41 passed` from vitest, zero TypeScript errors.

---

## Step 2: Build the package

```powershell
npm run build
```

This compiles `src/` → `dist/` with declarations (`.d.ts`) and source maps. The `dist/` directory is what consumers import.

---

## Step 3: Verify your MC project

```powershell
# List registered projects — you need at least one
mc project list

# Check the MC daemon is running
mc daemon --status
```

If you don't have a project yet:

```powershell
# Register your MC project
mc project register --id my-project --name "My Project" --repo-path "C:\path\to\my-project"

# Verify it appears
mc project list
```

---

## Step 4: Create the integration script

Create `run-jobs-algo.ts` (or `.js`) in your project:

```typescript
import {
  createMCBridge,
  mcJobSignature,
  buildMCJobPayload,
  type AlgorithmEvent,
} from '@intent-network/jobs-algo';

// ── Configuration ──

const MC_PROJECT_ROOT = process.env.MC_PROJECT_ROOT
  || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control';
const MC_PROJECT_ID = process.env.MC_PROJECT_ID || 'mc-platform';

// ── Create the bridge ──

const sink = createMCBridge({
  projectRoot: MC_PROJECT_ROOT,
  projectId: MC_PROJECT_ID,
  pollIntervalMs: 2_000,      // how often to poll MC job state
  algoConfig: {
    maxParallelism: 4,         // max worker slots
    defaultRefreshRateMs: 30_000,  // auto-refresh every 30s
    defaultCacheExpiryMs: 300_000, // cache TTL 5 minutes
  },
});

// ── Build signatures for your MC job types ──

const planSig = mcJobSignature('plan-story', 'story', {
  story_id: 'string',
  feature_id: 'string',
  epic_id: 'string',
});

const implSig = mcJobSignature('implement', 'story', {
  story_id: 'string',
});

const valSig = mcJobSignature('validate', 'story', {
  story_id: 'string',
});

// ── Subscribe to events ──

function logEvent(event: AlgorithmEvent) {
  const ts = new Date().toISOString();
  switch (event.type) {
    case 'job_complete':
      console.log(`[${ts}] COMPLETE  job=${event.jobId.slice(0,8)} sig=${event.signature.slice(0,8)}`);
      break;
    case 'job_failed':
      console.error(`[${ts}] FAILED    job=${event.jobId.slice(0,8)} error=${event.error}`);
      break;
    case 'profile_updated':
      console.log(`[${ts}] PROFILE    sig=${event.signature.slice(0,8)} ` +
        `cpu=${Math.round(event.profile.cpuTicksEWMA)} ` +
        `mem=${Math.round(event.profile.memBytesEWMA / 1024)}KB ` +
        `warm=${event.profile.sampleCount >= 5}`);
      break;
    case 'graph_complete':
      console.log(`[${ts}] GRAPH OK   id=${event.graphId}`);
      break;
    case 'graph_failed':
      console.error(`[${ts}] GRAPH FAIL id=${event.graphId} node=${event.failedNodeId} err=${event.error}`);
      break;
    case 'cache_push':
      console.log(`[${ts}] CACHE PUSH sig=${event.signature.slice(0,8)}`);
      break;
    case 'cache_expire':
      console.log(`[${ts}] CACHE EXPIRE sig=${event.signature.slice(0,8)}`);
      break;
  }
}

sink.subscribe(planSig, logEvent);
sink.subscribe(implSig, logEvent);
sink.subscribe(valSig, logEvent);

// ── Enqueue a single job ──

const jobId = sink.push(implSig, buildMCJobPayload({
  type: 'implement',
  story_id: 'S-001',
}), {
  cacheExpiryMs: 300_000,   // 5 min
  refreshRateMs: 30_000,    // refresh every 30s
});

console.log('Enqueued job:', jobId);

// ── Enqueue a graph (plan → implement → validate) ──

const graphId = sink.pushGraph({
  id: 'pipeline-S002',
  nodes: [
    {
      id: 'plan',
      signature: planSig,
      payload: buildMCJobPayload({ type: 'plan-story', story_id: 'S-002' }),
      dependsOn: [],
    },
    {
      id: 'implement',
      signature: implSig,
      payload: buildMCJobPayload({ type: 'implement', story_id: 'S-002' }),
      dependsOn: ['plan'],
    },
    {
      id: 'validate',
      signature: valSig,
      payload: buildMCJobPayload({ type: 'validate', story_id: 'S-002' }),
      dependsOn: ['implement'],
    },
  ],
});

console.log('Enqueued graph:', graphId);

// ── Inspect learned profiles after runs ──

setTimeout(() => {
  for (const [label, sig] of [['plan', planSig], ['implement', implSig], ['validate', valSig]]) {
    const profile = sink.inspectProfile(sig);
    if (profile) {
      console.log(`\n--- ${label} profile ---`);
      console.log(`  Samples:    ${profile.sampleCount}`);
      console.log(`  CPU (EWMA): ${Math.round(profile.cpuTicksEWMA)}`);
      console.log(`  Mem (EWMA): ${Math.round(profile.memBytesEWMA / 1024 / 1024)}MB`);
      console.log(`  Wall (EWMA):${Math.round(profile.wallTimeMsEWMA)}ms`);
      console.log(`  Fail rate:  ${(profile.failureRateEWMA * 100).toFixed(1)}%`);
      console.log(`  Refresh:    ${profile.refreshRateMs}ms`);
      console.log(`  Cache TTL:  ${profile.cacheExpiryMs}ms`);
    }
  }
}, 120_000);

// ── Graceful shutdown ──

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await sink.close();
  process.exit(0);
});
```

---

## Step 5: Run it

If using the local package (not yet published to npm), link it:

```powershell
# In the jobs-algo repo
npm link

# In your project repo
npm link @intent-network/jobs-algo
```

Then run with `tsx` or `ts-node`:

```powershell
npx tsx run-jobs-algo.ts
```

---

## Step 6: Configure the MC integration kit in your project

In your target project's `.mc/` directory, add `integration.yaml`:

```yaml
# .mc/integration.yaml
version: 1
package: "@my-project/orchestration"
domain: my-project

job_types:
  - path: "job-types/*.yaml"
workflows:
  - path: "workflows/*.yaml"
```

Then create job-type definitions that match the signatures you use in jobs-algo:

```yaml
# .mc/job-types/scheduled-implement.yaml
type: scheduled-implement
description: "Implementation job scheduled by jobs-algo"
domain: neutral
loop:
  mode: interval
  interval_sec: 30
  max_iterations: 5
  iteration_timeout_sec: 1800
  overall_timeout_sec: 14400
  done_when:
    - gate: no_todo_markers
      params:
        scope: "workspace"
        markers: ["TODO", "FIXME", "XXX", "HACK"]
  on_max_reached: exhausted
prompt_template: |
  You are an implementation agent executing a scheduled task.
  Story: {story_title}
  Details: {story_description}
  Acceptance: {acceptance}
  
  Iteration {iteration}/{max_iterations}. Previous: {last_summary}
```

Validate the integration kit:

```powershell
mc integration validate --project my-project
```

---

## Step 7: Understand the cache layer

Jobs-algo maintains a signature-keyed cache with three expiry mechanisms:

1. **Proactive timers** — each `.meta` file schedules a `setTimeout` at `createdAt + cacheExpiryMs`
2. **File watchers** — `fs.watch` on `.cache/` directories re-evaluates expiry on changes
3. **Periodic sweep** — every `sweepIntervalMs`, scan all `.meta` files for expired entries

When a cache entry expires:

- **If clients are subscribed** (`subscribe(sig, handler)` keeps a ref count): the cached result is pushed to the frontend in-memory graph cache layer, and a refresh is scheduled at `refreshRateMs`
- **If no clients remain**: the entry is evicted and a `cache_expire` event is emitted

This means your frontend can stay subscribed and receive continuous updates without manual polling.

---

## Step 8: Use the standalone queue (no MC)

If you just want the scheduling algorithm without MC:

```typescript
import { QueueSink, computeSignature } from '@intent-network/jobs-algo';

const sink = new QueueSink({
  maxParallelism: 4,
  defaultRefreshRateMs: 5_000,
});

// Provide your own executor via setWorkerScript or MissionControlExecutor
sink.setWorkerScript(new URL('./my-worker.js', import.meta.url).pathname);

const sig = computeSignature({
  type: 'ProcessData',
  entity: 'dataset',
  argSchema: { datasetId: 'string', format: 'string' },
});

sink.subscribe(sig, (event) => {
  if (event.type === 'job_complete') {
    console.log('Result:', event.result.toString());
  }
});

sink.push(sig, Buffer.from(JSON.stringify({ datasetId: 'ds-42', format: 'csv' })));
```

Your `my-worker.js`:

```javascript
import { workerData, parentPort } from 'node:worker_threads';

const payload = Buffer.from(workerData.payload);

// Your custom processing here
const result = JSON.stringify({
  processed: true,
  input: payload.toString(),
  timestamp: Date.now(),
});

const cpuUsage = process.cpuUsage();
parentPort.postMessage({
  type: 'complete',
  result: Buffer.from(result).toString('base64'),
  cpu: cpuUsage.user + cpuUsage.system,
  mem: process.memoryUsage().heapUsed,
});
```

---

## Step 9: Configuration reference

| Option | Default | Description |
|--------|---------|-------------|
| `maxParallelism` | CPU count | Max worker threads |
| `slotBudgetCpuTicks` | 1,000,000 | Per-slot CPU budget |
| `slotBudgetMemBytes` | 536,870,912 | Per-slot memory budget (512MB) |
| `ewmaAlpha` | 0.3 | EWMA smoothing factor |
| `coldStartSamples` | 5 | Runs before profile is trusted |
| `overBudgetFactor` | 2.0 | Threshold for over-budget detection |
| `defaultRefreshRateMs` | 5,000 | Auto-refresh interval (min 1,000) |
| `defaultCacheExpiryMs` | 60,000 | Default cache TTL |
| `cacheDir` | `.cache` | File cache root |
| `graphMaxNodes` | 10,000 | Safety limit on graph size |
| `cpuWeight` | 1.0 | CPU cost weight in bin-packing heuristic |
| `memWeight` | 1.0 | Memory cost weight in bin-packing heuristic |
| `sweepIntervalMs` | 60,000 | Cache sweep interval |

MCAdapter-specific:

| Option | Default | Description |
|--------|---------|-------------|
| `projectRoot` | (required) | Path to MC project root |
| `projectId` | (required) | MC project ID |
| `mcBinary` | `mc` | Path to MC CLI binary |
| `pollIntervalMs` | 1,000 | How often to poll MC job state |

---

## Step 10: Architecture diagram

```
                    Frontend Cache Layer
                    (signature-keyed, in-memory)
                    push on expiry with clients
                           |
                    Queue Sink (entry point)
                    .push() / .pushGraph() / .subscribe()
                           |
                     Scheduler (algorithm)
                    urgency sort + bin-pack
                    /       |        \
               Slot 0   Slot 1   Slot N
                    \       |        /
          Mission Control (MCAdapter)
                    |
              mc submit → mc daemon → agent process
                    |
           file markers → poll → status.json
                    |
              profile feedback loop
                    |
              file cache (.cache/)
              profiles/ results/ graphs/
              sharded by sig[:2]
              auto-expiry (timers + watchers + sweep)
```

---

## Troubleshooting

### Jobs stay in `queued` state
- Check that the MC daemon is running: `mc daemon --status`
- Check that the job type exists: `mc job-types list --project <id>`
- Check project ID matches: `mc project list`

### Cache not expiring
- Verify `.cache/` directory exists and has write permissions
- Check that `cacheExpiryMs` is set correctly (not `Infinity`)
- Enable debug logging: `DEBUG=jobs-algo* node your-script.js`

### Profile not learning
- Profiles need `coldStartSamples` (default 5) runs before the scheduler trusts them for bin-packing
- Cold-start jobs get their own slot (don't stack with others)
- After 5 runs, the profile is warm and packing becomes optimal

### Graph fails immediately
- Check for cycles: the graph engine validates acyclicity on submission
- Check that all `dependsOn` node IDs exist in the graph
- Remember: any node failure kills the entire graph. Check `job_failed` events.

### MC submission fails
- Ensure `mc` is on your PATH
- Ensure the project is registered: `mc project list`
- Ensure the job type is defined in `.mc/job-types/` or core catalog
- Check `MC_HOME` and `MC_PROJECT` environment variables