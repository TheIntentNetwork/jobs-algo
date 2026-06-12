# Codebase Completeness & Design Consistency Audit

**Date:** 2026-06-12
**Repository:** C:\Users\Bryan\Documents\jobs-algo
**Branch:** master
**Source of truth:** Working tree (clean, 9 commits ahead of initial implementation)

---

## Summary

`@intent-network/jobs-algo` is a predictive, learning job scheduler that wraps intent-network-mission-control. The core algorithm (urgency sort + best-fit decreasing bin-packing + EWMA profile learning) is implemented and well-tested. The MC and Ollama integration layers have been debugged through multiple rounds of Windows-specific fixes and now produce real Ollama inference end-to-end.

**Top risks in priority order:**

1. **9 of 18 public exports have no unit test** — integration, worker, cache, queue, and metrics modules are exercised only by the mileage benchmark, not by automated tests.
2. **No CI workflow** — there are no GitHub Actions or any CI config; all checks are manual.
3. **MCAdapter pollJobStatus uses fragile file-scanning** — it reads the MC jobs directory for .job marker files instead of using MC's documented API or watching status.json directly.
4. **Windows file-locking edge cases** — JobLock .lock file cleanup can fail with `PermissionError` on Windows when another process holds the file; the daemon's watcher has been patched with a guard but the underlying lock-release issue remains.
5. **Mileage benchmark backlog creation is not idempotent** — each run creates a new epic/feature/story in MC, accumulating orphaned backlog entries.

---

## Evidence Inventory

### Git Status

Clean working tree, 9 commits on master. No uncommitted changes.

### Package Files

- `package.json` — `type: "module"`, Node >= 18, single dependency (`uuid`)
- `package-lock.json` — present, aligned with package.json
- No `.npmrc`, `.yarnrc`, or workspace config

### Package Scripts

| Script | Command |
|--------|---------|
| build | `tsc` |
| lint | `tsc --noEmit` |
| test | `vitest run` |
| test:watch | `vitest` |
| test:ollama | `npx tsx src/integration/ollama/ollama-test-harness.ts` |
| prepublishOnly | `npm run build && npm run test` |

### CI and Deployment Files

**None.** No `.github/workflows/`, no Dockerfile, no deploy manifests.

### Documentation

| File | Claims verified |
|------|-----------------|
| `README.md` | Package description, keywords, basic usage — partially verified |
| `docs/design/SYSTEM_DESIGN.md` | Architecture, algorithms, data flow — verified against code |
| `docs/developer-guide/README.md` | Setup, configuration, integration steps — verified |
| `examples/mileage-benchmark/README.md` | Benchmark run instructions — verified with live Ollama |
| `examples/acme-data-pipeline/README.md` | End-to-end Ollama example — partially verified |

### Test Config

`vitest` with 10 test files, 46 tests, all passing. Test discovery is automatic (`test/*.test.ts`).

### Source Modules vs Test Coverage

**Tested (10 files, 46 tests):**
- `algorithm/scheduler.ts` — urgency sort, slot release, dispatch
- `algorithm/profile-store.ts` — EWMA learning, warm/cold profiles
- `algorithm/slot-manager.ts` — slot allocation, budget enforcement
- `algorithm/signature.ts` — deterministic signature computation
- `cache/file-cache.ts` — expiry, eviction, client-aware push
- `graph/graph-engine.ts` — DAG execution, all-or-nothing failure
- `push/event-bus.ts` — subscribe/unsubscribe, event delivery
- `metrics/ewma.ts` — exponential weighted moving average
- `slot-release` (integration) — scheduler + slot release cycle

**No direct unit tests (9 exports):**
- `integration/jobs-algorithm.ts` (`JobsAlgorithmImpl`)
- `queue/sink.ts` (`QueueSink`)
- `integration/mc/mc-adapter.ts` (`MCAdapter`)
- `integration/mc/mc-bridge.ts` (`createMCBridge`, `mcJobSignature`, `buildMCJobPayload`, `logMCBridgeEvents`)
- `worker/executor.ts` (`WorkerExecutor`)
- `metrics/collector.ts` (`MetricsCollectorImpl`)
- `integration/ollama/ollama-executor.ts` (`OllamaDirectExecutor`)
- `graph/graph-job-tracker.ts` (`GraphJobTracker`)
- `integration/mc/mc-types.ts` (`MC_TERMINAL_STATES`)

---

## Scorecard

