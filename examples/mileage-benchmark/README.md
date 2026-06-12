# Mileage Benchmark

Real Ollama inference benchmark through Mission Control, measuring how
parallelism, slot budgets, and profile learning affect throughput.

## The Three-Terminal Setup

This benchmark is designed to run with live MC infrastructure so you can
watch jobs flow through the system in real time:

| Terminal | Command | What You See |
|----------|---------|-------------|
| 1 | mc daemon | Daemon logs — job ingestion, agent dispatch, completion |
| 2 | mc tui | Live job board — Kanban + AGENT JOBS panel with real-time state |
| 3 | .\run-mileage.ps1 | Benchmark output — slot state, profiles, throughput, comparison |

## Quick Start

`powershell
# Terminal 1: Start the MC daemon
 = "1"
 = "ollama-local"
 = "qwen2.5:0.5b"
 = "python 'C:\Users\Bryan\Source\intent-network-mission-control\examples\providers\mc_alt_provider_agent.py'"
mc daemon

# Terminal 2: Start the live job board
mc tui

# Terminal 3: Run the benchmark
cd C:\Users\Bryan\Documents\jobs-algo
.\examples\mileage-benchmark\run-mileage.ps1
`

## What the Benchmark Measures

8 scenarios sweep across these dimensions:

| Dimension | Values | What It Tests |
|-----------|--------|--------------|
| maxParallelism | 1, 2, 4, 8 | Throughput scaling from serial to full parallel |
| Slot budget | tight (100K/64MB) vs generous (1M/512MB) | Bin-packing efficiency under pressure |
| Profile state | cold vs warm | The learning dividend after 6+ runs |
| Multi-run | 1 vs 3 runs | Profile convergence over repeated execution |

Each scenario submits 10 real Ollama inference prompts (fact, explain,
summarize, alert urgency bands) through MC's execution pipeline.

## Scenario Matrix

| # | Config | Purpose |
|---|--------|---------|
| 1 | 1 slot, generous, cold | Serial baseline |
| 2 | 2 slots, generous, cold | 2x parallelism |
| 3 | 4 slots, generous, cold | 4x parallelism |
| 4 | 8 slots, generous, cold | 8x parallelism (max throughput) |
| 5 | 4 slots, tight budget | Budget pressure on bin-packing |
| 6 | 4 slots, generous, warm | Profile learning dividend |
| 7 | 4 slots, generous, 3 runs | Convergence over repeated execution |
| 8 | 1 slot, generous, cold | Serial baseline with full mix |

## MC Integration Kit

The .mc/ directory follows the Integration Kit conventions:

`
.milestone-benchmark/.mc/
  integration.yaml           # Package, domain, providers, LLM providers
  job-types/
    benchmark-infer.yaml     # Benchmark inference job type
  agents/
    ollama-local.yaml        # Ollama-backed agent definition
  workflows/
    benchmark-pipeline.yaml  # infer → validate chain
`

## Report Output

After running, a JSON report is saved to .cache/mileage/mileage-report-<ts>.json
with per-scenario results and a comparison table. The comparison table
is also printed to the console.

## Watching the Job Board

While the benchmark runs, the MC TUI shows:

- **KANBAN panel**: Epic → Feature → Story hierarchy with job counts
- **AGENT JOBS panel**: Each submitted job with type (enchmark-infer),
  iteration, phase, and state transitions (new → queued → running → completed)
- **LIVE JOB DETAIL panel**: Active job progress with agent reports

You can click on a job row in the AGENT JOBS panel and press l to view
the full agent log.
