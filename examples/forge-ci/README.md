# Forge CI

AI-assisted CI/CD pipeline benchmark for @intent-network/jobs-algo.

Demonstrates **DAG execution**: each pipeline is a directed acyclic graph of stages (lint, build, test-unit, test-integration, security-scan, deploy) where dependencies are enforced. Every stage does real Ollama inference.

## Quick Start

### Live Mode (direct Ollama)

```powershell
ollama pull qwen2.5:0.5b
npx tsx examples/forge-ci/src/index.ts --pipelines 3 --mode live
```

### MC Mode (full MC daemon pipeline)

```powershell
.\examples\forge-ci\scripts\start-daemon.ps1
.\examples\forge-ci\scripts\start-tui.ps1
.\examples\forge-ci\scripts\run-forge.ps1 -Mode mc
```

## DAG Structure

```
lint -> build -> test-unit    -> deploy
              -> test-integration -> deploy
              -> security-scan    -> deploy
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| --pipelines | 3 | Number of CI/CD pipeline DAGs |
| --mode | live | live for Ollama, mc for MC daemon |
| --slots | 4 | Max parallelism (0 = auto) |
| --model | qwen2.5:0.5b | Ollama model (live mode) |
| --timeout | 600000 | Overall timeout in ms |
| --output | .cache/forge-ci | Report output directory |