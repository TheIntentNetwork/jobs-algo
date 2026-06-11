# Developer's Guide: Full Integration with Mission Control

This guide walks you through installing `@intent-network/jobs-algo`, wiring it to your Mission Control instance, and running your first scheduled jobs. Every step has a shell command you can paste.

---

## Prerequisites

- **Node.js 18+** (the package is ESM-only)
- **Git** (for cloning the repo)
- **Mission Control** installed and configured (the `mc` CLI on your PATH)
- A **registered MC project** (`mc project list` shows at least one entry)
- **Ollama** (for local LLM testing, see Step 11)

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

Expected output: `44 passed` from vitest, zero TypeScript errors.

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
  for (const [label, sig] of [['plan', planSig], ['implement', implSig], ['validate', valSig]] as const) {
    const profile = sink.inspectProfile(sig);
    if (profile) {
      console.log(`  ${label}: n=${profile.sampleCount} cpu=${Math.round(profile.cpuTicksEWMA)} mem=${Math.round(profile.memBytesEWMA / 1024)}KB warm=${profile.sampleCount >= 5}`);
    }
  }
}, 10_000);

// ── Graceful shutdown ──

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await sink.close();
  process.exit(0);
});
```

---

## Step 5: Run the integration

```powershell
# Terminal 1: Start MC daemon
mc daemon

# Terminal 2: Run your integration
npx tsx run-jobs-algo.ts
```

You should see event logs appear as jobs are submitted, scheduled, executed, and completed. Profiles start cold (sample count < 5) and warm up after repeated runs.

---

## Step 6: How the scheduler works

The core scheduling algorithm uses **urgency-based priority** with **best-fit decreasing bin-packing**:

1. **Urgency sort**: Jobs are sorted by `expiresAt` ascending — the job closest to expiry runs first
2. **Bin-packing**: Warm jobs (profile sample count >= 5) are stacked on existing slots using best-fit decreasing to minimize waste. Cold jobs (< 5 samples) get isolated slots for safety
3. **Slot release**: When a job completes or fails, its slot is freed and queued jobs are dispatched immediately
4. **Auto-refresh**: After completion, a refresh timer is set at the job's `refreshRateMs` (minimum 1 second). When it fires, the job is re-enqueued
5. **Profile learning**: After each run, `cpuTicks`, `memBytes`, and `wallTimeMs` are fed into EWMA (alpha=0.3). After 5 samples the profile is "warm" and used for bin-packing predictions

### All-or-nothing graph execution

When a graph (DAG) is submitted:
- Root nodes start immediately
- Downstream nodes start only after all their dependencies complete
- If **any** node fails, the entire graph is killed — no partial results, no silent errors
- All cancel tokens for remaining nodes in the graph are invoked

### Client-aware cache eviction

When a cached result expires:
- **If there are subscribers** (`subscribe(sig, handler)` keeps a ref count): the cached result is pushed to the frontend in-memory graph cache layer, and a refresh is scheduled at `refreshRateMs`
- **If no clients remain**: the entry is evicted and a `cache_expire` event is emitted

This means your frontend can stay subscribed and receive continuous updates without manual polling.

---

## Step 7: Use the standalone queue (no MC)

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

## Step 8: Configuration reference

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

## Step 9: Architecture diagram

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

## Step 10: MC Integration Kit (`.mc/`) conventions

The `.mc/` directory in your project follows the Integration Kit spec from Mission Control:

```
your-project/
  .mc/
    integration.yaml      # Package, domain, providers, LLM providers
    job-types/             # YAML definitions for each job type
      validate.yaml
    agents/                # Agent definitions with LLM provider bindings
      ollama-local.yaml
    workflows/             # Chain definitions (DAG pipelines)
      etl-pipeline.yaml
```

### integration.yaml

```yaml
version: 1
package: "@acme/data-pipeline"
domain: data-pipeline
subdomain: etl

job_types:
  - path: "job-types/*.yaml"
workflows:
  - path: "workflows/*.yaml"
agents:
  - path: "agents/*.yaml"

providers:
  allowed: [local-process]
  default: local-process

llm_providers:
  allowed: [ollama-local, ollama-cloud]
  default: ollama-local
```

The `llm_providers` policy gate lets A2A coordinators and skills call `get_llm_provider("ollama-local")` without hitting the allow-list gate.

### Agent definition (`.mc/agents/ollama-local.yaml`)

```yaml
id: "@acme/data-pipeline/ollama-local"
role: general-purpose
model: ollama-local
capabilities: [implement, validate, research]
supported_domains: [data-pipeline]
launch: 'python "{mc_root}/examples/providers/mc_alt_provider_agent.py"'
prompt_template: |
  You are a data-pipeline coding agent backed by local Ollama.
  Read PROMPT.txt in the workspace. Edit only under allowed_write_paths.
  Report progress with mc report; end the iteration with mc iter-done.
  Env: MC_ALT_PROVIDER=ollama-local, OLLAMA_MODEL=qwen2.5:0.5b.
