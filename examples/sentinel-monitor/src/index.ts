/**
 * sentinel-monitor -- Observability and alerting powered by jobs-algo.
 *
 * Demonstrates urgency-based scheduling for infrastructure monitoring.
 * Critical alerts (5s) are always scheduled before warnings (15s),
 * which are scheduled before info checks (30s) and health summaries (60s).
 *
 * Each monitoring job sends a real Ollama inference request describing
 * an infrastructure scenario, and the model returns an analysis.
 *
 * Run:
 *   npx tsx examples/sentinel-monitor/src/index.ts --checks 20 --mode live
 *   npx tsx examples/sentinel-monitor/src/index.ts --checks 20 --mode mc
 */

import { JobsAlgorithmImpl } from '../../../src/integration/jobs-algorithm.js';
import { MCAdapter } from '../../../src/integration/mc/mc-adapter.js';
import { OllamaDirectExecutor } from '../../../src/integration/ollama/ollama-executor.js';
import { computeSignature } from '../../../src/algorithm/signature.js';
import type { AlgorithmEvent, Signature } from '../../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../../src/types/index.js';
import fs from 'node:fs';
import path from 'node:path';

// -- Check types with urgency tiers --

interface CheckType {
  name: string;
  type: string;
  entity: string;
  argSchema: Record<string, string>;
  prompt: string;
  cacheExpiryMs: number;
  refreshRateMs: number;
  weight: number;
}

const CHECK_TYPES: CheckType[] = [
  // Tier 1: Critical alerts (5s urgency - always scheduled first)
  {
    name: 'critical-alert',
    type: 'alert',
    entity: 'infrastructure',
    argSchema: { metric: 'string', threshold: 'number', severity: 'string' },
    prompt: 'A critical infrastructure alert has been triggered. Metric: {metric} exceeded threshold {threshold}. Severity: {severity}. Provide an immediate action plan in 2-3 sentences. What should the on-call engineer do right now?',
    cacheExpiryMs: 5_000,
    refreshRateMs: 300_000,
    weight: 3,
  },
  {
    name: 'overbudget-alert',
    type: 'alert',
    entity: 'worker-pool',
    argSchema: { resource: 'string', usage: 'number', limit: 'number' },
    prompt: 'Worker pool resource {resource} is at {usage}% of limit {limit}. This is an over-budget alert. Recommend immediate scaling or load-shedding actions in 2-3 sentences.',
    cacheExpiryMs: 5_000,
    refreshRateMs: 300_000,
    weight: 2,
  },

  // Tier 2: Warnings (15s urgency)
  {
    name: 'degradation-warning',
    type: 'warning',
    entity: 'service',
    argSchema: { service: 'string', metric: 'string', trend: 'string' },
    prompt: 'Service {service} is showing degradation: {metric} is trending {trend}. This is a warning, not yet critical. Analyze the trend and suggest preventive actions in 2-3 sentences.',
    cacheExpiryMs: 15_000,
    refreshRateMs: 300_000,
    weight: 4,
  },
  {
    name: 'anomaly-detection',
    type: 'warning',
    entity: 'metric',
    argSchema: { metric_name: 'string', baseline: 'number', current: 'number' },
    prompt: 'Anomaly detected: {metric_name} baseline was {baseline} but current reading is {current}. Is this a real anomaly or expected variance? Provide a brief analysis in 2-3 sentences.',
    cacheExpiryMs: 15_000,
    refreshRateMs: 300_000,
    weight: 3,
  },

  // Tier 3: Info checks (30s urgency)
  {
    name: 'health-check',
    type: 'check',
    entity: 'node',
    argSchema: { node: 'string', role: 'string', uptime: 'string' },
    prompt: 'Health check for node {node} (role: {role}, uptime: {uptime}). Summarize the health status and any recommended maintenance in 2-3 sentences.',
    cacheExpiryMs: 30_000,
    refreshRateMs: 300_000,
    weight: 4,
  },
  {
    name: 'log-analysis',
    type: 'check',
    entity: 'log-aggregator',
    argSchema: { source: 'string', period: 'string', error_rate: 'number' },
    prompt: 'Analyze logs from {source} for the last {period}. Error rate is {error_rate}%. Identify the top 2 patterns and suggest improvements in 2-3 sentences.',
    cacheExpiryMs: 30_000,
    refreshRateMs: 300_000,
    weight: 3,
  },

  // Tier 4: Health summaries (60s urgency - scheduled last)
  {
    name: 'health-summary',
    type: 'summary',
    entity: 'cluster',
    argSchema: { cluster: 'string', node_count: 'number', healthy: 'number' },
    prompt: 'Generate a brief health summary for cluster {cluster}: {healthy}/{node_count} nodes healthy. Provide an overall assessment and any recommendations in 2-3 sentences.',
    cacheExpiryMs: 60_000,
    refreshRateMs: 300_000,
    weight: 2,
  },
  {
    name: 'capacity-forecast',
    type: 'summary',
    entity: 'capacity',
    argSchema: { resource: 'string', current_pct: 'number', growth_rate: 'number' },
    prompt: 'Capacity forecast for {resource}: currently at {current_pct}% with {growth_rate}% daily growth. When will capacity be exhausted and what should we plan for? Brief analysis in 2-3 sentences.',
    cacheExpiryMs: 60_000,
    refreshRateMs: 300_000,
    weight: 2,
  },
];

