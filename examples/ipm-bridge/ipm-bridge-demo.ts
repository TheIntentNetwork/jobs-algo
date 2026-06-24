/**
 * IPM Bridge Demo — demonstrates jobs-algo driving MC for IPM package operations.
 *
 * This script shows the full flow:
 *   ipm-bridge-demo.ts  →  JobsAlgorithmImpl  →  MCAdapter  →  mc submit
 *                                                                 →  mc daemon
 *                                                                 →  ollama-local agent
 *                                                                 →  Ollama HTTP API
 *
 * It enqueues three job types (build, validate, publish) matching the
 * IPM workflow defined in intent-network/.mc/workflows/ipm-package-delivery.yaml
 *
 * Run alongside:
 *   Terminal 1:  mc --project intent-network daemon
 *   Terminal 2:  mc tui
 *   Terminal 3:  npx tsx examples/ipm-bridge/ipm-bridge-demo.ts
 */

import { JobsAlgorithmImpl } from '../../src/integration/jobs-algorithm.js';
import { MCAdapter } from '../../src/integration/mc/mc-adapter.js';
import { computeSignature } from '../../src/algorithm/signature.js';
function mcCmd(args: string[], project?: string): string {
  const fullArgs = project ? ['--project', project, ...args] : args;
  try {
    return execSync('mc ' + fullArgs.map(a => a.includes(' ') ? "" : a).join(' '), {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/** Idempotent: create epic/feature/story for IPM bridge jobs. */
function ensureIPMBacklog(projectId: string): string {
  const epicList = mcCmd(['epic', 'list'], projectId);
  const existingEpic = epicList.match(/epic_\w+/);
  let epicId: string;

  if (existingEpic) {
    epicId = existingEpic[0];
  } else {
    const epicOut = mcCmd(['epic', 'create', '--title', 'IPM Package Pipeline', '--description', 'IPM build/validate/publish pipeline jobs'], projectId);
    epicId = epicOut.split(/\r?\n/).pop()?.trim() || '';
    if (!epicId.startsWith('epic_')) {
      const retryList = mcCmd(['epic', 'list'], projectId);
      const retryMatch = retryList.match(/epic_\w+/);
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
    const featOut = mcCmd(['feature', 'create', '--epic', epicId, '--title', 'Package Delivery', '--description', 'IPM package delivery pipeline'], projectId);
    featId = featOut.split(/\r?\n/).pop()?.trim() || '';
    if (!featId.startsWith('feat_')) {
      return '';
    }
  }

  const storyList = mcCmd(['story', 'list', '--feature', featId], projectId);
  const existingStory = storyList.match(/story_\w+/);

  if (existingStory) {
    return existingStory[0];
  }

  const storyOut = mcCmd(['story', 'create', '--feature', featId, '--title', 'IPM Bridge Run', '--description', 'Jobs-algo driving MC for IPM package operations'], projectId);
  return storyOut.split(/\r?\n/).pop()?.trim() || '';
}

import type { AlgorithmConfig, AlgorithmEvent, Signature } from '../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../src/types/index.js';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

// ── IPM job type definitions (matching .mc/job-types/ YAMLs) ──

interface IPMJobDef {
  name: string;
  type: string;
  entity: string;
  argSchema: Record<string, string>;
  prompt: string;
  cacheExpiryMs: number;
  refreshRateMs: number;
}

const IPM_JOBS: IPMJobDef[] = [
  {
    name: 'ipm-build',
    type: '@intent-network/core/ipm-package-build',
    entity: 'package',
    argSchema: { package_path: 'string', tenant_id: 'string', compile_cmd: 'string' },
    prompt: 'Build the Intent Package at src/. Run compile-manifest.ts to generate the network manifest. Verify all command routes are present. Report the compiled artifact paths.',
    cacheExpiryMs: 60_000,
    refreshRateMs: 300_000,
  },
  {
    name: 'ipm-validate',
    type: '@intent-network/core/ipm-package-validate',
    entity: 'package',
    argSchema: { package_path: 'string', strict: 'boolean' },
    prompt: 'Validate the Intent Package at src/. Check .intent manifest against the schema. Verify command routing consistency. Ensure all declared commands have implementations. Report pass/fail with details.',
    cacheExpiryMs: 30_000,
    refreshRateMs: 300_000,
  },
  {
    name: 'ipm-publish',
    type: '@intent-network/core/ipm-package-publish',
    entity: 'package',
    argSchema: { package_path: 'string', version: 'string' },
    prompt: 'Publish the validated Intent Package version 0.1.0. Verify validation passed. Update tenant manifest. Register command routes. Tag the release.',
    cacheExpiryMs: 120_000,
    refreshRateMs: 300_000,
  },
];

function ipmSignature(job: IPMJobDef): Signature {
  return computeSignature({ type: job.type, entity: job.entity, argSchema: job.argSchema });
}

// ── Bridge runner ──

interface BridgeConfig {
  mcProjectRoot: string;
  mcProjectId: string;
  mcBinary?: string;
  pollIntervalMs?: number;
  jobTimeoutMs?: number;
}

class IPMBridgeRunner {
  private config: Required<BridgeConfig>;
  private outputDir: string;
  private storyId: string = '';

  constructor(config: BridgeConfig) {
    this.config = {
      mcProjectRoot: config.mcProjectRoot,
      mcProjectId: config.mcProjectId,
      mcBinary: config.mcBinary || 'mc',
      pollIntervalMs: config.pollIntervalMs || 2000,
      jobTimeoutMs: config.jobTimeoutMs || 300_000,
    };
    this.outputDir = path.join(process.cwd(), '.cache', 'ipm-bridge');
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  async run(): Promise<void> {
    console.log('');
    console.log('  Setting up MC backlog for IPM bridge...');
    this.storyId = ensureIPMBacklog(this.config.mcProjectId);
    console.log('  Story ID: ' + this.storyId);

    console.log('');
    console.log('='.repeat(70));
    console.log('  IPM BRIDGE DEMO — Jobs-Algo driving MC for IPM Package Operations');
    console.log('  MC Project: ' + this.config.mcProjectId);
    console.log('  MC Root:    ' + this.config.mcProjectRoot);
    console.log('='.repeat(70));
    console.log('');

    const algoConfig: Partial<AlgorithmConfig> = {
      ...DEFAULT_CONFIG,
      maxParallelism: 3,
      defaultCacheExpiryMs: 60_000,
      defaultRefreshRateMs: 300_000,
      coldStartSamples: 2,
    };

    const mcAdapter = new MCAdapter({
      projectRoot: this.config.mcProjectRoot,
      projectId: this.config.mcProjectId,
      mcBinary: this.config.mcBinary,
      pollIntervalMs: this.config.pollIntervalMs,
    });

    const algo = new JobsAlgorithmImpl(algoConfig);
    algo.setMissionControl(mcAdapter);

    // Track results
    const results: Array<{
      name: string;
      mcJobId: string;
      wallMs: number;
      status: string;
      summary: string;
    }> = [];

    const startTime = Date.now();

    // Subscribe to events
    for (const job of IPM_JOBS) {
      const sig = ipmSignature(job);

      algo.subscribe(sig, (event: AlgorithmEvent) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (event.type === 'job_complete') {
          const resultStr = event.result.toString('utf8');
          let mcJobId = '';
          let summary = '';
          try {
            const parsed = JSON.parse(resultStr);
            mcJobId = parsed.mcJobId || '';
            summary = (parsed.summary || '').slice(0, 80);
          } catch { summary = resultStr.slice(0, 80); }

          results.push({
            name: job.name,
            mcJobId,
            wallMs: Date.now() - startTime,
            status: 'complete',
            summary,
          });

          const shortId = mcJobId ? mcJobId.slice(0, 12) : '???';
          console.log([s] OK  mc=  );
        } else if (event.type === 'job_failed') {
          results.push({
            name: job.name,
            mcJobId: '',
            wallMs: Date.now() - startTime,
            status: 'failed',
            summary: event.error,
          });
          console.log([s] FAIL  error: );
        }
      });
    }

    // Enqueue IPM jobs
    console.log('');
    console.log('Enqueuing IPM package jobs:');
    for (const job of IPM_JOBS) {
      const sig = ipmSignature(job);
      const payload = Buffer.from(JSON.stringify({
        type: job.type,
        entity: job.entity,
        argSchema: job.argSchema,
        prompt: job.prompt,
        story_id: this.storyId || undefined,
      }, null, 2), 'utf8');

      const jobId = algo.enqueue(sig, payload, {
        cacheExpiryMs: job.cacheExpiryMs,
        refreshRateMs: job.refreshRateMs,
      });
      console.log('  ' + job.name.padEnd(16) + ' sig=' + sig.slice(0, 12) + '...  id=' + jobId);
    }
    console.log('');
    console.log('Waiting for MC daemon to process (watch MC TUI for live updates)...');
    console.log('');

    // Wait for all jobs to complete
    const deadline = Date.now() + this.config.jobTimeoutMs;
    while (results.length < IPM_JOBS.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
    }

    const totalWallMs = Date.now() - startTime;

    console.log('');
    console.log('='.repeat(70));
    console.log('  RESULTS');
    console.log('='.repeat(70));
    console.log('');

    for (const r of results) {
      const status = r.status === 'complete' ? 'OK' : 'FAIL';
      console.log('  ' + status + '  ' + r.name.padEnd(16) + ' wall=' + String(r.wallMs) + 'ms  ' + r.summary.slice(0, 60));
    }

    const completed = results.filter(r => r.status === 'complete').length;
    const failed = results.filter(r => r.status === 'failed').length;

    console.log('');
    console.log('  Completed: ' + String(completed) + '/' + String(IPM_JOBS.length) + '  Failed: ' + String(failed) + '  Total wall: ' + String(totalWallMs) + 'ms');
    console.log('');

    // Save report
    const report = {
      timestamp: new Date().toISOString(),
      model: 'ollama-local (via MC)',
      mcProjectId: this.config.mcProjectId,
      totalWallMs,
      completed,
      failed,
      results,
    };

    const reportPath = path.join(this.outputDir, 'ipm-bridge-report-' + Date.now() + '.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('  Report saved: ' + reportPath);

    mcAdapter.shutdown();
    await algo.shutdown();
  }
}

// ── CLI entry ──

const isMain = process.argv[1]?.includes('ipm-bridge-demo');
if (isMain) {
  const mcProjectRoot = process.env.MC_PROJECT_ROOT || process.env.MC_ROOT || 'C:\Repos\intent-network';
  const mcProjectId = process.env.MC_PROJECT_ID || 'intent-network';

  const runner = new IPMBridgeRunner({
    mcProjectRoot,
    mcProjectId,
    pollIntervalMs: 2000,
    jobTimeoutMs: 300_000,
  });

  runner.run().catch((err) => {
    console.error('IPM Bridge demo failed:', err);
    process.exit(1);
  });
}

export { IPMBridgeRunner, IPM_JOBS };


