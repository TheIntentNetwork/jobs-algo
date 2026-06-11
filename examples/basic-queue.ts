/**
 * Basic example: standalone queue with worker threads (no MC dependency)
 */
import { QueueSink, computeSignature } from '../src/index.js';

async function main() {
  const sink = new QueueSink({
    maxParallelism: 2,
    defaultRefreshRateMs: 5_000,
    defaultCacheExpiryMs: 30_000,
  });

  // Build a job signature from its structural identity
  const sig = computeSignature({
    type: 'EchoJob',
    entity: 'message',
    argSchema: { text: 'string' },
  });

  // Subscribe to events for this signature
  const unsub = sink.subscribe(sig, (event) => {
    switch (event.type) {
      case 'job_complete':
        console.log('Complete:', event.jobId, 'Result:', event.result.toString());
        break;
      case 'job_failed':
        console.error('Failed:', event.jobId, event.error);
        break;
      case 'cache_push':
        console.log('Cache pushed to frontend:', event.signature);
        break;
      case 'cache_expire':
        console.log('Cache expired:', event.signature);
        break;
      case 'profile_updated':
        console.log('Profile learned:', event.signature,
          'CPU:', event.profile.cpuTicksEWMA,
          'Mem:', event.profile.memBytesEWMA);
        break;
    }
  });

  // Enqueue jobs with different urgency levels
  const urgent = sink.push(sig, Buffer.from(JSON.stringify({ text: 'urgent' })), {
    cacheExpiryMs: 5_000,    // expires in 5s — high urgency
    refreshRateMs: 1_000,    // refresh every 1s
  });
  console.log('Urgent job:', urgent);

  const casual = sink.push(sig, Buffer.from(JSON.stringify({ text: 'casual' })), {
    cacheExpiryMs: 60_000,   // expires in 60s — low urgency
    refreshRateMs: 10_000,
  });
  console.log('Casual job:', casual);

  // Inspect the learned profile
  setTimeout(() => {
    const profile = sink.inspectProfile(sig);
    if (profile) {
      console.log('\n--- Profile ---');
      console.log('Signature:', profile.signature);
      console.log('Samples:', profile.sampleCount);
      console.log('CPU (EWMA):', profile.cpuTicksEWMA);
      console.log('Memory (EWMA):', profile.memBytesEWMA);
      console.log('Wall time (EWMA):', profile.wallTimeMsEWMA);
      console.log('Failure rate:', profile.failureRateEWMA);
      console.log('Refresh rate:', profile.refreshRateMs, 'ms');
    }
  }, 5_000);

  // Clean shutdown after 10s
  setTimeout(async () => {
    unsub();
    await sink.close();
    console.log('\nShutdown complete');
    process.exit(0);
  }, 10_000);
}

main().catch(console.error);