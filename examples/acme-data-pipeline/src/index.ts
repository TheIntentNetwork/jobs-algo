/**
 * Acme Data Pipeline -- Full ETL pipeline powered by jobs-algo.
 *
 * Demonstrates a complete DAG pipeline: extract -> transform -> validate -> load
 * plus cache-aware results serving and profile learning across stages.
 *
 * Run:
 *   npx tsx examples/acme-data-pipeline/src/index.ts --pipelines 3 --mode live
 *   npx tsx examples/acme-data-pipeline/src/index.ts --pipelines 3 --mode mc
 */

import { JobsAlgorithmImpl } from '../../../src/integration/jobs-algorithm.js';
import { MCAdapter } from '../../../src/integration/mc/mc-adapter.js';
import { OllamaDirectExecutor } from '../../../src/integration/ollama/ollama-executor.js';
import { computeSignature } from '../../../src/algorithm/signature.js';
import type { AlgorithmEvent, Signature, GraphDefinition } from '../../../src/types/index.js';
import { DEFAULT_CONFIG } from '../../../src/types/index.js';
import fs from 'node:fs';
import path from 'node:path';

// -- ETL pipeline stages --

interface ETLStage {
  id: string;
  name: string;
  type: string;
  entity: string;
  argSchema: Record<string, string>;
  prompt: string;
  dependsOn: string[];
  cacheExpiryMs: number;
  refreshRateMs: number;
}

const ETL_STAGES: ETLStage[] = [
  {
    id: 'extract',
    name: 'extract',
    type: 'extract',
    entity: 'datasource',
    argSchema: { source: 'string', format: 'string' },
    prompt: 'Extract data from {source} in {format} format. Report the number of rows and columns extracted, any data quality issues found, and estimated extraction time. Be concise, 2-3 sentences.',
    dependsOn: [],
    cacheExpiryMs: 10_000,
    refreshRateMs: 300_000,
  },
  {
    id: 'transform',
    name: 'transform',
    type: 'transform',
    entity: 'dataset',
    argSchema: { pipeline: 'string', step: 'string' },
    prompt: 'Apply transformation step "{step}" from the "{pipeline}" pipeline. Describe the transformation logic, input/output schema changes, and any data quality improvements. Be concise, 2-3 sentences.',
    dependsOn: ['extract'],
    cacheExpiryMs: 15_000,
    refreshRateMs: 300_000,
  },
  {
    id: 'validate',
    name: 'validate',
    type: 'validate',
    entity: 'schema',
    argSchema: { schema_id: 'string', strict: 'string' },
    prompt: 'Validate the dataset against schema {schema_id}. Strict mode: {strict}. Report pass/fail status, list any field-level violations, and suggest corrections. Be concise, 2-3 sentences.',
    dependsOn: ['transform'],
    cacheExpiryMs: 20_000,
    refreshRateMs: 300_000,
  },
  {
    id: 'load',
    name: 'load',
    type: 'load',
    entity: 'warehouse',
    argSchema: { target: 'string', mode: 'string' },
    prompt: 'Load the validated dataset into {target} warehouse in {mode} mode. Report rows loaded, duplicates skipped, and any constraint violations. Be concise, 2-3 sentences.',
    dependsOn: ['validate'],
    cacheExpiryMs: 30_000,
    refreshRateMs: 300_000,
  },
];

// -- Result tracking --

interface PipelineResult {
  pipelineId: number;
  stage: string;
  success: boolean;
  wallMs: number;
  output: string;
}

