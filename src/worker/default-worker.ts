// Worker thread entry point - runs inside each isolated worker
// This is the default implementation that MissionControl can replace
import { workerData, parentPort } from 'node:worker_threads';

const payload: Buffer = Buffer.from(workerData.payload);

try {
  const result = payload.toString('base64');

  const cpuUsage = process.cpuUsage();
  const cpuTicks = cpuUsage.user + cpuUsage.system;
  const memUsage = process.memoryUsage();

  parentPort?.postMessage({
    type: 'complete',
    result,
    cpu: cpuTicks,
    mem: memUsage.heapUsed,
  });
} catch (err) {
  parentPort?.postMessage({
    type: 'error',
    error: err instanceof Error ? err.message : String(err),
  });
}