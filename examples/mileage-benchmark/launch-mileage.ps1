#!/usr/bin/env pwsh
# launch-mileage.ps1 — Launch all 3 panels for the mileage benchmark
#
# This script opens 3 terminal panes:
#   Panel 1: MC daemon
#   Panel 2: MC TUI (job board)
#   Panel 3: Benchmark runner
#
# Usage:
#   .\launch-mileage.ps1
#
# Prerequisites:
#   - Ollama running (ollama serve)
#   - MC installed (mc on PATH)
#   - Node.js 18+
#   - jobs-algo built (npm run build)

$McRoot = "C:\Users\Bryan\Source\intent-network-mission-control"
$ProjectId = "mileage-benchmark"
$OllamaModel = "qwen2.5:0.5b"
$JobsAlgoRoot = "C:\Users\Bryan\Documents\jobs-algo"

# Set shared environment
$env:MC_REGISTER_OLLAMA = "1"
$env:MC_ALT_PROVIDER = "ollama-local"
$env:OLLAMA_MODEL = $OllamaModel
$env:OLLAMA_HOST = "http://localhost:11434"
$env:MC_AGENT_CMD = "python `"$McRoot\examples\providers\mc_alt_provider_agent.py`""

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  MILEAGE BENCHMARK - 3-Panel Launcher" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
Write-Host "Checking prerequisites..." -ForegroundColor Yellow

$mcCmd = Get-Command mc -ErrorAction SilentlyContinue
if (-not $mcCmd) {
    Write-Error "'mc' CLI not found. Install MC first."
    exit 1
}
Write-Host "  [OK] mc CLI found" -ForegroundColor Green

try {
    $tags = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 3
    Write-Host "  [OK] Ollama running" -ForegroundColor Green
} catch {
    Write-Error "Ollama not running at http://localhost:11434. Start: ollama serve"
    exit 1
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error "Node.js not found."
    exit 1
}
Write-Host "  [OK] Node.js found" -ForegroundColor Green

Write-Host ""
Write-Host "Launching 3 terminal windows..." -ForegroundColor Yellow
Write-Host ""

# Panel 1: MC Daemon
Write-Host "  Panel 1: MC Daemon" -ForegroundColor White
Start-Process pwsh -ArgumentList @(
    "-NoExit",
    "-Command",
    "Write-Host '=== MC Daemon (mileage-benchmark) ===' -ForegroundColor Cyan; Write-Host ''; mc --project $ProjectId daemon"
) -WindowStyle Normal

Start-Sleep -Seconds 3

# Panel 2: MC TUI
Write-Host "  Panel 2: MC TUI (Job Board)" -ForegroundColor White
Start-Process pwsh -ArgumentList @(
    "-NoExit",
    "-Command",
    "Write-Host '=== MC TUI (mileage-benchmark) ===' -ForegroundColor Cyan; Write-Host ''; mc --project $ProjectId tui"
) -WindowStyle Normal

Start-Sleep -Seconds 2

# Panel 3: Benchmark Runner
Write-Host "  Panel 3: Benchmark Runner" -ForegroundColor White
Push-Location $JobsAlgoRoot
npm run build 2>&1 | Out-Null
$env:MC_PROJECT_ROOT = $McRoot
$env:MC_PROJECT_ID = $ProjectId
Start-Process pwsh -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$JobsAlgoRoot'; Write-Host '=== Mileage Benchmark Runner ===' -ForegroundColor Cyan; Write-Host ''; `$env:MC_REGISTER_OLLAMA='1'; `$env:MC_ALT_PROVIDER='ollama-local'; `$env:OLLAMA_MODEL='$OllamaModel'; `$env:MC_AGENT_CMD='python \`"$McRoot\examples\providers\mc_alt_provider_agent.py\`"'; `$env:MC_PROJECT_ROOT='$McRoot'; `$env:MC_PROJECT_ID='$ProjectId'; npx tsx examples/mileage-benchmark/mileage-benchmark.ts; Write-Host ''; Write-Host 'Benchmark complete. Press any key to close.' -ForegroundColor Green; `$null = Read-Host"
) -WindowStyle Normal
Pop-Location

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "  All 3 panels launched!" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Panel 1: MC Daemon        (mc --project $ProjectId daemon)" -ForegroundColor Gray
Write-Host "  Panel 2: MC TUI            (mc --project $ProjectId tui)" -ForegroundColor Gray
Write-Host "  Panel 3: Benchmark Runner   (npx tsx examples/mileage-benchmark/mileage-benchmark.ts)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Watch Panel 2 (TUI) for live job updates as the benchmark runs." -ForegroundColor Yellow
