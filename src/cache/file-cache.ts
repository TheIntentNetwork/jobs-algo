import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Profile, Signature, CacheMeta, JobId, GraphId } from '../types/index.js';

const PROFILE_HEADER = '---JOBS-ALGO-PROFILE-v1---';
const PROFILE_FOOTER = '---END---';
const META_HEADER = '---JOBS-ALGO-META-v1---';
const META_FOOTER = '---END---';
const RESULT_HEADER = '---JOBS-ALGO-RESULT-v1---';
const RESULT_FOOTER = '---END---';

export interface CacheExpiryEvent {
  signature: Signature;
  jobId?: JobId;
  graphId?: GraphId;
}

/**
 * File-based cache with:
 * - Header/footer conventions for structured files
 * - Directory sharding by signature prefix
 * - Auto-expiry via file watcher + periodic sweep
 * - Emits 'expired' events so the system can react (push to frontend or evict)
 */
export class FileCache extends EventEmitter {
  private cacheDir: string;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepIntervalMs: number;
  private watchers: fs.FSWatcher[] = [];
  /** Track expiry deadlines per meta file for proactive expiry detection */
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(cacheDir: string, sweepIntervalMs: number = 60_000) {
    super();
    this.cacheDir = cacheDir;
    this.sweepIntervalMs = sweepIntervalMs;
    this.ensureDirs();
    this.startSweeper();
    this.startFileWatchers();
  }

  // ── Profile persistence ──

  saveProfile(profile: Profile): void {
    const shard = profile.signature.slice(0, 2);
    const dir = path.join(this.cacheDir, 'profiles', shard);
    fs.mkdirSync(dir, { recursive: true });

    const profilePath = path.join(dir, profile.signature + '.profile');
    const metaPath = path.join(dir, profile.signature + '.meta');

    const profileData = JSON.stringify({
      signature: profile.signature,
      cpuTicksEWMA: profile.cpuTicksEWMA,
      memBytesEWMA: profile.memBytesEWMA,
      wallTimeMsEWMA: profile.wallTimeMsEWMA,
      failureRateEWMA: profile.failureRateEWMA,
      sampleCount: profile.sampleCount,
      refreshRateMs: profile.refreshRateMs,
    });

    fs.writeFileSync(profilePath, PROFILE_HEADER + '\n' + profileData + '\n' + PROFILE_FOOTER + '\n', 'utf8');

    const meta: CacheMeta = {
      cacheExpiryMs: profile.cacheExpiryMs,
      refreshRateMs: profile.refreshRateMs,
      createdAt: Date.now(),
      signature: profile.signature,
    };
    fs.writeFileSync(metaPath, META_HEADER + '\n' + JSON.stringify(meta) + '\n' + META_FOOTER + '\n', 'utf8');

    this.scheduleExpiry(metaPath, meta);
  }

  loadProfile(signature: Signature): Profile | null {
    const shard = signature.slice(0, 2);
    const profilePath = path.join(this.cacheDir, 'profiles', shard, signature + '.profile');
    const metaPath = path.join(this.cacheDir, 'profiles', shard, signature + '.meta');

    if (!fs.existsSync(profilePath)) return null;

    if (fs.existsSync(metaPath)) {
      const meta = this.parseMeta(metaPath);
      if (meta && Date.now() - meta.createdAt > meta.cacheExpiryMs) {
        this.expireEntry(metaPath, meta);
        return null;
      }
    }

    const raw = fs.readFileSync(profilePath, 'utf8');
    const data = this.extractPayload(raw, PROFILE_HEADER, PROFILE_FOOTER);
    if (!data) return null;

    const parsed = JSON.parse(data);
    const meta = fs.existsSync(metaPath) ? this.parseMeta(metaPath) : null;

    return {
      ...parsed,
      lastUpdated: Date.now(),
      cacheExpiryMs: meta ? meta.cacheExpiryMs : 60_000,
      refreshRateMs: meta ? meta.refreshRateMs : 5_000,
    };
  }

