#!/usr/bin/env pwsh
# start-daemon.ps1 — Start MC daemon with Ollama provider configured
$env:MC_REGISTER_OLLAMA = "1"
$env:MC_ALT_PROVIDER = "ollama-local"
$env:OLLAMA_MODEL = "qwen2.5:0.5b"
$env:OLLAMA_HOST = "http://localhost:11434"
$env:MC_AGENT_CMD = 'python "C:\Users\Bryan\Source\intent-network-mission-control\examples\providers\mc_alt_provider_agent.py"'

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "  MC Daemon for mileage-benchmark (Ollama qwen2.5:0.5b)" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  MC_REGISTER_OLLAMA=$env:MC_REGISTER_OLLAMA" -ForegroundColor Gray
Write-Host "  MC_ALT_PROVIDER=$env:MC_ALT_PROVIDER" -ForegroundColor Gray
Write-Host "  OLLAMA_MODEL=$env:OLLAMA_MODEL" -ForegroundColor Gray
Write-Host ""

mc --project mileage-benchmark daemon
