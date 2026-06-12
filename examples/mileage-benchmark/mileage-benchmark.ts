/**
 * Mileage Benchmark — real Ollama inference through MC.
 *
 * Architecture:
 *   mileage-benchmark.ts  →  JobsAlgorithmImpl  →  MCAdapter  →  mc submit
 *                                                                →  mc daemon
 *                                                                →  ollama-local agent
 *                                                                →  Ollama HTTP API
 *
 * Run alongside:
 *   Terminal 1:  mc daemon                         (or mc --project mileage-benchmark daemon)
 *   Terminal 2:  mc tui                             (live job board)
 *   Terminal 3:  npx tsx examples/mileage-benchmark/mileage-benchmark.ts  (this benchmark)
 *
 * The MC TUI shows live job state updates as the benchmark runs.
 * This script streams its own telemetry (slot state, profiles, throughput).
 */

import { JobsAlgorithmImpl } from '../../src/integration/jobs-algorithm.js';
import { MCAdapter } from '../../src/integration/mc/mc-adapter.js';
import { computeSignature } from '../../src/algorithm/signature.js';
import type {
  AlgorithmConfig,
  AlgorithmEvent,
  Signature,
  JobId,
  Slot,
} from '../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../src/types/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ── Prompt definitions (real work, varying complexity) ──

export interface PromptDef {
  name: string;
  type: string;
  entity: string;
  argSchema: Record<string, string>;
  prompt: string;
  cacheExpiryMs: number;
  refreshRateMs: number;
}

export const PROMPTS: PromptDef[] = [
  // ── Fast (1 sentence answers) ──
  {
    name: 'fact-quick',
    type: 'fact', entity: 'query',
    argSchema: { q: 'string' },
    prompt: 'What is the time complexity of quicksort? Answer in one sentence.',
    cacheExpiryMs: 10_000, refreshRateMs: 3_000,
  },
  {
    name: 'fact-dag',
    type: 'fact', entity: 'query',
    argSchema: { q: 'string' },
    prompt: 'What is a DAG in job scheduling? Answer in one sentence.',
    cacheExpiryMs: 10_000, refreshRateMs: 3_000,
  },
  {
    name: 'fact-cache',
    type: 'fact', entity: 'query',
    argSchema: { q: 'string' },
    prompt: 'What is cache invalidation? Answer in one sentence.',
    cacheExpiryMs: 10_000, refreshRateMs: 3_000,
  },
  // ── Medium (2-3 sentences) ──
  {
    name: 'explain-ewma',
    type: 'explain', entity: 'concept',
    argSchema: { topic: 'string' },
    prompt: 'Explain exponentially weighted moving average in 2-3 sentences.',
    cacheExpiryMs: 30_000, refreshRateMs: 10_000,
  },
  {
    name: 'explain-binpack',
    type: 'explain', entity: 'concept',
    argSchema: { topic: 'string' },
    prompt: 'Explain the bin packing problem and why it is NP-hard in 2-3 sentences.',
    cacheExpiryMs: 30_000, refreshRateMs: 10_000,
  },
  {
    name: 'explain-toposort',
    type: 'explain', entity: 'concept',
    argSchema: { topic: 'string' },
    prompt: 'Explain topological sort and its use in task scheduling in 2-3 sentences.',
    cacheExpiryMs: 30_000, refreshRateMs: 10_000,
  },
  // ── Longer (3-5 sentences) ──
  {
    name: 'summarize-scheduling',
    type: 'summarize', entity: 'document',
    argSchema: { topic: 'string' },
    prompt: 'Summarize why job scheduling algorithms need to consider both urgency and resource costs in 3-5 sentences.',
    cacheExpiryMs: 60_000, refreshRateMs: 15_000,
  },
  {
    name: 'summarize-profiles',
    type: 'summarize', entity: 'document',
    argSchema: { topic: 'string' },
    prompt: 'Summarize how learning resource profiles from historical runs improves scheduling decisions in 3-5 sentences.',
    cacheExpiryMs: 60_000, refreshRateMs: 15_000,
  },
  // ── Urgent alerts (short expiry — must run first) ──
  {
    name: 'alert-urgent',
    type: 'alert', entity: 'system',
    argSchema: { severity: 'string' },
    prompt: 'A job queue is backing up. Suggest one immediate action in one sentence.',
    cacheExpiryMs: 5_000, refreshRateMs: 1_000,
  },
  {
    name: 'alert-overbudget',
    type: 'alert', entity: 'system',
    argSchema: { severity: 'string' },
    prompt: 'A worker slot exceeded its memory budget. What should the scheduler do? One sentence.',
    cacheExpiryMs: 5_000, refreshRateMs: 1_000,
  },
];

