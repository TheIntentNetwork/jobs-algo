/**
 * Bridge: connects the jobs-algo QueueSink to MC via the MCAdapter.
 *
 * This is the wiring layer that makes the algorithm drive MC's job execution
 * without the algorithm needing to know MC's internals.
 *
 * Usage:
 *   const sink = createMCBridge({
 *     projectRoot: 'C:\\Users\\Bryan\\Source\\intent-network-mission-control',
 *     projectId: 'mc-platform',
 *   });
 *
 *   const jobId = sink.push(signature, payload, { cacheExpiryMs: 60000, refreshRateMs: 5000 });
 */

import { QueueSink } from '../../queue/sink.js';
import { MCAdapter, type MCAdapterConfig } from './mc-adapter.js';
import type { AlgorithmConfig, Signature, AlgorithmEvent } from '../../types/index.js';
import { computeSignature } from '../../algorithm/signature.js';

export interface MCBridgeConfig extends MCAdapterConfig {
  /** Algorithm configuration (passed to QueueSink) */
  algoConfig?: Partial<AlgorithmConfig>;
}

/**
 * Create a QueueSink pre-wired to Mission Control.
 *
 * The MCAdapter is registered as the MissionControlExecutor,
 * so all jobs pushed through this sink are executed by MC.
 */
export function createMCBridge(config: MCBridgeConfig): QueueSink {
  const sink = new QueueSink(config.algoConfig);
  const adapter = new MCAdapter(config);
  sink.connectMissionControl(adapter);
  return sink;
}

/**
 * Build a job signature from an MC job type definition.
 *
 * The signature captures the structural identity of the job type
 * (type name + entity kind + argument schema shape) so the algorithm
 * can learn resource profiles per signature.
 */
export function mcJobSignature(
  type: string,
  entity: string,
  argSchema: Record<string, string>,
): Signature {
  return computeSignature({ type, entity, argSchema });
}

/**
 * Build an MC-compatible job payload from algorithm inputs.
 *
 * This translates the algorithm's (signature + payload) into the
 * MC submission format that the MCAdapter expects.
 */
export function buildMCJobPayload(spec: {
  type: string;
  story_id?: string;
  feature_id?: string;
  epic_id?: string;
  chain_id?: string;
  stage_id?: string;
  item_key?: string;
  prompt?: string;
}): Buffer {
  return Buffer.from(JSON.stringify(spec), 'utf8');
}

/**
 * Helper: subscribe to MC bridge events and log them.
 * Useful for debugging and observability.
 */
export function logMCBridgeEvents(sink: QueueSink, signature: Signature): () => void {
  return sink.subscribe(signature, (event: AlgorithmEvent) => {
    switch (event.type) {
      case 'job_complete':
        console.log('[mc-bridge] job complete:', event.jobId, 'sig:', event.signature);
        break;
      case 'job_failed':
        console.error('[mc-bridge] job failed:', event.jobId, 'error:', event.error);
        break;
      case 'graph_complete':
        console.log('[mc-bridge] graph complete:', event.graphId);
        break;
      case 'graph_failed':
        console.error('[mc-bridge] graph failed:', event.graphId, 'node:', event.failedNodeId, 'error:', event.error);
        break;
      case 'cache_push':
        console.log('[mc-bridge] cache push:', event.signature);
        break;
      case 'cache_expire':
        console.log('[mc-bridge] cache expire:', event.signature);
        break;
      case 'profile_updated':
        console.log('[mc-bridge] profile updated:', event.signature);
        break;
    }
  });
}