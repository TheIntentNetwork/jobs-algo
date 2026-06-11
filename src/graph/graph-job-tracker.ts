import type { JobId, GraphId, GraphNode, Signature, AlgorithmConfig } from '../types/index.js';

/** Maps graph node IDs back to their scheduler job IDs */
export class GraphJobTracker {
  // graphId → nodeId → jobId
  private mapping = new Map<GraphId, Map<string, JobId>>();
  // jobId → { graphId, nodeId, signature }
  private reverseMapping = new Map<JobId, { graphId: GraphId; nodeId: string; signature: Signature }>();

  register(graphId: GraphId, nodeId: string, jobId: JobId, signature: Signature): void {
    if (!this.mapping.has(graphId)) {
      this.mapping.set(graphId, new Map());
    }
    this.mapping.get(graphId)!.set(nodeId, jobId);
    this.reverseMapping.set(jobId, { graphId, nodeId, signature });
  }

  getGraphId(jobId: JobId): GraphId | null {
    return this.reverseMapping.get(jobId)?.graphId ?? null;
  }

  getNodeId(jobId: JobId): string | null {
    return this.reverseMapping.get(jobId)?.nodeId ?? null;
  }

  getSignature(jobId: JobId): Signature | null {
    return this.reverseMapping.get(jobId)?.signature ?? null;
  }

  getJobId(graphId: GraphId, nodeId: string): JobId | null {
    return this.mapping.get(graphId)?.get(nodeId) ?? null;
  }

  /** Get all job IDs for a graph (used when cancelling a failed graph) */
  getAllJobIds(graphId: GraphId): JobId[] {
    const nodeMap = this.mapping.get(graphId);
    if (!nodeMap) return [];
    return [...nodeMap.values()];
  }

  cleanup(graphId: GraphId): void {
    const nodeMap = this.mapping.get(graphId);
    if (!nodeMap) return;
    for (const [, jobId] of nodeMap) {
      this.reverseMapping.delete(jobId);
    }
    this.mapping.delete(graphId);
  }
}
