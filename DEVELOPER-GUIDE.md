# Mission Control + Jobs-Algo Integration Guide

## Architecture Overview

`
┌─────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                      │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              React + Tailwind UI                      │ │
│  │  ┌──────────┬──────────┬──────────┬───────────────┐ │ │
│  │  │Dashboard │ Job Board│ Projects │  Benchmarks    │ │ │
│  │  │          │          │          │               │ │ │
│  │  │  Stats   │  Live    │  MC      │  Run & Review │ │ │
│  │  │  Cards   │  Jobs    │  Config  │  Examples      │ │ │
│  │  └──────────┴──────────┴──────────┴───────────────┘ │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │                              │
         │  HTTP (REST + WS)            │  IPC (Rust)
         ▼                              ▼
┌──────────────────────┐    ┌──────────────────────┐
│   FastAPI Server      │    │   Tauri Commands      │
│   (Python :8080)     │    │   (Rust shell)        │
│                      │    │   - spawn mc daemon    │
│   /api/projects      │    │   - spawn benchmarks   │
│   /api/jobs          │    │   - read reports       │
│   /api/backlog       │    └──────────────────────┘
│   /ws (live updates) │
│   /api/algo/*        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐    ┌──────────────────────┐
│  Mission Control     │    │   Jobs-Algo (Node)    │
│  Core (Python)       │    │                       │
│                      │    │   - Scheduler          │
│  - Daemon            │    │   - Profile Store      │
│  - TUI               │    │   - Graph Engine       │
│  - CLI               │    │   - File Cache         │
│  - MCP Server        │    │   - Ollama Executor    │
└──────────────────────┘    └──────────┬───────────┘
                                       │
                                       ▼
                              ┌──────────────────────┐
                              │   Ollama (localhost)   │
                              │   qwen2.5:0.5b        │
                              └──────────────────────┘
`

## Quick Start

### Prerequisites

- Python 3.10+ with mission-control installed (pip install -e . from MC repo)
- Node.js 18+ (24.13.0 recommended)
- Ollama running locally with qwen2.5:0.5b pulled
- Rust + Cargo (for Tauri, optional)

### 1. Start the MC Daemon

`powershell
# Terminal 1: Start the daemon
mc --project scaling-benchmark daemon
`

### 2. Start the API Server

`powershell
# Terminal 2: Start the FastAPI server
cd C:\Users\Bryan\Source\intent-network-mission-control
python -m mission_control.api.cli --port 8080 --daemon
`

The --daemon flag also starts the MC daemon alongside the API. Without it, only the API starts (useful when the daemon is already running).

### 3. Start the React UI

`powershell
# Terminal 3: Start the React dev server
cd C:\Users\Bryan\Source\intent-network-mission-control\ui
npm run dev
`

Open http://localhost:3000 in your browser.

### 4. Alternative: Use the API directly

`powershell
# List projects
Invoke-RestMethod http://localhost:8080/api/projects

# List jobs
Invoke-RestMethod http://localhost:8080/api/jobs

# Submit a job
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/jobs/submit 
  -ContentType "application/json" 
  -Body '{"project_id":"scaling-benchmark","type":"classify","story_id":"test_1"}'

# Check daemon status
Invoke-RestMethod http://localhost:8080/api/daemon/status

# Get benchmark results
Invoke-RestMethod http://localhost:8080/api/algo/benchmarks

# Run a benchmark
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/algo/benchmark/run 
  -ContentType "application/json" 
  -Body '{"example":"scaling-benchmark","mode":"live","jobs":30,"slots":4}'
`

## Benchmark Examples

### Running Examples Directly

Each example can be run standalone without the API:

`powershell
cd C:\Users\Bryan\Documents\jobs-algo

# Sentinel Monitor (urgency ordering)
npx tsx examples/sentinel-monitor/src/index.ts --checks 20 --mode live --slots 4

# Forge CI (DAG execution)
npx tsx examples/forge-ci/src/index.ts --pipelines 3 --mode live --slots 4

# Scribe Publisher (cache push)
npx tsx examples/scribe-publisher/src/index.ts --articles 15 --mode live --slots 4

# Vault Audit (profile learning at extremes)
npx tsx examples/vault-audit/src/index.ts --audits 20 --mode live --slots 4

# Acme Data Pipeline (ETL DAG)
npx tsx examples/acme-data-pipeline/src/index.ts --pipelines 2 --mode live --slots 4

# Scaling Benchmark (multi-vertical)
npx tsx examples/scaling-benchmark/scaling-benchmark.ts --mode live --jobs 50 --verticals 5

# Dungeon Forge (playable game)
npx tsx examples/dungeon-forge/dungeon-forge.ts --difficulty easy --floors 3

# Wordsmith (word game)
npx tsx examples/wordsmith/wordsmith.ts --rounds 5 --difficulty easy
`

### Reading Reports

