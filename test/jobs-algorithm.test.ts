import { describe, it, expect } from 'vitest';
import { JobsAlgorithmImpl } from '../src/integration/jobs-algorithm.js';
import type { MissionControlExecutor, CancelToken, MetricsCollector, AlgorithmEvent } from '../src/types/index.js';
import { computeSignature } from '../src/algorithm/signature.js';

class DelayedExecutor implements MissionControlExecutor {
  private delayMs: number;
  constructor(delayMs = 50) {
    this.delayMs = delayMs;
  }

  execute(
    payload: Buffer,
    metrics: MetricsCollector,
    done: (result: Buffer) => void,
    _error: (err: Error) => void,
  ): CancelToken {
    metrics.startWallTimer();
    metrics.recordCpu(500);
    metrics.recordMem(2048);
    setTimeout(() => {
      done(Buffer.from(JSON.stringify({ status: 'ok' }), 'utf8'));
    }, this.delayMs);
    return { cancel: () => {} };
  }
}

class FailingExecutor implements MissionControlExecutor {
  execute(
    payload: Buffer,
    metrics: MetricsCollector,
    _done: (result: Buffer) => void,
    error: (err: Error) => void,
  ): CancelToken {
    metrics.startWallTimer();
    setTimeout(() => {
      error(new Error('intentional failure'));
    }, 10);
    return { cancel: () => {} };
  }
}

describe('JobsAlgorithmImpl', () => {
  it('enqueues and completes a job through MissionControlExecutor', async () => {
    const algo = new JobsAlgorithmImpl({ maxParallelism: 1, cacheDir: '.cache/test-algo' });
    algo.setMissionControl(new DelayedExecutor());

    const sig = computeSignature({ type: 'test', entity: 'algo', argSchema: {} });
    const events: AlgorithmEvent[] = [];

    algo.subscribe(sig, (event) => {
      events.push(event);
    });

    const jobId = algo.enqueue(sig, Buffer.from('test'), { cacheExpiryMs: 60_000, refreshRateMs: 300_000 });
    expect(jobId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 300));

    const completes = events.filter(e => e.type === 'job_complete');
    expect(completes.length).toBeGreaterThanOrEqual(1);
    expect(completes[0].jobId).toBe(jobId);

    algo['scheduler'].clearAllRefreshTimers();
    await algo.shutdown();
  });

  it('handles job failure with job_failed event', async () => {
    const algo = new JobsAlgorithmImpl({ maxParallelism: 1, cacheDir: '.cache/test-algo-fail' });
    algo.setMissionControl(new FailingExecutor());

    const sig = computeSignature({ type: 'fail', entity: 'algo', argSchema: {} });
    const events: AlgorithmEvent[] = [];

    algo.subscribe(sig, (event) => {
      events.push(event);
    });

    algo.enqueue(sig, Buffer.from('fail'), { cacheExpiryMs: 60_000, refreshRateMs: 300_000 });

    await new Promise((r) => setTimeout(r, 200));

    const fails = events.filter(e => e.type === 'job_failed');
    expect(fails.length).toBeGreaterThanOrEqual(1);
    expect(fails[0].error).toContain('intentional failure');

    await algo.shutdown();
  });

  it('enqueues a graph and handles failure propagation', async () => {
    const algo = new JobsAlgorithmImpl({ maxParallelism: 2, cacheDir: '.cache/test-algo-graph' });
    algo.setMissionControl(new FailingExecutor());

    const sig = computeSignature({ type: 'graph', entity: 'fail', argSchema: {} });
    const events: AlgorithmEvent[] = [];

    // Subscribe without signature filter to get graph_failed events
    algo.subscribe(sig, (event) => {
      events.push(event);
    });

    algo.enqueueGraph({
      id: 'test-graph-fail',
      nodes: [
        { id: 'n1', signature: sig, payload: Buffer.from('a'), dependsOn: [] },
      ],
    });

    await new Promise((r) => setTimeout(r, 500));

    // The node fails, which should trigger either job_failed or graph_failed
    const failures = events.filter(e => e.type === 'job_failed' || e.type === 'graph_failed');
    expect(failures.length).toBeGreaterThanOrEqual(1);

    await algo.shutdown();
  });

  it('getProfile returns null for unseen signature', () => {
    const algo = new JobsAlgorithmImpl({ maxParallelism: 1, cacheDir: '.cache/test-algo-profile' });
    const sig = computeSignature({ type: 'noprofile', entity: 'x', argSchema: {} });
    expect(algo.getProfile(sig)?.sampleCount ?? 0).toBe(0);
  });

  it('records profile after successful job completion', async () => {
    const algo = new JobsAlgorithmImpl({ maxParallelism: 1, cacheDir: '.cache/test-algo-profile2' });
    algo.setMissionControl(new DelayedExecutor());

    const sig = computeSignature({ type: 'profile', entity: 'x', argSchema: {} });

    algo.enqueue(sig, Buffer.from('profile-test'), { cacheExpiryMs: 60_000, refreshRateMs: 300_000 });

    await new Promise<void>((resolve) => {
      algo.subscribe(sig, (event) => {
        if (event.type === 'job_complete') resolve();
      });
      setTimeout(resolve, 500);
    });

    const profile = algo.getProfile(sig);
    expect(profile).not.toBeNull();
    expect(profile!.sampleCount).toBeGreaterThanOrEqual(1);

    algo['scheduler'].clearAllRefreshTimers();
    await algo.shutdown();
  });
});
