#!/usr/bin/env pwsh
# run-scaling-mc.ps1
# Run the scaling benchmark in MC mode (requires mc daemon running)

param(
    [int]$Jobs = 30,
    [int]$Verticals = 5,
    [int]$Slots = 4,
    [string]$McRoot = "C:\Users\Bryan\Source\intent-network-mission-control",
    [string]$McProject = "scaling-benchmark",
    [string]$Output = ".cache/scaling-mc"
)

$repoRoot = "$PSScriptRoot\..\..\.."
Push-Location $repoRoot

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  SCALING BENCHMARK - MC MODE" -ForegroundColor Cyan
Write-Host "  Jobs: $Jobs | Verticals: $Verticals | Slots: $Slots" -ForegroundColor Cyan
Write-Host "  MC Project: $McProject" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "NOTE: Run start-daemon.ps1 in a separate terminal first!" -ForegroundColor Yellow
Write-Host "NOTE: Run start-tui.ps1 in another terminal to watch the job board." -ForegroundColor Yellow
Write-Host ""

npx tsx examples/scaling-benchmark/scaling-benchmark.ts --mode mc --jobs $Jobs --verticals $Verticals --slots $Slots --mc-root $McRoot --mc-project $McProject --output $Output

Pop-Location
