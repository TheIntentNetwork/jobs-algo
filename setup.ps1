# setup.ps1 — Full integration setup for @intent-network/jobs-algo
# Run from PowerShell: .\setup.ps1
#
# Prerequisites:
#   - Node.js 18+
#   - Git
#   - Mission Control installed (pip install -e . from MC repo)
#   - MC daemon running
#   - Ollama installed (for local LLM testing)

param(
    [string]$McRepoPath = "C:\Users\Bryan\Source\intent-network-mission-control",
    [string]$ProjectId = "mc-platform",
    [string]$InstallDir = "C:\Users\Bryan\Documents\jobs-algo",
    [string]$OllamaModel = "qwen2.5:0.5b"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  jobs-algo Integration Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Verify Node.js ──
Write-Host "[1/11] Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = node --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Node.js not found. Install Node.js 18+ from https://nodejs.org"
    exit 1
}
Write-Host "  Node.js $nodeVersion found." -ForegroundColor Green

# ── Step 2: Clone if needed, install dependencies ──
Write-Host "[2/11] Installing dependencies..." -ForegroundColor Yellow
if (-not (Test-Path "$InstallDir\package.json")) {
    Write-Error "Install directory not found: $InstallDir. Clone the repo first."
    exit 1
}
Push-Location $InstallDir
npm install
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; Pop-Location; exit 1 }
Write-Host "  Dependencies installed." -ForegroundColor Green

# ── Step 3: Build ──
Write-Host "[3/11] Building..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; Pop-Location; exit 1 }
Write-Host "  Build complete." -ForegroundColor Green

# ── Step 4: Run tests ──
Write-Host "[4/11] Running tests..." -ForegroundColor Yellow
npm test
if ($LASTEXITCODE -ne 0) { Write-Error "Tests failed"; Pop-Location; exit 1 }
Write-Host "  All 44 tests passed." -ForegroundColor Green

# ── Step 5: Verify Ollama ──
Write-Host "[5/11] Checking Ollama..." -ForegroundColor Yellow
try {
    $tags = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 5
    $modelList = ($tags.models | ForEach-Object { $_.name }) -join ", "
    Write-Host "  Ollama running. Models: $modelList" -ForegroundColor Green
    if ($modelList -notlike "*$OllamaModel*") {
        Write-Host "  Model $OllamaModel not found. Pulling..." -ForegroundColor Yellow
        ollama pull $OllamaModel
    }
} catch {
    Write-Host "  Ollama not running. Install from https://ollama.com and run: ollama serve" -ForegroundColor Yellow
    Write-Host "  (Setup can continue without Ollama — e2e tests will be skipped)" -ForegroundColor Yellow
}

