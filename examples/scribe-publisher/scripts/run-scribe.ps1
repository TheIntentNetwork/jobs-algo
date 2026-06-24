#!/usr/bin/env pwsh
param(
    [int]$Articles = 15,
    [string]$Mode = "live",
    [int]$Slots = 4,
    [string]$Model = "qwen2.5:0.5b"
)
npx tsx examples/scribe-publisher/src/index.ts --articles $Articles --mode $Mode --slots $Slots --model $Model