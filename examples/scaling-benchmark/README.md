# Scaling Benchmark

Real-work benchmark for `@intent-network/jobs-algo` across multiple vertical domains.
**No mocks.** Every job sends a real inference request through Ollama or the full MC pipeline.

## Quick Start

### Live Mode (direct Ollama, no MC needed)

```powershell
# Terminal 1: Ensure Ollama is running with qwen2.5:0.5b
ollama pull qwen2.5:0.5b

# Terminal 2: Run the benchmark
npx tsx examples/scaling-benchmark/scaling-benchmark.ts --mode live --jobs 50 --verticals 5 --slots 8
```

### MC Mode (full MC daemon pipeline)

```powershell
# Terminal 1: Start the MC daemon
.\examples\scaling-benchmark\scripts\start-daemon.ps1

# Terminal 2: Watch the job board (optional)
.\examples\scaling-benchmark\scripts\start-tui.ps1

# Terminal 3: Run the benchmark
.\examples\scaling-benchmark\scripts\run-scaling-mc.ps1 -Jobs 30 -Verticals 3
```

## Vertical Domains

| Domain | Job Types | Urgency Range |
|--------|-----------|---------------|
| data-pipeline/etl | extract, transform, validate-schema, load-warehouse | 5-60s |
| ml-inference/model-serving | classify, embed, summarize-result, detect-anomaly | 5-30s |
| content-ops/publishing | seo-audit, gen-description, review-content, flag-issue | 5-60s |
| infra-observability/monitoring | check-health, analyze-log, correlate-metrics, escalate-alert | 5-60s |
| security-compliance/audit | scan-policy, check-access, summarize-findings, urgent-alert | 5-60s |

Each job type has a `cacheExpiryMs` that doubles as its urgency score — shorter expiry means the scheduler prioritizes it. The `weight` field controls how frequently each type appears in a random selection.

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `live` | `live` for direct Ollama, `mc` for MC daemon pipeline |
| `--jobs` | `30` | Total number of jobs to enqueue |
| `--verticals` | `3` | Number of vertical domains (1-5) |
| `--slots` | `0` | Max parallelism (0 = auto, uses os.cpus) |
| `--model` | `qwen2.5:0.5b` | Ollama model name (live mode only) |
| `--ollamaHost` | `http://localhost:11434` | Ollama API URL (live mode only) |
| `--mcRoot` | env or default | MC project root path (mc mode only) |
| `--mcProject` | `scaling-benchmark` | MC project ID (mc mode only) |
| `--timeout` | `600000` | Overall timeout in ms |
| `--output` | `.cache/scaling` | Output directory for reports |

## How It Works

1. **Enqueue**: Jobs are created with weighted random selection across verticals, each carrying its real prompt and urgency
2. **Schedule**: The algorithm sorts by urgency (shortest cacheExpiryMs first) and bin-packs into available slots
3. **Execute**: Real LLM inference through Ollama (live) or MC daemon (mc)
4. **Learn**: Each completion updates the EWMA profile for that signature, improving future packing decisions
5. **Report**: Per-vertical throughput, latency percentiles, and profile learning metrics

## MC Integration

The `.mc/` directory contains:

- `integration.yaml` — Package manifest with Ollama provider config
- `agents/ollama-local.yaml` — Agent definition backed by qwen2.5:0.5b
- `job-types/*.yaml` — One job type definition per vertical job type
- `workflows/scaling-pipeline.yaml` — Two-stage infer+validate workflow

## Sample Results

| Scale | Jobs | Slots | Wall | Throughput | Warm Sigs |
|-------|------|-------|------|------------|-----------|
| 10, 2v | 10 | auto | 8s | 1.25 j/s | 2/7 |
| 30, 3v | 30 | 4 | 9s | 3.33 j/s | 10/10 |
| 100, 5v | 100 | 8 | 22s | 4.53 j/s | 17/19 |
| 500, 5v | 500 | 8 | 75s | 6.66 j/s | 20/20 |

Model: `qwen2.5:0.5b` on localhost. Throughput scales with parallelism as the scheduler learns profiles.
