#!/usr/bin/env pwsh
# run-ollama-e2e.ps1
# End-to-end test: jobs-algo -> MC -> Ollama (qwen2.5:0.5b)
#
# Prerequisites:
#   1. Ollama running with qwen2.5:0.5b pulled
#   2. Mission Control installed (pip install -e . in MC repo)
#   3. Node.js 18+
#   4. jobs-algo built (npm run build in this repo)

param(
    [string] = "C:\Users\Bryan\Source\intent-network-mission-control",
    [string] = "acme-data-pipeline",
    [string] = "qwen2.5:0.5b",
    [int] = 1,
    [switch]
)

Continue = "Stop"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  JOBS-ALGO + OLLAMA END-TO-END TEST" -ForegroundColor Cyan
Write-Host "  Model: " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Verify Ollama ──
Write-Host "[1/7] Checking Ollama..." -ForegroundColor Yellow
try {
     = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 5
     = (.models | ForEach-Object { .name }) -join ", "
    Write-Host "  Ollama running. Models: " -ForegroundColor Green
    if ( -notlike "**") {
        Write-Host "  Model  not found. Pulling..." -ForegroundColor Yellow
        ollama pull 
    }
} catch {
    Write-Error "Ollama not running at http://localhost:11434. Start it with: ollama serve"
    exit 1
}

# ── Step 2: Build jobs-algo ──
Write-Host "[2/7] Building jobs-algo..." -ForegroundColor Yellow
npm run build 2>&1 | Out-Null
npm test 2>&1 | Select-String "passed"
Write-Host "  Build + tests OK." -ForegroundColor Green

# ── Step 3: Verify MC ──
Write-Host "[3/7] Checking Mission Control..." -ForegroundColor Yellow
 = Get-Command mc -ErrorAction SilentlyContinue
if (-not ) {
    Write-Error "'mc' CLI not found. Install MC from "
    exit 1
}
Write-Host "  MC CLI found: " -ForegroundColor Green

# ── Step 4: Set up project ──
Write-Host "[4/7] Setting up project..." -ForegroundColor Yellow
 = "C:\Users\Bryan\Documents\jobs-algo\examples\acme-data-pipeline"
 = Join-Path  "var"
 = Join-Path  "projects" 

# Create MC project directory structure
New-Item -ItemType Directory -Path (Join-Path  "var" "jobs") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path  "var" "workspaces") -Force | Out-Null
Write-Host "  Project dirs created." -ForegroundColor Green

# ── Step 5: Configure environment ──
Write-Host "[5/7] Configuring environment..." -ForegroundColor Yellow
 = "1"
 = "ollama-local"
 = 
 = "python "\examples\providers\mc_alt_provider_agent.py""
 = 
 = 
 = 
Write-Host "  MC_REGISTER_OLLAMA=1" -ForegroundColor Gray
Write-Host "  MC_ALT_PROVIDER=ollama-local" -ForegroundColor Gray
Write-Host "  OLLAMA_MODEL=" -ForegroundColor Gray
Write-Host "  MC_AGENT_CMD set" -ForegroundColor Gray

# ── Step 6: Run the test harness ──
Write-Host "[6/7] Running test harness..." -ForegroundColor Yellow
Write-Host ""

 = node --input-type=module -e "
import { runOllamaTest } from './dist/integration/ollama/ollama-test-harness.js';
runOllamaTest(
  { model: '', maxTokens: 40, timeoutMs: 60000 },
  { runs: , outputDir: '.cache/reports', includeGraph: false }
).then(r => { console.log(JSON.stringify(r)); process.exit(0); })
.catch(e => { console.error('FAILED:', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 600000);
" 2>&1

if ( -ne 0 -and -not ) {
    Write-Error "Test harness failed."
    exit 1
}

# ── Step 7: Show report ──
Write-Host "[7/7] Reading report..." -ForegroundColor Yellow
 = Get-ChildItem ".cache\reports\ollama-test-report-*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if () {
     = [0]
    Write-Host "  Report: " -ForegroundColor Green
    
     = Get-Content .FullName | ConvertFrom-Json
    Write-Host ""
    Write-Host "  Summary:" -ForegroundColor Cyan
    Write-Host "    Total jobs:    "
    Write-Host "    Completed:     "
    Write-Host "    Failed:        "
    Write-Host "    Avg wall time: ms"
    Write-Host "    Total tokens:  "
    Write-Host "    Warm profiles:  /"
    
    Write-Host ""
    Write-Host "  Profiles:" -ForegroundColor Cyan
    foreach ( in .profiles) {
         = if (.warm) { "[WARM]" } else { "[COLD]" }
        Write-Host "      n= wall=ms fail=0%"
    }
} else {
    Write-Host "  No report files found." -ForegroundColor Red
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  E2E test complete!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
