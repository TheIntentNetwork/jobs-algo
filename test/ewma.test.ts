import { describe, it, expect } from 'vitest';
import { EWMA } from '../src/metrics/ewma.js';

describe('EWMA', () => {
  it('seeds the first observation directly', () => {
    const e = new EWMA(0.3, 0);
    e.update(100);
    expect(e.current()).toBe(100);
    expect(e.count()).toBe(1);
  });

  it('applies EWMA smoothing after first observation', () => {
    const e = new EWMA(0.3, 0);
    e.update(100); // seeds to 100
    e.update(200); // 0.3*200 + 0.7*100 = 60 + 70 = 130
    expect(e.current()).toBe(130);
  });

  it('converges toward recent values', () => {
    const e = new EWMA(0.3, 0);
    for (let i = 0; i < 20; i++) e.update(500);
    expect(e.current()).toBeCloseTo(500, 0);
  });

  it('serializes and restores', () => {
    const e = new EWMA(0.3, 0);
    e.update(100);
    e.update(200);
    const json = e.toJSON();
    const restored = EWMA.fromJSON(json);
    expect(restored.current()).toBe(e.current());
    expect(restored.count()).toBe(e.count());
  });
});