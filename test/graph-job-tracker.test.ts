import { describe, it, expect } from 'vitest';
import { GraphJobTracker } from '../src/graph/graph-job-tracker.js';

describe('GraphJobTracker', () => {
  it('registers and looks up graph-node-to-job mappings', () => {
    const tracker = new GraphJobTracker();
    tracker.register('graph-1', 'node-a', 'job-1', 'sig-1');
    tracker.register('graph-1', 'node-b', 'job-2', 'sig-2');

    expect(tracker.getJobId('graph-1', 'node-a')).toBe('job-1');
    expect(tracker.getJobId('graph-1', 'node-b')).toBe('job-2');
    expect(tracker.getGraphId('job-1')).toBe('graph-1');
    expect(tracker.getNodeId('job-1')).toBe('node-a');
    expect(tracker.getSignature('job-1')).toBe('sig-1');
  });

  it('returns null for unknown lookups', () => {
    const tracker = new GraphJobTracker();
    expect(tracker.getJobId('g', 'n')).toBeNull();
    expect(tracker.getGraphId('j')).toBeNull();
    expect(tracker.getNodeId('j')).toBeNull();
    expect(tracker.getSignature('j')).toBeNull();
  });

  it('getAllJobIds returns all jobs for a graph', () => {
    const tracker = new GraphJobTracker();
    tracker.register('g1', 'a', 'j1', 's1');
    tracker.register('g1', 'b', 'j2', 's2');
    tracker.register('g2', 'c', 'j3', 's3');

    const ids = tracker.getAllJobIds('g1');
    expect(ids).toContain('j1');
    expect(ids).toContain('j2');
    expect(ids).toHaveLength(2);
    expect(tracker.getAllJobIds('g2')).toEqual(['j3']);
    expect(tracker.getAllJobIds('g99')).toEqual([]);
  });

  it('cleanup removes graph entries and reverse mappings', () => {
    const tracker = new GraphJobTracker();
    tracker.register('g1', 'a', 'j1', 's1');
    tracker.register('g1', 'b', 'j2', 's2');

    tracker.cleanup('g1');

    expect(tracker.getJobId('g1', 'a')).toBeNull();
    expect(tracker.getGraphId('j1')).toBeNull();
    expect(tracker.getAllJobIds('g1')).toEqual([]);
  });

  it('all-or-nothing: cleanup on failure removes all jobs for the graph', () => {
    const tracker = new GraphJobTracker();
    tracker.register('g1', 'a', 'j1', 's1');
    tracker.register('g1', 'b', 'j2', 's2');
    tracker.register('g1', 'c', 'j3', 's3');

    const allIds = tracker.getAllJobIds('g1');
    expect(allIds).toHaveLength(3);

    tracker.cleanup('g1');
    for (const jid of allIds) {
      expect(tracker.getGraphId(jid)).toBeNull();
    }
    expect(tracker.getAllJobIds('g1')).toEqual([]);
  });
});
