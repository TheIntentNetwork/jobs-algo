/**
 * Mission Control Integration Adapter
 *
 * Bridges the jobs-algo scheduling layer with intent-network-mission-control.
 * MC is a Python daemon that manages job lifecycle via file-system markers
 * and a stable-path status.json per workspace.
 *
 * This adapter:
 * 1. Translates jobs-algo enqueue → MC submit via the CLI
 * 2. Reads MC's status.json for state transitions (authoritative source)
 * 3. Collects metrics from MC's status.json files
 * 4. Feeds completion/failure back into the algorithm's profile store
 *
 * The adapter implements the MissionControlExecutor interface so the
 * JobsAlgorithmImpl can use it as a drop-in executor.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CancelToken, MetricsCollector } from '../../types/index.js';

/** Configuration for the MC adapter */
export interface MCAdapterConfig {
  /** Path to the MC project root (where .mc/ lives) */
  projectRoot: string;
  /** MC home directory (defaults to projectRoot/var) */
  mcHome?: string;
  /** Project ID registered in MC */
  projectId: string;
  /** Path to the MC CLI binary (default: 'mc') */
  mcBinary?: string;
  /** Polling interval for watching job state changes (ms, default: 1000) */
  pollIntervalMs?: number;
  /** Enable debug logging to console (default: false) */
  debug?: boolean;

  /** Job timeout in ms — if no terminal state is reached within this time, the job is failed (default: 300000 = 5 min) */
  jobTimeoutMs?: number;
}

interface MCJobStatus {
  id: string;
  state: string;
  type?: string;
  iteration?: number;
  phase?: string;
  summary?: string;
  success?: boolean;
  error?: string;
  iterOutcomeKind?: string;
  iterOutcomeSummary?: string;
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'exhausted', 'cancelled', 'rejected']);

export class MCAdapter {
  private config: {
    projectRoot: string;
    mcHome: string;
    projectId: string;
    mcBinary: string;
    pollIntervalMs: number;
    jobTimeoutMs: number;
    debug: boolean;
    workspacesDir: string;
  };
  private activeJobs = new Map<string, {
    mcJobId: string;
    metrics: MetricsCollector;
    done: (result: Buffer) => void;
    error: (err: Error) => void;
    pollTimer: ReturnType<typeof setInterval> | null;
    timeoutTimer: ReturnType<typeof setTimeout> | null;
  }>();

  constructor(config: MCAdapterConfig) {
    const mcHome = config.mcHome || path.join(config.projectRoot, 'var');
    this.config = {
      projectRoot: config.projectRoot,
      mcHome,
      projectId: config.projectId,
      mcBinary: config.mcBinary || 'mc',
      debug: config.debug ?? false,
      pollIntervalMs: config.pollIntervalMs || 1000,
      jobTimeoutMs: config.jobTimeoutMs || 300_000,
      workspacesDir: path.join(mcHome, 'projects', config.projectId, 'var', 'workspaces'),
    };
  }

  /**
   * Execute a job by submitting it to Mission Control and polling for completion.
   * Implements the MissionControlExecutor contract.
   */
  execute(
    payload: Buffer,
    metrics: MetricsCollector,
    done: (result: Buffer) => void,
    error: (err: Error) => void,
  ): CancelToken {
    let cancelled = false;
    let mcJobId: string | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    // Submit to MC via CLI
    const submitResult = this.submitToMC(payload);

    if (submitResult.kind === 'error') {
      error(new Error('MC submission failed: ' + submitResult.message));
      return { cancel: () => {} };
    }

    mcJobId = submitResult.jobId;

    metrics.startWallTimer();

    // Poll MC's status.json for state changes
    pollTimer = setInterval(() => {
      if (cancelled) return;

      const status = this.pollJobStatus(mcJobId!);
      if (!status) return;

      // Collect metrics during execution
      if (status.iteration) {
        const mem = process.memoryUsage();
        metrics.recordMem(mem.heapUsed);
      }

      if (this.config.debug) console.log('[mc-adapter] job ' + mcJobId! + ' state=' + status.state + ' iterOutcome=' + (status.iterOutcomeKind || '(none)') + ' summary=' + (status.summary || '(none)').slice(0, 40));

      if (TERMINAL_STATES.has(status.state)) {
        clearInterval(pollTimer!);
        const entry = this.activeJobs.get(mcJobId!);
        if (entry?.timeoutTimer) clearTimeout(entry.timeoutTimer);
        this.activeJobs.delete(mcJobId!);

        if (status.state === 'completed' && status.success !== false) {
          const resultPayload = Buffer.from(JSON.stringify({
            mcJobId: status.id,
            state: status.state,
            summary: status.summary || '',
            type: status.type || '',
          }), 'utf8');
          done(resultPayload);
        } else if (status.state === 'exhausted') {
          // Exhausted jobs have success=false but may have real agent output.
          // Treat as success if: (1) iter_done, or (2) any summary text.
          // MC marks single-iteration jobs as exhausted when done_where is empty,
          // even though the agent completed successfully.
          if (status.iterOutcomeKind === 'iter_done' || (status.summary && status.summary.trim().length > 0)) {
            const resultPayload = Buffer.from(JSON.stringify({
              mcJobId: status.id,
              state: status.state,
              summary: status.summary || status.iterOutcomeSummary || '',
              type: status.type || '',
            }), 'utf8');
            done(resultPayload);
          } else {
            const errMsg = status.error || status.summary || 'Job ' + status.state;
            error(new Error('MC job ' + mcJobId + ': ' + errMsg));
          }
        } else {
          const errMsg = status.error || status.summary || 'Job ' + status.state;
          error(new Error('MC job ' + mcJobId + ': ' + errMsg));
        }
      }
    }, this.config.pollIntervalMs);

    this.activeJobs.set(mcJobId, {
      mcJobId,
      metrics,
      done,
      error,
      pollTimer,
      timeoutTimer: null,
    });

    // Enforce a maximum wall-clock time for this job
    const entry = this.activeJobs.get(mcJobId)!;
    entry.timeoutTimer = setTimeout(() => {
      if (cancelled) return;
      clearInterval(pollTimer!);
      this.activeJobs.delete(mcJobId!);
      this.cancelMCJob(mcJobId!);
      error(new Error('MC job ' + mcJobId + ': timed out after ' + String(this.config.jobTimeoutMs) + 'ms'));
    }, this.config.jobTimeoutMs);

    return {
      cancel: () => {
        cancelled = true;
        if (pollTimer) clearInterval(pollTimer);
        const entry = mcJobId ? this.activeJobs.get(mcJobId) : undefined;
        if (entry?.timeoutTimer) clearTimeout(entry.timeoutTimer);
        if (mcJobId) {
          this.cancelMCJob(mcJobId);
          this.activeJobs.delete(mcJobId);
        }
      },
    };
  }