// -- Result tracking --

interface CheckResult {
  checkType: string;
  signature: string;
  urgency: number;
  success: boolean;
  wallMs: number;
  analysis: string;
  timestamp: number;
}

interface SentinelReport {
  timestamp: string;
  mode: string;
  totalChecks: number;
  slots: number;
  checksByUrgency: Record<string, { total: number; completed: number; failed: number; avgWallMs: number }>;
  totalWallMs: number;
  completedChecks: number;
  failedChecks: number;
  throughput: number;
  profileSnapshots: Array<{ name: string; sampleCount: number; warm: boolean; wallEWMA: number }>;
}

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

async function runSentinel(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || 'live').toLowerCase();
  const checkCount = Number(args.checks || 20);
  const slots = Number(args.slots || 4);
  const model = String(args.model || 'qwen2.5:0.5b');
  const ollamaHost = String(args.ollamaHost || 'http://localhost:11434');
  const mcRoot = String(args.mcRoot || process.env.MC_ROOT || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control');
  const mcProject = String(args.mcProject || 'sentinel-monitor');
  const outputDir = String(args.output || '.cache/sentinel');

  console.log('');
  console.log('='.repeat(70));
  console.log('  SENTINEL MONITOR -- Observability and Alerting Benchmark');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:        ' + mode.toUpperCase());
  console.log('  Checks:     ' + checkCount);
  console.log('  Slots:       ' + (slots || 'auto'));
  console.log('  Model:       ' + model);
  console.log('');

  const config = {
    ...DEFAULT_CONFIG,
    maxParallelism: slots || undefined,
    cacheDir: outputDir + '/profiles',
  };
  const algo = new JobsAlgorithmImpl(config);

  if (mode === 'live') {
    const executor = new OllamaDirectExecutor({ baseUrl: ollamaHost, model });
    algo.setMissionControl(executor);
  } else if (mode === 'mc') {
    const mcAdapter = new MCAdapter({
      projectRoot: mcRoot,
      projectId: mcProject,
      debug: args.debug === 'true',
    });
    algo.setMissionControl(mcAdapter);
  }

  // Build weighted check type list
  const weightedChecks: CheckType[] = [];
  for (const ct of CHECK_TYPES) {
    for (let i = 0; i < ct.weight; i++) {
      weightedChecks.push(ct);
    }
  }

  // Pre-compute signatures
  const signatures = new Map<string, Signature>();
  for (const ct of CHECK_TYPES) {
    const sig = computeSignature({ type: ct.type, entity: ct.entity, argSchema: ct.argSchema });
    signatures.set(ct.name, sig);
  }

  const startTime = Date.now();
  const results: CheckResult[] = [];
  let completed = 0;
  let failed = 0;

  // Subscribe to signatures for result tracking
  for (const [name, sig] of signatures) {
    const ct = CHECK_TYPES.find(c => c.name === name)!;
    algo.subscribe(sig, (event: AlgorithmEvent) => {
      if (event.type === 'job_complete') {
        const wallMs = Date.now() - startTime;
        let analysis = '';
        try {
          const parsed = JSON.parse(event.result.toString('utf8'));
          analysis = (parsed.content || parsed.summary || '').slice(0, 200);
        } catch { analysis = '(parse error)'; }

        results.push({ checkType: name, signature: event.signature.slice(0, 10), urgency: ct.cacheExpiryMs, success: true, wallMs, analysis, timestamp: Date.now() });
        completed++;
        const icon = ct.cacheExpiryMs <= 5_000 ? 'CRITICAL' : ct.cacheExpiryMs <= 15_000 ? 'WARN' : ct.cacheExpiryMs <= 30_000 ? 'INFO' : 'SUMMARY';
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] OK  ' + name.padEnd(22) + ' urg=' + String(ct.cacheExpiryMs / 1000).padEnd(5) + 's ' + icon.padEnd(8) + ' [' + completed + '/' + checkCount + ']');
      } else if (event.type === 'job_failed') {
        failed++;
        results.push({ checkType: name, signature: event.signature.slice(0, 10), urgency: ct.cacheExpiryMs, success: false, wallMs: Date.now() - startTime, analysis: event.error, timestamp: Date.now() });
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] FAIL ' + name.padEnd(22) + ' error: ' + event.error.slice(0, 60));
      }
    });
  }

  // Enqueue checks
  console.log('  Enqueueing ' + checkCount + ' monitoring checks...');
  for (let i = 0; i < checkCount; i++) {
    const ct = weightedChecks[Math.floor(Math.random() * weightedChecks.length)];
    const sig = signatures.get(ct.name)!;

    let prompt = ct.prompt;
    const fills: Record<string, string> = {
      metric: ['CPU', 'memory', 'disk-io', 'network-latency', 'error-rate'][Math.floor(Math.random() * 5)],
      threshold: String(Math.floor(Math.random() * 30) + 70),
      severity: 'critical',
      resource: ['CPU', 'memory', 'disk', 'network'][Math.floor(Math.random() * 4)],
      usage: String(Math.floor(Math.random() * 20) + 80),
      limit: '100',
      service: ['api-gateway', 'auth-service', 'data-pipeline', 'notification-service'][Math.floor(Math.random() * 4)],
      trend: ['increasing', 'decreasing', 'spiking', 'oscillating'][Math.floor(Math.random() * 4)],
      metric_name: ['request-latency', 'error-rate', 'throughput', 'connection-pool'][Math.floor(Math.random() * 4)],
      baseline: String(Math.floor(Math.random() * 50) + 20),
      current: String(Math.floor(Math.random() * 80) + 40),
      node: ['node-0' + (i % 5 + 1), 'node-1' + (i % 3 + 1), 'node-2' + (i % 4 + 1)][Math.floor(Math.random() * 3)],
      role: ['primary', 'replica', 'worker', 'coordinator'][Math.floor(Math.random() * 4)],
      uptime: String(Math.floor(Math.random() * 720) + 1) + 'h',
      source: ['app-logs', 'access-logs', 'system-logs', 'audit-logs'][Math.floor(Math.random() * 4)],
      period: ['1h', '6h', '24h', '7d'][Math.floor(Math.random() * 4)],
      error_rate: String((Math.random() * 5).toFixed(2)),
      cluster: ['prod-us-east', 'prod-eu-west', 'staging'][Math.floor(Math.random() * 3)],
      node_count: String(Math.floor(Math.random() * 20) + 5),
      healthy: String(Math.floor(Math.random() * 5) + 15),
      current_pct: String(Math.floor(Math.random() * 40) + 40),
      growth_rate: String((Math.random() * 5 + 1).toFixed(1)),
    };
    for (const [key, val] of Object.entries(fills)) {
      prompt = prompt.replace(new RegExp('\\{' + key + '\\}', 'g'), val);
    }

    const payload = Buffer.from(JSON.stringify({ prompt, type: ct.type, entity: ct.entity }), 'utf8');
    algo.enqueue(sig, payload, { cacheExpiryMs: ct.cacheExpiryMs, refreshRateMs: ct.refreshRateMs });
  }

  // Wait for all jobs
  console.log('  Waiting for results...');
  const timeout = Number(args.timeout || 600_000);
  while (completed + failed < checkCount && Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 200));
  }

  const totalWallMs = Date.now() - startTime;

  // Aggregate by urgency tier
  const byUrgency: Record<string, { total: number; completed: number; failed: number; avgWallMs: number }> = {};
  for (const ct of CHECK_TYPES) {
    const tier = ct.cacheExpiryMs <= 5_000 ? 'critical' : ct.cacheExpiryMs <= 15_000 ? 'warning' : ct.cacheExpiryMs <= 30_000 ? 'info' : 'summary';
    if (!byUrgency[tier]) byUrgency[tier] = { total: 0, completed: 0, failed: 0, avgWallMs: 0 };
  }
  for (const r of results) {
    const ct = CHECK_TYPES.find(c => c.name === r.checkType);
    if (!ct) continue;
    const tier = ct.cacheExpiryMs <= 5_000 ? 'critical' : ct.cacheExpiryMs <= 15_000 ? 'warning' : ct.cacheExpiryMs <= 30_000 ? 'info' : 'summary';
    const entry = byUrgency[tier];
    entry.total++;
    if (r.success) entry.completed++;
    else entry.failed++;
  }
  for (const [tier, entry] of Object.entries(byUrgency)) {
    const tierResults = results.filter(r => {
      const ct = CHECK_TYPES.find(c => c.name === r.checkType);
      if (!ct) return false;
      const t = ct.cacheExpiryMs <= 5_000 ? 'critical' : ct.cacheExpiryMs <= 15_000 ? 'warning' : ct.cacheExpiryMs <= 30_000 ? 'info' : 'summary';
      return t === tier && r.success;
    });
    entry.avgWallMs = tierResults.length > 0 ? Math.round(tierResults.reduce((s, r) => s + r.wallMs, 0) / tierResults.length) : 0;
  }

  // Profile snapshots
  const profileSnaps = [];
  for (const ct of CHECK_TYPES) {
    const sig = signatures.get(ct.name)!;
    const profile = algo.getProfile(sig);
    if (profile) {
      profileSnaps.push({ name: ct.name, sampleCount: profile.sampleCount, warm: profile.sampleCount >= 2, wallEWMA: Math.round(profile.wallTimeMsEWMA) });
    }
  }

  // Print report
  console.log('');
  console.log('='.repeat(70));
  console.log('  SENTINEL MONITOR RESULTS');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:         ' + mode.toUpperCase());
  console.log('  Total checks: ' + checkCount);
  console.log('  Completed:    ' + completed + '/' + checkCount);
  console.log('  Failed:       ' + failed);
  console.log('  Total wall:   ' + (totalWallMs / 1000).toFixed(1) + 's');
  console.log('  Throughput:   ' + (completed / (totalWallMs / 1000)).toFixed(2) + ' checks/s');
  console.log('');
  console.log('  URGENCY TIERS:');
  console.log('  ' + 'Tier'.padEnd(10) + ' ' + 'Total'.padEnd(7) + ' ' + 'OK'.padEnd(5) + ' ' + 'Fail'.padEnd(5) + ' ' + 'Avg(ms)'.padEnd(8));
  console.log('  ' + '-'.repeat(40));
  for (const [tier, entry] of Object.entries(byUrgency)) {
    console.log('  ' + tier.padEnd(10) + ' ' + String(entry.total).padEnd(7) + ' ' + String(entry.completed).padEnd(5) + ' ' + String(entry.failed).padEnd(5) + ' ' + String(entry.avgWallMs).padEnd(8));
  }
  console.log('');
  console.log('  PROFILE LEARNING:');
  for (const ps of profileSnaps) {
    console.log('    ' + ps.name.padEnd(22) + ' samples=' + String(ps.sampleCount).padEnd(3) + ' warm=' + String(ps.warm).padEnd(5) + ' wall=' + ps.wallEWMA + 'ms');
  }

  // Save report
  fs.mkdirSync(outputDir, { recursive: true });
  const report: SentinelReport = {
    timestamp: new Date().toISOString(),
    mode,
    totalChecks: checkCount,
    slots,
    checksByUrgency: byUrgency,
    totalWallMs,
    completedChecks: completed,
    failedChecks: failed,
    throughput: completed / (totalWallMs / 1000),
    profileSnapshots: profileSnaps,
  };
  const reportPath = path.join(outputDir, 'sentinel-report-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log('  Report saved: ' + reportPath);

  algo['scheduler'].clearAllRefreshTimers();
  await algo.shutdown();
}

const isMain = process.argv[1]?.includes('sentinel-monitor') || process.argv[1]?.includes('index.ts');
if (isMain) {
  runSentinel().catch((err) => {
    console.error('Sentinel monitor failed:', err);
    process.exit(1);
  });
}

export { CHECK_TYPES, SentinelReport, CheckResult };