// ── Public API ──
export { JobsAlgorithmImpl } from './integration/jobs-algorithm.js';
export { QueueSink } from './queue/sink.js';
export { Scheduler } from '../src/algorithm/scheduler.js';
export { ProfileStore } from './algorithm/profile-store.js';
export { SlotManager } from './algorithm/slot-manager.js';
export { computeSignature } from './algorithm/signature.js';
export { GraphEngine } from './graph/graph-engine.js';
export { GraphJobTracker } from './graph/graph-job-tracker.js';
export { FileCache, type CacheExpiryEvent } from './cache/file-cache.js';
export { EventBus } from './push/event-bus.js';
export { WorkerExecutor } from './worker/executor.js';
export { MetricsCollectorImpl } from './metrics/collector.js';
export { EWMA } from './metrics/ewma.js';

// MC Integration
export { MCAdapter, type MCAdapterConfig } from './integration/mc/mc-adapter.js';
export { createMCBridge, mcJobSignature, buildMCJobPayload, logMCBridgeEvents, type MCBridgeConfig } from './integration/mc/mc-bridge.js';
export type {
  MCJobState, MCJobSpec, MCJobTypeDefinition,
  MCStage, MCWorkflow, MCChain,
  MCIntegrationManifest, MCProjectContext,
} from './integration/mc/mc-types.js';
export { MC_TERMINAL_STATES } from './integration/mc/mc-types.js';

export { OllamaDirectExecutor, ollamaMCEnv, type OllamaDirectConfig } from './integration/ollama/ollama-executor.js';
export { runOllamaTest } from './integration/ollama/ollama-test-harness.js';

export type {
  Signature, JobId, GraphId, NodeId, SlotId,
  Profile, Job, JobStatus, Metrics,
  Slot, Graph, GraphNode, GraphDefinition, GraphStatus,
  AlgorithmEvent, AlgorithmConfig, CacheMeta,
  MissionControlExecutor, CancelToken, MetricsCollector,
  JobsAlgorithm, JobOptions, FrontendCacheEntry,
} from './types/index.js';

export { DEFAULT_CONFIG } from './types/index.js';
