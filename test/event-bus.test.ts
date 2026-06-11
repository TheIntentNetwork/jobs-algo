import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/push/event-bus.js';
import type { AlgorithmEvent } from '../src/types/index.js';

describe('EventBus', () => {
  it('delivers events to subscribers', () => {
    const bus = new EventBus();
    const events: AlgorithmEvent[] = [];
    bus.subscribe((e) => events.push(e), 'sig1');

    bus.emit({ type: 'job_complete', jobId: 'j1', signature: 'sig1', result: Buffer.from('r') });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('job_complete');
  });

  it('tracks client count per signature', () => {
    const bus = new EventBus();
    const unsub1 = bus.subscribe(() => {}, 'sig1');
    const unsub2 = bus.subscribe(() => {}, 'sig1');

    expect(bus.hasClients('sig1')).toBe(true);

    unsub1();
    expect(bus.hasClients('sig1')).toBe(true);

    unsub2();
    expect(bus.hasClients('sig1')).toBe(false);
  });

  it('caches results by signature', () => {
    const bus = new EventBus();
    bus.emit({ type: 'job_complete', jobId: 'j1', signature: 'sig1', result: Buffer.from('result-data') });

    const cached = bus.getCachedResult('sig1');
    expect(cached).not.toBeNull();
    expect(cached!.toString()).toBe('result-data');
  });

  it('marks cached results stale', () => {
    const bus = new EventBus();
    bus.emit({ type: 'job_complete', jobId: 'j1', signature: 'sig1', result: Buffer.from('data') });
    bus.markStale('sig1');

    const entry = bus.getCacheEntry('sig1');
    expect(entry).not.toBeNull();
    expect(entry!.expiresAt).toBe(0); // stale
  });

  it('pushes cache to frontend on expiry when clients exist', () => {
    const bus = new EventBus();
    const events: AlgorithmEvent[] = [];
    bus.subscribe((e) => events.push(e), 'sig1');

    bus.emit({ type: 'job_complete', jobId: 'j1', signature: 'sig1', result: Buffer.from('data') });

    // Simulate cache expiry with active clients
    bus.emit({ type: 'cache_expire', signature: 'sig1' });
    // Should get both the job_complete and the cache_push
    const pushEvents = events.filter(e => e.type === 'cache_push');
    expect(pushEvents.length).toBe(1);
    if (pushEvents[0].type === 'cache_push') {
      expect(pushEvents[0].signature).toBe('sig1');
    }
  });

  it('evicts cache on expiry with no clients', () => {
    const bus = new EventBus();
    const events: AlgorithmEvent[] = [];
    bus.subscribe((e) => events.push(e)); // no signature = no client ref count

    bus.emit({ type: 'job_complete', jobId: 'j1', signature: 'sig1', result: Buffer.from('data') });
    bus.emit({ type: 'cache_expire', signature: 'sig1' });

    // With no clients, the entry should be evicted (no cache_push emitted)
    const pushEvents = events.filter(e => e.type === 'cache_push');
    expect(pushEvents.length).toBe(0);
    expect(bus.getCachedResult('sig1')).toBeNull();
  });
});