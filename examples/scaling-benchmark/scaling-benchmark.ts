/**
 * Scaling Benchmark — tests jobs-algo at scale with multiple verticals.
 *
 * Two modes, both use real work (no mocks):
 *   live  — uses OllamaDirectExecutor for real inference through the algorithm
 *           (requires Ollama running locally)
 *   mc    — uses MCAdapter for full MC daemon pipeline
 *           (requires mc daemon running)
 *
 * Each "vertical" represents a different domain/subdomain with its own job types
 * and urgency characteristics. The benchmark tracks per-vertical throughput,
 * latency, and resource profile learning.
 *
 * Run:
 *   # Live Ollama (requires Ollama):
 *   npx tsx examples/scaling-benchmark/scaling-benchmark.ts --mode live --jobs 30 --verticals 3
 *
 *   # Through MC daemon (requires mc daemon + Ollama):
 *   npx tsx examples/scaling-benchmark/scaling-benchmark.ts --mode mc --jobs 30 --verticals 3
 */

import { JobsAlgorithmImpl } from '../../src/integration/jobs-algorithm.js';
import { MCAdapter } from '../../src/integration/mc/mc-adapter.js';
import { OllamaDirectExecutor } from '../../src/integration/ollama/ollama-executor.js';
import { computeSignature } from '../../src/algorithm/signature.js';
import type { AlgorithmConfig, AlgorithmEvent, Signature } from '../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../src/types/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ── Vertical domain definitions ──
// Each vertical represents a product domain with its own job type distribution.

export interface VerticalDef {
  domain: string;
  subdomain: string;
  jobTypes: Array<{
    name: string;
    type: string;
    entity: string;
    argSchema: Record<string, string>;
    prompt: string;
    cacheExpiryMs: number;
    refreshRateMs: number;
    weight: number;  // relative frequency weight (higher = more jobs of this type)
  }>;
}

