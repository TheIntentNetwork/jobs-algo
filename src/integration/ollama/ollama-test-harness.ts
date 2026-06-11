/**
 * Ollama Test Harness - exercises jobs-algo with a local Ollama model.
 *
 * Direct mode: calls Ollama HTTP API directly (no MC dependency).
 * MC mode: via MCAdapter -> mc daemon -> mc_alt_provider_agent.py -> Ollama.
 *
 * Usage:
 *   npx tsx src/integration/ollama/ollama-test-harness.ts
 */

import { OllamaDirectExecutor, type OllamaDirectConfig } from './ollama-executor.js';
import { computeSignature } from '../../algorithm/signature.js';
import { JobsAlgorithmImpl } from '../jobs-algorithm.js';
import type { AlgorithmEvent, JobId, GraphDefinition, Signature } from '../../types/index.js';
import fs from 'node:fs';
import path from 'node:path';

interface TestJobDef {
  name: string;
  type: string;
  entity: string;
  argSchema: Record<string, string>;
  prompt: string;
  cacheExpiryMs: number;
  refreshRateMs: number;
}

const TEST_JOBS: TestJobDef[] = [
  {
    name: 'ExplainRecursion',
    type: 'explain', entity: 'concept',
    argSchema: { topic: 'string', depth: 'string' },
    prompt: 'Explain recursion in programming in 2-3 sentences. Be concise.',
    cacheExpiryMs: 30_000, refreshRateMs: 10_000,
  },
  {
    name: 'SummarizeTopic',
    type: 'summarize', entity: 'document',
    argSchema: { topic: 'string', length: 'string' },
    prompt: 'Summarize the concept of bin packing algorithms in 2 sentences.',
    cacheExpiryMs: 60_000, refreshRateMs: 15_000,
  },
  {
    name: 'GenerateList',
    type: 'generate', entity: 'list',
    argSchema: { count: 'string', category: 'string' },
    prompt: 'List exactly 3 common data structures used in job scheduling.',
    cacheExpiryMs: 15_000, refreshRateMs: 5_000,
  },
  {
    name: 'CompareApproaches',
    type: 'compare', entity: 'analysis',
    argSchema: { topic: 'string', criteria: 'string' },
    prompt: 'Compare EWMA vs simple moving average for resource prediction in 2 sentences.',
    cacheExpiryMs: 45_000, refreshRateMs: 12_000,
  },
  {
    name: 'QuickFact',
    type: 'fact', entity: 'query',
    argSchema: { question: 'string' },
    prompt: 'What is the time complexity of topological sort? One sentence.',
    cacheExpiryMs: 10_000, refreshRateMs: 3_000,
  },
];

interface JobResult {
  jobId: string;
  name: string;
  signature: string;
  status: 'complete' | 'failed';
  wallTimeMs: number;
  result: string | null;
  error: string | null;
  tokens: { prompt: number; completion: number; total: number } | null;
  timing: { totalMs: number; loadMs: number; promptEvalMs: number; evalMs: number } | null;
  urgency: number;
}

interface ProfileResult {
  signature: string;
  name: string;
  sampleCount: number;
  warm: boolean;
  cpuTicksEWMA: number;
  memBytesEWMA: number;
  wallTimeMsEWMA: number;
  failureRateEWMA: number;
  refreshRateMs: number;
  cacheExpiryMs: number;
}

interface GraphResult {
  graphId: string;
  status: 'completed' | 'failed';
  nodeCount: number;
  wallTimeMs: number;
  error: string | null;
}

interface FullReport {
  timestamp: string;
  mode: string;
  model: string;
  ollamaBaseUrl: string;
  runs: number;
  jobs: JobResult[];
  profiles: ProfileResult[];
  graphs: GraphResult[];
  cache: { totalEntries: number; expiredEntries: number; pushedToFrontend: number; signatures: string[] };
  summary: {
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    avgWallTimeMs: number;
    totalWallTimeMs: number;
    totalTokens: number;
    warmProfiles: number;
    coldProfiles: number;
  };
}

