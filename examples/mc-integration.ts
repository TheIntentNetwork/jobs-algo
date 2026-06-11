/**
 * MC Integration example: jobs-algo driving Mission Control
 *
 * Prerequisites:
 *   - Mission Control installed and configured
 *   - A project registered: mc project list
 *   - MC daemon running: mc daemon
 */
import {
  createMCBridge,
  mcJobSignature,
  buildMCJobPayload,
  computeSignature,
} from '../src/index.js';
import type { GraphDefinition } from '../src/types/index.js';

async function main() {
  // Create a bridge to Mission Control
  const sink = createMCBridge({
    projectRoot: process.env.MC_PROJECT_ROOT || 'C:\\Users\\Bryan\\Source\\intent-network-mission-control',
    projectId: process.env.MC_PROJECT_ID || 'mc-platform',
    pollIntervalMs: 2_000,  // poll MC job state every 2s
  });

  // ── Single job ──

  // Build signature from the MC job type's structural identity
  const implSig = mcJobSignature('implement', 'story', { story_id: 'string' });

  // Build payload in MC's submission format
  const implPayload = buildMCJobPayload({
    type: 'implement',
    story_id: 'S-001',
  });

  // Subscribe to events (also registers as a cache client)
  const unsub = sink.subscribe(implSig, (event) => {
    switch (event.type) {
      case 'job_complete':
        console.log('[mc] job done:', event.jobId);
        break;
      case 'job_failed':
        console.error('[mc] job failed:', event.error);
        break;
      case 'profile_updated':
        console.log('[mc] profile:', event.signature.slice(0, 8),
          'CPU:', Math.round(event.profile.cpuTicksEWMA),
          'Mem:', Math.round(event.profile.memBytesEWMA / 1024) + 'KB');
        break;
      case 'cache_push':
        console.log('[mc] cache pushed to frontend (clients still active)');
        break;
      case 'cache_expire':
        console.log('[mc] cache expired (no clients left)');
        break;
    }
  });

  // Push the job — urgency-driven scheduling + MC execution
  const jobId = sink.push(implSig, implPayload, {
    cacheExpiryMs: 300_000,  // 5 min cache
    refreshRateMs: 30_000,   // refresh every 30s
  });
  console.log('Submitted MC job:', jobId);

  // ── Graph (chain) ──

  const planSig = mcJobSignature('plan-story', 'story', { story_id: 'string' });
  const valSig = mcJobSignature('validate', 'story', { story_id: 'string' });

  const chainGraph: GraphDefinition = {
    id: 'mc-chain-1',
    nodes: [
      {
        id: 'plan',
        signature: planSig,
        payload: buildMCJobPayload({ type: 'plan-story', story_id: 'S-002' }),
        dependsOn: [],
      },
      {
        id: 'implement',
        signature: implSig,
        payload: buildMCJobPayload({ type: 'implement', story_id: 'S-002' }),
        dependsOn: ['plan'],
      },
      {
        id: 'validate',
        signature: valSig,
        payload: buildMCJobPayload({ type: 'validate', story_id: 'S-002' }),
        dependsOn: ['implement'],
      },
    ],
  };

  const graphId = sink.pushGraph(chainGraph);
  console.log('Submitted MC chain:', graphId);

  // ── Inspect profiles after some runs ──

  setTimeout(() => {
    const profile = sink.inspectProfile(implSig);
    if (profile) {
      console.log('\n--- Implement Profile ---');
      console.log('Samples:', profile.sampleCount);
      console.log('Avg CPU:', Math.round(profile.cpuTicksEWMA));
      console.log('Avg Memory:', Math.round(profile.memBytesEWMA / 1024 / 1024) + 'MB');
      console.log('Avg Wall Time:', Math.round(profile.wallTimeMsEWMA / 1000) + 's');
      console.log('Failure Rate:', (profile.failureRateEWMA * 100).toFixed(1) + '%');
      console.log('Warm?', profile.sampleCount >= 5 ? 'Yes' : 'No (cold defaults apply)');
    }
  }, 60_000);

  // Clean shutdown
  setTimeout(async () => {
    unsub();
    await sink.close();
    console.log('\nShutdown complete');
    process.exit(0);
  }, 120_000);
}

main().catch(console.error);