#!/usr/bin/env pwsh
# run-mileage.ps1 — Run the mileage benchmark with live MC integration
#
# Required terminals:
#   Terminal 1:  mc daemon                         (MC daemon processing jobs)
#   Terminal 2:  mc tui                             (Live job board dashboard)
#   Terminal 3:  .\run-mileage.ps1                  (This benchmark)
#
# Prerequisites:
#   - Node.js 18+
#   - Ollama running with qwen2.5:0.5b
#   - MC installed (mc on PATH)
#   - jobs-algo built (npm run build)

param(
    [string] = "C:\Users\Bryan\Source\intent-network-mission-control",
    [string] = "intent-network-mission-control",
    [string] = "qwen2.5:0.5b",
    [int] = 2000
)

Continue = "Stop"

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  MILEAGE BENCHMARK — Setup" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check Ollama ──
Write-Host "[1/5] Checking Ollama..." -ForegroundColor Yellow
try {
     = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 5
     = (.models | ForEach-Object { .name }) -join ", "
    Write-Host "  Ollama running. Models: " -ForegroundColor Green
    if ( -notlike "**") {
        Write-Host "  Model  not found. Pulling..." -ForegroundColor Yellow
        ollama pull 
    }
} catch {
    Write-Error "Ollama not running at http://localhost:11434. Start: ollama serve"
    exit 1
}

# ── Step 2: Check MC ──
Write-Host "[2/5] Checking Mission Control..." -ForegroundColor Yellow
 = Get-Command mc -ErrorAction SilentlyContinue
if (-not ) {
    Write-Error "'mc' CLI not found. Install MC from: "
    exit 1
}
Write-Host "  MC CLI found: " -ForegroundColor Green

# ── Step 3: Set environment ──
Write-Host "[3/5] Setting environment..." -ForegroundColor Yellow
 = "1"
 = "ollama-local"
 = 
0.0.0.0:11434 = "http://localhost:11434"
 = "python "\examples\providers\mc_alt_provider_agent.py""
Write-Host "  MC_REGISTER_OLLAMA=1" -ForegroundColor Gray
Write-Host "  MC_ALT_PROVIDER=ollama-local" -ForegroundColor Gray
Write-Host "  OLLAMA_MODEL=" -ForegroundColor Gray
Write-Host "  MC_AGENT_CMD set" -ForegroundColor Gray

# ── Step 4: Verify MC daemon is running ──
Write-Host "[4/5] Checking MC daemon..." -ForegroundColor Yellow
Write-Host "  Make sure the MC daemon is running in another terminal:" -ForegroundColor Yellow
Write-Host "    mc daemon" -ForegroundColor White
Write-Host ""
Write-Host "  And the MC TUI (job board) in another:" -ForegroundColor Yellow
Write-Host "    mc tui" -ForegroundColor White
Write-Host ""
Read-Host "  Press Enter when MC daemon + TUI are running (or Ctrl+C to abort)"

# ── Step 5: Build + Run ──
Write-Host "[5/5] Running benchmark..." -ForegroundColor Yellow
Push-Location "\..\..\.."

npm run build 2>&1 | Out-Null

npx tsx examples/mileage-benchmark/mileage-benchmark.ts

Pop-Location

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Benchmark complete!" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
