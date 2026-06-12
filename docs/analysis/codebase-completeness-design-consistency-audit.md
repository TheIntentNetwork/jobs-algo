# Codebase Completeness & Design Consistency Audit

**Date:** 2026-06-12 (updated)
**Repository:** C:\Users\Bryan\Documents\jobs-algo
**Branch:** master
**Commits:** 13 commits on master (b0f09e8 is HEAD)

---

## Summary

@intent-network/jobs-algo is a predictive, learning job scheduler that wraps intent-network-mission-control. The core algorithm (urgency sort + best-fit decreasing bin-packing + EWMA profile learning) is implemented and well-tested. The MC and Ollama integration layers have been debugged through multiple rounds of Windows-specific fixes and now produce real Ollama inference end-to-end through MC.

**The full 8-scenario mileage benchmark passes with real Ollama inference**, demonstrating parallel throughput scaling from 0.24 j/s (1 slot) to 1.19 j/s (4 slots warm profiles).

**Top findings in priority order:**

1. **No CI workflow** — no GitHub Actions or any CI config; all checks are manual.
2. **5 of 18 public exports lack dedicated unit tests** — MCAdapter, mc-bridge, WorkerExecutor, OllamaDirectExecutor, mc-types are exercised only via the mileage benchmark or 	est:ollama.
3. **No git remote configured** — the GitHub repository referenced in package.json does not exist yet.
4. **No TypeScript strict mode** — tsconfig does not set strict: true; no coverage config.

---

## Evidence Inventory

### Git Status

Clean working tree, 13 commits on master.

### Package Scripts

| Script | Command |
|--------|---------|
| build | 	sc |
| lint | 	sc --noEmit |
| test | itest run |
| test:watch | itest |
| test:ollama | 
px tsx src/integration/ollama/ollama-test-harness.ts |
| prepublishOnly | 
pm run build && npm run test |

### Test Coverage (59 tests, all passing)

**Tested (12 files, 59 tests):**
- lgorithm/scheduler.ts — urgency sort, slot release, dispatch
- lgorithm/profile-store.ts — EWMA learning, warm/cold profiles
- lgorithm/slot-manager.ts — slot allocation, budget enforcement
- lgorithm/signature.ts — deterministic signature computation
- cache/file-cache.ts — expiry, eviction, client-aware push
- graph/graph-engine.ts — DAG execution, all-or-nothing failure
- graph/graph-job-tracker.ts — register, lookup, cleanup, all-or-nothing propagation
- push/event-bus.ts — subscribe/unsubscribe, filtered delivery by signature, graph events
- metrics/ewma.ts — exponential weighted moving average
- integration/jobs-algorithm.ts — enqueue, complete, failure, graph failure, profile recording
- queue/sink.ts — push, subscribe, pushGraph, inspectProfile
- slot-release (integration) — scheduler + slot release cycle

**No direct unit tests (5 remaining exports):**
- integration/mc/mc-adapter.ts — tested via jobs-algorithm.test.ts mock executor + mileage benchmark
- integration/mc/mc-bridge.ts — thin wiring layer over QueueSink + MCAdapter
- worker/executor.ts — spawns child process, tested via mileage benchmark
- integration/ollama/ollama-executor.ts — tested via 	est:ollama script
- integration/mc/mc-types.ts — re-export of a constant set

### Build & Lint


pm run build passes. 
pm run lint (tsc --noEmit) passes. 59/59 tests pass.

### Mileage Benchmark Results

All 8 scenarios pass with real Ollama inference through MC:

| Scenario | Wall (ms) | J/s | Slots | Completed |
|---|---|---|---|---|
| 1 slot serial baseline | 41323 | 0.24 | 1 | 10/10 |
| 2 slots parallel | 21846 | 0.46 | 2 | 10/10 |
| 4 slots parallel | 12948 | 0.77 | 4 | 10/10 |
| 8 slots parallel | 9187 | 1.09 | 8 | 10/10 |
| 4 slots tight budget | 11508 | 0.87 | 4 | 9/10 |
| 4 slots warm profiles | 8374 | 1.19 | 1→4 | 10/10 |
| 4 slots 3 runs | 33472 | 0.90 | 4 | 30/30 |
| 1 slot full mixed | 43184 | 0.23 | 1 | 10/10 |

---

## Scorecard

| Dimension | Score | Main reason not higher |
|-----------|-------|----------------------|
| Build/release health | 4 | Build + lint + test pass clean. No CI, no deploy pipeline, no git remote. |
| Product completeness | 5 | Core algorithm works; MC+Ollama integration works end-to-end; full benchmark passes. Cache-layer frontend push works. |
| Data/API consistency | 4 | Type system is coherent; MCAdapter reads status.json directly (AUD-003 fixed). EventBus filters by signature. |
| Architecture boundaries | 5 | Clean module separation (algorithm, cache, graph, queue, push, integration). MCAdapter reads stable-path status.json instead of scanning marker files. |
| Test confidence | 3 | 59 tests cover core algorithm + integration. 5 exports have no dedicated unit test. No coverage thresholds. |