Each example saves a JSON report to .cache/<example-name>/:

`powershell
# Find reports
Get-ChildItem C:\Users\Bryan\Documents\jobs-algo\.cache -Recurse -Filter "*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 5

# Read a report
 = Get-Content C:\Users\Bryan\Documents\jobs-algo\.cache\sentinel\sentinel-report-*.json | ConvertFrom-Json
 | Format-List
`

### Example Output: Sentinel Monitor

`
======================================================================
  SENTINEL MONITOR RESULTS
======================================================================

  Mode:         LIVE
  Total checks: 10
  Completed:    10/10
  Failed:       0
  Total wall:   5.6s
  Throughput:   1.78 checks/s

  URGENCY TIERS:
  Tier       Total   OK    Fail  Avg(ms)
  ----------------------------------------
  critical   4       4     0     4095
  warning    1       1     0     4485
  info       2       2     0     4957
  summary    3       3     0     5153

  PROFILE LEARNING:
    critical-alert         samples=3   warm=true  wall=3899ms
    overbudget-alert       samples=1   warm=false wall=4216ms
    ...
`

### Example Output: Forge CI (DAG)

`
======================================================================
  FORGE CI RESULTS
======================================================================

  Pipelines:     2
  Total stages:  12
  Completed:     12/12
  Failed:        0
  Total wall:    4.0s
  Throughput:    2.99 stages/s

  STAGE TIMING:
  Stage              Count  Avg(ms)  Min(ms)  Max(ms)
  --------------------------------------------------
  lint               2      402      368      435
  build              2      1202     1174     1229
  test-unit          2      3134     3120     3148
  test-integration   2      2057     1938     2176
  security-scan      2      2059     1622     2496
  deploy             2      3960     3945     3975
`

### Example Output: Vault Audit (Cost Tiers)

`
  COST TIERS (profile learning at extremes):
  Tier     Total   OK    Fail  Avg(ms)  P50(ms)  P95(ms)
  -------------------------------------------------------
  light    6       6     0     2509     2362     3013
  medium   4       4     0     1166     1180     1182
  heavy    0       0     0     0        0        0
`

## Running via MC Daemon

Each example includes a .mc/ integration kit and PowerShell scripts:

`powershell
# Terminal 1: Start MC daemon for sentinel-monitor
.\examples\sentinel-monitor\scripts\start-daemon.ps1

# Terminal 2: (Optional) Watch the TUI
mc --project sentinel-monitor tui

# Terminal 3: Run the benchmark through MC
npx tsx examples/sentinel-monitor/src/index.ts --checks 20 --mode mc --slots 4
`

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/projects | List registered MC projects |
| GET | /api/jobs | List jobs (filter: ?project=id&state=running) |
| GET | /api/jobs/{id} | Get job detail |
| POST | /api/jobs/submit | Submit new job |
| POST | /api/jobs/{id}/cancel | Cancel a job |
| GET | /api/backlog | List backlog items |
| GET | /api/daemon/status | Daemon running state |
| GET | /api/algo/profiles | Jobs-algo EWMA profiles |
| GET | /api/algo/benchmarks | Recent benchmark reports |
| POST | /api/algo/benchmark/run | Trigger a benchmark |
| WS | /ws | Live job updates |

## What Each Example Demonstrates

| Example | Algorithm Focus | What to Look For |
|---------|----------------|-------------------|
| sentinel-monitor | Urgency ordering | Critical alerts (5s) always complete first |
| forge-ci | DAG execution | Build waits for lint; deploy waits for all tests |
| scribe-publisher | Cache push/refresh | Hot content (5s) refreshes faster than cold (60s) |
| vault-audit | Profile learning | Light/medium/heavy tiers show different EWMA profiles |
| scaling-benchmark | Multi-vertical scaling | Throughput scales with parallelism |
| mileage-benchmark | Slot packing | Bin-packing efficiency across urgency windows |
| dungeon-forge | Playable game | Procedural generation with parallel jobs |
| wordsmith | Playable game | Word game with urgency-ordered round jobs |
| acme-data-pipeline | ETL DAG | Extract -> transform -> validate -> load chain |

## Key Concepts

- **Urgency = cacheExpiryMs**: Shorter expiry = higher priority. The scheduler sorts by urgency so time-critical work runs first.
- **Profile Learning**: Each job signature tracks EWMA of CPU ticks, memory, and wall time. After cold-start samples, the scheduler bin-packs efficiently.
- **Graph DAG**: Nodes with dependencies run in topological order. If any node fails, the entire graph is killed (no partial results).
- **Cache Push**: When a cached result expires and there are active subscribers, the system pushes refreshed content instead of evicting.
- **MC Integration**: Every example has a .mc/ directory with integration.yaml, gents/ollama-local.yaml, job-types/*.yaml, and workflows/*.yaml for full MC daemon pipeline support.
