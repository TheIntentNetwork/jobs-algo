import type { Graph, GraphDefinition, GraphId, NodeId, Signature, AlgorithmConfig } from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';

export class GraphEngine {
  private graphs = new Map<GraphId, Graph>();
  private config: AlgorithmConfig;
  /** Track which nodes have already been dispatched to avoid re-dispatching */
  private dispatchedNodes = new Map<GraphId, Set<NodeId>>();

  private onNodeReady: (graphId: GraphId, nodeId: NodeId, signature: Signature, payload: Buffer) => void;

  constructor(
    onNodeReady: (graphId: GraphId, nodeId: NodeId, signature: Signature, payload: Buffer) => void,
    config: Partial<AlgorithmConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onNodeReady = onNodeReady;
  }

  submit(def: GraphDefinition): Graph {
    if (def.nodes.length > this.config.graphMaxNodes) {
      throw new Error('Graph exceeds max nodes limit (' + String(this.config.graphMaxNodes) + '): ' + String(def.nodes.length) + ' nodes');
    }

    this.validateAcyclic(def);

    const graph: Graph = {
      id: def.id,
      nodes: new Map(def.nodes.map(n => [n.id, n])),
      completedNodes: new Set(),
      failedNodes: new Set(),
      readyQueue: [],
      status: 'pending',
      results: new Map(),
    };

    const dispatched = new Set<NodeId>();
    this.dispatchedNodes.set(def.id, dispatched);

    for (const node of def.nodes) {
      if (node.dependsOn.length === 0) {
        graph.readyQueue.push(node.id);
        dispatched.add(node.id);
      }
    }

    graph.status = 'running';
    this.graphs.set(graph.id, graph);

    for (const nodeId of graph.readyQueue) {
      const node = graph.nodes.get(nodeId);
      if (node) {
        this.onNodeReady(graph.id, node.id, node.signature, node.payload);
      }
    }
    graph.readyQueue = [];

    return graph;
  }

  advance(graphId: GraphId, nodeId: NodeId, result: Buffer): Graph | null {
    const graph = this.graphs.get(graphId);
    if (!graph) return null;
    if (graph.status !== 'running') return graph;

    graph.completedNodes.add(nodeId);
    graph.results.set(nodeId, result);

    const dispatched = this.dispatchedNodes.get(graphId) || new Set();
    const newlyReady: NodeId[] = [];

    for (const [nid, node] of graph.nodes) {
      if (graph.completedNodes.has(nid) || graph.failedNodes.has(nid)) continue;
      if (dispatched.has(nid)) continue; // already dispatched

      const allDepsComplete = node.dependsOn.every(dep => graph.completedNodes.has(dep));
      if (allDepsComplete) {
        newlyReady.push(nid);
        dispatched.add(nid);
      }
    }

    if (graph.completedNodes.size === graph.nodes.size) {
      graph.status = 'completed';
      return graph;
    }

    for (const nid of newlyReady) {
      const node = graph.nodes.get(nid);
      if (node) {
        this.onNodeReady(graphId, node.id, node.signature, node.payload);
      }
    }

    return graph;
  }

  failGraph(graphId: GraphId, failedNodeId: NodeId, error: string): Graph | null {
    const graph = this.graphs.get(graphId);
    if (!graph) return null;

    graph.status = 'failed';
    graph.failedNodes.add(failedNodeId);

    return graph;
  }

  getGraph(graphId: GraphId): Graph | undefined {
    return this.graphs.get(graphId);
  }

  private validateAcyclic(def: GraphDefinition): void {
    const inDegree = new Map<NodeId, number>();
    const adjacency = new Map<NodeId, NodeId[]>();

    for (const node of def.nodes) {
      if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
      if (!adjacency.has(node.id)) adjacency.set(node.id, []);

      for (const dep of node.dependsOn) {
        if (!adjacency.has(dep)) adjacency.set(dep, []);
        adjacency.get(dep)!.push(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
      }
    }

    const queue: NodeId[] = [];
    for (const [nid, deg] of inDegree) {
      if (deg === 0) queue.push(nid);
    }

    let visited = 0;
    while (queue.length > 0) {
      const nid = queue.shift()!;
      visited++;
      for (const downstream of adjacency.get(nid) || []) {
        const newDeg = (inDegree.get(downstream) || 1) - 1;
        inDegree.set(downstream, newDeg);
        if (newDeg === 0) queue.push(downstream);
      }
    }

    if (visited !== def.nodes.length) {
      throw new Error('Graph ' + def.id + ' contains a cycle');
    }
  }
}