interface AcmeReport {
  timestamp: string;
  mode: string;
  totalPipelines: number;
  totalStages: number;
  completedStages: number;
  failedStages: number;
  totalWallMs: number;
  throughput: number;
  stageTiming: Record<string, { count: number; avgWallMs: number }>;
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

async function runAcme(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || 'live').toLowerCase();
  const pipelineCount = Number(args.pipelines || 2);
  const slots = Number(args.slots || 4);
  const model = String(args.model || 'qwen2.5:0.5b');
  const ollamaHost = String(args.ollamaHost || 'http://localhost:11434');
  const mcRoot = String(args.mcRoot || process.env.MC_ROOT || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control');
  const mcProject = String(args.mcProject || 'acme-data-pipeline');
  const outputDir = String(args.output || '.cache/acme-pipeline');

  console.log('');
  console.log('='.repeat(70));
  console.log('  ACME DATA PIPELINE -- ETL DAG Benchmark');
  console.log('='.repeat(70));
  console.log('');
  console.log('  Mode:        ' + mode.toUpperCase());
  console.log('  Pipelines:  ' + pipelineCount);
  console.log('  Stages/pipe: ' + ETL_STAGES.length);
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
  for (const stage of ETL_STAGES) {
    const sig = computeSignature({ type: stage.type, entity: stage.entity, argSchema: stage.argSchema });
    signatures.set(stage.id, sig);
  }

  const startTime = Date.now();
  const results: PipelineResult[] = [];
  let completed = 0;
  let failed = 0;
  const totalStages = pipelineCount * ETL_STAGES.length;

  // Subscribe to all signatures
  for (const [stageId, sig] of signatures) {
    algo.subscribe(sig, (event: AlgorithmEvent) => {
      if (event.type === 'job_complete') {
        let output = '';
        try {
          const parsed = JSON.parse(event.result.toString('utf8'));
          output = (parsed.content || parsed.summary || '').slice(0, 200);
        } catch { output = '(parse error)'; }

        results.push({ pipelineId: 0, stage: stageId, success: true, wallMs: Date.now() - startTime, output });
        completed++;
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] OK  ' + stageId.padEnd(12) + ' [' + completed + '/' + totalStages + ']');
      } else if (event.type === 'job_failed') {
        failed++;
        results.push({ pipelineId: 0, stage: stageId, success: false, wallMs: Date.now() - startTime, output: event.error });
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] FAIL ' + stageId.padEnd(12) + ' err=' + event.error.slice(0, 60));
      } else if (event.type === 'graph_complete') {
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] GRAPH COMPLETE ' + event.graphId.slice(0, 8));
      } else if (event.type === 'graph_failed') {
        console.log('  [' + new Date().toISOString().slice(11, 19) + '] GRAPH FAILED ' + event.graphId.slice(0, 8));
      }
    });
  }

  // Enqueue ETL pipeline DAGs
  const sources = ['PostgreSQL orders_db', 'S3 customer_events', 'MongoDB product_catalog', 'Kafka clickstream', 'REST API inventory_feed'];
  const formats = ['CSV', 'JSON', 'Parquet', 'Avro'];
  const pipelines = ['customer_360', 'revenue_analytics', 'fraud_detection', 'inventory_tracking'];
  const schemas = ['orders_v3', 'customers_v2', 'products_v1', 'events_v4'];
  const warehouses = ['Redshift cluster', 'BigQuery dataset', 'Snowflake schema', 'Delta Lake table'];

  console.log('  Enqueueing ' + pipelineCount + ' ETL pipelines as DAGs...');

  for (let p = 0; p < pipelineCount; p++) {
    const nodes = ETL_STAGES.map(stage => {
      const sig = signatures.get(stage.id)!;
      let prompt = stage.prompt;
      const fills: Record<string, string> = {
        source: sources[p % sources.length],
        format: formats[p % formats.length],
        pipeline: pipelines[p % pipelines.length],
        step: stage.id + '-' + (p + 1),
        schema_id: schemas[p % schemas.length],
        strict: p % 2 === 0 ? 'true' : 'false',
        target: warehouses[p % warehouses.length],
        mode: p % 2 === 0 ? 'upsert' : 'append',
      };
      for (const [key, val] of Object.entries(fills)) {
        prompt = prompt.replace(new RegExp('\\{' + key + '\\}', 'g'), val);
      }

      return {
        id: 'pipe-' + p + '-' + stage.id,
        signature: sig,
        payload: Buffer.from(JSON.stringify({ prompt, type: stage.type, entity: stage.entity, pipeline: p }), 'utf8'),
        dependsOn: stage.dependsOn.map(dep => 'pipe-' + p + '-' + dep),
      };
    });

    const graphDef: GraphDefinition = {
      id: 'etl-pipeline-' + p,
      nodes,
    };

    algo.enqueueGraph(graphDef);
  }

  // Wait for completion
  console.log('  Waiting for pipeline results...');
  const timeout = Number(args.timeout || 600_000);
  while (completed + failed < totalStages && Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 200));
  }

  const totalWallMs = Date.now() - startTime;

  // Aggregate stage timing
  const stageTiming: Record<string, { count: number; avgWallMs: number }> = {};
  for (const stage of ETL_STAGES) {
    const stageResults = results.filter(r => r.stage === stage.id && r.success);
    stageTiming[stage.id] = {
      count: stageResults.length,
      avgWallMs: stageResults.length > 0 ? Math.round(stageResults.reduce((s, r) => s + r.wallMs, 0) / stageResults.length) : 0,
    };
  }

  // Profile snapshots
  const profileSnaps = [];
  for (const stage of ETL_STAGES) {
    const sig = signatures.get(stage.id)!;
    const profile = algo.getProfile(sig);
    if (profile) {
      profileSnaps.push({ name: stage.id, sampleCount: profile.sampleCount, warm: profile.sampleCount >= 2, wallEWMA: Math.round(profile.wallTimeMsEWMA) });
    }
  }

  // Print report
  console.log('');
  console.log('='.repeat(70));
  console.log('  ACME DATA PIPELINE RESULTS');
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
  console.log('  ETL STAGE TIMING:');
  console.log('  ' + 'Stage'.padEnd(12) + ' ' + 'Count'.padEnd(6) + ' ' + 'Avg(ms)'.padEnd(8));
  console.log('  ' + '-'.repeat(30));
  for (const [stageId, timing] of Object.entries(stageTiming)) {
    console.log('  ' + stageId.padEnd(12) + ' ' + String(timing.count).padEnd(6) + ' ' + String(timing.avgWallMs).padEnd(8));
  }

  console.log('');
  console.log('  PROFILE LEARNING:');
  for (const ps of profileSnaps) {
    console.log('    ' + ps.name.padEnd(12) + ' samples=' + String(ps.sampleCount).padEnd(3) + ' warm=' + String(ps.warm).padEnd(5) + ' wall=' + ps.wallEWMA + 'ms');
  }

  // Save report
  fs.mkdirSync(outputDir, { recursive: true });
  const report: AcmeReport = {
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
  const reportPath = path.join(outputDir, 'acme-pipeline-report-' + Date.now() + '.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log('  Report saved: ' + reportPath);

  algo['scheduler'].clearAllRefreshTimers();
  await algo.shutdown();
}

const isMain = process.argv[1]?.includes('acme-data-pipeline') || process.argv[1]?.includes('index.ts');
if (isMain) {
  runAcme().catch((err) => {
    console.error('Acme pipeline failed:', err);
    process.exit(1);
  });
}

export { ETL_STAGES, AcmeReport, PipelineResult };