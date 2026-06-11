/**
 * Mission Control Integration Adapter
 *
 * Bridges the jobs-algo scheduling layer with intent-network-mission-control.
 * MC is a Python daemon that manages job lifecycle via file-system markers:
 *   <id>.job → <id>.queued.job → <id>.running.job → <id>.completed.job | <id>.failed.job
 *
 * This adapter:
 * 1. Translates jobs-algo `enqueue` → MC `submission.drop()` via the MCP server
 * 2. Watches MC's job spool directory for state transitions (file markers)
 * 3. Collects metrics from MC's status.json files
 * 4. Feeds completion/failure back into the algorithm's profile store
 *
 * The adapter implements the MissionControlExecutor interface so the
 * JobsAlgorithmImpl can use it as a drop-in executor.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
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
  /** Path to the MC MCP server entry (default: 'mc-mcp') */
  mcpBinary?: string;
  /** Polling interval for watching job state changes (ms, default: 1000) */
  pollIntervalMs?: number;
  /** Jobs directory override (defaults to mcHome/projects/<projectId>/var/jobs/) */
  jobsDir?: string;
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
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'exhausted', 'cancelled', 'rejected']);

export class MCAdapter {
  private config: Required<MCAdapterConfig>;
  private activeJobs = new Map<string, {
    mcJobId: string;
    metrics: MetricsCollector;
    done: (result: Buffer) => void;
    error: (err: Error) => void;
    pollTimer: ReturnType<typeof setInterval> | null;
    process?: ChildProcess;
  }>();

  constructor(config: MCAdapterConfig) {
    this.config = {
      projectRoot: config.projectRoot,
      mcHome: config.mcHome || path.join(config.projectRoot, 'var'),
      projectId: config.projectId,
      mcBinary: config.mcBinary || 'mc',
      mcpBinary: config.mcpBinary || 'mc-mcp',
      pollIntervalMs: config.pollIntervalMs || 1000,
      jobsDir: config.jobsDir || '',
    };

    if (!this.config.jobsDir) {
      this.config.jobsDir = path.join(
        this.config.mcHome,
        'projects',
        this.config.projectId,
        'var',
        'jobs',
      );
    }
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

    // Poll MC's job spool for state changes
    pollTimer = setInterval(() => {
      if (cancelled) return;

      const status = this.pollJobStatus(mcJobId!);
      if (!status) return;

      // Collect metrics during execution
      if (status.iteration) {
        // MC doesn't give us direct CPU/memory, but we can collect what's available
        const mem = process.memoryUsage();
        metrics.recordMem(mem.heapUsed);
      }

      if (TERMINAL_STATES.has(status.state)) {
        clearInterval(pollTimer!);
        this.activeJobs.delete(mcJobId!);

        if (status.state === 'completed' && status.success !== false) {
          const resultPayload = Buffer.from(JSON.stringify({
            mcJobId: status.id,
            state: status.state,
            summary: status.summary || '',
            type: status.type || '',
          }), 'utf8');
          done(resultPayload);
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
    });

    return {
      cancel: () => {
        cancelled = true;
        if (pollTimer) clearInterval(pollTimer);
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

      // Use mc CLI to submit the job
      const args: string[] = [
        '--project', this.config.projectId,
        'submit',
        '--type', type,
      ];

      if (spec.story_id) args.push('--story-id', spec.story_id);
      if (spec.feature_id) args.push('--feature-id', spec.feature_id);
      if (spec.epic_id) args.push('--epic-id', spec.epic_id);
      if (spec.chain_id) args.push('--chain-id', spec.chain_id);

      const result = this.runSync(this.config.mcBinary, args);
      if (result.code !== 0) {
        return { kind: 'error', message: result.stderr || 'mc submit exited non-zero' };
      }

      // MC CLI returns the job ID on stdout
      const jobId = result.stdout.trim();
      if (!jobId) {
        return { kind: 'error', message: 'mc submit returned empty job ID' };
      }

      return { kind: 'ok', jobId };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Poll MC's job spool directory for a job's current state */
  private pollJobStatus(jobId: string): MCJobStatus | null {
    const jobsDir = this.config.jobsDir;

    // Scan for marker files matching this job ID
    try {
      for (const entry of fs.readdirSync(jobsDir)) {
        if (!entry.endsWith('.job')) continue;
        // Parse: <jobId>.<state>.job or <jobId>.job (new)
        const dotParts = entry.replace('.job', '').split('.');
        const id = dotParts[0];
        const state = dotParts.length > 1 ? dotParts[1] : 'new';

        if (id === jobId) {
          // Read status.json for details
          const statusPath = path.join(this.config.mcHome, 'projects', this.config.projectId, 'var', 'workspaces', jobId, 'status.json');
          let details: Record<string, unknown> = {};
          try {
            if (fs.existsSync(statusPath)) {
              details = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            }
          } catch { /* partial read is fine */ }

          const spec = (details as Record<string, Record<string, unknown>>).spec || {};
          const status = (details as Record<string, Record<string, unknown>>).status || {};
          const result = (details as Record<string, Record<string, unknown>>).result || {};

          return {
            id: jobId,
            state,
            type: (spec as Record<string, string>).type,
            iteration: typeof status.iteration === 'number' ? status.iteration : undefined,
            phase: typeof status.phase === 'string' ? status.phase : undefined,
            summary: typeof result.summary === 'string' ? result.summary : (typeof (status as Record<string, string>).last_summary === 'string' ? (status as Record<string, string>).last_summary : undefined),
            success: typeof result.success === 'boolean' ? result.success : undefined,
            error: typeof details.error === 'string' ? details.error : undefined,
          };
        }
      }
    } catch { /* directory not ready yet */ }

    return null;
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
      const result = spawnSyncOrThrow(cmd, args, {
        cwd: this.config.projectRoot,
        env: {
          ...process.env,
          MC_PROJECT: this.config.projectId,
          MC_HOME: this.config.mcHome,
        },
        timeout: 30_000,
      });
      return result;
    } catch (err) {
      return { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Shutdown: cancel all active jobs and clear timers */
  shutdown(): void {
    for (const [jobId, entry] of this.activeJobs) {
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      try { this.cancelMCJob(jobId); } catch { /* best effort */ }
    }
    this.activeJobs.clear();
  }
}

/** Synchronous spawn with captured output */
function spawnSyncOrThrow(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number },
): { code: number; stdout: string; stderr: string } {
  // Use Node's execSync as a simpler alternative
  const { execSync } = require('node:child_process');
  const envStr = Object.entries(opts.env || {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => k + '=' + '"' + v + '"')
    .join(' ');

  try {
    const stdout = execSync(
      envStr + ' ' + cmd + ' ' + args.join(' '),
      {
        cwd: opts.cwd,
        timeout: opts.timeout,
        encoding: 'utf8',
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { code: 0, stdout: stdout || '', stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status || 1,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
    };
  }
}