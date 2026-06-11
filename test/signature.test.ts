import { describe, it, expect } from 'vitest';
import { computeSignature } from '../src/algorithm/signature.js';

describe('computeSignature', () => {
  it('produces same hash for same structural input', () => {
    const a = computeSignature({ type: 'TransformCSV', entity: 'document', argSchema: { count: 'number', name: 'string' } });
    const b = computeSignature({ type: 'TransformCSV', entity: 'document', argSchema: { count: 'number', name: 'string' } });
    expect(a).toBe(b);
  });

  it('ignores argument schema key ordering', () => {
    const a = computeSignature({ type: 'TransformCSV', entity: 'document', argSchema: { count: 'number', name: 'string' } });
    const b = computeSignature({ type: 'TransformCSV', entity: 'document', argSchema: { name: 'string', count: 'number' } });
    expect(a).toBe(b);
  });

  it('differs when type differs', () => {
    const a = computeSignature({ type: 'TransformCSV', entity: 'document', argSchema: { count: 'number' } });
    const b = computeSignature({ type: 'RunInference', entity: 'document', argSchema: { count: 'number' } });
    expect(a).not.toBe(b);
  });

  it('differs when schema shape differs', () => {
    const a = computeSignature({ type: 'TransformCSV', entity: 'document', argSchema: { count: 'number' } });
    const b = computeSignature({ type: 'TransformCSV', entity: 'document', argSchema: { count: 'number', extra: 'boolean' } });
    expect(a).not.toBe(b);
  });
});