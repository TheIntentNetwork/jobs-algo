/**
 * scribe-publisher -- Content operations pipeline powered by jobs-algo.
 *
 * Demonstrates cache push and refresh behavior. Content jobs generate
 * articles, descriptions, SEO audits, and reviews. The system tracks
 * which signatures have active subscribers and pushes refreshed content
 * to the frontend cache layer on expiry, rather than evicting.
 *
 * Run:
 *   npx tsx examples/scribe-publisher/src/index.ts --articles 10 --mode live
 *   npx tsx examples/scribe-publisher/src/index.ts --articles 10 --mode mc
 */

import { JobsAlgorithmImpl } from '../../../src/integration/jobs-algorithm.js';
import { MCAdapter } from '../../../src/integration/mc/mc-adapter.js';
import { OllamaDirectExecutor } from '../../../src/integration/ollama/ollama-executor.js';
import { computeSignature } from '../../../src/algorithm/signature.js';
import type { AlgorithmEvent, Signature } from '../../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../../src/types/index.js';
import fs from 'node:fs';
import path from 'node:path';

// -- Content types with cache/refresh settings --

interface ContentType {
  name: string;
  type: string;
  entity: string;
  argSchema: Record<string, string>;
  prompt: string;
  cacheExpiryMs: number;
  refreshRateMs: number;
  weight: number;
}

const CONTENT_TYPES: ContentType[] = [
  // Hot content: short expiry, frequent refresh (like news headlines)
  {
    name: 'headline',
    type: 'headline',
    entity: 'article',
    argSchema: { topic: 'string', tone: 'string' },
    prompt: 'Write a catchy news headline about {topic} with a {tone} tone. Just the headline, nothing else.',
    cacheExpiryMs: 8_000,
    refreshRateMs: 5_000,
    weight: 4,
  },
  {
    name: 'breaking-alert',
    type: 'alert',
    entity: 'news-feed',
    argSchema: { topic: 'string', severity: 'string' },
    prompt: 'Write a brief breaking news alert about {topic}. Severity: {severity}. Include what happened and what to expect next in 2-3 sentences.',
    cacheExpiryMs: 5_000,
    refreshRateMs: 3_000,
    weight: 3,
  },

  // Warm content: medium expiry, moderate refresh (like product descriptions)
  {
    name: 'product-desc',
    type: 'description',
    entity: 'product',
    argSchema: { product: 'string', category: 'string' },
    prompt: 'Write a compelling product description for {product} in the {category} category. Highlight key features and benefits in 2-3 sentences.',
    cacheExpiryMs: 20_000,
    refreshRateMs: 15_000,
    weight: 3,
  },
  {
    name: 'seo-audit',
    type: 'audit',
    entity: 'page',
    argSchema: { page: 'string', keywords: 'string' },
    prompt: 'Audit the page "{page}" for SEO best practices regarding "{keywords}". List the top 3 improvements in bullet points.',
    cacheExpiryMs: 30_000,
    refreshRateMs: 20_000,
    weight: 2,
  },

  // Cold content: long expiry, rare refresh (like evergreen articles)
  {
    name: 'evergreen',
    type: 'article',
    entity: 'knowledge-base',
    argSchema: { topic: 'string', depth: 'string' },
    prompt: 'Write a brief {depth} explanation of {topic} for a knowledge base. Make it timeless and informative in 3-4 sentences.',
    cacheExpiryMs: 60_000,
    refreshRateMs: 45_000,
    weight: 2,
  },
  {
    name: 'review-summary',
    type: 'summary',
    entity: 'review',
    argSchema: { product: 'string', rating: 'number' },
    prompt: 'Summarize reviews for {product} with an average rating of {rating}/5. Highlight the most common praise and criticism in 2-3 sentences.',
    cacheExpiryMs: 45_000,
    refreshRateMs: 30_000,
    weight: 2,
  },
];

// -- Result tracking --

interface ContentResult {
  contentType: string;
  signature: string;
  cacheTier: string;
  success: boolean;
  wallMs: number;
  content: string;
  cachePushes: number;
  cacheExpiries: number;
}

