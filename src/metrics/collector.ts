import type { Metrics, MetricsCollector } from '../types/index.js';

/** Collects metrics during a single job execution */
export class MetricsCollectorImpl implements MetricsCollector {
  private cpuSamples: number[] = [];
  private memSamples: number[] = [];
  private wallStart: number = 0;
  private cpuStart: { user: number; system: number } = { user: 0, system: 0 };

  recordCpu(ticks: number): void {
    this.cpuSamples.push(ticks);
  }

  recordMem(bytes: number): void {
    this.memSamples.push(bytes);
  }

  startWallTimer(): void {
    this.wallStart = performance.now();
    const usage = process.cpuUsage();
    this.cpuStart = { user: usage.user, system: usage.system };
  }

  /** Call when job finishes to collect final metrics */
  collect(): Metrics {
    const wallTimeMs = this.wallStart ? performance.now() - this.wallStart : 0;

    let cpuTicks: number;
    if (this.cpuSamples.length > 0) {
      // Use peak sample
      cpuTicks = Math.max(...this.cpuSamples);
    } else {
      // Fallback: derive from process.cpuUsage delta
      const usage = process.cpuUsage();
      cpuTicks = (usage.user - this.cpuStart.user) + (usage.system - this.cpuStart.system);
    }

    const memBytes = this.memSamples.length > 0
      ? Math.max(...this.memSamples)
      : 0;

    return { cpuTicks, memBytes, wallTimeMs };
  }

  /** Reset for reuse */
  reset(): void {
    this.cpuSamples = [];
    this.memSamples = [];
    this.wallStart = 0;
    this.cpuStart = { user: 0, system: 0 };
  }
}