function promptSignature(p: PromptDef): Signature {
  return computeSignature({ type: p.type, entity: p.entity, argSchema: p.argSchema });
}

// ── Scenario definitions ──

export interface MileageScenario {
  id: string;
  label: string;
  config: Partial<AlgorithmConfig>;
  prompts: PromptDef[];
  runs: number;
  preWarm: boolean;
}

const GENEROUS: Partial<AlgorithmConfig> = {
  slotBudgetCpuTicks: 1_000_000,
  slotBudgetMemBytes: 512 * 1024 * 1024,
};

const TIGHT: Partial<AlgorithmConfig> = {
  slotBudgetCpuTicks: 100_000,
  slotBudgetMemBytes: 64 * 1024 * 1024,
};

export const SCENARIOS: MileageScenario[] = [
  { id: 'p1-baseline', label: '1 slot serial baseline', config: { maxParallelism: 1, ...GENEROUS }, prompts: PROMPTS, runs: 1, preWarm: false },
  { id: 'p2-parallel',  label: '2 slots parallel',       config: { maxParallelism: 2, ...GENEROUS }, prompts: PROMPTS, runs: 1, preWarm: false },
  { id: 'p4-parallel',  label: '4 slots parallel',       config: { maxParallelism: 4, ...GENEROUS }, prompts: PROMPTS, runs: 1, preWarm: false },
  { id: 'p8-parallel',  label: '8 slots parallel',       config: { maxParallelism: 8, ...GENEROUS }, prompts: PROMPTS, runs: 1, preWarm: false },
  { id: 'p4-tight', label: '4 slots tight budget', config: { maxParallelism: 4, ...TIGHT }, prompts: PROMPTS, runs: 1, preWarm: false },
  { id: 'p4-warm', label: '4 slots warm profiles', config: { maxParallelism: 4, ...GENEROUS }, prompts: PROMPTS, runs: 1, preWarm: true },
  { id: 'p4-3run', label: '4 slots 3 runs', config: { maxParallelism: 4, ...GENEROUS }, prompts: PROMPTS, runs: 3, preWarm: false },
  { id: 'p1-full', label: '1 slot full mixed baseline', config: { maxParallelism: 1, ...GENEROUS }, prompts: PROMPTS, runs: 1, preWarm: false },
];

// ── Telemetry ──

export interface JobTelemetry {
  jobId: string;
  mcJobId: string;
  name: string;
  signature: Signature;
  prompt: string;
  summary: string;
  enqueuedAt: number;
  completedAt: number;
  wallMs: number;
  slotId: number | null;
  urgency: number;
  status: 'complete' | 'failed' | 'timeout';
  error: string | null;
  runIndex: number;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioLabel: string;
  totalWallMs: number;
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
  throughputJps: number;
  avgWallMs: number;
  p50WallMs: number;
  p95WallMs: number;
  slotCount: number;
  slotUtilPct: number;
  warmSigs: number;
  coldSigs: number;
  urgencyErrors: number;
  jobs: JobTelemetry[];
  profiles: Array<{
    signature: string;
    name: string;
    sampleCount: number;
    warm: boolean;
    cpuEWMA: number;
    memEWMA: number;
    wallEWMA: number;
  }>;
}

export interface MileageReport {
  timestamp: string;
  model: string;
  mcProjectId: string;
  scenarios: ScenarioResult[];
  comparison: { headers: string[]; rows: string[][] };
}

// ── Live streaming ──

class LiveStream {
  header(label: string, jobCount: number): void {
    const ts = new Date().toISOString().slice(11, 23);
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────');
    console.log('  │ ' + label);
    console.log('  │ Jobs: ' + String(jobCount) + '   at ' + ts);
    console.log('  │ (watch MC TUI in your other terminal for the job board)');
    console.log('  ├──────────────────────────────────────────────────────────');
  }

  jobDispatch(name: string, slotId: number | null, urgency: number, idx: number, total: number, mcJobId: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const slot = slotId !== null ? 'S' + String(slotId) : '??';
    const urg = (urgency / 1000).toFixed(1);
    const mcShort = mcJobId.length > 12 ? mcJobId.slice(0, 12) : mcJobId;
    console.log('  │ [' + ts + '] ▶ ' + name.padEnd(18) + ' ' + slot + ' urg=' + urg + 's mc=' + mcShort + '  [' + String(idx) + '/' + String(total) + ']');
  }

