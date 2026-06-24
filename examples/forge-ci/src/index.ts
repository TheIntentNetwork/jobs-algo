/**
 * forge-ci -- AI-assisted CI/CD pipeline powered by jobs-algo.
 *
 * Demonstrates DAG execution where build stages are graph nodes
 * with dependencies. The pipeline enforces correct ordering:
 *   lint -> build -> test -> security-scan -> deploy
 * Each stage is a real Ollama inference job.
 *
 * Run:
 *   npx tsx examples/forge-ci/src/index.ts --pipelines 5 --mode live
 *   npx tsx examples/forge-ci/src/index.ts --pipelines 5 --mode mc
 */

import { JobsAlgorithmImpl } from '../../../src/integration/jobs-algorithm.js';
import { MCAdapter } from '../../../src/integration/mc/mc-adapter.js';
import { OllamaDirectExecutor } from '../../../src/integration/ollama/ollama-executor.js';
import { computeSignature } from '../../../src/algorithm/signature.js';
import type { AlgorithmEvent, Signature, GraphDefinition } from '../../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../../src/types/index.js';
import fs from 'node:fs';
import path from 'node:path';

// -- Pipeline stage definitions --

interface PipelineStage {
  id: string;
  name: string;
  type: string;
  entity: string;
  argSchema: Record<string, string>;
  prompt: string;
  dependsOn: string[];
}

const STAGES: PipelineStage[] = [
  {
    id: 'lint',
    name: 'lint',
    type: 'lint',
    entity: 'codebase',
    argSchema: { language: 'string', files: 'number' },
    prompt: 'You are a linter for a {language} codebase with {files} source files. Report the top 3 linting issues you would expect to find and suggest fixes. Be concise, 2-3 sentences total.',
    dependsOn: [],
  },
  {
    id: 'build',
    name: 'build',
    type: 'build',
    entity: 'artifact',
    argSchema: { language: 'string', target: 'string' },
    prompt: 'You are building a {language} project for target {target}. Describe the build process, any likely warnings, and the final artifact size estimate in 2-3 sentences.',
    dependsOn: ['lint'],
  },
  {
    id: 'test-unit',
    name: 'test-unit',
    type: 'test',
    entity: 'test-suite',
    argSchema: { language: 'string', coverage: 'number' },
    prompt: 'You are running unit tests for a {language} project targeting {coverage}% coverage. Report the test results summary, including pass/fail counts and any flaky tests in 2-3 sentences.',
    dependsOn: ['build'],
  },
  {
    id: 'test-integration',
    name: 'test-integration',
    type: 'test',
    entity: 'integration-suite',
    argSchema: { language: 'string', services: 'number' },
    prompt: 'You are running integration tests for a {language} project with {services} microservices. Report the integration test results, including any service communication failures in 2-3 sentences.',
    dependsOn: ['build'],
  },
  {
    id: 'security-scan',
    name: 'security-scan',
    type: 'security',
    entity: 'codebase',
    argSchema: { language: 'string', severity: 'string' },
    prompt: 'You are running a security scan on a {language} codebase. Report any vulnerabilities found at {severity} severity level and above, with remediation advice in 2-3 sentences.',
    dependsOn: ['build'],
  },
  {
    id: 'deploy',
    name: 'deploy',
    type: 'deploy',
    entity: 'environment',
    argSchema: { environment: 'string', region: 'string' },
    prompt: 'You are deploying to {environment} in region {region}. Confirm the deployment steps, any rollback procedures needed, and the health check results in 2-3 sentences.',
    dependsOn: ['test-unit', 'test-integration', 'security-scan'],
  },
];

// -- Result tracking --

interface PipelineResult {
  pipelineId: number;
  stage: string;
  success: boolean;
  wallMs: number;
  output: string;
  timestamp: number;
}

