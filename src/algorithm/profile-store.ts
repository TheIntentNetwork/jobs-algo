import { EWMA } from '../metrics/ewma.js';
import type { Profile, Signature, AlgorithmConfig } from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';

interface ProfileState {
  signature: Signature;
  cpuTicks: EWMA;
  memBytes: EWMA;
  wallTimeMs: EWMA;
  failureRate: EWMA;
  cacheExpiryMs: number;
  refreshRateMs: number;
}

export class ProfileStore {
  private profiles = new Map<Signature, ProfileState>();
  private config: AlgorithmConfig;

  constructor(config: Partial<AlgorithmConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getOrCreate(signature: string, cacheExpiryMs?: number, refreshRateMs?: number): Profile {
    let state = this.profiles.get(signature);
    if (!state) {
      const refresh = refreshRateMs ?? this.config.defaultRefreshRateMs;
      state = {
        signature,
        cpuTicks: new EWMA(this.config.ewmaAlpha, this.config.defaultCpuTicks),
        memBytes: new EWMA(this.config.ewmaAlpha, this.config.defaultMemBytes),
        wallTimeMs: new EWMA(this.config.ewmaAlpha, 0),
        failureRate: new EWMA(this.config.ewmaAlpha, 0),
        cacheExpiryMs: cacheExpiryMs ?? this.config.defaultCacheExpiryMs,
        refreshRateMs: Math.max(1000, refresh),  // min 1 second
      };
      this.profiles.set(signature, state);
    }
    return this.toProfile(state);
  }

  recordRun(signature: string, metrics: { cpuTicks: number; memBytes: number; wallTimeMs: number; failed: boolean }): Profile {
    this.getOrCreate(signature);
    const s = this.profiles.get(signature)!;
    s.cpuTicks.update(metrics.cpuTicks);
    s.memBytes.update(metrics.memBytes);
    s.wallTimeMs.update(metrics.wallTimeMs);
    s.failureRate.update(metrics.failed ? 1 : 0);
    return this.toProfile(s);
  }

  isWarm(signature: string): boolean {
    const state = this.profiles.get(signature);
    if (!state) return false;
    return state.cpuTicks.count() >= this.config.coldStartSamples;
  }

  serializeAll(): string {
    const entries: Array<{
      signature: string;
      cpuTicks: ReturnType<EWMA['toJSON']>;
      memBytes: ReturnType<EWMA['toJSON']>;
      wallTimeMs: ReturnType<EWMA['toJSON']>;
      failureRate: ReturnType<EWMA['toJSON']>;
      cacheExpiryMs: number;
      refreshRateMs: number;
    }> = [];
    for (const [sig, state] of this.profiles) {
      entries.push({
        signature: sig,
        cpuTicks: state.cpuTicks.toJSON(),
        memBytes: state.memBytes.toJSON(),
        wallTimeMs: state.wallTimeMs.toJSON(),
        failureRate: state.failureRate.toJSON(),
        cacheExpiryMs: state.cacheExpiryMs,
        refreshRateMs: state.refreshRateMs,
      });
    }
    return JSON.stringify(entries);
  }

  deserializeAll(data: string): void {
    const entries = JSON.parse(data) as Array<{
      signature: string;
      cpuTicks: { value: number; count: number; alpha: number };
      memBytes: { value: number; count: number; alpha: number };
      wallTimeMs: { value: number; count: number; alpha: number };
      failureRate: { value: number; count: number; alpha: number };
      cacheExpiryMs: number;
      refreshRateMs: number;
    }>;
    for (const entry of entries) {
      this.profiles.set(entry.signature, {
        signature: entry.signature,
        cpuTicks: EWMA.fromJSON(entry.cpuTicks),
        memBytes: EWMA.fromJSON(entry.memBytes),
        wallTimeMs: EWMA.fromJSON(entry.wallTimeMs),
        failureRate: EWMA.fromJSON(entry.failureRate),
        cacheExpiryMs: entry.cacheExpiryMs,
        refreshRateMs: entry.refreshRateMs,
      });
    }
  }

  private toProfile(state: ProfileState): Profile {
    return {
      signature: state.signature,
      cpuTicksEWMA: state.cpuTicks.current(),
      memBytesEWMA: state.memBytes.current(),
      wallTimeMsEWMA: state.wallTimeMs.current(),
      failureRateEWMA: state.failureRate.current(),
      sampleCount: state.cpuTicks.count(),
      lastUpdated: Date.now(),
      cacheExpiryMs: state.cacheExpiryMs,
      refreshRateMs: state.refreshRateMs,
    };
  }
}