  jobComplete(j: JobTelemetry, idx: number, total: number): void {
    const ts = new Date().toISOString().slice(11, 23);
    const icon = j.status === 'complete' ? '✓' : (j.status === 'timeout' ? '⏱' : '✗');
    const name = j.name.padEnd(18);
    const wall = String(j.wallMs).padStart(6);
    const mcShort = j.mcJobId.length > 12 ? j.mcJobId.slice(0, 12) : j.mcJobId;
    console.log('  │ [' + ts + '] ' + icon + ' ' + name + ' wall=' + wall + 'ms  mc=' + mcShort + '  [' + String(idx) + '/' + String(total) + ']');
    if (j.summary) {
      console.log('  │              → ' + j.summary.replace(/\n/g, ' ').slice(0, 80));
    }
    if (j.error) {
      console.log('  │              ! ' + j.error.slice(0, 80));
    }
  }

  slotState(slots: readonly Slot[]): void {
    const ts = new Date().toISOString().slice(11, 23);
    const parts = slots.map(s => {
      const pct = Math.min(100, Math.round((s.usedCpuTicks / (s.budgetCpuTicks || 1)) * 100));
      const bar = '░▒▓█'.charAt(Math.min(3, Math.floor(pct / 25)));
      const tag = s.overBudget ? '!' : bar;
      return 'S' + String(s.id) + ':' + tag + String(s.activeJobs.length);
    });
    console.log('  │ [' + ts + ']   slots: ' + parts.join('  '));
  }

  profileUpdate(sig: string, n: number, warm: boolean): void {
    const ts = new Date().toISOString().slice(11, 23);
    const tag = warm ? 'WARM' : 'cold';
    console.log('  │ [' + ts + ']   profile ' + sig.slice(0, 10) + '… n=' + String(n) + ' [' + tag + ']');
  }

  scenarioResult(r: ScenarioResult): void {
    console.log('  ├──────────────────────────────────────────────────────────');
    console.log('  │ DONE: ' + String(r.completedJobs) + '/' + String(r.jobCount) +
      '  wall=' + String(r.totalWallMs) + 'ms' +
      '  throughput=' + r.throughputJps.toFixed(2) + ' j/s' +
      '  warm=' + String(r.warmSigs));
    console.log('  └──────────────────────────────────────────────────────────');
  }
}

// ── MC helper: create backlog hierarchy ──