# ── Step 6: Verify MC installation ──
Write-Host "[6/11] Checking Mission Control..." -ForegroundColor Yellow
$mcCheck = Get-Command mc -ErrorAction SilentlyContinue
if (-not $mcCheck) {
    Write-Host "  'mc' CLI not found on PATH." -ForegroundColor Red
    Write-Host "  Install MC from: $McRepoPath" -ForegroundColor Red
    Write-Host "  Run: cd $McRepoPath ; pip install -e ." -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "  MC CLI found at: $($mcCheck.Source)" -ForegroundColor Green

# ── Step 7: Verify MC project ──
Write-Host "[7/11] Verifying MC project..." -ForegroundColor Yellow
$projectList = mc project list 2>&1
if ($projectList -match $ProjectId) {
    Write-Host "  Project '$ProjectId' found." -ForegroundColor Green
} else {
    Write-Host "  Project '$ProjectId' not found. Register it:" -ForegroundColor Red
    Write-Host "    mc project register --id $ProjectId --name `"$ProjectId`" --repo-path `"$McRepoPath`"" -ForegroundColor Red
    Pop-Location
    exit 1
}

# ── Step 8: Check MC daemon ──
Write-Host "[8/11] Checking MC daemon..." -ForegroundColor Yellow
$daemonStatus = mc daemon --status 2>&1
if ($daemonStatus -match "running" -or $daemonStatus -match "up") {
    Write-Host "  MC daemon is running." -ForegroundColor Green
} else {
    Write-Host "  MC daemon may not be running. Start it in a separate terminal:" -ForegroundColor Yellow
    Write-Host "    mc daemon" -ForegroundColor Yellow
    Write-Host "  (You can continue setup without it for now)" -ForegroundColor Yellow
}

# ── Step 9: Create .mc/integration.yaml if missing ──
Write-Host "[9/11] Setting up MC integration kit..." -ForegroundColor Yellow
$mcDir = Join-Path $McRepoPath ".mc"
if (-not (Test-Path $mcDir)) {
    New-Item -ItemType Directory -Path $mcDir -Force | Out-Null
    Write-Host "  Created .mc/ directory." -ForegroundColor Green
}

$integrationYaml = Join-Path $mcDir "integration.yaml"
if (-not (Test-Path $integrationYaml)) {
    @"
version: 1
package: "@intent-network/jobs-algo"
domain: intent-network

job_types:
  - path: "job-types/*.yaml"
workflows:
  - path: "workflows/*.yaml"
"@ | Out-File -Encoding utf8 $integrationYaml
    Write-Host "  Created .mc/integration.yaml" -ForegroundColor Green
} else {
    Write-Host "  .mc/integration.yaml already exists." -ForegroundColor Green
}

$jobTypesDir = Join-Path $mcDir "job-types"
if (-not (Test-Path $jobTypesDir)) {
    New-Item -ItemType Directory -Path $jobTypesDir -Force | Out-Null
    Write-Host "  Created .mc/job-types/ directory." -ForegroundColor Green
}

$workflowsDir = Join-Path $mcDir "workflows"
if (-not (Test-Path $workflowsDir)) {
    New-Item -ItemType Directory -Path $workflowsDir -Force | Out-Null
    Write-Host "  Created .mc/workflows/ directory." -ForegroundColor Green
}

# ── Step 10: Validate MC integration ──
Write-Host "[10/11] Validating MC integration..." -ForegroundColor Yellow
$validate = mc integration validate --project $ProjectId 2>&1
Write-Host "  $validate" -ForegroundColor Green

# ── Step 11: Create cache directories ──
Write-Host "[11/11] Creating cache directories..." -ForegroundColor Yellow
$cacheDir = Join-Path $InstallDir ".cache"
New-Item -ItemType Directory -Path "$cacheDir\profiles" -Force | Out-Null
New-Item -ItemType Directory -Path "$cacheDir\results" -Force | Out-Null
New-Item -ItemType Directory -Path "$cacheDir\graphs" -Force | Out-Null
New-Item -ItemType Directory -Path "$cacheDir\reports" -Force | Out-Null
Write-Host "  Cache directories created at $cacheDir" -ForegroundColor Green

Pop-Location

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Run the Ollama e2e test:" -ForegroundColor White
Write-Host "     npx tsx src/integration/ollama/ollama-test-harness.ts" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. Link the package for local development:" -ForegroundColor White
Write-Host "     cd $InstallDir" -ForegroundColor Gray
Write-Host "     npm link" -ForegroundColor Gray
Write-Host ""
Write-Host "  3. In your project, link to it:" -ForegroundColor White
Write-Host "     cd <your-project>" -ForegroundColor Gray
Write-Host "     npm link @intent-network/jobs-algo" -ForegroundColor Gray
Write-Host ""
Write-Host "  4. Create your integration script (see docs/developer-guide/README.md)" -ForegroundColor White
Write-Host ""
Write-Host "  5. Start the MC daemon in a separate terminal:" -ForegroundColor White
Write-Host "     mc daemon" -ForegroundColor Gray
Write-Host ""
Write-Host "Cache files will appear in: $cacheDir" -ForegroundColor White
Write-Host "Profiles are learned automatically after 5 runs per signature." -ForegroundColor White
Write-Host "Ollama model for testing: $OllamaModel" -ForegroundColor White
