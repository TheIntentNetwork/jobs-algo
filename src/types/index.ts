// ── Core type definitions for the jobs algorithm ──

/** Deterministic hash of a job's structural identity (type + entity + arg schema, not values) */
export type Signature = string;

/** Unique job identifier */
export type JobId = string;

/** Unique graph identifier */
export type GraphId = string;

/** Node identifier within a graph */
export type NodeId = string;

/** Slot (thread) identifier */
export type SlotId = number;

// ── Profile ──

export interface Profile {
  signature: Signature;
  cpuTicksEWMA: number;
  memBytesEWMA: number;
  wallTimeMsEWMA: number;
  failureRateEWMA: number;
  sampleCount: number;
  lastUpdated: number;
  cacheExpiryMs: number;
  refreshRateMs: number;   // how often to re-execute (min 1000ms)
}

// ── Job ──

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface Job {
  id: JobId;
  signature: Signature;
  payload: Buffer;
  graphId: GraphId | null;
  graphNodeId: NodeId | null;
  predictedProfile: Profile;
  actualMetrics: Metrics | null;
  status: JobStatus;
  slotId: SlotId | null;
  enqueuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** When this job's cached result expires (epoch ms) */
  expiresAt: number;
  /** How urgently this job needs to run — lower = more urgent (ms until expiry) */
  urgency: number;
}

// ── Metrics ──

export interface Metrics {
  cpuTicks: number;
  memBytes: number;
  wallTimeMs: number;
}

// ── Slot ──

export interface Slot {
  id: SlotId;
  budgetCpuTicks: number;
  budgetMemBytes: number;
  usedCpuTicks: number;
  usedMemBytes: number;
  activeJobs: Job[];
  overBudget: boolean;
}

// ── Graph ──

export type GraphStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface GraphNode {
  id: NodeId;
  signature: Signature;
  payload: Buffer;
  dependsOn: NodeId[];
}

export interface Graph {
  id: GraphId;
  nodes: Map<NodeId, GraphNode>;
  completedNodes: Set<NodeId>;
  failedNodes: Set<NodeId>;
  readyQueue: NodeId[];
  status: GraphStatus;
  results: Map<NodeId, Buffer>;
}

export interface GraphDefinition {
  id: GraphId;
  nodes: GraphNode[];
}

// ── Events ──

export type AlgorithmEvent =
  | { type: 'job_complete'; jobId: JobId; signature: Signature; result: Buffer }
  | { type: 'job_failed'; jobId: JobId; signature: Signature; error: string }
  | { type: 'graph_complete'; graphId: GraphId; results: Map<NodeId, Buffer> }
  | { type: 'graph_failed'; graphId: GraphId; failedNodeId: NodeId; error: string }
  | { type: 'profile_updated'; signature: Signature; profile: Profile }
  | { type: 'cache_push'; signature: Signature; result: Buffer; expiresAt: number }
  | { type: 'cache_expire'; signature: Signature };

// ── Configuration ──

export interface AlgorithmConfig {
  maxParallelism: number;
  slotBudgetCpuTicks: number;
  slotBudgetMemBytes: number;
  ewmaAlpha: number;
  coldStartSamples: number;
  overBudgetFactor: number;
  defaultCpuTicks: number;
  defaultMemBytes: number;
  sweepIntervalMs: number;
  cacheDir: string;
  graphMaxNodes: number;
  cpuWeight: number;
  memWeight: number;
  defaultRefreshRateMs: number;   // default refresh interval (min 1000ms)
  defaultCacheExpiryMs: number;    // default cache TTL
}

export const DEFAULT_CONFIG: AlgorithmConfig = {
  maxParallelism: 0,
  slotBudgetCpuTicks: 1_000_000,
  slotBudgetMemBytes: 512 * 1024 * 1024,
  ewmaAlpha: 0.3,
  coldStartSamples: 5,
  overBudgetFactor: 2.0,
  defaultCpuTicks: 100_000,
  defaultMemBytes: 64 * 1024 * 1024,
  sweepIntervalMs: 60_000,
  cacheDir: '.cache',
  graphMaxNodes: 10_000,
  cpuWeight: 1.0,
  memWeight: 1.0,
  defaultRefreshRateMs: 5_000,     // 5 seconds
  defaultCacheExpiryMs: 60_000,    // 1 minute
};

// ── Integration Kit ──

export interface MissionControlExecutor {
  execute(
    payload: Buffer,
    metrics: MetricsCollector,
    done: (result: Buffer) => void,
    error: (err: Error) => void
  ): CancelToken;
}

export interface CancelToken {
  cancel(): void;
}

export interface MetricsCollector {
  recordCpu(ticks: number): void;
  recordMem(bytes: number): void;
  startWallTimer(): void;
}

export interface JobsAlgorithm {
  enqueue(signature: Signature, payload: Buffer, opts?: JobOptions): JobId;
  enqueueGraph(graphDef: GraphDefinition): GraphId;
  subscribe(signature: Signature, handler: (event: AlgorithmEvent) => void): () => void;
  getProfile(signature: Signature): Profile | null;
  shutdown(): Promise<void>;
}

export interface JobOptions {
  cacheExpiryMs?: number;
  refreshRateMs?: number;   // min 1000ms
}

// ── Cache Meta ──

export interface CacheMeta {
  cacheExpiryMs: number;
  refreshRateMs: number;
  createdAt: number;
  signature: Signature;
  jobId?: JobId;
  graphId?: GraphId;
}

// ── Frontend Graph Cache Entry ──

export interface FrontendCacheEntry {
  signature: Signature;
  result: Buffer;
  expiresAt: number;
  refreshRateMs: number;
  clientCount: number;
  lastPushedAt: number;
}