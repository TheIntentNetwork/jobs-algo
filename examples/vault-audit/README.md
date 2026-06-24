# Vault Audit

Security and compliance benchmark for @intent-network/jobs-algo.

Demonstrates **profile learning at extremes**: some scan types are fast and cheap (policy checks), others are slow and expensive (penetration simulations). The scheduler learns these profiles over time and optimally packs them into parallel execution windows.

## Quick Start

### Live Mode (direct Ollama)

```powershell
ollama pull qwen2.5:0.5b
npx tsx examples/vault-audit/src/index.ts --audits 20 --mode live
```

### MC Mode (full MC daemon pipeline)

```powershell
.\examples\vault-audit\scripts\start-daemon.ps1
.\examples\vault-audit\scripts\start-tui.ps1
.\examples\vault-audit\scripts\run-vault.ps1 -Mode mc
```

## Cost Tiers

| Tier | Audit Types | Typical Cost | Urgency |
|------|------------|---------------|----------|
| Light | policy-check, access-review | Fast, cheap | 25-30s |
| Medium | vuln-scan, config-audit | Moderate | 15-20s |
| Heavy | pen-simulation, forensic-analysis, urgent-alert | Slow, expensive | 5-10s |

The scheduler learns profile data (CPU ticks, memory, wall time) from each job type and uses EWMA to predict resource requirements. Heavy jobs get scheduled into slots that can accommodate them, while light jobs fill the gaps.

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| --audits | 20 | Number of security audits |
| --mode | live | live for Ollama, mc for MC daemon |
| --slots | 4 | Max parallelism (0 = auto) |
| --model | qwen2.5:0.5b | Ollama model (live mode) |
| --timeout | 600000 | Overall timeout in ms |
| --output | .cache/vault-audit | Report directory |