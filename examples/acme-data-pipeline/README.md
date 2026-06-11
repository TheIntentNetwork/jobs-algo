# Acme Data Pipeline

Example project demonstrating `@intent-network/jobs-algo` integration with
Mission Control and local Ollama.

## Structure

```
acme-data-pipeline/
  .mc/
    integration.yaml       # MC Integration Kit manifest
    agents/
      ollama-local.yaml     # Ollama agent definition
    job-types/
      etl-validate.yaml     # ETL validation job type
    workflows/
      etl-pipeline.yaml     # DAG workflow: validate → transform → check
  src/
    index.ts                # Example integration script
  tests/
    signatures.test.ts      # Signature determinism tests
  run-ollama-e2e.ps1        # End-to-end Ollama test runner
```

## Quick Start

### Direct mode (no MC dependency)

```powershell
# From the jobs-algo repo root
npx tsx examples/acme-data-pipeline/src/index.ts
```

### End-to-end Ollama test

```powershell
# From the jobs-algo repo root
.\examples\acme-data-pipeline\run-ollama-e2e.ps1
```

### MC integration mode

1. Start Ollama: `ollama serve`
2. Pull the model: `ollama pull qwen2.5:0.5b`
3. Set environment variables:
   ```powershell
   $env:MC_REGISTER_OLLAMA = "1"
   $env:MC_ALT_PROVIDER = "ollama-local"
   $env:OLLAMA_MODEL = "qwen2.5:0.5b"
   ```
4. Register the project in MC and start the daemon:
   ```powershell
   mc project register --id acme-data-pipeline --name "Acme Data Pipeline" --repo-path "."
   mc --project acme-data-pipeline daemon
   ```
5. Submit a job:
   ```powershell
   mc --project acme-data-pipeline submit --type '@acme/data-pipeline/etl-validate' --story-id story_42 --prompt "Validate null handling"
   ```

## Job Type: etl-validate

The `etl-validate` job type validates ETL transform output. It has:
- Interval loop mode (30s, max 3 iterations)
- `done_when` gate: no TODO/FIXME/HACK markers in workspace
- Configurable via the `.mc/job-types/etl-validate.yaml` definition

## Workflow: etl-pipeline

The workflow is a 3-stage DAG:

```
validate → transform → check
```

Any stage failure kills the entire graph (all-or-nothing).
