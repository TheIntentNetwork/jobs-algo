#!/usr/bin/env pwsh
# start-daemon.ps1 - Start the MC daemon for sentinel-monitor with Ollama provider

param(
    [string]$McRoot = "C:\Users\Bryan\Source\intent-network-mission-control",
    [string]$ProjectId = "sentinel-monitor",
    [string]$Model = "qwen2.5:0.5b"
)

$env:MC_REGISTER_OLLAMA = "1"
$env:MC_ALT_PROVIDER = "ollama-local"
$env:OLLAMA_MODEL = $Model
$env:MC_AGENT_CMD = "python "$McRoot\examples\providers\mc_alt_provider_agent.py""

Write-Host "Starting MC daemon for project: $ProjectId" -ForegroundColor Cyan
Write-Host "  MC Root: $McRoot" -ForegroundColor Gray
Write-Host "  Model: $Model" -ForegroundColor Gray
Write-Host ""

mc --project $ProjectId daemon