interface ForgeReport {
  timestamp: string;
  mode: string;
  totalPipelines: number;
  totalStages: number;
  completedStages: number;
  failedStages: number;
  totalWallMs: number;
  throughput: number;
  stageTiming: Record<string, { count: number; avgWallMs: number; minWallMs: number; maxWallMs: number }>;
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

async function runForge(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || 'live').toLowerCase();
  const pipelineCount = Number(args.pipelines || 3);
  const slots = Number(args.slots || 4);
  const model = String(args.model || 'qwen2.5:0.5b');
  const ollamaHost = String(args.ollamaHost || 'http://localhost:11434');
  const mcRoot = String(args.mcRoot || process.env.MC_ROOT || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control');
  const mcProject = String(args.mcProject || 'forge-ci');
  const outputDir = String(args.output || '.cache/forge-ci');

  console.log('');
  console.log('='.repeat(70));
  console.log('  FORGE CI -- AI-Assisted CI/CD Pipeline Benchmark');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:        ' + mode.toUpperCase());
  console.log('  Pipelines:  ' + pipelineCount);
  console.log('  Stages/pipeline: ' + STAGES.length);
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

  // Pre-compute signatures
  const signatures = new Map<string, Signature>();
  for (const stage of STAGES) {
    const sig = computeSignature({ type: stage.type, entity: stage.entity, argSchema: stage.argSchema });
    signatures.set(stage.id, sig);
  }

  const startTime = Date.now();
  const results: PipelineResult[] = [];
  let completed = 0;
  let failed = 0;
  const totalStages = pipelineCount * STAGES.length;

  // Subscribe to all signatures
  for (const [stageId, sig] of signatures) {
    algo.subscribe(sig, (event: AlgorithmEvent) => {
      if (event.type === 'job_complete') {
        let output = '';
        try {
          const parsed = JSON.parse(event.result.toString('utf8'));
          output = (parsed.content || parsed.summary || '').slice(0, 200);
        } catch { output = '(parse error)'; }

        results.push({
          pipelineId: 0, // filled in later
          stage: stageId,
          success: true,
          wallMs: Date.now() - startTime,
          output,
          timestamp: Date.now(),
        });
        completed++;
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] OK  ' + stageId.padEnd(18) + ' [' + completed + '/' + totalStages + ']');
      } else if (event.type === 'graph_complete') {
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] GRAPH COMPLETE ' + event.graphId.slice(0, 8));
      } else if (event.type === 'graph_failed') {
        failed++;
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] GRAPH FAILED ' + event.graphId.slice(0, 8) + ' node=' + event.failedNodeId + ' err=' + event.error.slice(0, 60));
      } else if (event.type === 'job_failed') {
        failed++;
        results.push({
          pipelineId: 0,
          stage: stageId,
          success: false,
          wallMs: Date.now() - startTime,
          output: event.error,
          timestamp: Date.now(),
        });
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] FAIL ' + stageId.padEnd(18) + ' err=' + event.error.slice(0, 60));
      }
    });
  }

  // Enqueue pipeline DAGs
  const languages = ['TypeScript', 'Python', 'Rust', 'Go', 'Java'];
  const environments = ['staging', 'production', 'canary'];
  const regions = ['us-east-1', 'eu-west-1', 'ap-southeast-1'];

  console.log('  Enqueueing ' + pipelineCount + ' CI/CD pipelines as DAGs...');

  for (let p = 0; p < pipelineCount; p++) {
    const lang = languages[p % languages.length];
    const env = environments[p % environments.length];
    const region = regions[p % regions.length];

    const nodes = STAGES.map(stage => {
      const sig = signatures.get(stage.id)!;
      let prompt = stage.prompt;
      const fills: Record<string, string> = {
        language: lang,
        files: String(Math.floor(Math.random() * 200) + 50),
        target: env === 'production' ? 'release' : 'debug',
        coverage: String(Math.floor(Math.random() * 30) + 70),
        services: String(Math.floor(Math.random() * 8) + 2),
        severity: env === 'production' ? 'critical' : 'medium',
        environment: env,
        region: region,
      };
      for (const [key, val] of Object.entries(fills)) {
        prompt = prompt.replace(new RegExp('\\{' + key + '\\}', 'g'), val);
      }

      return {
        id: 'pipeline-' + p + '-' + stage.id,
        signature: sig,
        payload: Buffer.from(JSON.stringify({ prompt, type: stage.type, entity: stage.entity, pipeline: p }), 'utf8'),
        dependsOn: stage.dependsOn.map(dep => 'pipeline-' + p + '-' + dep),
      };
    });

    const graphDef: GraphDefinition = {
      id: 'ci-pipeline-' + p,
      nodes,
    };

    algo.enqueueGraph(graphDef);
  }

  // Wait for all graph completions
  console.log('  Waiting for pipeline results...');
  const timeout = Number(args.timeout || 600_000);

  while (completed + failed < totalStages && Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 200));
  }

  const totalWallMs = Date.now() - startTime;

  // Aggregate stage timing
  const stageTiming: Record<string, { count: number; avgWallMs: number; minWallMs: number; maxWallMs: number }> = {};
  for (const stage of STAGES) {
    const stageResults = results.filter(r => r.stage === stage.id && r.success);
    if (stageResults.length > 0) {
      const walls = stageResults.map(r => r.wallMs);
      stageTiming[stage.id] = {
        count: stageResults.length,
        avgWallMs: Math.round(walls.reduce((s, w) => s + w, 0) / walls.length),
        minWallMs: Math.min(...walls),
        maxWallMs: Math.max(...walls),
      };
    } else {
      stageTiming[stage.id] = { count: 0, avgWallMs: 0, minWallMs: 0, maxWallMs: 0 };
    }
  }

  // Profile snapshots
  const profileSnaps = [];
  for (const stage of STAGES) {
    const sig = signatures.get(stage.id)!;
    const profile = algo.getProfile(sig);
    if (profile) {
      profileSnaps.push({ name: stage.id, sampleCount: profile.sampleCount, warm: profile.sampleCount >= 2, wallEWMA: Math.round(profile.wallTimeMsEWMA) });
    }
  }

  // Print report
  console.log('');
  console.log('='.repeat(70));
  console.log('  FORGE CI RESULTS');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:          ' + mode.toUpperCase());
  console.log('  Pipelines:     ' + pipelineCount);
  console.log('  Total stages:  ' + totalStages);
  console.log('  Completed:     ' + completed + '/' + totalStages);
  console.log('  Failed:        ' + failed);
  console.log('  Total wall:    ' + (totalWallMs / 1000).toFixed(1) + 's');
  console.log('  Throughput:    ' + (completed / (totalWallMs / 1000)).toFixed(2) + ' stages/s');
  console.log('');
  console.log('  STAGE TIMING:');
  console.log('  ' + 'Stage'.padEnd(18) + ' ' + 'Count'.padEnd(6) + ' ' + 'Avg(ms)'.padEnd(8) + ' ' + 'Min(ms)'.padEnd(8) + ' ' + 'Max(ms)'.padEnd(8));
  console.log('  ' + '-'.repeat(50));
  for (const [stageId, timing] of Object.entries(stageTiming)) {
    console.log('  ' + stageId.padEnd(18) + ' ' + String(timing.count).padEnd(6) + ' ' + String(timing.avgWallMs).padEnd(8) + ' ' + String(timing.minWallMs).padEnd(8) + ' ' + String(timing.maxWallMs).padEnd(8));
  }

  console.log('');
  console.log('  PROFILE LEARNING:');
  for (const ps of profileSnaps) {
    console.log('    ' + ps.name.padEnd(18) + ' samples=' + String(ps.sampleCount).padEnd(3) + ' warm=' + String(ps.warm).padEnd(5) + ' wall=' + ps.wallEWMA + 'ms');
  }

  // Save report
  fs.mkdirSync(outputDir, { recursive: true });
  const report: ForgeReport = {
    timestamp: new Date().toISOString(),
    mode,
    totalPipelines: pipelineCount,
    totalStages,
    completedStages: completed,
    failedStages: failed,
    totalWallMs,
    throughput: completed / (totalWallMs / 1000),
    stageTiming,
    profileSnapshots: profileSnaps,
  };
  const reportPath = path.join(outputDir, 'forge-ci-report-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log('  Report saved: ' + reportPath);

  algo['scheduler'].clearAllRefreshTimers();
  await algo.shutdown();
}

const isMain = process.argv[1]?.includes('forge-ci') || process.argv[1]?.includes('index.ts');
if (isMain) {
  runForge().catch((err) => {
    console.error('Forge CI failed:', err);
    process.exit(1);
  });
}

export { STAGES, ForgeReport, PipelineResult };