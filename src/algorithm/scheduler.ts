import type { Job, JobId, Profile, Signature, AlgorithmConfig } from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';
import { SlotManager } from './slot-manager.js';
import { ProfileStore } from './profile-store.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Scheduler with urgency-based priority: jobs closer to expiry are scheduled first.
 * Within a parallel execution window, jobs are sorted by urgency (time-until-expiry)
 * so that time-critical results are refreshed before they go stale.
 */
export class Scheduler {
  private queue: Job[] = [];
  private slotManager: SlotManager;
  private profileStore: ProfileStore;
  private config: AlgorithmConfig;
  private onJobReady: (job: Job, slotId: number) => void;
  private tickScheduled = false;
  /** Tracks refresh timers per signature for auto-re-enqueue */
  private refreshTimers = new Map<Signature, ReturnType<typeof setTimeout>>();

  constructor(
    onJobReady: (job: Job, slotId: number) => void,
    config: Partial<AlgorithmConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.slotManager = new SlotManager(this.config);
    this.profileStore = new ProfileStore(this.config);
    this.onJobReady = onJobReady;
  }

  getProfileStore(): ProfileStore {
    return this.profileStore;
  }

  getSlotManager(): SlotManager {
    return this.slotManager;
  }

  enqueue(signature: Signature, payload: Buffer, cacheExpiryMs?: number, refreshRateMs?: number): Job {
    const profile = this.profileStore.getOrCreate(signature, cacheExpiryMs, refreshRateMs);
    const now = Date.now();
    const expiresAt = now + profile.cacheExpiryMs;
    const urgency = expiresAt - now; // lower = more urgent

    const job: Job = {
      id: uuidv4(),
      signature,
      payload,
      graphId: null,
      graphNodeId: null,
      predictedProfile: profile,
      actualMetrics: null,
      status: 'queued',
      slotId: null,
      enqueuedAt: now,
      startedAt: null,
      completedAt: null,
      expiresAt,
      urgency,
    };
    this.queue.push(job);
    this.scheduleTick();
    return job;
  }

  recordCompletion(signature: string, metrics: { cpuTicks: number; memBytes: number; wallTimeMs: number; failed: boolean }): Profile {
    this.profileStore.recordRun(signature, metrics);
    return this.profileStore.getOrCreate(signature);
  }

  /** Release a slot after a job completes or fails, using actual resource usage */
  releaseSlot(job: Job, actualCpu: number, actualMem: number): void {
    if (job.slotId === null) return;
    const slot = this.slotManager.getSlots().find(s => s.id === job.slotId);
    if (!slot) return;
    this.slotManager.releaseJob(slot, job, actualCpu, actualMem);
    // After freeing a slot, schedule a tick so queued jobs can be dispatched
    this.scheduleTick();
  }

  getJob(id: JobId): Job | undefined {
    return this.queue.find(j => j.id === id);
  }

  /** Schedule automatic re-execution at the profile's refresh rate */
  scheduleRefresh(signature: Signature, payload: Buffer, refreshRateMs: number, cacheExpiryMs: number): void {
    // Clear existing timer if any
    const existing = this.refreshTimers.get(signature);
    if (existing) clearTimeout(existing);

    const rate = Math.max(1000, refreshRateMs); // min 1 second
    const timer = setTimeout(() => {
      this.refreshTimers.delete(signature);
      this.enqueue(signature, payload, cacheExpiryMs, rate);
    }, rate);

    this.refreshTimers.set(signature, timer);
  }

  /** Cancel a scheduled refresh */
  cancelRefresh(signature: Signature): void {
    const timer = this.refreshTimers.get(signature);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(signature);
    }
  }

  clearAllRefreshTimers(): void {
    for (const [, timer] of this.refreshTimers) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
  }

  private tick(): void {
    this.tickScheduled = false;
    if (this.queue.length === 0) return;

    // Primary sort: urgency ascending (soonest-expiry first)
    // Secondary sort: cost descending (expensive jobs first within same urgency)
    const sorted = [...this.queue]
      .filter(j => j.status === 'queued')
      .sort((a, b) => {
        const urgencyDiff = a.urgency - b.urgency;
        if (Math.abs(urgencyDiff) > 1000) return urgencyDiff; // 1s threshold for urgency grouping
        return this.costHeuristic(b.predictedProfile) - this.costHeuristic(a.predictedProfile);
      });

    const assigned: JobId[] = [];

    for (const job of sorted) {
      const slot = this.slotManager.findOrCreateSlot(job);
      if (!slot) continue;

      this.slotManager.assignJob(slot, job);
      assigned.push(job.id);
      this.onJobReady(job, slot.id);
    }

    this.queue = this.queue.filter(j => !assigned.includes(j.id));

    if (this.queue.some(j => j.status === 'queued')) {
      this.scheduleTick();
    }
  }

  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    setTimeout(() => this.tick(), 0);
  }

  private costHeuristic(profile: Profile): number {
    return profile.cpuTicksEWMA * this.config.cpuWeight
         + profile.memBytesEWMA * this.config.memWeight;
  }
}
