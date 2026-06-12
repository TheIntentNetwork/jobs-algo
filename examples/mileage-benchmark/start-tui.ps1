#!/usr/bin/env pwsh
# start-tui.ps1 — Start MC TUI (live job board dashboard)
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  MC TUI — Live Job Board (mileage-benchmark)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""
mc --project mileage-benchmark tui
