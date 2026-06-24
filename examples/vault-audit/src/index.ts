/**
 * vault-audit -- Security and compliance benchmark powered by jobs-algo.
 *
 * Demonstrates profile learning at extremes: some scan types are fast
 * and cheap (policy checks), others are slow and expensive (penetration
 * simulations). The scheduler learns these profiles over time and
 * optimally packs them into parallel execution windows.
 *
 * Run:
 *   npx tsx examples/vault-audit/src/index.ts --audits 20 --mode live
 *   npx tsx examples/vault-audit/src/index.ts --audits 20 --mode mc
 */

import { JobsAlgorithmImpl } from '../../../src/integration/jobs-algorithm.js';
import { MCAdapter } from '../../../src/integration/mc/mc-adapter.js';
import { OllamaDirectExecutor } from '../../../src/integration/ollama/ollama-executor.js';
import { computeSignature } from '../../../src/algorithm/signature.js';
import type { AlgorithmEvent, Signature } from '../../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../../src/types/index.js';
import fs from 'node:fs';
import path from 'node:path';

// -- Audit types with extreme resource variance --

interface AuditType {
  name: string;
  type: string;
  entity: string;
  argSchema: Record<string, string>;
  prompt: string;
  cacheExpiryMs: number;
  refreshRateMs: number;
  weight: number;
  costTier: 'light' | 'medium' | 'heavy';
}

const AUDIT_TYPES: AuditType[] = [
  // Light: fast, cheap, high-volume (policy compliance)
  {
    name: 'policy-check',
    type: 'compliance',
    entity: 'policy',
    argSchema: { policy_id: 'string', framework: 'string' },
    prompt: 'Check policy {policy_id} against {framework} compliance framework. List any violations found in 2-3 concise sentences.',
    cacheExpiryMs: 30_000,
    refreshRateMs: 300_000,
    weight: 5,
    costTier: 'light',
  },
  {
    name: 'access-review',
    type: 'compliance',
    entity: 'access-log',
    argSchema: { user_role: 'string', resource: 'string' },
    prompt: 'Review access log for role {user_role} accessing {resource}. Identify any access violations or privilege escalation risks in 2-3 sentences.',
    cacheExpiryMs: 25_000,
    refreshRateMs: 300_000,
    weight: 4,
    costTier: 'light',
  },

  // Medium: moderate cost (vulnerability scan)
  {
    name: 'vuln-scan',
    type: 'security',
    entity: 'endpoint',
    argSchema: { endpoint: 'string', severity: 'string' },
    prompt: 'Scan endpoint {endpoint} for vulnerabilities at {severity} severity level. Report the top 3 findings with CVSS scores in 2-3 sentences.',
    cacheExpiryMs: 15_000,
    refreshRateMs: 300_000,
    weight: 3,
    costTier: 'medium',
  },
  {
    name: 'config-audit',
    type: 'security',
    entity: 'infrastructure',
    argSchema: { service: 'string', config_type: 'string' },
    prompt: 'Audit the {config_type} configuration of {service} for security misconfigurations. Report the top 3 issues and remediation steps in 2-3 sentences.',
    cacheExpiryMs: 20_000,
    refreshRateMs: 300_000,
    weight: 3,
    costTier: 'medium',
  },

  // Heavy: slow, expensive, low-volume (penetration simulation, forensic analysis)
  {
    name: 'pen-simulation',
    type: 'penetration',
    entity: 'network',
    argSchema: { target: 'string', vector: 'string' },
    prompt: 'Simulate a penetration test against {target} using {vector} attack vector. Describe the attack chain, potential entry points, and recommended defenses in 3-4 sentences. This is a defensive security exercise.',
    cacheExpiryMs: 10_000,
    refreshRateMs: 300_000,
    weight: 2,
    costTier: 'heavy',
  },
  {
    name: 'forensic-analysis',
    type: 'forensic',
    entity: 'incident',
    argSchema: { incident_type: 'string', affected_system: 'string' },
    prompt: 'Perform forensic analysis of {incident_type} incident affecting {affected_system}. Describe the attack timeline, indicators of compromise, and containment steps in 3-4 sentences.',
    cacheExpiryMs: 8_000,
    refreshRateMs: 300_000,
    weight: 2,
    costTier: 'heavy',
  },
  {
    name: 'urgent-alert',
    type: 'alert',
    entity: 'security-ops',
    argSchema: { alert_type: 'string', severity: 'string' },
    prompt: 'URGENT: {alert_type} alert at {severity} severity detected. Provide immediate containment actions and escalation procedures in 2-3 sentences.',
    cacheExpiryMs: 5_000,
    refreshRateMs: 300_000,
    weight: 3,
    costTier: 'heavy',
  },
];

// -- Result tracking --

interface AuditResult {
  auditType: string;
  signature: string;
  costTier: string;
  success: boolean;
  wallMs: number;
  finding: string;
}

