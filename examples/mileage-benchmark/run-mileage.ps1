#!/usr/bin/env pwsh
# run-mileage.ps1 — Run the mileage benchmark with live MC integration
#
# Required terminals (3-panel split):
#   Panel 1:  .\start-daemon.ps1                   (MC daemon processing jobs)
#   Panel 2:  .\start-tui.ps1                      (Live job board dashboard)
#   Panel 3:  .\run-mileage.ps1                    (This benchmark)
#
# Prerequisites:
#   - Node.js 18+
#   - Ollama running with qwen2.5:0.5b
#   - MC installed (mc on PATH)
#   - jobs-algo built (npm run build)

param(
    [string]$McRoot = "C:\Users\Bryan\Source\intent-network-mission-control",
    [string]$ProjectId = "mileage-benchmark",
    [string]$OllamaModel = "qwen2.5:0.5b",
    [int]$PollMs = 2000
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  MILEAGE BENCHMARK - Real Ollama Inference through MC" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check Ollama ──
Write-Host "[1/5] Checking Ollama..." -ForegroundColor Yellow
try {
    $tags = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 5
    $modelList = ($tags.models | ForEach-Object { $_.name }) -join ", "
    Write-Host "  Ollama running. Models: $modelList" -ForegroundColor Green
    if ($modelList -notlike "*$OllamaModel*") {
        Write-Host "  Model $OllamaModel not found. Pulling..." -ForegroundColor Yellow
        ollama pull $OllamaModel
    }
} catch {
    Write-Error "Ollama not running at http://localhost:11434. Start: ollama serve"
    exit 1
}

# ── Step 2: Check MC ──
Write-Host "[2/5] Checking Mission Control..." -ForegroundColor Yellow
$mcCmd = Get-Command mc -ErrorAction SilentlyContinue
if (-not $mcCmd) {
    Write-Error "'mc' CLI not found. Install MC first."
    exit 1
}
Write-Host "  MC CLI found: $($mcCmd.Source)" -ForegroundColor Green

# ── Step 3: Set environment ──
Write-Host "[3/5] Setting environment..." -ForegroundColor Yellow
$env:MC_REGISTER_OLLAMA = "1"
$env:MC_ALT_PROVIDER = "ollama-local"
$env:OLLAMA_MODEL = $OllamaModel
$env:OLLAMA_HOST = "http://localhost:11434"
$env:MC_AGENT_CMD = "python `"$McRoot\examples\providers\mc_alt_provider_agent.py`""
$env:MC_PROJECT_ROOT = $McRoot
$env:MC_PROJECT_ID = $ProjectId
Write-Host "  MC_REGISTER_OLLAMA=1" -ForegroundColor Gray
Write-Host "  MC_ALT_PROVIDER=ollama-local" -ForegroundColor Gray
Write-Host "  OLLAMA_MODEL=$OllamaModel" -ForegroundColor Gray
Write-Host "  MC_AGENT_CMD set" -ForegroundColor Gray

# ── Step 4: Verify MC daemon is running ──
Write-Host "[4/5] Checking MC daemon..." -ForegroundColor Yellow
Write-Host "  Make sure the MC daemon is running in Panel 1:" -ForegroundColor Yellow
Write-Host "    .\examples\mileage-benchmark\start-daemon.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  And the MC TUI (job board) in Panel 2:" -ForegroundColor Yellow
Write-Host "    .\examples\mileage-benchmark\start-tui.ps1" -ForegroundColor White
Write-Host ""
Read-Host "  Press Enter when MC daemon + TUI are running (or Ctrl+C to abort)"

# ── Step 5: Build + Run ──
Write-Host "[5/5] Running benchmark..." -ForegroundColor Yellow
Push-Location "$PSScriptRoot\..\..\"

npm run build 2>&1 | Out-Null

npx tsx examples/mileage-benchmark/mileage-benchmark.ts

Pop-Location

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "  Benchmark complete!" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
