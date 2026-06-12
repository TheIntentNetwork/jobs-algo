import { describe, it, expect } from 'vitest';
import { QueueSink } from '../src/queue/sink.js';
import type { MissionControlExecutor, CancelToken, MetricsCollector } from '../src/types/index.js';
import { computeSignature } from '../src/algorithm/signature.js';

class MockExecutor implements MissionControlExecutor {
  execute(
    payload: Buffer,
    metrics: MetricsCollector,
    done: (result: Buffer) => void,
    _error: (err: Error) => void,
  ): CancelToken {
    metrics.startWallTimer();
    metrics.recordCpu(100);
    metrics.recordMem(1024);
    setTimeout(() => {
      done(Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
    }, 10);
    return { cancel: () => {} };
  }
}

describe('QueueSink', () => {
  it('pushes a job and receives completion via subscribe', async () => {
    const sink = new QueueSink({ maxParallelism: 1, cacheDir: '.cache/test-sink' });
    sink.connectMissionControl(new MockExecutor());

    const sig = computeSignature({ type: 'test', entity: 'unit', argSchema: {} });
    let eventReceived = false;

    sink.subscribe(sig, (event) => {
      if (event.type === 'job_complete') {
        eventReceived = true;
      }
    });

    const jobId = sink.push(sig, Buffer.from('test', 'utf8'), { cacheExpiryMs: 60_000, refreshRateMs: 300_000 });
    expect(jobId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 200));

    expect(eventReceived).toBe(true);
    await sink.close();
  });

  it('pushGraph enqueues a graph definition', () => {
    const sink = new QueueSink({ maxParallelism: 1, cacheDir: '.cache/test-sink-graph' });
    sink.connectMissionControl(new MockExecutor());

    const sig1 = computeSignature({ type: 'a', entity: 'x', argSchema: {} });
    const sig2 = computeSignature({ type: 'b', entity: 'x', argSchema: {} });

    const graphId = sink.pushGraph({
      id: 'test-graph',
      nodes: [
        { id: 'n1', signature: sig1, payload: Buffer.from('a'), dependsOn: [] },
        { id: 'n2', signature: sig2, payload: Buffer.from('b'), dependsOn: ['n1'] },
      ],
    });

    expect(graphId).toBeTruthy();
  });

  it('inspectProfile returns null for unseen signature', () => {
    const sink = new QueueSink({ maxParallelism: 1, cacheDir: '.cache/test-sink-profile' });
    const sig = computeSignature({ type: 'z', entity: 'z', argSchema: {} });
    expect(sink.inspectProfile(sig)?.sampleCount ?? 0).toBe(0);
  });
});
