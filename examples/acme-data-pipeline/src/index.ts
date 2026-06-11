/**
 * Acme Data Pipeline — Example integration script.
 *
 * Demonstrates how to use @intent-network/jobs-algo with the
 * OllamaDirectExecutor for local testing, and shows how to
 * configure it for Mission Control in production.
 *
 * Usage:
 *   npx tsx examples/acme-data-pipeline/src/index.ts
 */

import {
  computeSignature,
  QueueSink,
  OllamaDirectExecutor,
  ollamaMCEnv,
} from '../../../dist/index.js';

// ── Configuration ──

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
const OLLAMA_BASE_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MAX_PARALLELISM = Number(process.env.MAX_PARALLELISM) || 2;

// ── Signatures ──

const validateSig = computeSignature({
  type: 'etl-validate',
  entity: 'dataset',
  argSchema: { datasetId: 'string', format: 'string' },
});

// ── Create the queue ──

const sink = new QueueSink({
  maxParallelism: MAX_PARALLELISM,
  defaultRefreshRateMs: 10_000,
  defaultCacheExpiryMs: 60_000,
});

// ── Connect to Ollama directly (for local testing) ──

const executor = new OllamaDirectExecutor({
  baseUrl: OLLAMA_BASE_URL,
  model: OLLAMA_MODEL,
  timeoutMs: 60_000,
  maxTokens: 100,
});

sink.connectMissionControl(executor);

// ── Subscribe to events ──

sink.subscribe(validateSig, (event) => {
  switch (event.type) {
    case 'job_complete':
      console.log(`[COMPLETE] sig=${event.signature.slice(0, 8)} job=${event.jobId.slice(0, 8)}`);
      try {
        const result = JSON.parse(event.result.toString());
        console.log(`  content: ${result.content?.slice(0, 80)}...`);
        console.log(`  tokens: ${result.tokens?.total} inference: ${result.timing?.evalMs}ms`);
      } catch {
        console.log(`  result: ${event.result.toString().slice(0, 80)}`);
      }
      break;
    case 'job_failed':
      console.error(`[FAILED] sig=${event.signature.slice(0, 8)} error=${event.error}`);
      break;
    case 'profile_updated':
      console.log(`[PROFILE] sig=${event.signature.slice(0, 8)} n=${event.profile.sampleCount} warm=${event.profile.sampleCount >= 5}`);
      break;
    case 'cache_push':
      console.log(`[CACHE PUSH] sig=${event.signature.slice(0, 8)}`);
      break;
    case 'cache_expire':
      console.log(`[CACHE EXPIRE] sig=${event.signature.slice(0, 8)}`);
      break;
  }
});

// ── Enqueue a validation job ──

const jobId = sink.push(validateSig, Buffer.from(JSON.stringify({
  prompt: 'Validate that the ETL transform handles null values correctly. List 2 common null edge cases.',
})), {
  cacheExpiryMs: 30_000,
  refreshRateMs: 10_000,
});

console.log(`Enqueued job: ${jobId}`);
console.log(`Model: ${OLLAMA_MODEL}  Parallelism: ${MAX_PARALLELISM}`);
console.log('');

// ── For MC production mode, use these env vars ──

if (process.env.MC_REGISTER_OLLAMA) {
  const mcEnv = ollamaMCEnv({ model: OLLAMA_MODEL, baseUrl: OLLAMA_BASE_URL });
  console.log('MC environment:');
  for (const [key, value] of Object.entries(mcEnv)) {
    console.log(`  ${key}=${value}`);
  }
}

// ── Graceful shutdown ──

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await sink.close();
  process.exit(0);
});

// Auto-shutdown after 30s for demo
setTimeout(async () => {
  console.log('\nDemo complete. Shutting down...');
  const profile = sink.inspectProfile(validateSig);
  if (profile) {
    console.log(`Final profile: n=${profile.sampleCount} cpu=${Math.round(profile.cpuTicksEWMA)} wall=${Math.round(profile.wallTimeMsEWMA)}ms warm=${profile.sampleCount >= 5}`);
  }
  await sink.close();
  process.exit(0);
}, 30_000);