interface VaultReport {
  timestamp: string;
  mode: string;
  totalAudits: number;
  slots: number;
  resultsByCostTier: Record<string, { total: number; completed: number; failed: number; avgWallMs: number; p50WallMs: number; p95WallMs: number }>;
  totalWallMs: number;
  completedAudits: number;
  failedAudits: number;
  throughput: number;
  profileSnapshots: Array<{ name: string; costTier: string; sampleCount: number; warm: boolean; wallEWMA: number; cpuEWMA: number; memEWMA: number }>;
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

async function runVault(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || 'live').toLowerCase();
  const auditCount = Number(args.audits || 20);
  const slots = Number(args.slots || 4);
  const model = String(args.model || 'qwen2.5:0.5b');
  const ollamaHost = String(args.ollamaHost || 'http://localhost:11434');
  const mcRoot = String(args.mcRoot || process.env.MC_ROOT || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control');
  const mcProject = String(args.mcProject || 'vault-audit');
  const outputDir = String(args.output || '.cache/vault-audit');

  console.log('');
  console.log('='.repeat(70));
  console.log('  VAULT AUDIT -- Security & Compliance Benchmark');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:        ' + mode.toUpperCase());
  console.log('  Audits:     ' + auditCount);
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

  // Build weighted audit type list
  const weightedAudits: AuditType[] = [];
  for (const at of AUDIT_TYPES) {
    for (let i = 0; i < at.weight; i++) {
      weightedAudits.push(at);
    }
  }

  // Pre-compute signatures
  const signatures = new Map<string, Signature>();
  for (const at of AUDIT_TYPES) {
    const sig = computeSignature({ type: at.type, entity: at.entity, argSchema: at.argSchema });
    signatures.set(at.name, sig);
  }

  const startTime = Date.now();
  const results: AuditResult[] = [];
  let completed = 0;
  let failed = 0;

  // Subscribe to all signatures
  for (const [name, sig] of signatures) {
    const at = AUDIT_TYPES.find(a => a.name === name)!;
    algo.subscribe(sig, (event: AlgorithmEvent) => {
      if (event.type === 'job_complete') {
        let finding = '';
        try {
          const parsed = JSON.parse(event.result.toString('utf8'));
          finding = (parsed.content || parsed.summary || '').slice(0, 200);
        } catch { finding = '(parse error)'; }

        results.push({
          auditType: name,
          signature: event.signature.slice(0, 10),
          costTier: at.costTier,
          success: true,
          wallMs: Date.now() - startTime,
          finding,
        });
        completed++;
        const icon = at.costTier === 'heavy' ? 'HEAVY' : at.costTier === 'medium' ? 'MED' : 'LITE';
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] OK  ' + name.padEnd(20) + ' cost=' + icon.padEnd(5) + ' urg=' + String(at.cacheExpiryMs / 1000).padEnd(4) + 's [' + completed + '/' + auditCount + ']');
      } else if (event.type === 'job_failed') {
        failed++;
        results.push({
          auditType: name,
          signature: event.signature.slice(0, 10),
          costTier: at.costTier,
          success: false,
          wallMs: Date.now() - startTime,
          finding: event.error,
        });
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] FAIL ' + name.padEnd(20) + ' err=' + event.error.slice(0, 60));
      }
    });
  }

  // Enqueue audits
  console.log('  Enqueueing ' + auditCount + ' security audits...');
  const frameworks = ['SOC2', 'HIPAA', 'GDPR', 'PCI-DSS', 'ISO27001'];
  const endpoints = ['api-gateway', 'auth-service', 'data-lake', 'web-frontend', 'admin-panel'];
  const targets = ['corporate-network', 'dmz', 'cloud-vpc', 'kubernetes-cluster'];
  const vectors = ['phishing', 'sql-injection', 'xss', 'privilege-escalation', 'supply-chain'];

  for (let i = 0; i < auditCount; i++) {
    const at = weightedAudits[Math.floor(Math.random() * weightedAudits.length)];
    const sig = signatures.get(at.name)!;

    let prompt = at.prompt;
    const fills: Record<string, string> = {
      policy_id: 'POL-' + String(i + 1000),
      framework: frameworks[i % frameworks.length],
      user_role: ['admin', 'developer', 'analyst', 'auditor'][i % 4],
      resource: endpoints[i % endpoints.length],
      endpoint: endpoints[i % endpoints.length],
      severity: ['low', 'medium', 'high', 'critical'][Math.floor(Math.random() * 4)],
      service: endpoints[i % endpoints.length],
      config_type: ['IAM', 'network', 'encryption', 'logging'][i % 4],
      target: targets[i % targets.length],
      vector: vectors[i % vectors.length],
      incident_type: ['data-breach', 'ransomware', 'ddos', 'insider-threat'][i % 4],
      affected_system: endpoints[i % endpoints.length],
      alert_type: ['intrusion', 'data-exfiltration', 'malware', 'misconfiguration'][i % 4],
    };
    for (const [key, val] of Object.entries(fills)) {
      prompt = prompt.replace(new RegExp('\\{' + key + '\\}', 'g'), val);
    }

    const payload = Buffer.from(JSON.stringify({ prompt, type: at.type, entity: at.entity }), 'utf8');
    algo.enqueue(sig, payload, { cacheExpiryMs: at.cacheExpiryMs, refreshRateMs: at.refreshRateMs });
  }

  // Wait for completion
  console.log('  Waiting for results...');
  const timeout = Number(args.timeout || 600_000);
  while (completed + failed < auditCount && Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 200));
  }

  const totalWallMs = Date.now() - startTime;

  // Aggregate by cost tier
  const byCostTier: Record<string, { total: number; completed: number; failed: number; avgWallMs: number; p50WallMs: number; p95WallMs: number }> = {};
  for (const at of AUDIT_TYPES) {
    if (!byCostTier[at.costTier]) byCostTier[at.costTier] = { total: 0, completed: 0, failed: 0, avgWallMs: 0, p50WallMs: 0, p95WallMs: 0 };
  }
  for (const r of results) {
    const entry = byCostTier[r.costTier];
    if (entry) {
      entry.total++;
      if (r.success) entry.completed++;
      else entry.failed++;
    }
  }
  for (const [tier, entry] of Object.entries(byCostTier)) {
    const tierResults = results.filter(r => r.costTier === tier && r.success).map(r => r.wallMs).sort((a, b) => a - b);
    entry.avgWallMs = tierResults.length > 0 ? Math.round(tierResults.reduce((s, t) => s + t, 0) / tierResults.length) : 0;
    entry.p50WallMs = tierResults.length > 0 ? tierResults[Math.floor(tierResults.length * 0.5)] : 0;
    entry.p95WallMs = tierResults.length > 0 ? tierResults[Math.min(tierResults.length - 1, Math.floor(tierResults.length * 0.95))] : 0;
  }

  // Profile snapshots
  const profileSnaps = [];
  for (const at of AUDIT_TYPES) {
    const sig = signatures.get(at.name)!;
    const profile = algo.getProfile(sig);
    if (profile) {
      profileSnaps.push({
        name: at.name,
        costTier: at.costTier,
        sampleCount: profile.sampleCount,
        warm: profile.sampleCount >= 2,
        wallEWMA: Math.round(profile.wallTimeMsEWMA),
        cpuEWMA: Math.round(profile.cpuTicksEWMA),
        memEWMA: Math.round(profile.memBytesEWMA),
      });
    }
  }

  // Print report
  console.log('');
  console.log('='.repeat(70));
  console.log('  VAULT AUDIT RESULTS');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:          ' + mode.toUpperCase());
  console.log('  Total audits:  ' + auditCount);
  console.log('  Completed:     ' + completed + '/' + auditCount);
  console.log('  Failed:        ' + failed);
  console.log('  Total wall:    ' + (totalWallMs / 1000).toFixed(1) + 's');
  console.log('  Throughput:    ' + (completed / (totalWallMs / 1000)).toFixed(2) + ' audits/s');
  console.log('');
  console.log('  COST TIERS (profile learning at extremes):');
  console.log('  ' + 'Tier'.padEnd(8) + ' ' + 'Total'.padEnd(7) + ' ' + 'OK'.padEnd(5) + ' ' + 'Fail'.padEnd(5) + ' ' + 'Avg(ms)'.padEnd(8) + ' ' + 'P50(ms)'.padEnd(8) + ' ' + 'P95(ms)'.padEnd(8));
  console.log('  ' + '-'.repeat(55));
  for (const [tier, entry] of Object.entries(byCostTier)) {
    console.log('  ' + tier.padEnd(8) + ' ' + String(entry.total).padEnd(7) + ' ' + String(entry.completed).padEnd(5) + ' ' + String(entry.failed).padEnd(5) + ' ' + String(entry.avgWallMs).padEnd(8) + ' ' + String(entry.p50WallMs).padEnd(8) + ' ' + String(entry.p95WallMs).padEnd(8));
  }

  console.log('');
  console.log('  PROFILE LEARNING:');
  for (const ps of profileSnaps) {
    console.log('    ' + ps.name.padEnd(20) + ' tier=' + ps.costTier.padEnd(7) + ' samples=' + String(ps.sampleCount).padEnd(3) + ' warm=' + String(ps.warm).padEnd(5) + ' cpu=' + String(ps.cpuEWMA).padEnd(7) + ' mem=' + String(ps.memEWMA).padEnd(8) + ' wall=' + ps.wallEWMA + 'ms');
  }

  // Save report
  fs.mkdirSync(outputDir, { recursive: true });
  const report: VaultReport = {
    timestamp: new Date().toISOString(),
    mode,
    totalAudits: auditCount,
    slots,
    resultsByCostTier: byCostTier,
    totalWallMs,
    completedAudits: completed,
    failedAudits: failed,
    throughput: completed / (totalWallMs / 1000),
    profileSnapshots: profileSnaps,
  };
  const reportPath = path.join(outputDir, 'vault-audit-report-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log('  Report saved: ' + reportPath);

  algo['scheduler'].clearAllRefreshTimers();
  await algo.shutdown();
}

const isMain = process.argv[1]?.includes('vault-audit') || process.argv[1]?.includes('index.ts');
if (isMain) {
  runVault().catch((err) => {
    console.error('Vault audit failed:', err);
    process.exit(1);
  });
}

export { AUDIT_TYPES, VaultReport, AuditResult };