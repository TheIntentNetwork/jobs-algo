import { describe, it, expect } from 'vitest';
import { GraphEngine } from '../src/graph/graph-engine.js';
import type { GraphDefinition } from '../src/types/index.js';

describe('GraphEngine', () => {
  it('executes root nodes immediately', () => {
    const ready: Array<{ graphId: string; nodeId: string; signature: string }> = [];
    const engine = new GraphEngine((graphId, nodeId, signature, _payload) => {
      ready.push({ graphId, nodeId, signature });
    });

    const def: GraphDefinition = {
      id: 'g1',
      nodes: [
        { id: 'a', signature: 'sig-a', payload: Buffer.from('a'), dependsOn: [] },
        { id: 'b', signature: 'sig-b', payload: Buffer.from('b'), dependsOn: ['a'] },
      ],
    };

    engine.submit(def);
    expect(ready).toEqual([{ graphId: 'g1', nodeId: 'a', signature: 'sig-a' }]);
  });

  it('advances downstream nodes when upstream completes', () => {
    const ready: Array<{ graphId: string; nodeId: string; signature: string }> = [];
    const engine = new GraphEngine((graphId, nodeId, signature, _payload) => {
      ready.push({ graphId, nodeId, signature });
    });

    const def: GraphDefinition = {
      id: 'g1',
      nodes: [
        { id: 'a', signature: 'sig-a', payload: Buffer.from('a'), dependsOn: [] },
        { id: 'b', signature: 'sig-b', payload: Buffer.from('b'), dependsOn: ['a'] },
      ],
    };

    engine.submit(def);
    ready.length = 0;

    engine.advance('g1', 'a', Buffer.from('result-a'));
    expect(ready).toEqual([{ graphId: 'g1', nodeId: 'b', signature: 'sig-b' }]);
  });

  it('marks graph completed when all nodes finish', () => {
    const ready: string[] = [];
    const engine = new GraphEngine((graphId, nodeId, _sig, _payload) => {
      ready.push(nodeId);
    });

    const def: GraphDefinition = {
      id: 'g1',
      nodes: [
        { id: 'a', signature: 'sig-a', payload: Buffer.alloc(0), dependsOn: [] },
        { id: 'b', signature: 'sig-b', payload: Buffer.alloc(0), dependsOn: [] },
      ],
    };

    engine.submit(def);

    const g1 = engine.advance('g1', 'a', Buffer.from('r1'));
    expect(g1?.status).toBe('running');

    const g2 = engine.advance('g1', 'b', Buffer.from('r2'));
    expect(g2?.status).toBe('completed');
  });

  it('fails the whole graph on any node failure', () => {
    const engine = new GraphEngine(() => {});

    const def: GraphDefinition = {
      id: 'g1',
      nodes: [
        { id: 'a', signature: 'sig-a', payload: Buffer.alloc(0), dependsOn: [] },
        { id: 'b', signature: 'sig-b', payload: Buffer.alloc(0), dependsOn: ['a'] },
      ],
    };

    engine.submit(def);
    const graph = engine.failGraph('g1', 'a', 'something went wrong');
    expect(graph?.status).toBe('failed');
    expect(graph?.failedNodes.has('a')).toBe(true);
  });

  it('rejects cyclic graphs', () => {
    const engine = new GraphEngine(() => {});

    const def: GraphDefinition = {
      id: 'g1',
      nodes: [
        { id: 'a', signature: 'sig-a', payload: Buffer.alloc(0), dependsOn: ['b'] },
        { id: 'b', signature: 'sig-b', payload: Buffer.alloc(0), dependsOn: ['a'] },
      ],
    };

    expect(() => engine.submit(def)).toThrow(/cycle/);
  });

  it('handles fan-in (multiple deps)', () => {
    const ready: string[] = [];
    const engine = new GraphEngine((_gid, nodeId, _sig, _payload) => {
      ready.push(nodeId);
    });

    // Both a and b must complete before c can run
    const def: GraphDefinition = {
      id: 'g1',
      nodes: [
        { id: 'a', signature: 'sig-a', payload: Buffer.alloc(0), dependsOn: [] },
        { id: 'b', signature: 'sig-b', payload: Buffer.alloc(0), dependsOn: [] },
        { id: 'c', signature: 'sig-c', payload: Buffer.alloc(0), dependsOn: ['a', 'b'] },
      ],
    };

    engine.submit(def);
    // After submit, both a and b are ready (root nodes)
    expect(ready.sort()).toEqual(['a', 'b']);
    ready.length = 0;

    // Completing a does NOT make c ready (b still pending)
    engine.advance('g1', 'a', Buffer.from('r1'));
    expect(ready).toEqual([]);

    // Completing b makes c ready (both deps now done)
    engine.advance('g1', 'b', Buffer.from('r2'));
    expect(ready).toEqual(['c']);
  });
});