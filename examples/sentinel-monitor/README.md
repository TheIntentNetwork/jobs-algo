# Sentinel Monitor

Observability and alerting benchmark for @intent-network/jobs-algo.

Demonstrates **urgency-based scheduling**: critical alerts (5s) are always dispatched before warnings (15s), info checks (30s), and health summaries (60s). Every job does real Ollama inference -- no mocks.

## Quick Start

### Live Mode (direct Ollama)

```powershell
# Terminal 1: Ensure Ollama is running
ollama pull qwen2.5:0.5b

# Terminal 2: Run the monitor
npx tsx examples/sentinel-monitor/src/index.ts --checks 20 --mode live
```

### MC Mode (full MC daemon pipeline)

```powershell
# Terminal 1: Start the MC daemon
.\examples\sentinel-monitor\scripts\start-daemon.ps1

# Terminal 2: Watch the job board
.\examples\sentinel-monitor\scripts\start-tui.ps1

# Terminal 3: Run the monitor
.\examples\sentinel-monitor\scripts\run-sentinel.ps1 -Mode mc
```

## Urgency Tiers

| Tier | Check Types | Urgency | Scheduled |
|------|------------|---------|-----------|
| Critical | critical-alert, overbudget-alert | 5s | First |
| Warning | degradation-warning, anomaly-detection | 15s | Second |
| Info | health-check, log-analysis | 30s | Third |
| Summary | health-summary, capacity-forecast | 60s | Last |

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| --checks | 20 | Number of monitoring checks |
| --mode | live | live for Ollama, mc for MC daemon |
| --slots | 4 | Max parallelism (0 = auto) |
| --model | qwen2.5:0.5b | Ollama model (live mode) |
| --ollamaHost | http://localhost:11434 | Ollama API URL |
| --timeout | 600000 | Overall timeout in ms |
| --output | .cache/sentinel | Report output directory |

## How It Works

1. **Enqueue** monitoring checks with weighted random type selection across urgency tiers
2. **Schedule** by urgency: the algorithm sorts jobs so shortest cacheExpiryMs (most urgent) are dispatched first
3. **Execute** real LLM inference through Ollama (live) or MC daemon (mc)
4. **Learn** profile data per signature (EWMA of CPU, memory, wall time)
5. **Report** per-tier latency, throughput, and profile warm-up metrics