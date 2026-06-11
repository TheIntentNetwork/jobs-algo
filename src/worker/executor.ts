import { Worker } from 'node:worker_threads';
import type { CancelToken, MetricsCollector } from '../types/index.js';

export class WorkerExecutor {
  private workers = new Map<number, Worker>();
  private nextWorkerId = 0;

  execute(
    workerScriptPath: string,
    payload: Buffer,
    metrics: MetricsCollector,
    done: (result: Buffer) => void,
    error: (err: Error) => void,
  ): CancelToken {
    const workerId = this.nextWorkerId++;
    let cancelled = false;

    const worker = new Worker(workerScriptPath, {
      workerData: { payload },
    });

    this.workers.set(workerId, worker);
    metrics.startWallTimer();

    const memInterval = setInterval(() => {
      const mem = process.memoryUsage();
      metrics.recordMem(mem.heapUsed);
    }, 100);

    worker.on('message', (msg: { type: string; result?: string; error?: string; cpu?: number; mem?: number }) => {
      if (cancelled) return;
      clearInterval(memInterval);

      if (msg.type === 'complete' && msg.result) {
        if (msg.cpu) metrics.recordCpu(msg.cpu);
        if (msg.mem) metrics.recordMem(msg.mem);
        done(Buffer.from(msg.result, 'base64'));
      } else if (msg.type === 'error' && msg.error) {
        error(new Error(msg.error));
      } else {
        error(new Error('Worker sent unknown message format'));
      }

      this.workers.delete(workerId);
      worker.terminate();
    });

    worker.on('error', (err: Error) => {
      if (cancelled) return;
      clearInterval(memInterval);
      error(err);
      this.workers.delete(workerId);
    });

    worker.on('exit', (code: number) => {
      clearInterval(memInterval);
      if (code !== 0 && !cancelled) {
        error(new Error('Worker exited with code ' + String(code)));
      }
      this.workers.delete(workerId);
    });

    return {
      cancel: () => {
        cancelled = true;
        clearInterval(memInterval);
        worker.terminate();
        this.workers.delete(workerId);
      },
    };
  }

  terminateAll(): void {
    for (const [, worker] of this.workers) {
      worker.terminate();
    }
    this.workers.clear();
  }

  activeCount(): number {
    return this.workers.size;
  }
}