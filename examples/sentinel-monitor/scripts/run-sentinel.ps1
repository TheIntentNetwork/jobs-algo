#!/usr/bin/env pwsh
# run-sentinel.ps1 - Run the sentinel-monitor benchmark

param(
    [int]$Checks = 20,
    [string]$Mode = "live",
    [int]$Slots = 4,
    [string]$Model = "qwen2.5:0.5b"
)

npx tsx examples/sentinel-monitor/src/index.ts --checks $Checks --mode $Mode --slots $Slots --model $Model