import type {
  JobsAlgorithm,
  AlgorithmEvent,
  AlgorithmConfig,
  Signature,
  GraphId,
  GraphDefinition,
  JobId,
  Profile,
  MissionControlExecutor,
  Job,
} from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';
import { Scheduler } from '../algorithm/scheduler.js';
import { GraphEngine } from '../graph/graph-engine.js';
import { GraphJobTracker } from '../graph/graph-job-tracker.js';
import { FileCache, type CacheExpiryEvent } from '../cache/file-cache.js';
import { EventBus } from '../push/event-bus.js';
import { WorkerExecutor } from '../worker/executor.js';
import { MetricsCollectorImpl } from '../metrics/collector.js';
import { v4 as uuidv4 } from 'uuid';

export class JobsAlgorithmImpl implements JobsAlgorithm {
  private config: AlgorithmConfig;
  private scheduler: Scheduler;
  private graphEngine: GraphEngine;
  private graphJobTracker: GraphJobTracker;
  private fileCache: FileCache;
  private eventBus: EventBus;
  private workerExecutor: WorkerExecutor;
  private cancelTokens = new Map<JobId, { cancel: () => void }>();
  private jobMetrics = new Map<JobId, MetricsCollectorImpl>();
  private missionControl: MissionControlExecutor | null = null;
  private workerScriptPath = '';
  private shutDown = false;
  private signaturePayloads = new Map<Signature, Buffer>();
  private signatureConfig = new Map<Signature, { cacheExpiryMs: number; refreshRateMs: number }>();

  constructor(config: Partial<AlgorithmConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fileCache = new FileCache(this.config.cacheDir, this.config.sweepIntervalMs);
    this.eventBus = new EventBus();

    this.scheduler = new Scheduler(
      (job, slotId) => this.onJobReady(job, slotId),
      this.config,
    );

    this.graphEngine = new GraphEngine(
      (graphId, nodeId, signature, payload) => this.onGraphNodeReady(graphId, nodeId, signature, payload),
      this.config,
    );

    this.graphJobTracker = new GraphJobTracker();
    this.workerExecutor = new WorkerExecutor();

    this.fileCache.on('expired', (event: CacheExpiryEvent) => {
      this.handleCacheExpiry(event);
    });

    this.warmProfiles();
  }

  setMissionControl(executor: MissionControlExecutor): void {
    this.missionControl = executor;
  }

  setWorkerScriptPath(path: string): void {
    this.workerScriptPath = path;
  }

  enqueue(signature: Signature, payload: Buffer, opts?: { cacheExpiryMs?: number; refreshRateMs?: number }): JobId {
    const expiryMs = opts?.cacheExpiryMs ?? this.config.defaultCacheExpiryMs;
    const refreshMs = Math.max(1000, opts?.refreshRateMs ?? this.config.defaultRefreshRateMs);

    this.eventBus.markStale(signature);
    this.fileCache.markStale(signature);

    this.signaturePayloads.set(signature, payload);
    this.signatureConfig.set(signature, { cacheExpiryMs: expiryMs, refreshRateMs: refreshMs });

    const job = this.scheduler.enqueue(signature, payload, expiryMs, refreshMs);
    return job.id;
  }

  enqueueGraph(graphDef: GraphDefinition): GraphId {
    const graphId = graphDef.id || uuidv4();

    for (const node of graphDef.nodes) {
      this.eventBus.markStale(node.signature);
    }

    this.graphEngine.submit({ ...graphDef, id: graphId });
    return graphId;
  }

  subscribe(signature: Signature, handler: (event: AlgorithmEvent) => void): () => void {
    return this.eventBus.subscribe(handler, signature);
  }

  getProfile(signature: Signature): Profile | null {
    return this.scheduler.getProfileStore().getOrCreate(signature);
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;

    for (const [, token] of this.cancelTokens) {
      token.cancel();
    }
    this.cancelTokens.clear();
    this.jobMetrics.clear();
    this.signaturePayloads.clear();
    this.signatureConfig.clear();

    this.scheduler.clearAllRefreshTimers();
    this.workerExecutor.terminateAll();
    this.fileCache.shutdown();
  }

  private handleCacheExpiry(event: CacheExpiryEvent): void {
    if (this.shutDown) return;

    if (this.eventBus.hasClients(event.signature)) {
      this.eventBus.emit({
        type: 'cache_push',
        signature: event.signature,
        result: this.eventBus.getCachedResult(event.signature) || Buffer.alloc(0),
        expiresAt: 0,
      });

      const config = this.signatureConfig.get(event.signature);
      const payload = this.signaturePayloads.get(event.signature);
      if (config && payload) {
        this.scheduler.scheduleRefresh(
          event.signature,
          payload,
          config.refreshRateMs,
          config.cacheExpiryMs,
        );
      }
    } else {
      this.eventBus.emit({
        type: 'cache_expire',
        signature: event.signature,
      });
    }
  }

