#!/usr/bin/env pwsh
# run-ollama-e2e.ps1
# End-to-end test: jobs-algo -> Ollama (qwen2.5:0.5b)
#
# Prerequisites:
#   1. Ollama running with qwen2.5:0.5b pulled
#   2. Node.js 18+
#   3. jobs-algo built (npm run build in this repo)

param(
    [string]$McRepoPath = "C:\Users\Bryan\Source\intent-network-mission-control",
    [string]$ProjectId = "acme-data-pipeline",
    [string]$Model = "qwen2.5:0.5b",
    [int]$Runs = 1,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  JOBS-ALGO + OLLAMA END-TO-END TEST" -ForegroundColor Cyan
Write-Host "  Model: $Model" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Verify Ollama ──
Write-Host "[1/7] Checking Ollama..." -ForegroundColor Yellow
try {
    $tags = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 5
    $modelList = ($tags.models | ForEach-Object { $_.name }) -join ", "
    Write-Host "  Ollama running. Models: $modelList" -ForegroundColor Green
    if ($modelList -notlike "*$Model*") {
        Write-Host "  Model $Model not found. Pulling..." -ForegroundColor Yellow
        ollama pull $Model
    }
} catch {
    Write-Error "Ollama not running at http://localhost:11434. Start it with: ollama serve"
    exit 1
}

# ── Step 2: Build jobs-algo ──
if (-not $SkipBuild) {
    Write-Host "[2/7] Building jobs-algo..." -ForegroundColor Yellow
    Push-Location "$PSScriptRoot\..\..\.."
    npm run build 2>&1 | Out-Null
    npm test 2>&1 | Select-String "passed"
    Write-Host "  Build + tests OK." -ForegroundColor Green
    Pop-Location
} else {
    Write-Host "[2/7] Skipping build (--SkipBuild)" -ForegroundColor Yellow
}

# ── Step 3: Set up environment ──
Write-Host "[3/7] Setting up environment..." -ForegroundColor Yellow
$env:MC_REGISTER_OLLAMA = "1"
$env:MC_ALT_PROVIDER = "ollama-local"
$env:OLLAMA_MODEL = $Model
$env:OLLAMA_HOST = "http://localhost:11434"
Write-Host "  MC_REGISTER_OLLAMA=1" -ForegroundColor Gray
Write-Host "  MC_ALT_PROVIDER=ollama-local" -ForegroundColor Gray
Write-Host "  OLLAMA_MODEL=$Model" -ForegroundColor Gray

# ── Step 4: Run the test harness ──
Write-Host "[4/7] Running test harness..." -ForegroundColor Yellow
Write-Host ""

$repoRoot = "$PSScriptRoot\..\..\.."
Push-Location $repoRoot

$result = node --input-type=module -e @"
import { runOllamaTest } from './dist/integration/ollama/ollama-test-harness.js';
runOllamaTest(
  { model: '$Model', maxTokens: 40, timeoutMs: 60000 },
  { runs: $Runs, outputDir: '.cache/reports', includeGraph: true }
).then(r => { console.log(JSON.stringify(r)); process.exit(0); })
.catch(e => { console.error('FAILED:', e.message); process.exit(1); });
setTimeout(() => { console.error('GLOBAL TIMEOUT'); process.exit(1); }, 600000);
"@

$exitCode = $LASTEXITCODE

Pop-Location

if ($exitCode -ne 0) {
    Write-Error "Test harness failed with exit code $exitCode"
    exit 1
}

# ── Step 5: Show report ──
Write-Host "[5/7] Reading report..." -ForegroundColor Yellow
$reports = Get-ChildItem "$repoRoot\.cache\reports\ollama-test-report-*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if ($reports) {
    $latest = $reports[0]
    Write-Host "  Report: $($latest.FullName)" -ForegroundColor Green

    $reportData = Get-Content $latest.FullName | ConvertFrom-Json
    Write-Host ""
    Write-Host "  Summary:" -ForegroundColor Cyan
    Write-Host "    Total jobs:    $($reportData.summary.totalJobs)"
    Write-Host "    Completed:     $($reportData.summary.completedJobs)"
    Write-Host "    Failed:        $($reportData.summary.failedJobs)"
    Write-Host "    Avg wall time: $($reportData.summary.avgWallTimeMs)ms"
    Write-Host "    Total tokens:  $($reportData.summary.totalTokens)"
    Write-Host "    Warm profiles: $($reportData.summary.warmProfiles)/$($reportData.summary.warmProfiles + $reportData.summary.coldProfiles)"

    Write-Host ""
    Write-Host "  Profiles:" -ForegroundColor Cyan
    foreach ($p in $reportData.profiles) {
        $warm = if ($p.warm) { "[WARM]" } else { "[COLD]" }
        Write-Host "    $warm $($p.name) n=$($p.sampleCount) wall=$($p.wallTimeMsEWMA)ms fail=$([math]::Round($p.failureRateEWMA * 100, 1))%"
    }
} else {
    Write-Host "  No report files found." -ForegroundColor Red
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  E2E test complete!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