export const VERTICALS: VerticalDef[] = [
  {
    domain: 'data-pipeline',
    subdomain: 'etl',
    jobTypes: [
      { name: 'extract', type: 'extract', entity: 'datasource', argSchema: { source: 'string', format: 'string' },
        prompt: 'Extract data from the specified source. Return a summary of rows and columns extracted.', cacheExpiryMs: 10_000, refreshRateMs: 300_000, weight: 3 },
      { name: 'transform', type: 'transform', entity: 'dataset', argSchema: { pipeline: 'string', step: 'string' },
        prompt: 'Apply the transformation step to the dataset. Return before/after row counts.', cacheExpiryMs: 15_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'validate-schema', type: 'validate', entity: 'schema', argSchema: { schema_id: 'string', strict: 'boolean' },
        prompt: 'Validate the dataset against the schema. Report pass/fail with field-level detail.', cacheExpiryMs: 30_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'load-warehouse', type: 'load', entity: 'warehouse', argSchema: { target: 'string', mode: 'string' },
        prompt: 'Load the transformed data into the data warehouse. Report rows loaded and duplicates skipped.', cacheExpiryMs: 60_000, refreshRateMs: 300_000, weight: 1 },
    ],
  },
  {
    domain: 'ml-inference',
    subdomain: 'model-serving',
    jobTypes: [
      { name: 'classify', type: 'classify', entity: 'text', argSchema: { model_id: 'string', text: 'string' },
        prompt: 'Classify the input text into categories. Return the top 3 labels with confidence scores.', cacheExpiryMs: 5_000, refreshRateMs: 300_000, weight: 4 },
      { name: 'embed', type: 'embed', entity: 'document', argSchema: { model_id: 'string', dimension: 'string' },
        prompt: 'Generate embeddings for the input text. Return the first 5 dimension values as a sanity check.', cacheExpiryMs: 20_000, refreshRateMs: 300_000, weight: 3 },
      { name: 'summarize-result', type: 'summarize', entity: 'inference', argSchema: { model_id: 'string', length: 'string' },
        prompt: 'Summarize the inference result in 2-3 sentences. Focus on the most significant findings.', cacheExpiryMs: 30_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'detect-anomaly', type: 'alert', entity: 'metric', argSchema: { metric_name: 'string', threshold: 'string' },
        prompt: 'Analyze the metric for anomalies. Is the current value within normal range? Answer in one sentence.', cacheExpiryMs: 5_000, refreshRateMs: 300_000, weight: 1 },
    ],
  },
  {
    domain: 'content-ops',
    subdomain: 'publishing',
    jobTypes: [
      { name: 'seo-audit', type: 'audit', entity: 'page', argSchema: { url: 'string', keywords: 'string' },
        prompt: 'Audit the page for SEO best practices. List the top 3 improvements in bullet points.', cacheExpiryMs: 60_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'gen-description', type: 'generate', entity: 'content', argSchema: { topic: 'string', tone: 'string' },
        prompt: 'Generate a product description for the given topic. Keep it under 50 words.', cacheExpiryMs: 15_000, refreshRateMs: 300_000, weight: 3 },
      { name: 'review-content', type: 'review', entity: 'article', argSchema: { style: 'string', length: 'string' },
        prompt: 'Review the content for clarity and accuracy. List 2 specific suggestions for improvement.', cacheExpiryMs: 30_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'flag-issue', type: 'alert', entity: 'content', argSchema: { severity: 'string' },
        prompt: 'Flag any policy or quality issues in the content. Answer in one sentence.', cacheExpiryMs: 5_000, refreshRateMs: 300_000, weight: 1 },
    ],
  },
  {
    domain: 'infra-observability',
    subdomain: 'monitoring',
    jobTypes: [
      { name: 'check-health', type: 'check', entity: 'service', argSchema: { service: 'string', region: 'string' },
        prompt: 'Check the health of the specified service. Report status and response time.', cacheExpiryMs: 5_000, refreshRateMs: 300_000, weight: 4 },
      { name: 'analyze-log', type: 'analyze', entity: 'log', argSchema: { source: 'string', window: 'string' },
        prompt: 'Analyze the log entries for the specified time window. Identify the top error pattern.', cacheExpiryMs: 15_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'correlate-metrics', type: 'correlate', entity: 'metric', argSchema: { metric_a: 'string', metric_b: 'string' },
        prompt: 'Correlate the two metrics over the last hour. Describe the relationship in 2 sentences.', cacheExpiryMs: 30_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'escalate-alert', type: 'alert', entity: 'system', argSchema: { severity: 'string' },
        prompt: 'The system alert threshold has been exceeded. What is the recommended immediate action? One sentence.', cacheExpiryMs: 5_000, refreshRateMs: 300_000, weight: 1 },
    ],
  },
  {
    domain: 'security-compliance',
    subdomain: 'audit',
    jobTypes: [
      { name: 'scan-policy', type: 'scan', entity: 'policy', argSchema: { framework: 'string', scope: 'string' },
        prompt: 'Scan the policy against the compliance framework. Report any gaps found.', cacheExpiryMs: 60_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'check-access', type: 'check', entity: 'access', argSchema: { role: 'string', resource: 'string' },
        prompt: 'Check if the role has appropriate access to the resource. Answer in one sentence.', cacheExpiryMs: 10_000, refreshRateMs: 300_000, weight: 3 },
      { name: 'summarize-findings', type: 'summarize', entity: 'report', argSchema: { report_id: 'string', severity: 'string' },
        prompt: 'Summarize the security findings report. List the top 3 critical issues.', cacheExpiryMs: 30_000, refreshRateMs: 300_000, weight: 2 },
      { name: 'urgent-alert', type: 'alert', entity: 'security', argSchema: { severity: 'string' },
        prompt: 'A critical security vulnerability has been detected. What is the immediate remediation? One sentence.', cacheExpiryMs: 5_000, refreshRateMs: 300_000, weight: 1 },
    ],
  },
];

// ── Per-vertical metrics tracking ──

