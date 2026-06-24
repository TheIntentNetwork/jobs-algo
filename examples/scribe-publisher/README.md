# Scribe Publisher

Content operations benchmark for @intent-network/jobs-algo.

Demonstrates **cache push and refresh behavior**: content jobs generate articles, descriptions, SEO audits, and reviews with varying cache expiry times. The system tracks which signatures have active subscribers and pushes refreshed content to the frontend cache layer on expiry.

## Quick Start

### Live Mode (direct Ollama)

```powershell
ollama pull qwen2.5:0.5b
npx tsx examples/scribe-publisher/src/index.ts --articles 15 --mode live
```

### MC Mode (full MC daemon pipeline)

```powershell
.\examples\scribe-publisher\scripts\start-daemon.ps1
.\examples\scribe-publisher\scripts\start-tui.ps1
.\examples\scribe-publisher\scripts\run-scribe.ps1 -Mode mc
```

## Cache Tiers

| Tier | Content Types | TTL | Refresh | Behavior |
|------|-------------|-----|---------|----------|
| Hot | headline, breaking-alert | 5-8s | 3-5s | Push on expiry, always fresh |
| Warm | product-desc, seo-audit | 20-30s | 15-20s | Push to subscribers |
| Cold | evergreen, review-summary | 45-60s | 30-45s | Refresh only if clients exist |

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| --articles | 15 | Number of content jobs |
| --mode | live | live for Ollama, mc for MC daemon |
| --slots | 4 | Max parallelism |
| --model | qwen2.5:0.5b | Ollama model (live mode) |
| --timeout | 600000 | Overall timeout in ms |
| --output | .cache/scribe-publisher | Report directory |