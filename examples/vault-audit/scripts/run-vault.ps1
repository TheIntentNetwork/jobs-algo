#!/usr/bin/env pwsh
param(
    [int]$Audits = 20,
    [string]$Mode = "live",
    [int]$Slots = 4,
    [string]$Model = "qwen2.5:0.5b"
)
npx tsx examples/vault-audit/src/index.ts --audits $Audits --mode $Mode --slots $Slots --model $Model