  /** Submit a job spec to Mission Control via CLI */
  private submitToMC(payload: Buffer): { kind: 'ok'; jobId: string } | { kind: 'error'; message: string } {
    try {
      const spec = JSON.parse(payload.toString('utf8'));
      const type = spec.type || spec.job_type;
      if (!type) {
        return { kind: 'error', message: 'payload missing "type" field for MC submission' };
      }

      const args: string[] = [
        '--project', this.config.projectId,
        'submit',
        '--type', type,
      ];

      if (spec.story_id) args.push('--story-id', spec.story_id);
      if (spec.feature_id) args.push('--feature-id', spec.feature_id);
      if (spec.epic_id) args.push('--epic-id', spec.epic_id);
      if (spec.chain_id) args.push('--chain-id', spec.chain_id);
      if (spec.prompt) args.push('--prompt', spec.prompt);

      const result = this.runSync(this.config.mcBinary, args);
      if (result.code !== 0) {
        return { kind: 'error', message: result.stderr || 'mc submit exited non-zero' };
      }

      const jobId = result.stdout.trim();
      if (!jobId) {
        return { kind: 'error', message: 'mc submit returned empty job ID' };
      }

      return { kind: 'ok', jobId };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read MC's status.json directly for a job's current state */
  private pollJobStatus(jobId: string): MCJobStatus | null {
    const statusPath = path.join(this.config.workspacesDir, jobId, 'status.json');

    let raw: string;
    try {
      raw = fs.readFileSync(statusPath, 'utf8');
    } catch {
      // status.json doesn't exist yet — job not ingested by MC
      return null;
    }

    let details: Record<string, unknown>;
    try {
      details = JSON.parse(raw);
    } catch {
      // Partial/corrupt read — try again next poll
      return null;
    }

    const spec = (details as Record<string, Record<string, unknown>>).spec || {};
    const status = (details as Record<string, Record<string, unknown>>).status || {};
    const result = (details as Record<string, Record<string, unknown>>).result || {};

    const iterOutcome = (status as Record<string, Record<string, string>>).iter_outcome;
    const state = typeof details.state === 'string' ? details.state : 'unknown';

    return {
      id: jobId,
      state,
      type: (spec as Record<string, string>).type,
      iteration: typeof status.iteration === 'number' ? status.iteration : undefined,
      phase: typeof status.phase === 'string' ? status.phase : undefined,
      summary: typeof result.summary === 'string' ? result.summary
        : (typeof (status as Record<string, string>).last_summary === 'string'
          ? (status as Record<string, string>).last_summary : undefined),
      success: typeof result.success === 'boolean' ? result.success : undefined,
      error: typeof details.error === 'string' ? details.error : undefined,
      iterOutcomeKind: typeof iterOutcome?.kind === 'string' ? iterOutcome.kind : undefined,
      iterOutcomeSummary: typeof iterOutcome?.summary === 'string' ? iterOutcome.summary : undefined,
    };
  }

  /** Cancel a running MC job */
  private cancelMCJob(jobId: string): void {
    try {
      this.runSync(this.config.mcBinary, ['--project', this.config.projectId, 'cancel', jobId]);
    } catch { /* best effort */ }
  }

  /** Run a command synchronously and capture output */
  private runSync(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
    try {
      const result = spawnSync(cmd, args, {
        cwd: this.config.projectRoot,
        env: {
          ...process.env,
          MC_PROJECT: this.config.projectId,
          MC_HOME: this.config.mcHome,
        },
        timeout: 30_000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    } catch (err) {
      return { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Shutdown: cancel all active jobs, clear timers, and resolve in-flight callbacks */
  shutdown(): void {
    for (const [jobId, entry] of this.activeJobs) {
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      try { this.cancelMCJob(jobId); } catch { /* best effort */ }
      // Resolve in-flight callbacks so the algorithm can release slots
      entry.error(new Error('MCAdapter shutdown: job ' + jobId + ' cancelled'));
    }
    this.activeJobs.clear();
  }
}