| Dimension | Score | Main reason not higher |
|-----------|-------|----------------------|
| Build/release health | 4 | Build + lint + test pass clean. No CI, no deploy pipeline. |
| Product completeness | 3 | Core algorithm works; MC+Ollama integration works end-to-end. Missing: cache-layer frontend, persistent profile store, graceful shutdown tests. |
| Data/API consistency | 3 | Type system is coherent; MCAdapter uses fragile file-scanning instead of MC's API. Cache expiry and graph all-or-nothing contracts are clear. |
| Architecture boundaries | 4 | Clean module separation (algorithm, cache, graph, queue, push, integration). MCAdapter leaks file-system details across the boundary. |
| Test confidence | 2 | 46 tests cover core algorithm well, but 9/18 public exports have no tests. No integration tests for MC or Ollama paths in automated suite. |
| CI correctness | 0 | No CI workflow exists. |
| Docs accuracy | 3 | System design doc and developer guide match code. Mileage benchmark README references scripts that work. Some claims about "live TUI updates" depend on the MC watcher fix. |
| Design-token integrity | N/A | No UI tokens; this is a library, not a visual application. |
| Component consistency | N/A | Library package with no visual components. |
| Accessibility/responsive readiness | N/A | No UI surface. |

---

## Product Area Completeness Matrix

| Area | Route/UI | Data contract | Service impl | Auth/error/loading states | Tests | Docs match | Deploy path |
|------|---------|--------------|-------------|--------------------------|-------|-------------|-------------|
| Core scheduler | N/A | Present | Present | Error: present, Loading: partial | Present | Yes | npm publish |
| Profile store (EWMA) | N/A | Present | Present | Present | Present | Yes | npm publish |
| Graph engine | N/A | Present | Present | All-or-nothing fail | Present | Yes | npm publish |
| File cache | N/A | Present | Present | Expiry/eviction: present | Present | Yes | npm publish |
| Queue sink | N/A | Present | Present | Partial | **Missing** | Partial | npm publish |
| Event bus | N/A | Present | Present | Partial | Present | Partial | npm publish |
| MC adapter | N/A | Partial | Present | File-scan fragility | **Missing** | Partial | npm publish |
| MC bridge | N/A | Present | Present | Partial | **Missing** | Partial | npm publish |
| Ollama executor | N/A | Present | Present | Timeout: present | **Missing** (e2e only) | Partial | npm publish |
| Mileage benchmark | N/A | Present | Present | Partial | **Missing** | Yes | Manual |
| Worker/executor | N/A | Present | Present | Partial | **Missing** | Partial | npm publish |
| Metrics collector | N/A | Present | Present | Partial | **Missing** | Partial | npm publish |

---

## Findings And Prioritized Backlog

### AUD-001: No CI workflow

- ID: AUD-001
- Area: CI
- Severity: P1
- Evidence: No `.github/workflows/` directory, no CI config of any kind
- Impact: No automated gate for PRs; regressions can land undetected
- Recommended fix: Add `.github/workflows/ci.yml` with `npm ci && npm run lint && npm run test`
- Acceptance criteria: PRs trigger CI; build+lint+test must pass on all PRs

### AUD-002: 9 public exports have no unit tests

- ID: AUD-002
- Area: Test
- Severity: P1
- Evidence: `QueueSink`, `MCAdapter`, `MCBridge`, `WorkerExecutor`, `MetricsCollectorImpl`, `OllamaDirectExecutor`, `GraphJobTracker`, `MC_TERMINAL_STATES`, `JobsAlgorithmImpl` have no `test/*.test.ts` file
- Impact: Integration paths can break silently; refactoring safety is low
- Recommended fix: Add unit tests for each uncovered export, prioritizing `MCAdapter` and `JobsAlgorithmImpl`
- Acceptance criteria: Every public export has at least one unit test

### AUD-003: MCAdapter polls jobs directory with fragile file scanning

- ID: AUD-003
- Area: Data/API
- Severity: P2
- Evidence: `src/integration/mc/mc-adapter.ts:207-240` — `pollJobStatus()` reads `fs.readdirSync(jobsDir)` and parses marker filenames
- Impact: Breaks if MC changes marker naming; Windows `\r\n` in filenames; race conditions with daemon
- Recommended fix: Read `status.json` directly instead of scanning marker files; use MC's `mc job wait` or watch status.json with chokidar
- Acceptance criteria: MCAdapter reads job state from `status.json`, not from marker filenames

### AUD-004: Windows JobLock .lock file cleanup fails with PermissionError

