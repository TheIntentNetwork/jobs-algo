#!/usr/bin/env pwsh
# start-tui.ps1
# Start the MC TUI for the scaling-benchmark project

param(
    [string]$ProjectId = "scaling-benchmark"
)

mc --project $ProjectId tui
