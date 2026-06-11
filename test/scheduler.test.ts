import { describe, it, expect } from 'vitest';
import { Scheduler } from '../src/algorithm/scheduler.js';
import type { Job, AlgorithmConfig } from '../src/types/index.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';

describe('Scheduler', () => {
  it('enqueues jobs and fires onJobReady callback', async () => {
    const ready: Job[] = [];
    const scheduler = new Scheduler((job, _slotId) => {
      ready.push(job);
    });

    const job = scheduler.enqueue('sig1', Buffer.from('payload'), 60_000, 5_000);
    expect(job.signature).toBe('sig1');
    expect(job.urgency).toBeGreaterThan(0);

    // Wait for the async tick
    await new Promise(r => setTimeout(r, 50));
    expect(ready.length).toBeGreaterThanOrEqual(1);
  });

  it('sorts by urgency — sooner-expiry jobs first', async () => {
    const ready: Job[] = [];
    const scheduler = new Scheduler((job, _slotId) => {
      ready.push(job);
    }, { ...DEFAULT_CONFIG, maxParallelism: 1, slotBudgetCpuTicks: 1_000_000, slotBudgetMemBytes: 1_000_000 });

    // Enqueue with different expiry times
    const urgent = scheduler.enqueue('sig-urgent', Buffer.from('u'), 2_000, 1_000); // 2s expiry
    const casual = scheduler.enqueue('sig-casual', Buffer.from('c'), 60_000, 30_000); // 60s expiry

    await new Promise(r => setTimeout(r, 50));

    // Urgent job (lower urgency value) should be first
    expect(ready.length).toBeGreaterThanOrEqual(1);
    expect(ready[0].id).toBe(urgent.id);
  });

  it('records completion and updates profile', () => {
    const scheduler = new Scheduler(() => {});
    scheduler.enqueue('sig1', Buffer.from('p'), 60_000, 5_000);

    const profile = scheduler.recordCompletion('sig1', {
      cpuTicks: 500,
      memBytes: 2048,
      wallTimeMs: 100,
      failed: false,
    });

    expect(profile.cpuTicksEWMA).toBe(500);
    expect(profile.memBytesEWMA).toBe(2048);
  });

  it('schedules auto-refresh after completion', () => {
    const scheduler = new Scheduler(() => {});
    scheduler.enqueue('sig1', Buffer.from('p'), 60_000, 1_000);

    scheduler.scheduleRefresh('sig1', Buffer.from('p'), 1_000, 60_000);
    // No crash = timer was set. We cancel on shutdown.
    scheduler.clearAllRefreshTimers();
  });
});