- ID: AUD-004
- Area: System
- Severity: P2
- Evidence: `watcher.py` line 117 — `with jf.JobLock(job_id):` fails to `unlink` on Windows when another process holds the file; observed in `20260612T045029Z_b43a16` job
- Impact: Occasional job ingest failures on Windows; daemon continues but the specific job is rejected
- Recommended fix: Use `contextlib.suppress` or try/except around `.lock` unlink in `jobfile.py`; Windows file locks are advisory and the lock file is just a sentinel
- Acceptance criteria: Job ingest succeeds on Windows even when .lock file is briefly held by another process

### AUD-005: Mileage benchmark backlog creation is not idempotent

- ID: AUD-005
- Area: Product
- Severity: P2
- Evidence: `examples/mileage-benchmark/mileage-benchmark.ts:292-312` — `ensureBenchmarkBacklog()` creates a new epic every run without checking if one already exists by title
- Impact: Accumulates orphaned backlog entries in MC; `mc epic list` shows duplicates
- Recommended fix: Check for existing epic by title before creating; reuse existing epic/feature/story
- Acceptance criteria: Re-running the benchmark does not create duplicate backlog entries

### AUD-006: No integration/e2e test in automated suite

- ID: AUD-006
- Area: Test
- Severity: P2
- Evidence: `test:ollama` script exists but is not run by `npm test`; mileage benchmark is manual
- Impact: MC/Ollama integration can break without detection
- Recommended fix: Add `test:e2e` script that runs the Ollama test harness (skipped if Ollama not available)
- Acceptance criteria: `npm run test:e2e` passes when Ollama is running locally

### AUD-007: GraphJobTracker lacks test for all-or-nothing failure propagation

- ID: AUD-007
- Area: Test
- Severity: P2
- Evidence: `graph-engine.test.ts` tests graph execution but `GraphJobTracker` has no dedicated test
- Impact: The "entire graph dies on any node failure" contract is not directly verified
- Recommended fix: Add `test/graph-job-tracker.test.ts` with failure propagation tests
- Acceptance criteria: Test confirms graph failure on single node error; no silent errors

### AUD-008: No TypeScript strict mode or coverage config

- ID: AUD-008
- Area: Build
- Severity: P3
- Evidence: `tsconfig.json` does not set `strict: true`; no `vitest` coverage config
- Impact: Loose type checking allows implicit any; no coverage metrics to guide test improvements
- Recommended fix: Enable `strict: true` in tsconfig; add coverage thresholds to vitest config
- Acceptance criteria: `tsc --noEmit` passes with strict mode; coverage report generated

### AUD-009: Examples reference hardcoded paths

- ID: AUD-009
- Area: Docs
- Severity: P3
- Evidence: `examples/mileage-benchmark/mileage-benchmark.ts:635` defaults to `C:\Users\Bryan\Source\...`; `start-daemon.ps1` has hardcoded `mc_root`
- Impact: Examples won't work for other developers without modification
- Recommended fix: Use `process.env.MC_ROOT` or resolve from `mc list-projects` output; document env var overrides
- Acceptance criteria: Examples work with env vars and no hardcoded paths

### AUD-010: No git remote configured

- ID: AUD-010
- Area: Release
- Severity: P3
- Evidence: `git remote -v` returns empty; package.json references `github.com/TheIntentNetwork/jobs-algo`
- Impact: Cannot push or publish from this repo
- Recommended fix: `git remote add origin https://github.com/TheIntentNetwork/jobs-algo.git`
- Acceptance criteria: `git push origin master` succeeds

---

## Blocked Or Deferred Checks

| Check | Command | Reason blocked | Required prerequisite | Confidence impact |
|-------|---------|----------------|---------------------|-------------------|
| E2E MC+Ollama test in CI | `npm run test:ollama` | Requires running Ollama daemon (not available in CI) | Ollama service in CI or mock MC adapter | Medium — real Ollama inference verified manually |
| MC TUI visual inspection | `mc tui` | Requires interactive terminal | Terminal access in CI | Low — TUI is MC's responsibility |
| Coverage report | `vitest --coverage` | No coverage config in vitest | Add coverage config | Medium — test gaps identified by import analysis |
| Package publish dry-run | `npm publish --dry-run` | No git remote configured | AUD-010 fix | Low — build and prepublishOnly pass |

---

## Assumptions

- MC daemon is running with `MC_REGISTER_OLLAMA=1` and `MC_AGENT_CMD` set when running the mileage benchmark
- Ollama is available at `http://localhost:11434` with `qwen2.5:0.5b` model
- The Windows `OLLAMA_HOST=0.0.0.0:11434` env var is normalized by the MC agent script fix (commit dd9d258)
- The MC watcher guard fix (commit 7ad95ed) prevents the `_reject_in_scope` race condition on Windows
- Integration tests require live MC daemon and Ollama — these are not expected to run in CI
