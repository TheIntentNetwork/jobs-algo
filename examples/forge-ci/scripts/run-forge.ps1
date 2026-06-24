#!/usr/bin/env pwsh
param(
    [int]$Pipelines = 3,
    [string]$Mode = "live",
    [int]$Slots = 4,
    [string]$Model = "qwen2.5:0.5b"
)
npx tsx examples/forge-ci/src/index.ts --pipelines $Pipelines --mode $Mode --slots $Slots --model $Model