  // ── Result cache ──

  saveResult(signature: Signature, jobId: JobId, result: Buffer, cacheExpiryMs: number, refreshRateMs: number): void {
    const shard = signature.slice(0, 2);
    const dir = path.join(this.cacheDir, 'results', shard);
    fs.mkdirSync(dir, { recursive: true });

    const resultPath = path.join(dir, jobId + '.result');
    const metaPath = path.join(dir, jobId + '.meta');

    fs.writeFileSync(resultPath, RESULT_HEADER + '\n' + result.toString('base64') + '\n' + RESULT_FOOTER + '\n', 'utf8');

    const meta: CacheMeta = {
      cacheExpiryMs,
      refreshRateMs,
      createdAt: Date.now(),
      signature,
      jobId,
    };
    fs.writeFileSync(metaPath, META_HEADER + '\n' + JSON.stringify(meta) + '\n' + META_FOOTER + '\n', 'utf8');

    this.scheduleExpiry(metaPath, meta);
  }

  loadResult(jobId: JobId, signature: Signature): Buffer | null {
    const shard = signature.slice(0, 2);
    const resultPath = path.join(this.cacheDir, 'results', shard, jobId + '.result');
    const metaPath = path.join(this.cacheDir, 'results', shard, jobId + '.meta');

    if (!fs.existsSync(resultPath)) return null;

    if (fs.existsSync(metaPath)) {
      const meta = this.parseMeta(metaPath);
      if (meta && Date.now() - meta.createdAt > meta.cacheExpiryMs) {
        this.expireEntry(metaPath, meta);
        return null;
      }
    }

    const raw = fs.readFileSync(resultPath, 'utf8');
    const data = this.extractPayload(raw, RESULT_HEADER, RESULT_FOOTER);
    if (!data) return null;

    return Buffer.from(data.trim(), 'base64');
  }

  // ── Graph persistence ──

  saveGraphResult(graphId: GraphId, nodeId: string, result: Buffer, cacheExpiryMs: number, refreshRateMs: number): void {
    const dir = path.join(this.cacheDir, 'graphs', graphId);
    fs.mkdirSync(dir, { recursive: true });

    const resultPath = path.join(dir, nodeId + '.result');
    fs.writeFileSync(resultPath, RESULT_HEADER + '\n' + result.toString('base64') + '\n' + RESULT_FOOTER + '\n', 'utf8');

    const metaPath = path.join(dir, 'graph.meta');
    if (!fs.existsSync(metaPath)) {
      const meta: CacheMeta = {
        cacheExpiryMs,
        refreshRateMs,
        createdAt: Date.now(),
        signature: '',
        graphId,
      };
      fs.writeFileSync(metaPath, META_HEADER + '\n' + JSON.stringify(meta) + '\n' + META_FOOTER + '\n', 'utf8');
      this.scheduleExpiry(metaPath, meta);
    }
  }

  // ── Signature-based invalidation ──

  markStale(signature: Signature): void {
    const shard = signature.slice(0, 2);
    const resultsDir = path.join(this.cacheDir, 'results', shard);
    if (!fs.existsSync(resultsDir)) return;

    for (const file of fs.readdirSync(resultsDir)) {
      if (!file.endsWith('.meta')) continue;
      const metaPath = path.join(resultsDir, file);
      const meta = this.parseMeta(metaPath);
      if (meta && meta.signature === signature) {
        const jobId = meta.jobId;
        if (jobId) {
          this.deleteFile(path.join(resultsDir, jobId + '.result'));
        }
        this.deleteFile(metaPath);
      }
    }
  }

  // ── File watching for proactive expiry ──

