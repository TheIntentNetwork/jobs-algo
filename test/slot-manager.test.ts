import { describe, it, expect } from 'vitest';
import { SlotManager } from '../src/algorithm/slot-manager.js';
import type { Job, Profile } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

function makeJob(sig: string, cpu: number, mem: number, sampleCount = 10): Job {
  const profile: Profile = {
    signature: sig,
    cpuTicksEWMA: cpu,
    memBytesEWMA: mem,
    wallTimeMsEWMA: 100,
    failureRateEWMA: 0,
    sampleCount,
    lastUpdated: Date.now(),
    cacheExpiryMs: 60_000,
    refreshRateMs: 5_000,
  };
  return {
    id: sig,
    signature: sig,
    payload: Buffer.alloc(0),
    graphId: null,
    graphNodeId: null,
    predictedProfile: profile,
    actualMetrics: null,
    status: 'queued',
    slotId: null,
    enqueuedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    expiresAt: Date.now() + 60_000,
    urgency: 60_000,
  };
}

describe('SlotManager', () => {
  it('creates new slots for jobs', () => {
    const mgr = new SlotManager({ ...DEFAULT_CONFIG, maxParallelism: 4 });
    const slot = mgr.findOrCreateSlot(makeJob('a', 100, 100));
    expect(slot).not.toBeNull();
    expect(mgr.getSlots().length).toBe(1);
  });

  it('stacks warm jobs on the same slot with best-fit', () => {
    const mgr = new SlotManager({ ...DEFAULT_CONFIG, maxParallelism: 4, slotBudgetCpuTicks: 1000, slotBudgetMemBytes: 1000 });
    const job1 = makeJob('a', 200, 200);
    const slot1 = mgr.findOrCreateSlot(job1)!;
    mgr.assignJob(slot1, job1);

    const job2 = makeJob('b', 200, 200);
    const slot2 = mgr.findOrCreateSlot(job2);
    expect(slot2?.id).toBe(slot1.id);
  });

  it('opens new slot when existing is full', () => {
    const mgr = new SlotManager({ ...DEFAULT_CONFIG, maxParallelism: 4, slotBudgetCpuTicks: 200, slotBudgetMemBytes: 200 });
    const job1 = makeJob('a', 200, 200);
    const slot1 = mgr.findOrCreateSlot(job1)!;
    mgr.assignJob(slot1, job1);

    const job2 = makeJob('b', 200, 200);
    const slot2 = mgr.findOrCreateSlot(job2);
    expect(slot2).not.toBeNull();
    expect(slot2?.id).not.toBe(slot1.id);
  });

  it('cold jobs get their own slot', () => {
    const mgr = new SlotManager({ ...DEFAULT_CONFIG, maxParallelism: 4, slotBudgetCpuTicks: 10000, slotBudgetMemBytes: 10000 });
    const warmJob = makeJob('a', 200, 200, 10);
    const slot1 = mgr.findOrCreateSlot(warmJob)!;
    mgr.assignJob(slot1, warmJob);

    const coldJob = makeJob('b', 200, 200, 0);
    const slot2 = mgr.findOrCreateSlot(coldJob);
    expect(slot2).not.toBeNull();
    expect(slot2?.id).not.toBe(slot1.id);
  });

  it('detects over-budget and resets when slot empties', () => {
    const mgr = new SlotManager({ ...DEFAULT_CONFIG, maxParallelism: 4, overBudgetFactor: 1.5, slotBudgetCpuTicks: 10000, slotBudgetMemBytes: 10000 });
    const job1 = makeJob('a', 100, 100);
    const job2 = makeJob('c', 100, 100); // second job to keep slot alive
    const slot = mgr.findOrCreateSlot(job1)!;
    mgr.assignJob(slot, job1);
    mgr.assignJob(slot, job2);

    // Release job1 with over-budget actuals — slot still has job2 so it stays over-budget
    mgr.releaseJob(slot, job1, 200, 200);
    expect(slot.overBudget).toBe(true);
    expect(slot.activeJobs.length).toBe(1);

    // Release job2 — slot empties and resets
    mgr.releaseJob(slot, job2, 50, 50);
    expect(slot.overBudget).toBe(false);
    expect(slot.usedCpuTicks).toBe(0);
  });

  it('returns null when max parallelism reached and all slots full', () => {
    const mgr = new SlotManager({ ...DEFAULT_CONFIG, maxParallelism: 1, slotBudgetCpuTicks: 200, slotBudgetMemBytes: 200 });
    const job1 = makeJob('a', 200, 200);
    const slot1 = mgr.findOrCreateSlot(job1)!;
    mgr.assignJob(slot1, job1);

    const job2 = makeJob('b', 200, 200);
    const slot2 = mgr.findOrCreateSlot(job2);
    expect(slot2).toBeNull();
  });
});