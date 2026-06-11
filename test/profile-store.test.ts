import { describe, it, expect } from 'vitest';
import { ProfileStore } from '../src/algorithm/profile-store.js';

describe('ProfileStore', () => {
  it('creates cold profiles with conservative defaults', () => {
    const store = new ProfileStore();
    const profile = store.getOrCreate('sig1');
    expect(profile.sampleCount).toBe(0);
    expect(profile.cpuTicksEWMA).toBeGreaterThan(0);
    expect(profile.refreshRateMs).toBeGreaterThanOrEqual(1000);
  });

  it('warms up after enough samples', () => {
    const store = new ProfileStore({ coldStartSamples: 3 });
    store.getOrCreate('sig1');
    store.recordRun('sig1', { cpuTicks: 500, memBytes: 1024, wallTimeMs: 100, failed: false });
    store.recordRun('sig1', { cpuTicks: 600, memBytes: 2048, wallTimeMs: 120, failed: false });
    expect(store.isWarm('sig1')).toBe(false);
    store.recordRun('sig1', { cpuTicks: 550, memBytes: 1536, wallTimeMs: 110, failed: false });
    expect(store.isWarm('sig1')).toBe(true);
  });

  it('tracks failure rate', () => {
    const store = new ProfileStore({ ewmaAlpha: 0.5 });
    store.getOrCreate('sig1');
    store.recordRun('sig1', { cpuTicks: 100, memBytes: 100, wallTimeMs: 10, failed: true });
    const profile = store.recordRun('sig1', { cpuTicks: 100, memBytes: 100, wallTimeMs: 10, failed: false });
    expect(profile.failureRateEWMA).toBeGreaterThan(0);
    expect(profile.failureRateEWMA).toBeLessThan(1);
  });

  it('enforces minimum refresh rate of 1 second', () => {
    const store = new ProfileStore();
    const profile = store.getOrCreate('sig1', 60_000, 100);
    expect(profile.refreshRateMs).toBe(1000);
  });

  it('serializes and deserializes', () => {
    const store = new ProfileStore({ coldStartSamples: 3 });
    store.getOrCreate('sig1');
    store.recordRun('sig1', { cpuTicks: 500, memBytes: 1024, wallTimeMs: 100, failed: false });
    store.recordRun('sig1', { cpuTicks: 600, memBytes: 2048, wallTimeMs: 120, failed: false });
    store.recordRun('sig1', { cpuTicks: 550, memBytes: 1536, wallTimeMs: 110, failed: false });
    const data = store.serializeAll();

    const store2 = new ProfileStore({ coldStartSamples: 3 });
    store2.deserializeAll(data);
    expect(store2.isWarm('sig1')).toBe(true);
  });
});