interface ScribeReport {
  timestamp: string;
  mode: string;
  totalArticles: number;
  slots: number;
  resultsByTier: Record<string, { total: number; completed: number; failed: number; avgWallMs: number; cachePushes: number; cacheExpiries: number }>;
  totalWallMs: number;
  completedArticles: number;
  failedArticles: number;
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

async function runScribe(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || 'live').toLowerCase();
  const articleCount = Number(args.articles || 15);
  const slots = Number(args.slots || 4);
  const model = String(args.model || 'qwen2.5:0.5b');
  const ollamaHost = String(args.ollamaHost || 'http://localhost:11434');
  const mcRoot = String(args.mcRoot || process.env.MC_ROOT || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control');
  const mcProject = String(args.mcProject || 'scribe-publisher');
  const outputDir = String(args.output || '.cache/scribe-publisher');

  console.log('');
  console.log('='.repeat(70));
  console.log('  SCRIBE PUBLISHER -- Content Operations Benchmark');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:        ' + mode.toUpperCase());
  console.log('  Articles:   ' + articleCount);
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

  // Build weighted content list
  const weightedContent: ContentType[] = [];
  for (const ct of CONTENT_TYPES) {
    for (let i = 0; i < ct.weight; i++) {
      weightedContent.push(ct);
    }
  }

  // Pre-compute signatures
  const signatures = new Map<string, Signature>();
  for (const ct of CONTENT_TYPES) {
    const sig = computeSignature({ type: ct.type, entity: ct.entity, argSchema: ct.argSchema });
    signatures.set(ct.name, sig);
  }

  const startTime = Date.now();
  const results: ContentResult[] = [];
  let completed = 0;
  let failed = 0;

  // Track cache events per signature
  const cacheEvents = new Map<string, { pushes: number; expiries: number }>();
  for (const [name] of signatures) {
    cacheEvents.set(name, { pushes: 0, expiries: 0 });
  }

  // Subscribe for tracking
  for (const [name, sig] of signatures) {
    const ct = CONTENT_TYPES.find(c => c.name === name)!;

    algo.subscribe(sig, (event: AlgorithmEvent) => {
      if (event.type === 'job_complete') {
        let content = '';
        try {
          const parsed = JSON.parse(event.result.toString('utf8'));
          content = (parsed.content || parsed.summary || '').slice(0, 200);
        } catch { content = '(parse error)'; }

        const tier = ct.cacheExpiryMs <= 10_000 ? 'hot' : ct.cacheExpiryMs <= 30_000 ? 'warm' : 'cold';
        const cacheInfo = cacheEvents.get(name) || { pushes: 0, expiries: 0 };
        results.push({
          contentType: name,
          signature: event.signature.slice(0, 10),
          cacheTier: tier,
          success: true,
          wallMs: Date.now() - startTime,
          content,
          cachePushes: cacheInfo.pushes,
          cacheExpiries: cacheInfo.expiries,
        });
        completed++;
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] OK  ' + name.padEnd(18) + ' tier=' + tier.padEnd(5) + ' ttl=' + String(ct.cacheExpiryMs / 1000).padEnd(4) + 's [' + completed + '/' + articleCount + ']');
      } else if (event.type === 'job_failed') {
        failed++;
        results.push({
          contentType: name,
          signature: event.signature.slice(0, 10),
          cacheTier: ct.cacheExpiryMs <= 10_000 ? 'hot' : ct.cacheExpiryMs <= 30_000 ? 'warm' : 'cold',
          success: false,
          wallMs: Date.now() - startTime,
          content: event.error,
          cachePushes: 0,
          cacheExpiries: 0,
        });
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] FAIL ' + name.padEnd(18) + ' err=' + event.error.slice(0, 60));
      } else if (event.type === 'cache_push') {
        const info = cacheEvents.get(name);
        if (info) info.pushes++;
      } else if (event.type === 'cache_expire') {
        const info = cacheEvents.get(name);
        if (info) info.expiries++;
      }
    });
  }

  // Enqueue content jobs
  console.log('  Enqueueing ' + articleCount + ' content jobs...');
  const topics = ['artificial intelligence', 'cloud computing', 'cybersecurity', 'quantum computing', 'space exploration'];
  const tones = ['professional', 'casual', 'enthusiastic', 'informative'];
  const products = ['SmartWatch Pro', 'CloudSync 360', 'DataVault Enterprise', 'CodeForge IDE', 'NetShield Firewall'];
  const categories = ['technology', 'software', 'hardware', 'services', 'security'];

  for (let i = 0; i < articleCount; i++) {
    const ct = weightedContent[Math.floor(Math.random() * weightedContent.length)];
    const sig = signatures.get(ct.name)!;

    let prompt = ct.prompt;
    const fills: Record<string, string> = {
      topic: topics[i % topics.length],
      tone: tones[Math.floor(Math.random() * tones.length)],
      severity: ['low', 'medium', 'high', 'critical'][Math.floor(Math.random() * 4)],
      product: products[i % products.length],
      category: categories[i % categories.length],
      page: products[i % products.length] + ' landing page',
      keywords: topics[i % topics.length],
      depth: ['brief', 'detailed', 'comprehensive'][Math.floor(Math.random() * 3)],
      rating: String((Math.random() * 2 + 3).toFixed(1)),
    };
    for (const [key, val] of Object.entries(fills)) {
      prompt = prompt.replace(new RegExp('\\{' + key + '\\}', 'g'), val);
    }

    const payload = Buffer.from(JSON.stringify({ prompt, type: ct.type, entity: ct.entity }), 'utf8');
    algo.enqueue(sig, payload, { cacheExpiryMs: ct.cacheExpiryMs, refreshRateMs: ct.refreshRateMs });
  }

  // Wait for completion
  console.log('  Waiting for results...');
  const timeout = Number(args.timeout || 600_000);
  while (completed + failed < articleCount && Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 200));
  }

  const totalWallMs = Date.now() - startTime;

  // Aggregate by cache tier
  const byTier: Record<string, { total: number; completed: number; failed: number; avgWallMs: number; cachePushes: number; cacheExpiries: number }> = {};
  for (const ct of CONTENT_TYPES) {
    const tier = ct.cacheExpiryMs <= 10_000 ? 'hot' : ct.cacheExpiryMs <= 30_000 ? 'warm' : 'cold';
    if (!byTier[tier]) byTier[tier] = { total: 0, completed: 0, failed: 0, avgWallMs: 0, cachePushes: 0, cacheExpiries: 0 };
  }
  for (const r of results) {
    const entry = byTier[r.cacheTier];
    if (!entry) continue;
    entry.total++;
    if (r.success) entry.completed++;
    else entry.failed++;
  }
  for (const [tier, entry] of Object.entries(byTier)) {
    const tierResults = results.filter(r => r.cacheTier === tier && r.success);
    entry.avgWallMs = tierResults.length > 0 ? Math.round(tierResults.reduce((s, r) => s + r.wallMs, 0) / tierResults.length) : 0;
    const cacheInfo = cacheEvents.get(tier === 'hot' ? 'headline' : tier === 'warm' ? 'product-desc' : 'evergreen') || { pushes: 0, expiries: 0 };
    entry.cachePushes = cacheInfo.pushes;
    entry.cacheExpiries = cacheInfo.expiries;
  }

  // Profile snapshots
  const profileSnaps = [];
  for (const ct of CONTENT_TYPES) {
    const sig = signatures.get(ct.name)!;
    const profile = algo.getProfile(sig);
    if (profile) {
      profileSnaps.push({ name: ct.name, sampleCount: profile.sampleCount, warm: profile.sampleCount >= 2, wallEWMA: Math.round(profile.wallTimeMsEWMA) });
    }
  }

  // Print report
  console.log('');
  console.log('='.repeat(70));
  console.log('  SCRIBE PUBLISHER RESULTS');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:          ' + mode.toUpperCase());
  console.log('  Total articles: ' + articleCount);
  console.log('  Completed:     ' + completed + '/' + articleCount);
  console.log('  Failed:        ' + failed);
  console.log('  Total wall:    ' + (totalWallMs / 1000).toFixed(1) + 's');
  console.log('  Throughput:    ' + (completed / (totalWallMs / 1000)).toFixed(2) + ' articles/s');
  console.log('');
  console.log('  CACHE TIERS:');
  console.log('  ' + 'Tier'.padEnd(6) + ' ' + 'Total'.padEnd(7) + ' ' + 'OK'.padEnd(5) + ' ' + 'Fail'.padEnd(5) + ' ' + 'Avg(ms)'.padEnd(8) + ' ' + 'Pushes'.padEnd(7) + ' ' + 'Expires'.padEnd(8));
  console.log('  ' + '-'.repeat(50));
  for (const [tier, entry] of Object.entries(byTier)) {
    console.log('  ' + tier.padEnd(6) + ' ' + String(entry.total).padEnd(7) + ' ' + String(entry.completed).padEnd(5) + ' ' + String(entry.failed).padEnd(5) + ' ' + String(entry.avgWallMs).padEnd(8) + ' ' + String(entry.cachePushes).padEnd(7) + ' ' + String(entry.cacheExpiries).padEnd(8));
  }

  console.log('');
  console.log('  PROFILE LEARNING:');
  for (const ps of profileSnaps) {
    console.log('    ' + ps.name.padEnd(18) + ' samples=' + String(ps.sampleCount).padEnd(3) + ' warm=' + String(ps.warm).padEnd(5) + ' wall=' + ps.wallEWMA + 'ms');
  }

  // Save report
  fs.mkdirSync(outputDir, { recursive: true });
  const report: ScribeReport = {
    timestamp: new Date().toISOString(),
    mode,
    totalArticles: articleCount,
    slots,
    resultsByTier: byTier,
    totalWallMs,
    completedArticles: completed,
    failedArticles: failed,
    throughput: completed / (totalWallMs / 1000),
    profileSnapshots: profileSnaps,
  };
  const reportPath = path.join(outputDir, 'scribe-report-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log('  Report saved: ' + reportPath);

  algo['scheduler'].clearAllRefreshTimers();
  await algo.shutdown();
}

const isMain = process.argv[1]?.includes('scribe-publisher') || process.argv[1]?.includes('index.ts');
if (isMain) {
  runScribe().catch((err) => {
    console.error('Scribe publisher failed:', err);
    process.exit(1);
  });
}

export { CONTENT_TYPES, ScribeReport, ContentResult };