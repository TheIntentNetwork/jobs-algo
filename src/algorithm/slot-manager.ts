import os from 'node:os';
import type { Job, Slot, AlgorithmConfig } from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';

export class SlotManager {
  private slots: Slot[] = [];
  private nextSlotId = 0;
  private config: AlgorithmConfig;

  constructor(config: Partial<AlgorithmConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getSlots(): readonly Slot[] {
    return this.slots;
  }

  maxParallelism(): number {
    return this.config.maxParallelism || os.cpus().length;
  }

  findOrCreateSlot(job: Job): Slot | null {
    const needed = {
      cpu: job.predictedProfile.cpuTicksEWMA,
      mem: job.predictedProfile.memBytesEWMA,
    };

    const isCold = job.predictedProfile.sampleCount < this.config.coldStartSamples;

    if (isCold) {
      const emptySlot = this.slots.find(s => s.activeJobs.length === 0 && !s.overBudget);
      if (emptySlot) return emptySlot;
      return this.createSlot();
    }

    let bestSlot: Slot | null = null;
    let bestWaste = Infinity;

    for (const slot of this.slots) {
      if (slot.overBudget) continue;

      const remaining = {
        cpu: slot.budgetCpuTicks - slot.usedCpuTicks,
        mem: slot.budgetMemBytes - slot.usedMemBytes,
      };

      if (remaining.cpu >= needed.cpu && remaining.mem >= needed.mem) {
        const waste = (remaining.cpu - needed.cpu) * this.config.cpuWeight
                    + (remaining.mem - needed.mem) * this.config.memWeight;
        if (waste < bestWaste) {
          bestSlot = slot;
          bestWaste = waste;
        }
      }
    }

    if (bestSlot) return bestSlot;
    return this.createSlot();
  }

  assignJob(slot: Slot, job: Job): void {
    slot.activeJobs.push(job);
    slot.usedCpuTicks += job.predictedProfile.cpuTicksEWMA;
    slot.usedMemBytes += job.predictedProfile.memBytesEWMA;
    job.slotId = slot.id;
    job.status = 'running';
  }

  releaseJob(slot: Slot, job: Job, actualCpu: number, actualMem: number): void {
    const idx = slot.activeJobs.indexOf(job);
    if (idx === -1) return;
    slot.activeJobs.splice(idx, 1);

    slot.usedCpuTicks -= job.predictedProfile.cpuTicksEWMA;
    slot.usedMemBytes -= job.predictedProfile.memBytesEWMA;

    slot.usedCpuTicks = Math.max(0, slot.usedCpuTicks);
    slot.usedMemBytes = Math.max(0, slot.usedMemBytes);

    if (
      actualCpu > job.predictedProfile.cpuTicksEWMA * this.config.overBudgetFactor ||
      actualMem > job.predictedProfile.memBytesEWMA * this.config.overBudgetFactor
    ) {
      slot.overBudget = true;
    }

    if (slot.activeJobs.length === 0 && slot.overBudget) {
      this.resetSlot(slot);
    }
  }

  markOverBudget(slot: Slot): void {
    slot.overBudget = true;
  }

  cancelAllJobs(slot: Slot): Job[] {
    const cancelled = [...slot.activeJobs];
    slot.activeJobs = [];
    slot.usedCpuTicks = 0;
    slot.usedMemBytes = 0;
    slot.overBudget = false;
    return cancelled;
  }

  private createSlot(): Slot | null {
    const max = this.maxParallelism();
    if (this.slots.length >= max) return null;

    const slot: Slot = {
      id: this.nextSlotId++,
      budgetCpuTicks: this.config.slotBudgetCpuTicks,
      budgetMemBytes: this.config.slotBudgetMemBytes,
      usedCpuTicks: 0,
      usedMemBytes: 0,
      activeJobs: [],
      overBudget: false,
    };
    this.slots.push(slot);
    return slot;
  }

  private resetSlot(slot: Slot): void {
    slot.usedCpuTicks = 0;
    slot.usedMemBytes = 0;
    slot.overBudget = false;
  }
}