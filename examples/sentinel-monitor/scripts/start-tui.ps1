#!/usr/bin/env pwsh
# start-tui.ps1 - Start the MC TUI for monitoring

param(
    [string]$ProjectId = "sentinel-monitor"
)

mc --project $ProjectId tui