  private startFileWatchers(): void {
    const dirs = [
      path.join(this.cacheDir, 'profiles'),
      path.join(this.cacheDir, 'results'),
      path.join(this.cacheDir, 'graphs'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename || !filename.endsWith('.meta')) return;
          // On meta file change, re-evaluate expiry
          const metaPath = path.join(dir, filename as string);
          if (fs.existsSync(metaPath)) {
            const meta = this.parseMeta(metaPath);
            if (meta) {
              const remaining = meta.createdAt + meta.cacheExpiryMs - Date.now();
              if (remaining <= 0) {
                this.expireEntry(metaPath, meta);
              } else {
                this.scheduleExpiry(metaPath, meta);
              }
            }
          }
        });
        this.watchers.push(watcher);
      } catch {
        // fs.watch may not support recursive on all platforms
      }
    }
  }

  // ── Proactive expiry scheduling ──

  private scheduleExpiry(metaPath: string, meta: CacheMeta): void {
    // Clear existing timer for this meta file
    const existing = this.expiryTimers.get(metaPath);
    if (existing) clearTimeout(existing);

    const remaining = meta.createdAt + meta.cacheExpiryMs - Date.now();
    if (remaining <= 0) {
      // Already expired
      this.expireEntry(metaPath, meta);
      return;
    }

    const timer = setTimeout(() => {
      this.expiryTimers.delete(metaPath);
      this.expireEntry(metaPath, meta);
    }, remaining);

    this.expiryTimers.set(metaPath, timer);
  }

  private expireEntry(metaPath: string, meta: CacheMeta): void {
    // Emit event before deleting so consumers can react (e.g., push to frontend)
    this.emit('expired', {
      signature: meta.signature,
      jobId: meta.jobId,
      graphId: meta.graphId,
    } as CacheExpiryEvent);

    // Delete the data and meta files
    const base = path.basename(metaPath, '.meta');
    const parentDir = path.dirname(metaPath);
    this.deleteFile(path.join(parentDir, base + '.profile'));
    this.deleteFile(path.join(parentDir, base + '.result'));
    this.deleteFile(metaPath);
  }

  // ── Shutdown ──

  shutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    for (const [, timer] of this.expiryTimers) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();
    this.removeAllListeners();
  }

  // ── Periodic sweep (safety net for missed expiries) ──

  private startSweeper(): void {
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
  }

  private sweep(): void {
    const now = Date.now();
    this.sweepDir(path.join(this.cacheDir, 'profiles'), now);
    this.sweepDir(path.join(this.cacheDir, 'results'), now);
    this.sweepDir(path.join(this.cacheDir, 'graphs'), now);
  }

  private sweepDir(dir: string, now: number): void {
    if (!fs.existsSync(dir)) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        this.sweepDir(fullPath, now);
        continue;
      }

      if (!entry.name.endsWith('.meta')) continue;

      const meta = this.parseMeta(fullPath);
      if (!meta) continue;

      if (now - meta.createdAt > meta.cacheExpiryMs) {
        this.expireEntry(fullPath, meta);
      }
    }
  }

  // ── Helpers ──

  private ensureDirs(): void {
    fs.mkdirSync(path.join(this.cacheDir, 'profiles'), { recursive: true });
    fs.mkdirSync(path.join(this.cacheDir, 'results'), { recursive: true });
    fs.mkdirSync(path.join(this.cacheDir, 'graphs'), { recursive: true });
  }

  private extractPayload(raw: string, header: string, footer: string): string | null {
    const start = raw.indexOf(header);
    const end = raw.indexOf(footer);
    if (start === -1 || end === -1 || end <= start) return null;
    return raw.slice(start + header.length, end).trim();
  }

  private parseMeta(metaPath: string): CacheMeta | null {
    if (!fs.existsSync(metaPath)) return null;
    const raw = fs.readFileSync(metaPath, 'utf8');
    const data = this.extractPayload(raw, META_HEADER, META_FOOTER);
    if (!data) return null;
    return JSON.parse(data) as CacheMeta;
  }

  private deleteFile(filePath: string): void {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }
}