#!/usr/bin/env pwsh
param(
    [int]$Pipelines = 2,
    [string]$Mode = "live",
    [int]$Slots = 4,
    [string]$Model = "qwen2.5:0.5b"
)
npx tsx examples/acme-data-pipeline/src/index.ts --pipelines $Pipelines --mode $Mode --slots $Slots --model $Model