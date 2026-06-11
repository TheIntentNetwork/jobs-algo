/**
 * MC-specific type definitions for the integration adapter.
 *
 * These types model the data shapes Mission Control uses:
 * - Job markers (filename conventions)
 * - Job specs (submission format)
 * - Chain definitions (DAG workflows)
 * - Job type definitions (YAML schema)
 */

// ── Job Marker States ──
// MC uses filename markers for lifecycle: <id>.<state>.job

export type MCJobState = 'new' | 'queued' | 'running' | 'completed' | 'failed' | 'exhausted' | 'cancelled' | 'rejected';

export const MC_TERMINAL_STATES: ReadonlySet<MCJobState> = new Set([
  'completed', 'failed', 'exhausted', 'cancelled', 'rejected',
]);

// ── Job Spec (submission format) ──

export interface MCJobSpec {
  type: string;
  story_id?: string;
  feature_id?: string;
  epic_id?: string;
  chain_id?: string;
  stage_id?: string;
  item_key?: string;
  prompt?: string;
  prompt_template?: string;
  project_id?: string;
  provider_policy?: Record<string, unknown>;
}

// ── MC Job Type Definition (from YAML) ──

export interface MCJobTypeDefinition {
  type: string;
  description?: string;
  domain?: string;
  context?: {
    references?: string[];
    skills?: string[];
    upstream_artifacts?: string[];
  };
  loop?: {
    mode: string;
    interval_sec?: number;
    max_iterations?: number;
    iteration_timeout_sec?: number;
    overall_timeout_sec?: number;
    done_when?: Array<{ gate: string; params?: Record<string, unknown> }>;
    on_max_reached?: string;
    carry_context?: boolean;
  };
  prompt_template?: string;
  required_capability?: string;
  provider_policy?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

// ── Chain / Workflow ──

export interface MCStage {
  id: string;
  primitive: string;
  needs?: string[];
  inputs?: Record<string, string>;
  agent?: string;
  skills?: string | string[];
  fan_out?: { over: string; key: string } | null;
  join_at?: string | null;
}

export interface MCWorkflow {
  stages: MCStage[];
}

export interface MCChain {
  chain_id: string;
  project_id: string;
  domain: string;
  subdomain?: string;
  workflow: MCWorkflow;
  shared_context_id?: string;
  created_at?: string;
}

// ── Integration Kit Manifest ──

export interface MCIntegrationManifest {
  version: number;
  package: string;
  domain: string;
  subdomain?: string;
  job_types?: Array<{ path: string }>;
  workflows?: Array<{ path: string }>;
  agents?: Array<{ path: string }>;
  skills?: Array<{ path: string }>;
  providers?: { allowed?: string[]; default?: string };
  llm_providers?: { allowed?: string[]; default?: string };
  validation?: Array<{ id: string; command: string; cwd?: string; description?: string }>;
}

// ── MC Project Context ──

export interface MCProjectContext {
  project_id: string;
  name?: string;
  repo_path: string;
  default_branch?: string;
  validation_commands?: Array<{ id: string; command: string }>;
}