interface VerticalMetrics {
  domain: string;
  subdomain: string;
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
  totalWallMs: number;
  avgWallMs: number;
  p50WallMs: number;
  p95WallMs: number;
  minWallMs: number;
  maxWallMs: number;
  throughputJps: number;
  warmSignatures: number;
  coldSignatures: number;
  profileSnapshots: Array<{
    signature: string;
    name: string;
    sampleCount: number;
    warm: boolean;
    cpuEWMA: number;
    memEWMA: number;
    wallEWMA: number;
  }>;
}

// ── Argument parsing ──

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      parsed[key] = value;
      if (value !== 'true') i++;
    }
  }
  return parsed;
}

// ── MC backlog setup ──

function mcCmd(args: string[], projectId: string): string {
  try {
    const result = execSync('mc ' + args.map(a => '"' + a.replace(/"/g, '\\"') + '"').join(' '), {
      env: { ...process.env, MC_PROJECT: projectId },
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return (e.stderr || e.message || '').trim();
  }
}

function ensureBenchmarkBacklog(projectId: string): string {
  const epicList = mcCmd(['epic', 'list', '--project', projectId], projectId);
  const existingEpic = epicList.match(/epic_\w+/);
  let epicId: string;

  if (existingEpic) {
    epicId = existingEpic[0];
  } else {
    const epicOut = mcCmd(['epic', 'create', '--project', projectId, '--title', 'Scaling Benchmark', '--description', 'Multi-vertical scaling benchmark'], projectId);
    const epicMatch = epicOut.match(/epic_\w+/);
    if (epicMatch) {
      epicId = epicMatch[0];
    } else {
      const retryMatch = epicOut.split(/[\r\n]/).map(l => l.match(/epic_\w+/)).find(m => m);
      if (retryMatch) {
        epicId = retryMatch[0];
      } else {
        return '';
      }
    }
  }

  const featList = mcCmd(['feature', 'list', '--epic', epicId], projectId);
  const existingFeat = featList.match(/feat_\w+/);
  let featId: string;

  if (existingFeat) {
    featId = existingFeat[0];
  } else {
    const featOut = mcCmd(['feature', 'create', '--epic', epicId, '--title', 'Benchmark Scenarios', '--description', 'Multi-vertical scaling scenarios'], projectId);
    featId = featOut.split(/[\r\n]/).pop()?.trim() || '';
    if (!featId.startsWith('feat_')) {
      return '';
    }
  }

  const storyList = mcCmd(['story', 'list', '--feature', featId], projectId);
  const existingStory = storyList.match(/story_\w+/);

  if (existingStory) {
    return existingStory[0];
  }

  const storyOut = mcCmd(['story', 'create', '--feature', featId, '--title', 'Scaling Run', '--description', 'Multi-vertical real Ollama inference jobs for scaling benchmark'], projectId);
  return storyOut.split(/[\r\n]/).pop()?.trim() || '';
}

// ── Main runner ──

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || 'live');
  const totalJobs = Number(args.jobs || 30);
  const verticalCount = Math.min(Number(args.verticals || 3), VERTICALS.length);
  const maxParallelism = Number(args.slots || 0) || undefined;  // 0 = auto
  const outputDir = String(args.output || '.cache/scaling');

  if (mode !== 'live' && mode !== 'mc') {
    console.error('Mode must be "live" or "mc". No mocks/synthetic allowed.');
    console.error('Usage: npx tsx examples/scaling-benchmark/scaling-benchmark.ts --mode live --jobs 30 --verticals 3');
    process.exit(1);
  }

  const verticals = VERTICALS.slice(0, verticalCount);
  const jobsPerVertical = Math.ceil(totalJobs / verticalCount);

  console.log('');
  console.log('='.repeat(80));
  console.log('  SCALING BENCHMARK — ' + mode.toUpperCase() + ' MODE (real inference, no mocks)');
  console.log('  Verticals:  ' + verticalCount + ' (' + verticals.map(v => v.domain).join(', ') + ')');
  console.log('  Jobs:        ' + totalJobs + ' (~' + jobsPerVertical + ' per vertical)');
  console.log('  Slots:       ' + (maxParallelism || 'auto (os.cpus)'));
  console.log('  Output:      ' + outputDir);
  console.log('='.repeat(80));
  console.log('');

  const config: Partial<AlgorithmConfig> = {
    ...DEFAULT_CONFIG,
    maxParallelism: maxParallelism || 0,
    defaultCacheExpiryMs: 60_000,
    defaultRefreshRateMs: 300_000,
    coldStartSamples: 2,
    cacheDir: path.join(outputDir, 'cache'),
  };

  const algo = new JobsAlgorithmImpl(config);
  let storyId = '';

  // Set executor based on mode
  if (mode === 'live') {
    const model = String(args.model || 'qwen2.5:0.5b');
    const ollamaHost = String(args.ollamaHost || 'http://localhost:11434');
    const timeoutMs = Number(args.timeout || 120_000);
    algo.setMissionControl(new OllamaDirectExecutor({
      model,
      baseUrl: ollamaHost,
      timeoutMs,
    }));
    console.log('  Executor: Ollama Direct (model: ' + model + ', host: ' + ollamaHost + ')');
    console.log('  NOTE: Each job sends a real inference request. Latency reflects actual model performance.');
    console.log('');
  } else if (mode === 'mc') {
    const mcProjectRoot = String(args.mcRoot || process.env.MC_PROJECT_ROOT || process.env.MC_ROOT || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control');
    const mcProjectId = String(args.mcProject || process.env.MC_PROJECT_ID || 'scaling-benchmark');
    const mcPollMs = Number(args.pollInterval || 2000);
    const mcTimeoutMs = Number(args.jobTimeout || 300_000);

    storyId = ensureBenchmarkBacklog(mcProjectId);
    console.log('  Story ID: ' + (storyId || '(none — MC will require story_id per job)'));
    console.log('  MC Project: ' + mcProjectId);
    console.log('  MC Root:    ' + mcProjectRoot);

    algo.setMissionControl(new MCAdapter({
      projectRoot: mcProjectRoot,
      projectId: mcProjectId,
      pollIntervalMs: mcPollMs,
      jobTimeoutMs: mcTimeoutMs,
    }));
    console.log('  Executor: MC Adapter (project: ' + mcProjectId + ')');
    console.log('');
  }

  // Track per-vertical results
  const verticalResults = new Map<string, Array<{ wallMs: number; success: boolean; signature: string; jobType: string; enqueuedAt: number }>>();
  for (const v of verticals) {
    verticalResults.set(v.domain, []);
  }

  const startTime = Date.now();
  let totalCompleted = 0;
  let totalFailed = 0;

  // Subscribe to events
  for (const v of verticals) {
    for (const jt of v.jobTypes) {
      const sig = computeSignature({ type: jt.type, entity: jt.entity, argSchema: jt.argSchema });

      algo.subscribe(sig, (event: AlgorithmEvent) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (event.type === 'job_complete') {
          totalCompleted++;
          const results = verticalResults.get(v.domain)!;
          results.push({
            wallMs: Date.now() - startTime,
            success: true,
            signature: event.signature,
            jobType: jt.name,
            enqueuedAt: startTime,
          });

          if (totalCompleted % 10 === 0 || totalCompleted + totalFailed === totalJobs) {
            const pct = ((totalCompleted + totalFailed) / totalJobs * 100).toFixed(0);
            process.stdout.write('  [' + elapsed + 's] ' + pct + '% complete (' + totalCompleted + '/' + totalJobs + ' OK, ' + totalFailed + ' failed)\n');
          }
        } else if (event.type === 'job_failed') {
          totalFailed++;
          const results = verticalResults.get(v.domain)!;
          results.push({
            wallMs: Date.now() - startTime,
            success: false,
            signature: event.signature,
            jobType: jt.name,
            enqueuedAt: startTime,
          });

          const errSnippet = event.error ? event.error.slice(0, 80) : 'unknown';
          process.stdout.write('  [' + elapsed + 's] FAILED ' + jt.name + ': ' + errSnippet + '\n');
        }
      });
    }
  }

  // Enqueue jobs weighted by vertical and job type
  console.log('Enqueuing jobs:');
  let jobIndex = 0;
  for (const v of verticals) {
    const vJobs = jobsPerVertical;
    const totalWeight = v.jobTypes.reduce((s, jt) => s + jt.weight, 0);
    console.log('  ' + v.domain + '/' + v.subdomain + ': ' + vJobs + ' jobs');

    for (let i = 0; i < vJobs; i++) {
      // Weighted random selection of job type
      const rand = Math.random() * totalWeight;
      let cumWeight = 0;
      let selectedJt = v.jobTypes[0];
      for (const jt of v.jobTypes) {
        cumWeight += jt.weight;
        if (rand <= cumWeight) {
          selectedJt = jt;
          break;
        }
      }

      const sig = computeSignature({ type: selectedJt.type, entity: selectedJt.entity, argSchema: selectedJt.argSchema });
      const payloadObj: Record<string, unknown> = {
        type: selectedJt.type,
        entity: selectedJt.entity,
        argSchema: selectedJt.argSchema,
        prompt: selectedJt.prompt + ' (vertical=' + v.domain + ' iteration=' + i + ')',
        vertical: v.domain,
        subdomain: v.subdomain,
      };
      if (storyId) {
        payloadObj.story_id = storyId;
      }
      const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8');

      algo.enqueue(sig, payload, {
        cacheExpiryMs: selectedJt.cacheExpiryMs,
        refreshRateMs: selectedJt.refreshRateMs,
      });
      jobIndex++;
    }
  }
  console.log('  Total: ' + jobIndex + ' jobs enqueued');
  console.log('');

  // Wait for completion or timeout
  const timeout = Number(args.timeout || 600_000); // 10 min default
  const deadline = Date.now() + timeout;
  console.log('Waiting for completion (timeout: ' + (timeout / 1000) + 's)...');
  console.log('');

  while (totalCompleted + totalFailed < jobIndex && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }

  const totalWallMs = Date.now() - startTime;

  // Compute per-vertical metrics
  const perVertical: VerticalMetrics[] = [];
  for (const v of verticals) {
    const results = verticalResults.get(v.domain) || [];
    const completed = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const wallTimes = completed.map(r => r.wallMs).sort((a, b) => a - b);

    const uniqueSigs = new Set(completed.map(r => r.signature));
    const profileSnaps = Array.from(uniqueSigs).map(sig => {
      const profile = algo.getProfile(sig);
      const name = completed.find(r => r.signature === sig)?.jobType || sig.slice(0, 10);
      return {
        signature: sig,
        name,
        sampleCount: profile?.sampleCount || 0,
        warm: (profile?.sampleCount ?? 0) >= (config.coldStartSamples ?? 5),
        cpuEWMA: Math.round(profile?.cpuTicksEWMA ?? 0),
        memEWMA: Math.round(profile?.memBytesEWMA ?? 0),
        wallEWMA: Math.round(profile?.wallTimeMsEWMA ?? 0),
      };
    });

    perVertical.push({
      domain: v.domain,
      subdomain: v.subdomain,
      jobCount: results.length,
      completedJobs: completed.length,
      failedJobs: failed.length,
      totalWallMs: wallTimes.length > 0 ? (wallTimes[wallTimes.length - 1] - wallTimes[0]) : 0,
      avgWallMs: wallTimes.length > 0 ? Math.round(wallTimes.reduce((s, t) => s + t, 0) / wallTimes.length) : 0,
      p50WallMs: wallTimes.length > 0 ? wallTimes[Math.floor(wallTimes.length * 0.5)] : 0,
      p95WallMs: wallTimes.length > 0 ? wallTimes[Math.min(wallTimes.length - 1, Math.floor(wallTimes.length * 0.95))] : 0,
      minWallMs: wallTimes.length > 0 ? wallTimes[0] : 0,
      maxWallMs: wallTimes.length > 0 ? wallTimes[wallTimes.length - 1] : 0,
      throughputJps: totalWallMs > 0 ? (completed.length / (totalWallMs / 1000)) : 0,
      warmSignatures: profileSnaps.filter(p => p.warm).length,
      coldSignatures: profileSnaps.filter(p => !p.warm).length,
      profileSnapshots: profileSnaps,
    });
  }

  // Print results
  console.log('');
  console.log('='.repeat(80));
  console.log('  SCALING BENCHMARK RESULTS');
  console.log('='.repeat(80));
  console.log('');
  console.log('  Mode:         ' + mode.toUpperCase());
  console.log('  Total jobs:   ' + totalJobs);
  console.log('  Verticals:     ' + verticalCount);
  console.log('  Slots:        ' + (maxParallelism || 'auto'));
  console.log('  Completed:    ' + totalCompleted + '/' + totalJobs);
  console.log('  Failed:        ' + totalFailed);
  console.log('  Total wall:   ' + (totalWallMs / 1000).toFixed(1) + 's');
  console.log('  Throughput:    ' + (totalCompleted / (totalWallMs / 1000)).toFixed(2) + ' j/s');
  console.log('');

  // Per-vertical table
  const headers = ['Vertical', 'Jobs', 'OK', 'Fail', 'Avg(ms)', 'P50(ms)', 'P95(ms)', 'J/s', 'Warm', 'Cold'];
  console.log('  ' + headers.map(h => h.padEnd(10)).join(' '));
  console.log('  ' + '-'.repeat(headers.reduce((s, h) => s + h.length + 2, 0)));
  for (const vm of perVertical) {
    console.log('  ' + vm.domain.padEnd(10) + ' ' + String(vm.jobCount).padEnd(5) + ' ' + String(vm.completedJobs).padEnd(4) + ' ' + String(vm.failedJobs).padEnd(5) + ' ' + String(Math.round(vm.avgWallMs)).padEnd(8) + ' ' + String(Math.round(vm.p50WallMs)).padEnd(8) + ' ' + String(Math.round(vm.p95WallMs)).padEnd(8) + ' ' + vm.throughputJps.toFixed(2).padEnd(5) + ' ' + String(vm.warmSignatures).padEnd(5) + ' ' + String(vm.coldSignatures));
  }

  // Profile learning summary
  console.log('');
  console.log('  PROFILE LEARNING:');
  let totalWarm = 0, totalCold = 0;
  for (const vm of perVertical) {
    totalWarm += vm.warmSignatures;
    totalCold += vm.coldSignatures;
    for (const ps of vm.profileSnapshots) {
      console.log('    ' + vm.domain + '/' + ps.name.padEnd(20) + ' samples=' + String(ps.sampleCount).padEnd(3) + ' warm=' + String(ps.warm).padEnd(5) + ' cpu=' + String(ps.cpuEWMA).padEnd(6) + ' mem=' + String(ps.memEWMA).padEnd(7) + ' wall=' + ps.wallEWMA + 'ms');
    }
  }
  console.log('  Total: ' + totalWarm + ' warm signatures, ' + totalCold + ' cold signatures');

  // Save report
  fs.mkdirSync(outputDir, { recursive: true });
  const report = {
    timestamp: new Date().toISOString(),
    mode,
    totalJobs,
    verticalCount,
    maxParallelism: maxParallelism || 'auto',
    totalWallMs,
    totalCompleted,
    totalFailed,
    throughputJps: totalCompleted / (totalWallMs / 1000),
    perVertical,
  };
  const reportPath = path.join(outputDir, 'scaling-report-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log('  Report saved: ' + reportPath);

  // Stop any pending refresh jobs
  algo['scheduler'].clearAllRefreshTimers();
  await algo.shutdown();
}

const isMain = process.argv[1]?.includes('scaling-benchmark');
if (isMain) {
  main().catch((err) => {
    console.error('Scaling benchmark failed:', err);
    process.exit(1);
  });
}

export { VerticalMetrics };

