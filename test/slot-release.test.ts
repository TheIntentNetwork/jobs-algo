import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/algorithm/scheduler.js';
import type { Job, AlgorithmConfig, CancelToken, MetricsCollector } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

describe('Scheduler slot release', () => {
  it('frees slots when jobs complete, allowing queued jobs to run', async () => {
    const completed: string[] = [];
    const config: Partial<AlgorithmConfig> = {
      ...DEFAULT_CONFIG,
      maxParallelism: 2,
      slotBudgetCpuTicks: 1_000_000,
      slotBudgetMemBytes: 1_000_000,
    };

    const scheduler = new Scheduler((job, _slotId) => {
      setTimeout(() => {
        scheduler.recordCompletion(job.signature, {
          cpuTicks: 500,
          memBytes: 32768,
          wallTimeMs: 10,
          failed: false,
        });
        scheduler.releaseSlot(job, 500, 32768);
        completed.push(job.signature);
      }, 20);
    }, config);

    scheduler.enqueue('sig-a', Buffer.from('a'), 5_000, 1_000);
    scheduler.enqueue('sig-b', Buffer.from('b'), 10_000, 2_000);
    scheduler.enqueue('sig-c', Buffer.from('c'), 15_000, 3_000);
    scheduler.enqueue('sig-d', Buffer.from('d'), 20_000, 4_000);

    await new Promise(r => setTimeout(r, 300));
    expect(completed.length).toBe(4);
  });

  it('releaseSlot frees a slot and triggers dispatch of queued jobs', async () => {
    const ready: Job[] = [];
    const config: Partial<AlgorithmConfig> = {
      ...DEFAULT_CONFIG,
      maxParallelism: 1,
      slotBudgetCpuTicks: 1_000_000,
      slotBudgetMemBytes: 1_000_000,
    };

    const scheduler = new Scheduler((job, _slotId) => {
      ready.push(job);
    }, config);

    const job1 = scheduler.enqueue('sig-a', Buffer.from('a'), 60_000, 5_000);

    await new Promise(r => setTimeout(r, 20));
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe(job1.id);

    const job2 = scheduler.enqueue('sig-b', Buffer.from('b'), 60_000, 5_000);

    await new Promise(r => setTimeout(r, 20));
    expect(ready.length).toBe(1); // still blocked

    scheduler.recordCompletion('sig-a', { cpuTicks: 100, memBytes: 100, wallTimeMs: 10, failed: false });
    scheduler.releaseSlot(job1, 100, 100);

    await new Promise(r => setTimeout(r, 20));
    expect(ready.length).toBe(2);
    expect(ready[1].id).toBe(job2.id);
  });

  it('slot is reusable after releaseSlot', async () => {
    const config: Partial<AlgorithmConfig> = {
      ...DEFAULT_CONFIG,
      maxParallelism: 1,
      slotBudgetCpuTicks: 200,
      slotBudgetMemBytes: 200,
    };

    const scheduler = new Scheduler(() => {}, config);
    const job1 = scheduler.enqueue('sig-a', Buffer.from('a'), 60_000, 5_000);

    await new Promise(r => setTimeout(r, 20));

    const slotManager = scheduler.getSlotManager();
    expect(slotManager.getSlots().length).toBe(1);
    expect(slotManager.getSlots()[0].activeJobs.length).toBe(1);

    scheduler.releaseSlot(job1, 100, 100);

    expect(slotManager.getSlots()[0].activeJobs.length).toBe(0);
    expect(slotManager.getSlots()[0].usedCpuTicks).toBe(0);
  });
});