```

The `{mc_root}` placeholder resolves to the Mission Control installation root at runtime — no relative path hacks.

### Registering the project

Add a record to `config/projects.yaml` on the MC host:

```yaml
  - project_id: acme-data-pipeline
    name: Acme Data Pipeline
    repo_path: /path/to/acme-data-pipeline
    allowed_write_paths:
      - src/
      - tests/
      - .mc/
    forbidden_paths:
      - .git/
      - __pycache__/
    validation_commands:
      - id: tests
        description: Run test suite
        cwd: repo
        command: pytest -q
```

---

## Step 11: Local Ollama end-to-end testing

The test harness exercises the full jobs-algo pipeline against a local Ollama model. It tests scheduling, slot management, profile learning, cache expiry, and graph (DAG) execution.

### Prerequisites

1. **Ollama installed and running** — `ollama serve`
2. **A small model pulled** — `ollama pull qwen2.5:0.5b` (397 MB)
3. **jobs-algo built** — `npm run build`

### Running the test

**Quick test (direct mode, no MC dependency):**

```powershell
# From the repo root
npx tsx src/integration/ollama/ollama-test-harness.ts
```

This runs 5 job signatures across 2 passes with `qwen2.5:0.5b`, plus a 3-node graph test. Expected output:

```
============================================================
  OLLAMA TEST HARNESS
  Model: qwen2.5:0.5b  Mode: direct  Runs: 2
============================================================

--- Run 1/2 ---
  [OK] QuickFact            wall=2253ms tok=113 infer=201ms
  [OK] GenerateList         wall=2527ms tok=241 infer=493ms
  [OK] ExplainRecursion     wall=2588ms tok=105 infer=145ms
  [OK] CompareApproaches    wall=3006ms tok=149 infer=285ms
  [OK] SummarizeTopic       wall=3052ms tok=146 infer=271ms
--- Run 2/2 ---
  [OK] QuickFact            wall=401ms tok=111 infer=194ms
  [OK] GenerateList         wall=677ms tok=241 infer=470ms
  ...
--- Graph Test ---
  [GRAPH OK] test-graph wall=723ms
```

**With options:**

```typescript
import { runOllamaTest } from '@intent-network/jobs-algo';

const report = await runOllamaTest(
  { model: 'qwen2.5:0.5b', timeoutMs: 60000, maxTokens: 40 },
  { runs: 2, outputDir: '.cache/reports', includeGraph: true, jobTimeoutMs: 120000 }
);
```

### Full MC integration test via PowerShell

```powershell
# From examples/acme-data-pipeline/
.\run-ollama-e2e.ps1 -Model "qwen2.5:0.5b" -Runs 1
```

This script:
1. Checks Ollama is running and the model is available
2. Builds and tests the package
3. Configures `MC_REGISTER_OLLAMA=1` environment
4. Runs the test harness via the compiled JS
5. Reads and displays the JSON report

### Understanding the report

The harness produces a JSON report at `.cache/reports/ollama-test-report-<timestamp>.json`:

| Field | Description |
|-------|-------------|
| `jobs[].wallTimeMs` | Wall-clock time from enqueue to completion |
| `jobs[].tokens.total` | Total tokens (prompt + completion) |
| `jobs[].timing.evalMs` | Ollama inference time in ms |
| `profiles[].warm` | True after 5+ runs (EWMA converges) |
| `profiles[].cpuTicksEWMA` | Learned CPU cost (microseconds) |
| `profiles[].wallTimeMsEWMA` | Learned wall-time prediction |
| `cache.expiredEntries` | Cache entries that expired and were evicted |
| `cache.pushedToFrontend` | Cache pushes to in-memory with active subscribers |
| `graphs[].status` | `completed` or `failed` (all-or-nothing) |

### Configuring the local model

The Ollama model can be configured per-project via the `.mc/agents/ollama-local.yaml` file, or overridden at runtime:

```powershell
# Use a different model
$env:OLLAMA_MODEL = "codellama:7b"

# Or pin it per-job in the agent YAML:
# Env: MC_ALT_PROVIDER=ollama-local, OLLAMA_MODEL=codellama:7b
```

The `ollamaMCEnv()` helper returns the standard env vars:

```typescript
import { ollamaMCEnv } from '@intent-network/jobs-algo';

const env = ollamaMCEnv({ model: 'qwen2.5:0.5b' });
// => { MC_REGISTER_OLLAMA: '1', MC_ALT_PROVIDER: 'ollama-local', OLLAMA_MODEL: 'qwen2.5:0.5b', OLLAMA_HOST: 'http://localhost:11434' }
```

---

## Troubleshooting

### Jobs stay in queued state
- Check that the MC daemon is running: `mc daemon --status`
- Check that the job type exists: `mc job-types list --project <id>`
- Check project ID matches: `mc project list`
- **Most common**: verify slots are being released after job completion. The scheduler calls `releaseSlot()` automatically, but if you implement a custom executor, make sure it calls its `done` or `error` callback.

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

### Ollama test harness hangs
- The harness has per-job timeouts (default 120s). If a job times out, it's reported as `[TIMEOUT]`
- Ensure Ollama is running: `ollama list` should show your model
- For slow machines, increase the timeout: `{ jobTimeoutMs: 300000 }`
