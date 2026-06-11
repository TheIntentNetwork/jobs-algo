/**
 * Cache layer example: demonstrates client-aware cache eviction
 * and auto-refresh with frontend graph cache push
 */
import { QueueSink, computeSignature } from '../src/index.js';

async function main() {
  const sink = new QueueSink({
    maxParallelism: 2,
    defaultCacheExpiryMs: 5_000,   // short expiry for demo
    defaultRefreshRateMs: 2_000,    // refresh every 2s
  });

  const sig = computeSignature({
    type: 'DataStream',
    entity: 'sensor',
    argSchema: { sensor_id: 'string' },
  });

  // Client 1 subscribes — ref count = 1
  const unsub1 = sink.subscribe(sig, (event) => {
    if (event.type === 'cache_push') {
      console.log('[client-1] Cache pushed to frontend — still serving while refreshing');
    }
    if (event.type === 'cache_expire') {
      console.log('[client-1] Cache expired — no more clients, data gone');
    }
    if (event.type === 'job_complete') {
      console.log('[client-1] Job complete:', event.jobId);
    }
  });

  // Client 2 subscribes — ref count = 2
  const unsub2 = sink.subscribe(sig, (event) => {
    if (event.type === 'cache_push') {
      console.log('[client-2] Got pushed cache too');
    }
  });

  // Enqueue a job
  const jobId = sink.push(sig, Buffer.from(JSON.stringify({ sensor_id: 'temp-01' })), {
    cacheExpiryMs: 5_000,
    refreshRateMs: 2_000,
  });
  console.log('Job enqueued:', jobId);

  // After 6s, cache expires but clients are still connected
  // → system pushes cache to frontend + schedules refresh
  setTimeout(() => {
    console.log('\n--- 6s elapsed: cache expiry with active clients ---');
    console.log('(cache_push events should fire, refresh should be scheduled)');
  }, 6_000);

  // Client 2 disconnects at 8s — ref count drops to 1
  setTimeout(() => {
    console.log('\n--- 8s: client-2 disconnects ---');
    unsub2();
  }, 8_000);

  // Client 1 disconnects at 12s — ref count drops to 0
  // Next expiry → clean eviction (cache_expire)
  setTimeout(() => {
    console.log('\n--- 12s: client-1 disconnects ---');
    unsub1();
  }, 12_000);

  // At 15s, verify the cache was evicted
  setTimeout(() => {
    console.log('\n--- 15s: no clients, cache should be evicted ---');
  }, 15_000);

  setTimeout(async () => {
    await sink.close();
    console.log('\nDone');
    process.exit(0);
  }, 20_000);
}

main().catch(console.error);