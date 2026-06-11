import { JobsAlgorithmImpl } from '../integration/jobs-algorithm.js';
import type { AlgorithmConfig, Signature, GraphDefinition, JobId, GraphId, AlgorithmEvent, MissionControlExecutor, FrontendCacheEntry } from '../types/index.js';

/**
 * QueueSink — the main entry point into the jobs algorithm.
 *
 * Frontend and external systems push jobs here.
 * Supports:
 * - Urgency-sorted parallel execution windows
 * - Client-aware cache push to frontend in-memory
 * - Signature-keyed graph caching layer
 */
export class QueueSink {
  private algorithm: JobsAlgorithmImpl;

  constructor(config: Partial<AlgorithmConfig> = {}) {
    this.algorithm = new JobsAlgorithmImpl(config);
  }

  connectMissionControl(executor: MissionControlExecutor): void {
    this.algorithm.setMissionControl(executor);
  }

  setWorkerScript(path: string): void {
    this.algorithm.setWorkerScriptPath(path);
  }

  /** Push a job into the queue. Jobs are sorted by urgency (expiry/refresh_rate) within execution windows. */
  push(signature: Signature, payload: Buffer, opts?: { cacheExpiryMs?: number; refreshRateMs?: number }): JobId {
    return this.algorithm.enqueue(signature, payload, opts);
  }

  /** Push a graph of jobs into the queue */
  pushGraph(graphDef: GraphDefinition): GraphId {
    return this.algorithm.enqueueGraph(graphDef);
  }

  /**
   * Subscribe to a signature's events.
   * This also registers the client in the reference count, so the system
   * knows to push cache to frontend in-memory when the entry expires
   * rather than evicting it.
   */
  subscribe(signature: Signature, handler: (event: AlgorithmEvent) => void): () => void {
    return this.algorithm.subscribe(signature, handler);
  }

  inspectProfile(signature: Signature) {
    return this.algorithm.getProfile(signature);
  }

  async close(): Promise<void> {
    return this.algorithm.shutdown();
  }
}