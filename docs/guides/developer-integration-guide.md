# Developer Integration Guide: jobs-algo + Mission Control

This guide walks through integrating @intent-network/jobs-algo with
intent-network-mission-control for end-to-end job scheduling, execution,
and monitoring with local Ollama inference.

## Prerequisites

- Node.js >= 18.0.0
- Python >= 3.11
- Ollama running locally with at least one model pulled
- intent-network-mission-control installed (pip install -e .)
- A working MC project registration

## Step-by-Step Setup

### 1. Install Ollama and pull a model

``powershell
# Install Ollama from https://ollama.com
ollama pull qwen2.5:0.5b
``

### 2. Clone and install jobs-algo

``powershell
cd C:\Users\Bryan\Documents
git clone https://github.com/TheIntentNetwork/jobs-algo.git
cd jobs-algo
npm install
npm run build
npm test
``

### 3. Clone and install intent-network-mission-control

``powershell
cd C:\Users\Bryan\Source
git clone https://github.com/TheIntentNetwork/intent-network-mission-control.git
cd intent-network-mission-control
pip install -e .
``

### 4. Register your project with MC

Add your project to config/projects.yaml in the MC repo:

``yaml
- project_id: my-project
  name: My Project
  repo_path: C:\path\to\my-project
  allowed_write_paths:
    - src/
    - tests/
    - .mc/
  forbidden_paths:
    - .git/
  validation_commands:
    - id: tests
      description: Run test suite
      cwd: repo
      command: npm test
``

### 5. Create .mc/ integration files in your project

Create .mc/integration.yaml:

``yaml
version: 1
package: "@my-org/my-project"
domain: my-domain
subdomain: my-subdomain

job_types:
  - path: "job-types/*.yaml"
workflows:
  - path: "workflows/*.yaml"
agents:
  - path: "agents/*.yaml"

providers:
  allowed: [local-process]
  default: local-process

llm_providers:
  allowed: [ollama-local]
  default: ollama-local
``

Create .mc/agents/ollama-local.yaml:

``yaml
id: ollama-local
role: general-purpose
model: ollama-local
capabilities:
  - implement
  - validate
  - research
supported_domains:
  - my-domain
launch: 'python "{mc_root}/examples/providers/mc_alt_provider_agent.py"'
prompt_template: |
  You are a coding agent backed by local Ollama.
  Read PROMPT.txt in the workspace. Edit only under allowed_write_paths.
  Report progress with mc report; end the iteration with mc iter-done.
  Env: MC_ALT_PROVIDER=ollama-local, OLLAMA_MODEL=qwen2.5:0.5b.
``

### 6. Start the MC daemon

``powershell
=1
="ollama-local"
="qwen2.5:0.5b"
='python {mc_root}/examples/providers/mc_alt_provider_agent.py'
mc --project my-project daemon
``

### 7. Run the mileage benchmark (in a separate terminal)

``powershell
cd C:\Users\Bryan\Documents\jobs-algo
npx tsx examples/mileage-benchmark/mileage-benchmark.ts
``

### 8. Run the IPM bridge demo (in a separate terminal)

``powershell
cd C:\Users\Bryan\Documents\jobs-algo
="intent-network"
npx tsx examples/ipm-bridge/ipm-bridge-demo.ts
``

## Architecture

```
jobs-algo (TypeScript)
  |
  |-- JobsAlgorithmImpl (scheduler + bin-packing + EWMA profiles)
  |     |
  |     +-- MCAdapter (submits jobs to mc CLI, polls status.json)
  |     |     |
  |     |     +-- mc submit (CLI)
  |     |           |
  |     |           +-- mc daemon (Python)
  |     |                 |
  |     |                 +-- mc_alt_provider_agent.py
  |     |                       |
  |     |                       +-- Ollama HTTP API (localhost:11434)
  |     |
  |     +-- EventBus (push/expire events filtered by signature)
  |     +-- FileCache (file-based result + profile cache)
  |     +-- GraphEngine (DAG execution with all-or-nothing failure)
  |
  +-- QueueSink (frontend cache layer, signature-based routing)
```

## Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| MC_PROJECT_ROOT | C:\Users\Bryan\Source\intent-network-mission-control | Path to MC repo |
| MC_PROJECT_ID | mileage-benchmark | MC project ID registered in projects.yaml |
| MC_REGISTER_OLLAMA | (unset) | Set to 1 to auto-register Ollama LLM providers |
| MC_ALT_PROVIDER | ollama-local | Backend for mc_alt_provider_agent.py |
| OLLAMA_MODEL | llama3.2 | Ollama model to use |
| OLLAMA_HOST | http://localhost:11434 | Ollama API endpoint |

## Monitoring

- **MC TUI**: mc tui — live job board showing queued, running, and completed jobs
- **MC daemon logs**: daemon-stdout.log and daemon-stderr.log in the MC project var directory
- **jobs-algo reports**: Saved to .cache/mileage/ and .cache/ipm-bridge/

## Integration Checklist

- [ ] Ollama installed and model pulled
- [ ] MC installed and project registered in config/projects.yaml
- [ ] .mc/integration.yaml created in target project
- [ ] .mc/agents/ollama-local.yaml created
- [ ] .mc/job-types/*.yaml created for your domain
- [ ] MC daemon started with MC_REGISTER_OLLAMA=1
- [ ] MC TUI running in a separate terminal
- [ ] Environment variables set (MC_PROJECT_ROOT, MC_PROJECT_ID, OLLAMA_MODEL)
- [ ] Benchmark or bridge script executed
- [ ] Results reviewed in MC TUI and saved reports