---

## Findings

### AUD-001: No CI workflow (P1)

- No .github/workflows/, no Dockerfile, no deploy manifests.
- Recommended fix: Add .github/workflows/ci.yml with 
pm ci && npm run lint && npm run test.
- Acceptance criteria: Push to master triggers CI; PRs must pass before merge.

### AUD-002: 5 of 18 public exports have no dedicated unit test (P2)

- Evidence: MCAdapter, mc-bridge, WorkerExecutor, OllamaDirectExecutor, mc-types lack dedicated test files.
- Impact: Regressions in MC integration may not be caught until the mileage benchmark is run.
- Status: Reduced from 9 to 5. JobsAlgorithmImpl, QueueSink, GraphJobTracker now have tests.

### AUD-003: MCAdapter polls status.json directly (P2→FIXED)

- ID: AUD-003
- Status: FIXED in commit 7a5aeff
- Previous: MCAdapter scanned the jobs directory for .job marker files, which was fragile (Windows line endings, race conditions, parsing marker filenames).
- Current: pollJobStatus reads status.json directly via workspaces/<jobId>/status.json. State comes from details.state, which is authoritative and always updated before marker rename.

### AUD-004: Windows JobLock PermissionError (P2→FIXED)

- ID: AUD-004
- Status: FIXED in MC commit eb90201
- JobLock.__exit__ now catches PermissionError alongside FileNotFoundError, since Windows file locks are advisory and the lock file is just a sentinel.

### AUD-005: Mileage benchmark backlog creation not idempotent (P2→FIXED)

- ID: AUD-005
- Status: FIXED in commit fd41c68
- ensureBenchmarkBacklog() checks for existing epic/feature/story by name before creating.

### AUD-006: No integration/e2e test in automated suite (P2)

- Evidence: 	est:ollama exists but is not run by 
pm test; mileage benchmark is manual.
- Recommended fix: Add 	est:e2e script that runs the Ollama test harness (skipped if Ollama not available).

### AUD-007: GraphJobTracker all-or-nothing failure propagation (P2→FIXED)

- ID: AUD-007
- Status: FIXED in commit 7a5aeff — 5 tests covering register, lookup, getAllJobIds, cleanup, all-or-nothing.

### AUD-008: No TypeScript strict mode or coverage config (P3)

- 	sconfig.json does not set strict: true; no itest coverage config.
- Recommended fix: Enable strict: true; add coverage thresholds to vitest config.

### AUD-009: Examples reference hardcoded Windows paths (P3)

- mileage-benchmark.ts defaults MC root to C:\Users\Bryan\Source\....
- Recommended fix: Use process.env.MC_ROOT exclusively; document env var overrides.

### AUD-010: No git remote configured (P3)

- git remote -v returns empty; package.json references github.com/TheIntentNetwork/jobs-algo.
- The GitHub repository does not exist yet.
- Status: Remote added but push failed (repo not created). User needs to create the repo on GitHub first.
- Recommended fix: Create the repo on GitHub, then git remote add origin <url> && git push origin master.

### AUD-011: EventBus signature filtering (P2→FIXED)

- Previous: EventBus subscribe(handler, signature) tracked reference counts but delivered ALL events to ALL handlers, causing 4x event duplication in the benchmark.
- Status: FIXED in commit 7a5aeff. Handlers with a signature filter only receive events whose event.signature matches, plus events without a signature field (graph_complete, graph_failed).

### AUD-012: Benchmark refresh loop explosion (P2→FIXED)

- Previous: Short efreshRateMs values (1–15 seconds) caused unbounded refresh cycles after each job completion, inflating the completion counter past 100%.
- Status: FIXED in commit 7a5aeff. Benchmark uses 300-second efreshRateMs for all jobs; only the initial batch of job IDs is counted.

---

## Blocked Or Deferred Checks

| Check | Command | Reason blocked | Required prerequisite | Confidence impact |
|-------|---------|----------------|---------------------|-------------------|
| E2E MC+Ollama test in CI | 
pm run test:ollama | Requires running Ollama daemon | Ollama service in CI or mock MC adapter | Medium |
| MC TUI visual inspection | mc tui | Requires interactive terminal | Terminal access in CI | Low |
| Coverage report | itest --coverage | No coverage config | Add coverage config | Medium |
| Package publish dry-run | 
pm publish --dry-run | No git remote configured | AUD-010 fix | Low |
| Push to GitHub | git push origin master | Repo doesn't exist on GitHub | Create repo on GitHub | Low |

---

## Assumptions

- MC daemon is running with MC_REGISTER_OLLAMA=1 and MC_AGENT_CMD set when running the mileage benchmark
- Ollama is available at http://localhost:11434 with qwen2.5:0.5b model
- The Windows OLLAMA_HOST=0.0.0.0:11434 env var is normalized by the MC agent script fix (commit dd9d258)
- The MC watcher guard fix (commit 7ad95ed) prevents the _reject_in_scope race condition on Windows
- Integration tests require live MC daemon and Ollama — not expected to run in CI
