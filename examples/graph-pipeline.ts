/**
 * Graph example: DAG-structured job execution
 */
import { QueueSink, computeSignature } from '../src/index.js';
import type { GraphDefinition } from '../src/types/index.js';

async function main() {
  const sink = new QueueSink({ maxParallelism: 3 });

  // Define signatures for each stage
  const planSig = computeSignature({ type: 'Plan', entity: 'story', argSchema: { story_id: 'string' } });
  const implSig = computeSignature({ type: 'Implement', entity: 'story', argSchema: { story_id: 'string' } });
  const valSig = computeSignature({ type: 'Validate', entity: 'story', argSchema: { story_id: 'string' } });

  // Subscribe to all three signatures
  for (const sig of [planSig, implSig, valSig]) {
    sink.subscribe(sig, (event) => {
      if (event.type === 'profile_updated') {
        console.log('[learned]', event.signature.slice(0, 8), 'CPU:', Math.round(event.profile.cpuTicksEWMA));
      }
    });
  }

  // Build a graph: plan → implement → validate
  const graph: GraphDefinition = {
    id: 'pipeline-1',
    nodes: [
      {
        id: 'plan',
        signature: planSig,
        payload: Buffer.from(JSON.stringify({ type: 'plan', story_id: 'S-001' })),
        dependsOn: [],
      },
      {
        id: 'implement',
        signature: implSig,
        payload: Buffer.from(JSON.stringify({ type: 'implement', story_id: 'S-001' })),
        dependsOn: ['plan'],
      },
      {
        id: 'validate',
        signature: valSig,
        payload: Buffer.from(JSON.stringify({ type: 'validate', story_id: 'S-001' })),
        dependsOn: ['implement'],
      },
    ],
  };

  const graphId = sink.pushGraph(graph);
  console.log('Graph submitted:', graphId);

  // Subscribe specifically for graph events
  sink.subscribe(planSig, (event) => {
    if (event.type === 'graph_complete') {
      console.log('Graph complete:', event.graphId);
      console.log('Results:', [...event.results.entries()].map(([k, v]) => k + ': ' + v.toString()).join(', '));
    }
    if (event.type === 'graph_failed') {
      console.error('Graph failed:', event.graphId, 'node:', event.failedNodeId, 'error:', event.error);
    }
  });

  // Fan-out example: plan → [impl-A, impl-B] → validate (fan-in)
  const fanOutGraph: GraphDefinition = {
    id: 'fanout-1',
    nodes: [
      {
        id: 'plan',
        signature: planSig,
        payload: Buffer.from(JSON.stringify({ type: 'plan', story_id: 'S-002' })),
        dependsOn: [],
      },
      {
        id: 'impl-a',
        signature: implSig,
        payload: Buffer.from(JSON.stringify({ type: 'implement', story_id: 'S-002', branch: 'a' })),
        dependsOn: ['plan'],
      },
      {
        id: 'impl-b',
        signature: implSig,
        payload: Buffer.from(JSON.stringify({ type: 'implement', story_id: 'S-002', branch: 'b' })),
        dependsOn: ['plan'],
      },
      {
        id: 'validate',
        signature: valSig,
        payload: Buffer.from(JSON.stringify({ type: 'validate', story_id: 'S-002' })),
        dependsOn: ['impl-a', 'impl-b'],  // fan-in: waits for both
      },
    ],
  };

  const fanOutId = sink.pushGraph(fanOutGraph);
  console.log('Fan-out graph submitted:', fanOutId);

  setTimeout(async () => {
    await sink.close();
    process.exit(0);
  }, 15_000);
}

main().catch(console.error);