  private onJobReady(job: Job, _slotId: number): void {
    if (this.shutDown) return;
    job.startedAt = Date.now();

    const metrics = new MetricsCollectorImpl();
    this.jobMetrics.set(job.id, metrics);

    if (this.missionControl) {
      const token = this.missionControl.execute(
        job.payload,
        metrics,
        (result) => this.onJobComplete(job, result, metrics),
        (err) => this.onJobFailed(job, err),
      );
      this.cancelTokens.set(job.id, token);
    } else if (this.workerScriptPath) {
      const token = this.workerExecutor.execute(
        this.workerScriptPath,
        job.payload,
        metrics,
        (result) => this.onJobComplete(job, result, metrics),
        (err) => this.onJobFailed(job, err),
      );
      this.cancelTokens.set(job.id, token);
    } else {
      this.onJobFailed(job, new Error('No MissionControlExecutor registered and no worker script path set'));
    }
  }

  private onJobComplete(job: Job, result: Buffer, metrics: MetricsCollectorImpl): void {
    this.cancelTokens.delete(job.id);
    this.jobMetrics.delete(job.id);
    const collected = metrics.collect();

    // Release the slot so queued jobs can be dispatched
    this.scheduler.releaseSlot(job, collected.cpuTicks, collected.memBytes);

    const profile = this.scheduler.recordCompletion(job.signature, {
      cpuTicks: collected.cpuTicks,
      memBytes: collected.memBytes,
      wallTimeMs: collected.wallTimeMs,
      failed: false,
    });

    job.status = 'complete';
    job.completedAt = Date.now();

    this.fileCache.saveProfile(profile);
    this.fileCache.saveResult(job.signature, job.id, result, profile.cacheExpiryMs, profile.refreshRateMs);

    const cacheEntry = this.eventBus.getCacheEntry(job.signature);
    if (cacheEntry) {
      cacheEntry.result = result;
      cacheEntry.expiresAt = Date.now() + profile.cacheExpiryMs;
      cacheEntry.refreshRateMs = profile.refreshRateMs;
      cacheEntry.lastPushedAt = Date.now();
    }

    // Only schedule cache refresh for standalone jobs, not graph nodes.
    // Graph nodes are one-shot pipeline steps that should not be refreshed.
    const payload = this.signaturePayloads.get(job.signature);
    if (payload && !job.graphId) {
      this.scheduler.scheduleRefresh(
        job.signature,
        payload,
        profile.refreshRateMs,
        profile.cacheExpiryMs,
      );
    }

    if (job.graphId) {
      const nodeId = this.graphJobTracker.getNodeId(job.id);
      if (nodeId && job.graphId) {
        this.fileCache.saveGraphResult(job.graphId, nodeId, result, profile.cacheExpiryMs, profile.refreshRateMs);

        const graph = this.graphEngine.advance(job.graphId, nodeId, result);
        if (graph && graph.status === 'completed') {
          this.eventBus.emit({
            type: 'graph_complete',
            graphId: job.graphId,
            results: graph.results,
          });
          this.graphJobTracker.cleanup(job.graphId);
        }
      }
    }

    this.eventBus.emit({
      type: 'job_complete',
      jobId: job.id,
      signature: job.signature,
      result,
    });

    this.eventBus.emit({
      type: 'profile_updated',
      signature: job.signature,
      profile,
    });
  }

  private onJobFailed(job: Job, err: Error): void {
    this.cancelTokens.delete(job.id);

    // Use the real metrics from onJobReady, not a fresh empty collector.
    const metrics = this.jobMetrics.get(job.id) || new MetricsCollectorImpl();
    this.jobMetrics.delete(job.id);
    const collected = metrics.collect();

    // Release the slot so queued jobs can be dispatched
    this.scheduler.releaseSlot(job, collected.cpuTicks || 0, collected.memBytes || 0);

    this.scheduler.recordCompletion(job.signature, {
      cpuTicks: collected.cpuTicks || 0,
      memBytes: collected.memBytes || 0,
      wallTimeMs: collected.wallTimeMs || 0,
      failed: true,
    });

    job.status = 'failed';

    if (job.graphId) {
      const nodeId = this.graphJobTracker.getNodeId(job.id);
      if (nodeId) {
        this.graphEngine.failGraph(job.graphId, nodeId, err.message);

        const allJobIds = this.graphJobTracker.getAllJobIds(job.graphId);
        for (const jid of allJobIds) {
          const token = this.cancelTokens.get(jid);
          if (token) {
            token.cancel();
            this.cancelTokens.delete(jid);
          }
        }

        this.eventBus.emit({
          type: 'graph_failed',
          graphId: job.graphId,
          failedNodeId: nodeId,
          error: err.message,
        });

        this.graphJobTracker.cleanup(job.graphId);
        return;
      }
    }

    this.eventBus.emit({
      type: 'job_failed',
      jobId: job.id,
      signature: job.signature,
      error: err.message,
    });
  }

  private onGraphNodeReady(graphId: GraphId, nodeId: string, signature: Signature, payload: Buffer): void {
    const job = this.scheduler.enqueue(signature, payload);

    if (job) {
      job.graphId = graphId;
      job.graphNodeId = nodeId;
    }
    this.graphJobTracker.register(graphId, nodeId, job.id, signature);
  }

  private warmProfiles(): void {
    // Profiles loaded lazily via getOrCreate on first enqueue
  }
}

