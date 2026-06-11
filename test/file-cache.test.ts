import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileCache, type CacheExpiryEvent } from '../src/cache/file-cache.js';
import type { Profile } from '../src/types/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-algo-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeProfile(sig: string, expiryMs = 60_000, refreshMs = 5_000): Profile {
  return {
    signature: sig,
    cpuTicksEWMA: 500,
    memBytesEWMA: 1024,
    wallTimeMsEWMA: 100,
    failureRateEWMA: 0,
    sampleCount: 10,
    lastUpdated: Date.now(),
    cacheExpiryMs: expiryMs,
    refreshRateMs: refreshMs,
  };
}

describe('FileCache', () => {
  it('saves and loads profiles with headers/footers', () => {
    const cache = new FileCache(tmpDir, 999999);
    const profile = makeProfile('abcdef1234');
    cache.saveProfile(profile);

    const loaded = cache.loadProfile('abcdef1234');
    expect(loaded).not.toBeNull();
    expect(loaded!.cpuTicksEWMA).toBe(500);
    expect(loaded!.refreshRateMs).toBe(5_000);

    cache.shutdown();
  });

  it('saves and loads results with headers/footers', () => {
    const cache = new FileCache(tmpDir, 999999);
    const result = Buffer.from('hello world');
    cache.saveResult('abcdef1234', 'job-1', result, 60_000, 5_000);

    const loaded = cache.loadResult('job-1', 'abcdef1234');
    expect(loaded).not.toBeNull();
    expect(loaded!.toString()).toBe('hello world');

    cache.shutdown();
  });

  it('expires profiles past their TTL', async () => {
    const cache = new FileCache(tmpDir, 999999);
    const profile = makeProfile('abcdef1234', 50); // 50ms expiry
    cache.saveProfile(profile);

    // Wait for proactive expiry timer to fire
    await new Promise(r => setTimeout(r, 200));

    const loaded = cache.loadProfile('abcdef1234');
    expect(loaded).toBeNull();

    cache.shutdown();
  });

  it('emits expired event on cache expiry', async () => {
    const cache = new FileCache(tmpDir, 999999);
    const expired: CacheExpiryEvent[] = [];
    cache.on('expired', (e) => expired.push(e));

    const profile = makeProfile('abcdef1234', 50);
    cache.saveProfile(profile);

    await new Promise(r => setTimeout(r, 200));

    expect(expired.length).toBeGreaterThanOrEqual(1);
    expect(expired[0].signature).toBe('abcdef1234');

    cache.shutdown();
  });

  it('marks stale results for a signature', () => {
    const cache = new FileCache(tmpDir, 999999);
    cache.saveResult('abcdef1234', 'job-1', Buffer.from('data'), 60_000, 5_000);
    cache.markStale('abcdef1234');

    const loaded = cache.loadResult('job-1', 'abcdef1234');
    expect(loaded).toBeNull();

    cache.shutdown();
  });

  it('persists graph results', () => {
    const cache = new FileCache(tmpDir, 999999);
    cache.saveGraphResult('graph-1', 'node-a', Buffer.from('result'), 60_000, 5_000);

    const graphDir = path.join(tmpDir, 'graphs', 'graph-1');
    expect(fs.existsSync(path.join(graphDir, 'node-a.result'))).toBe(true);
    expect(fs.existsSync(path.join(graphDir, 'graph.meta'))).toBe(true);

    cache.shutdown();
  });
});