#!/usr/bin/env pwsh
# run-scaling-live.ps1
# Run the scaling benchmark in live (direct Ollama) mode

param(
    [int]$Jobs = 50,
    [int]$Verticals = 5,
    [int]$Slots = 0,
    [string]$Model = "qwen2.5:0.5b",
    [string]$Output = ".cache/scaling-live"
)

$repoRoot = "$PSScriptRoot\..\..\.."
Push-Location $repoRoot

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  SCALING BENCHMARK - LIVE MODE" -ForegroundColor Cyan
Write-Host "  Jobs: $Jobs | Verticals: $Verticals | Slots: $Slots" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

npx tsx examples/scaling-benchmark/scaling-benchmark.ts --mode live --jobs $Jobs --verticals $Verticals --slots $Slots --model $Model --output $Output

Pop-Location