function mcCmd(args: string[], project?: string): string {
  const fullArgs = project ? ['--project', project, ...args] : args;
  // Properly quote args that contain spaces for shell execution
  const quoted = fullArgs.map(a => a.includes(' ') ? `"${a}"` : a);
  try {
    return execSync('mc ' + quoted.join(' '), {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function ensureBenchmarkBacklog(projectId: string): string {
  // Create epic → feature → story for benchmark jobs
  const epicOut = mcCmd(['epic', 'create', '--title', 'Mileage Benchmark', '--description', 'Parallel execution benchmark scenarios'], projectId);
  const epicId = epicOut.split(/\r?\n/).pop()?.trim() || '';
  if (!epicId.startsWith('epic_')) {
    // Epic already exists or create failed — find existing
    const list = mcCmd(['epic', 'list'], projectId);
    const match = list.match(/epic_\w+/);
    if (match) {
      const featOut = mcCmd(['feature', 'create', '--epic', match[0], '--title', 'Benchmark Scenarios', '--description', 'Parallel execution scenario runs'], projectId);
      const featId = featOut.split(/\r?\n/).pop()?.trim() || '';
      const storyOut = mcCmd(['story', 'create', '--feature', featId || 'feat_benchmark', '--title', 'Benchmark Run', '--description', 'Real Ollama inference jobs for mileage benchmark'], projectId);
      return storyOut.split(/\r?\n/).pop()?.trim() || '';
    }
    return '';
  }

  const featOut = mcCmd(['feature', 'create', '--epic', epicId, '--title', 'Benchmark Scenarios', '--description', 'Parallel execution scenario runs'], projectId);
  const featId = featOut.split(/\r?\n/).pop()?.trim() || '';
  const storyOut = mcCmd(['story', 'create', '--feature', featId, '--title', 'Benchmark Run', '--description', 'Real Ollama inference jobs for mileage benchmark'], projectId);
  return storyOut.split(/\r?\n/).pop()?.trim() || '';
}

// ── The runner ──

export interface MileageRunnerOpts {
  mcProjectRoot: string;
  mcProjectId: string;
  mcHome?: string;
  pollIntervalMs?: number;
  jobTimeoutMs?: number;
  outputDir?: string;
}

export class MileageRunner {
  private mcProjectRoot: string;
  private mcProjectId: string;
  private mcHome: string;
  private pollIntervalMs: number;
  private jobTimeoutMs: number;
  private outputDir: string;
  private stream = new LiveStream();
  private storyId: string = '';

  constructor(opts: MileageRunnerOpts) {
    this.mcProjectRoot = opts.mcProjectRoot;
    this.mcProjectId = opts.mcProjectId;
    this.mcHome = opts.mcHome || path.join(opts.mcProjectRoot, 'var');
    this.pollIntervalMs = opts.pollIntervalMs || 2_000;
    this.jobTimeoutMs = opts.jobTimeoutMs || 300_000;
    this.outputDir = opts.outputDir || '.cache/mileage';
  }

  async setup(): Promise<void> {
    console.log('');
    console.log('  Setting up MC backlog for benchmark...');
    this.storyId = ensureBenchmarkBacklog(this.mcProjectId);
    console.log('  Story ID: ' + this.storyId);
    console.log('  Submitting jobs to MC project: ' + this.mcProjectId);
  }

  async runScenario(scenario: MileageScenario): Promise<ScenarioResult> {
    const config: Partial<AlgorithmConfig> = {
      ...scenario.config,
      cacheDir: '.cache/mileage-' + scenario.id,
      sweepIntervalMs: 600_000,
    };

    const algo = new JobsAlgorithmImpl(config);

    const mcAdapter = new MCAdapter({
      projectRoot: this.mcProjectRoot,
      projectId: this.mcProjectId,
      mcHome: this.mcHome,
      pollIntervalMs: this.pollIntervalMs,
    });
    algo.setMissionControl(mcAdapter);

    if (scenario.preWarm) {
      console.log('  │ Pre-warming profiles (6 runs each through MC)...');
      const allSigs = [...new Set(scenario.prompts.map(p => promptSignature(p)))];
      for (const sig of allSigs) {
        const pd = scenario.prompts.find(p => promptSignature(p) === sig);
        if (!pd) continue;
        for (let i = 0; i < 6; i++) {
          const jobId = algo.enqueue(sig, Buffer.from(JSON.stringify({
            type: 'benchmark-infer',
            story_id: this.storyId,
            prompt: pd.prompt,
          }), 'utf8'), {
            cacheExpiryMs: 300_000,
            refreshRateMs: 300_000,
          });
          await new Promise<void>((resolve) => {
            let done = false;
            algo.subscribe(sig, (event: AlgorithmEvent) => {
              if (done) return;
              if ((event.type === 'job_complete' || event.type === 'job_failed') && event.jobId === jobId) {
                done = true;
                resolve();
              }
            });
            setTimeout(() => { if (!done) { done = true; resolve(); } }, this.jobTimeoutMs);
          });
        }
      }
      algo['scheduler'].clearAllRefreshTimers();
      console.log('  │ Pre-warm complete.');
    }

    const totalJobCount = scenario.prompts.length * scenario.runs;
    this.stream.header(scenario.label, totalJobCount);

    const jobs: JobTelemetry[] = [];
    const jobNames = new Map<JobId, string>();
    const jobPrompts = new Map<JobId, string>();
    const jobUrgency = new Map<JobId, number>();
    const jobRunIdx = new Map<JobId, number>();
    const jobMcIds = new Map<JobId, string>();
    const completedCount = { value: 0 };
    const startedAt = Date.now();

    const allSigs = new Set(scenario.prompts.map(p => promptSignature(p)));
    for (const sig of allSigs) {
      algo.subscribe(sig, (event: AlgorithmEvent) => {
        if (event.type === 'job_complete') {
          completedCount.value++;
          const name = jobNames.get(event.jobId) || event.signature.slice(0, 12);
          let summary = '';
          try {
            const parsed = JSON.parse(event.result.toString('utf8'));
            summary = parsed.summary || '';
          } catch { }

          const tel: JobTelemetry = {
            jobId: event.jobId,
            mcJobId: jobMcIds.get(event.jobId) || '',
            name,
            signature: event.signature,
            prompt: jobPrompts.get(event.jobId) || '',
            summary,
            enqueuedAt: startedAt,
            completedAt: Date.now(),
            wallMs: Date.now() - startedAt,
            slotId: null,
            urgency: jobUrgency.get(event.jobId) || 0,
            status: 'complete',
            error: null,
            runIndex: jobRunIdx.get(event.jobId) || 0,
          };
          jobs.push(tel);
          this.stream.jobComplete(tel, completedCount.value, totalJobCount);

          const slotMgr = algo['scheduler'].getSlotManager();
          this.stream.slotState(slotMgr.getSlots());

          const profile = algo.getProfile(event.signature);
          if (profile && profile.sampleCount > 0 && profile.sampleCount % 3 === 0) {
            this.stream.profileUpdate(event.signature, profile.sampleCount, profile.sampleCount >= 5);
          }
        } else if (event.type === 'job_failed') {
          completedCount.value++;
          const name = jobNames.get(event.jobId) || event.signature.slice(0, 12);
          const tel: JobTelemetry = {
            jobId: event.jobId,
            mcJobId: jobMcIds.get(event.jobId) || '',
            name,
            signature: event.signature,
            prompt: jobPrompts.get(event.jobId) || '',
            summary: '',
            enqueuedAt: startedAt,
            completedAt: Date.now(),
            wallMs: Date.now() - startedAt,
            slotId: null,
            urgency: jobUrgency.get(event.jobId) || 0,
            status: 'failed',
            error: event.error,
            runIndex: jobRunIdx.get(event.jobId) || 0,
          };
          jobs.push(tel);
          this.stream.jobComplete(tel, completedCount.value, totalJobCount);
        }
      });
    }

    // ── Enqueue jobs ──
    for (let run = 0; run < scenario.runs; run++) {
      if (scenario.runs > 1) {
        console.log('  │ ── Run ' + String(run + 1) + '/' + String(scenario.runs) + ' ──');
      }
      for (const pd of scenario.prompts) {
        const sig = promptSignature(pd);
        const payload = Buffer.from(JSON.stringify({
          type: 'benchmark-infer',
          story_id: this.storyId,
          prompt: pd.prompt,
        }), 'utf8');

        const jobId = algo.enqueue(sig, payload, {
          cacheExpiryMs: pd.cacheExpiryMs,
          refreshRateMs: pd.refreshRateMs,
        });

        const label = pd.name + (scenario.runs > 1 ? '-r' + String(run) : '');
        jobNames.set(jobId, label);
        jobPrompts.set(jobId, pd.prompt);
        jobUrgency.set(jobId, pd.cacheExpiryMs);
        jobRunIdx.set(jobId, run);

        this.stream.jobDispatch(label, null, pd.cacheExpiryMs, 0, totalJobCount, 'pending');
      }
    }

    // ── Wait for all jobs ──
    await new Promise<void>((resolve) => {
      const check = () => {
        if (completedCount.value >= totalJobCount) { resolve(); return; }
        setTimeout(check, 500);
      };
      setTimeout(() => resolve(), this.jobTimeoutMs * (scenario.runs + 1));
      check();
    });

    algo['scheduler'].clearAllRefreshTimers();
    const completedAt = Date.now();
    const totalWallMs = completedAt - startedAt;

    // ── Compute results ──
    const completed = jobs.filter(j => j.status === 'complete');
    const failed = jobs.filter(j => j.status !== 'complete');
    const wallTimes = completed.map(j => j.wallMs).sort((a, b) => a - b);
    const avgWall = wallTimes.length > 0 ? Math.round(wallTimes.reduce((s, w) => s + w, 0) / wallTimes.length) : 0;
    const p50 = wallTimes.length > 0 ? wallTimes[Math.floor(wallTimes.length * 0.5)] : 0;
    const p95 = wallTimes.length > 0 ? wallTimes[Math.min(wallTimes.length - 1, Math.floor(wallTimes.length * 0.95))] : 0;

    const slotMgr = algo['scheduler'].getSlotManager();
    const slots = slotMgr.getSlots();
    const slotUtil = slots.length > 0 ? slots.reduce((s, sl) => s + (sl.usedCpuTicks / (sl.budgetCpuTicks || 1)), 0) / slots.length : 0;

    const uniqueSigs = new Set(jobs.map(j => j.signature));
    let warmSigs = 0, coldSigs = 0;
    const profileSnaps: ScenarioResult['profiles'] = [];
    for (const sig of uniqueSigs) {
      const p = algo.getProfile(sig);
      if (p) {
        const isWarm = p.sampleCount >= (scenario.config.coldStartSamples || 5);
        if (isWarm) warmSigs++; else coldSigs++;
        profileSnaps.push({
          signature: sig, name: jobs.find(j => j.signature === sig)?.name || sig.slice(0, 10),
          sampleCount: p.sampleCount, warm: isWarm,
          cpuEWMA: Math.round(p.cpuTicksEWMA), memEWMA: Math.round(p.memBytesEWMA), wallEWMA: Math.round(p.wallTimeMsEWMA),
        });
      }
    }

    const byCompletion = [...jobs].sort((a, b) => a.completedAt - b.completedAt);
    let urgErrors = 0;
    for (let i = 1; i < byCompletion.length; i++) {
      if (byCompletion[i].urgency < byCompletion[i - 1].urgency - 2000) urgErrors++;
    }

    const result: ScenarioResult = {
      scenarioId: scenario.id, scenarioLabel: scenario.label, totalWallMs,
      jobCount: jobs.length, completedJobs: completed.length, failedJobs: failed.length,
      throughputJps: totalWallMs > 0 ? (jobs.length / (totalWallMs / 1000)) : 0,
      avgWallMs: avgWall, p50WallMs: p50, p95WallMs: p95,
      slotCount: slots.length, slotUtilPct: Math.round(slotUtil * 100),
      warmSigs, coldSigs, urgencyErrors: urgErrors,
      jobs, profiles: profileSnaps,
    };

    this.stream.scenarioResult(result);
    mcAdapter.shutdown();
    await algo.shutdown();
    return result;
  }

  async runAll(scenarios: MileageScenario[]): Promise<MileageReport> {
    await this.setup();

    console.log('');
    console.log('═'.repeat(70));
    console.log('  MILEAGE BENCHMARK — Real Ollama Inference through MC');
    console.log('  MC Project: ' + this.mcProjectId);
    console.log('  MC Root:    ' + this.mcProjectRoot);
    console.log('  Scenarios:  ' + String(scenarios.length));
    console.log('═'.repeat(70));

    const results: ScenarioResult[] = [];
    for (let i = 0; i < scenarios.length; i++) {
      console.log('');
      console.log('─'.repeat(70));
      console.log('  Scenario ' + String(i + 1) + '/' + String(scenarios.length));
      console.log('─'.repeat(70));
      const result = await this.runScenario(scenarios[i]);
      results.push(result);
    }

    const headers = ['Scenario', 'Wall', 'J/s', 'AvgWall', 'P95Wall', 'Slots', 'Util%', 'Warm', 'UrgErr'];
    const rows = results.map(r => [
      r.scenarioLabel.slice(0, 28).padEnd(28),
      (String(r.totalWallMs) + 'ms').padStart(9),
      r.throughputJps.toFixed(2).padStart(7),
      (String(r.avgWallMs) + 'ms').padStart(9),
      (String(r.p95WallMs) + 'ms').padStart(9),
      String(r.slotCount).padStart(5),
      (String(r.slotUtilPct) + '%').padStart(5),
      String(r.warmSigs).padStart(4),
      String(r.urgencyErrors).padStart(6),
    ]);

    const report: MileageReport = {
      timestamp: new Date().toISOString(),
      model: 'ollama-local (via MC)',
      mcProjectId: this.mcProjectId,
      scenarios: results,
      comparison: { headers, rows },
    };

    console.log('');
    console.log('═'.repeat(70));
    console.log('  COMPARISON');
    console.log('═'.repeat(70));
    console.log('');
    console.log('  ' + headers.join('  '));
    console.log('  ' + '─'.repeat(headers.reduce((s, h) => s + h.length + 2, 0)));
    for (const row of rows) {
      console.log('  ' + row.join('  '));
    }
    console.log('');

    fs.mkdirSync(this.outputDir, { recursive: true });
    const reportPath = path.join(this.outputDir, 'mileage-report-' + Date.now() + '.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('  Report saved: ' + reportPath);

    return report;
  }
}

// ── CLI entry ──

const isMain = process.argv[1]?.includes('mileage-benchmark');
if (isMain) {
  const mcProjectRoot = process.env.MC_PROJECT_ROOT || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control';
  const mcProjectId = process.env.MC_PROJECT_ID || 'mileage-benchmark';

  const runner = new MileageRunner({
    mcProjectRoot,
    mcProjectId,
    pollIntervalMs: 2000,
    jobTimeoutMs: 300_000,
  });

  runner.runAll(SCENARIOS).catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