export async function runOllamaTest(
  ollamaConfig: OllamaDirectConfig = {},
  options: { outputDir?: string; runs?: number; includeGraph?: boolean; mode?: string } = {},
): Promise<FullReport> {
  const runs = options.runs || 2;
  const outputDir = options.outputDir || '.cache/reports';
  const mode = options.mode || 'direct';
  const includeGraph = options.includeGraph !== false;
  const model = ollamaConfig.model || 'qwen2.5:0.5b';

  const algo = new JobsAlgorithmImpl({
    maxParallelism: 2,
    defaultRefreshRateMs: 5_000,
    defaultCacheExpiryMs: 30_000,
  });

  if (mode === 'direct') {
    const executor = new OllamaDirectExecutor(ollamaConfig);
    algo.setMissionControl(executor);
  }

  const jobResults: JobResult[] = [];
  const profileResults: ProfileResult[] = [];
  const graphResults: GraphResult[] = [];
  let cacheExpired = 0;
  let cachePushed = 0;
  const cacheSignatures = new Set<string>();

  const pendingJobs = new Map<JobId, {
    name: string; signature: string; enqueuedAt: number; urgency: number;
    resolve: (r: JobResult) => void;
  }>();
  const pendingGraphs = new Map<string, {
    resolve: (r: GraphResult) => void; startTime: number;
  }>();

  for (const tj of TEST_JOBS) {
    const sig = computeSignature({ type: tj.type, entity: tj.entity, argSchema: tj.argSchema });
    algo.subscribe(sig, (event: AlgorithmEvent) => {
      if (event.type === 'job_complete') {
        const p = pendingJobs.get(event.jobId);
        if (p) {
          let rd: Record<string, unknown> = {};
          try { rd = JSON.parse(event.result.toString()); } catch { /* ok */ }
          p.resolve({
            jobId: event.jobId, name: p.name, signature: event.signature, status: 'complete',
            wallTimeMs: Date.now() - p.enqueuedAt,
            result: String(rd.content || event.result.toString().slice(0, 200)),
            error: null,
            tokens: (rd.tokens as JobResult['tokens']) || null,
            timing: (rd.timing as JobResult['timing']) || null,
            urgency: p.urgency,
          });
          pendingJobs.delete(event.jobId);
        }
        cacheSignatures.add(event.signature);
      }
      if (event.type === 'job_failed') {
        const p = pendingJobs.get(event.jobId);
        if (p) {
          p.resolve({
            jobId: event.jobId, name: p.name, signature: event.signature, status: 'failed',
            wallTimeMs: Date.now() - p.enqueuedAt, result: null, error: event.error,
            tokens: null, timing: null, urgency: p.urgency,
          });
          pendingJobs.delete(event.jobId);
        }
      }
      if (event.type === 'cache_expire') cacheExpired++;
      if (event.type === 'cache_push') cachePushed++;
      if (event.type === 'graph_complete') {
        const pg = pendingGraphs.get(event.graphId);
        if (pg) {
          graphResults.push({
            graphId: event.graphId, status: 'completed', nodeCount: event.results.size,
            wallTimeMs: Date.now() - pg.startTime, error: null,
          });
          pg.resolve(graphResults[graphResults.length - 1]);
          pendingGraphs.delete(event.graphId);
        }
      }
      if (event.type === 'graph_failed') {
        const pg = pendingGraphs.get(event.graphId);
        if (pg) {
          graphResults.push({
            graphId: event.graphId, status: 'failed', nodeCount: 0,
            wallTimeMs: Date.now() - pg.startTime, error: event.error,
          });
          pg.resolve(graphResults[graphResults.length - 1]);
          pendingGraphs.delete(event.graphId);
        }
      }
    });
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('  OLLAMA TEST HARNESS  (' + mode + ' mode)');
  console.log('  Model: ' + model);
  console.log('='.repeat(60));
  console.log('');

  console.log('Phase 1: Individual jobs (' + String(runs) + ' runs x ' + String(TEST_JOBS.length) + ' signatures)');
  console.log('-'.repeat(50));

  for (let run = 1; run <= runs; run++) {
    console.log('  Run ' + String(run) + '/' + String(runs) + ':');
    for (const tj of TEST_JOBS) {
      const sig = computeSignature({ type: tj.type, entity: tj.entity, argSchema: tj.argSchema });
      const payload = Buffer.from(JSON.stringify({ prompt: tj.prompt }));
      const jr = await new Promise<JobResult>((resolve) => {
        const jobId = algo.enqueue(sig, payload, {
          cacheExpiryMs: tj.cacheExpiryMs, refreshRateMs: tj.refreshRateMs,
        });
        pendingJobs.set(jobId, {
          name: tj.name, signature: sig, enqueuedAt: Date.now(),
          urgency: tj.cacheExpiryMs, resolve,
        });
      });
      jobResults.push(jr);
      const icon = jr.status === 'complete' ? '+' : 'X';
      const wall = String(Math.round(jr.wallTimeMs)).padStart(6) + 'ms';
      const tok = jr.tokens ? ' tok=' + String(jr.tokens.total).padStart(4) : '';
      const inf = jr.timing ? ' infer=' + String(jr.timing.evalMs).padStart(5) + 'ms' : '';
      console.log('    ' + icon + ' ' + tj.name.padEnd(20) + ' ' + wall + tok + inf);
    }
  }

  if (includeGraph) {
    console.log('');
    console.log('Phase 2: Graph (DAG) execution');
    console.log('-'.repeat(50));
    const gjs = TEST_JOBS.slice(0, 3).map(tj => ({
      sig: computeSignature({ type: tj.type, entity: tj.entity, argSchema: tj.argSchema }),
      prompt: tj.prompt,
    }));
    const graphDef: GraphDefinition = {
      id: 'ollama-test-chain',
      nodes: [
        { id: 's1', signature: gjs[0].sig, payload: Buffer.from(JSON.stringify({ prompt: gjs[0].prompt })), dependsOn: [] },
        { id: 's2', signature: gjs[1].sig, payload: Buffer.from(JSON.stringify({ prompt: 'Then: ' + gjs[1].prompt })), dependsOn: ['s1'] },
        { id: 's3', signature: gjs[2].sig, payload: Buffer.from(JSON.stringify({ prompt: 'Finally: ' + gjs[2].prompt })), dependsOn: ['s2'] },
      ],
    };
    const gr = await new Promise<GraphResult>((resolve) => {
      const gid = algo.enqueueGraph(graphDef);
      pendingGraphs.set(gid, { resolve, startTime: Date.now() });
    });
    console.log('    Graph: ' + gr.status + ' nodes=' + String(gr.nodeCount) +
      ' wall=' + String(Math.round(gr.wallTimeMs)) + 'ms' +
      (gr.error ? ' err=' + gr.error.slice(0, 60) : ''));
  }

  for (const tj of TEST_JOBS) {
    const sig = computeSignature({ type: tj.type, entity: tj.entity, argSchema: tj.argSchema });
    const profile = algo.getProfile(sig);
    if (profile) {
      profileResults.push({
        signature: sig, name: tj.name, sampleCount: profile.sampleCount,
        warm: profile.sampleCount >= 5,
        cpuTicksEWMA: Math.round(profile.cpuTicksEWMA),
        memBytesEWMA: Math.round(profile.memBytesEWMA),
        wallTimeMsEWMA: Math.round(profile.wallTimeMsEWMA),
        failureRateEWMA: Math.round(profile.failureRateEWMA * 1000) / 1000,
        refreshRateMs: profile.refreshRateMs, cacheExpiryMs: profile.cacheExpiryMs,
      });
    }
  }

  const completed = jobResults.filter(j => j.status === 'complete');
  const fullReport: FullReport = {
    timestamp: new Date().toISOString(), mode, model,
    ollamaBaseUrl: ollamaConfig.baseUrl || 'http://localhost:11434',
    runs,
    jobs: jobResults, profiles: profileResults, graphs: graphResults,
    cache: { totalEntries: cacheSignatures.size, expiredEntries: cacheExpired, pushedToFrontend: cachePushed, signatures: [...cacheSignatures] },
    summary: {
      totalJobs: jobResults.length, completedJobs: completed.length,
      failedJobs: jobResults.filter(j => j.status === 'failed').length,
      avgWallTimeMs: completed.length > 0 ? Math.round(completed.reduce((s, j) => s + j.wallTimeMs, 0) / completed.length) : 0,
      totalWallTimeMs: jobResults.reduce((s, j) => s + j.wallTimeMs, 0),
      totalTokens: jobResults.reduce((s, j) => s + (j.tokens?.total || 0), 0),
      warmProfiles: profileResults.filter(p => p.warm).length,
      coldProfiles: profileResults.filter(p => !p.warm).length,
    },
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'ollama-test-report-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(fullReport, null, 2), 'utf8');

  console.log('');
  console.log('='.repeat(60));
  console.log('  FULL REPORT');
  console.log('='.repeat(60));
  console.log('');
  console.log('  Model:         ' + fullReport.model);
  console.log('  Mode:          ' + fullReport.mode);
  console.log('  Timestamp:     ' + fullReport.timestamp);
  console.log('  Report file:   ' + reportPath);
  console.log('');
  console.log('  --- Summary ---');
  console.log('  Total jobs:    ' + String(fullReport.summary.totalJobs));
  console.log('  Completed:     ' + String(fullReport.summary.completedJobs));
  console.log('  Failed:        ' + String(fullReport.summary.failedJobs));
  console.log('  Avg wall time: ' + String(fullReport.summary.avgWallTimeMs) + 'ms');
  console.log('  Total wall:   ' + String(fullReport.summary.totalWallTimeMs) + 'ms');
  console.log('  Total tokens:  ' + String(fullReport.summary.totalTokens));
  console.log('  Warm profiles: ' + String(fullReport.summary.warmProfiles) + '/' + String(fullReport.summary.warmProfiles + fullReport.summary.coldProfiles));
  console.log('');
  console.log('  --- Job Details ---');
  for (const j of jobResults) {
    const icon = j.status === 'complete' ? '[OK]' : '[FAIL]';
    const tok = j.tokens ? ' tok=' + String(j.tokens.total) : '';
    const inf = j.timing ? ' infer=' + String(j.timing.evalMs) + 'ms' : '';
    console.log('  ' + icon + ' ' + j.name.padEnd(20) + ' wall=' + String(Math.round(j.wallTimeMs)).padStart(6) + 'ms urg=' + String(Math.round(j.urgency / 1000)) + 's' + tok + inf);
    if (j.result) console.log('       > ' + j.result.replace(/\n/g, ' ').slice(0, 100));
    if (j.error) console.log('       ! ' + j.error.slice(0, 100));
  }
  console.log('');
  console.log('  --- Learned Profiles ---');
  for (const p of profileResults) {
    console.log('  ' + (p.warm ? '[WARM]' : '[COLD]') + ' ' + p.name.padEnd(20) +
      ' n=' + String(p.sampleCount) + ' cpu=' + String(p.cpuTicksEWMA) +
      ' mem=' + String(Math.round(p.memBytesEWMA / 1024)) + 'KB' +
      ' wall=' + String(p.wallTimeMsEWMA) + 'ms' +
      ' fail=' + String((p.failureRateEWMA * 100).toFixed(1)) + '%');
  }
  console.log('');
  console.log('  --- Graph ---');
  for (const g of graphResults) {
    console.log('  ' + g.graphId + ': ' + g.status + ' wall=' + String(Math.round(g.wallTimeMs)) + 'ms' + (g.error ? ' err=' + g.error : ''));
  }
  console.log('');
  console.log('  --- Cache ---');
  console.log('  Active:    ' + String(fullReport.cache.totalEntries));
  console.log('  Expired:  ' + String(fullReport.cache.expiredEntries));
  console.log('  Pushed FE: ' + String(fullReport.cache.pushedToFrontend));
  console.log('');

  await algo.shutdown();
  console.log('  Report saved: ' + reportPath);
  return fullReport;
}

const isMain = process.argv[1]?.includes('ollama-test-harness');
if (isMain) {
  runOllamaTest().catch((err) => { console.error('Harness failed:', err); process.exit(1); });
}
