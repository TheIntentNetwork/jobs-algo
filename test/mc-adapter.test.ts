import { describe, it, expect } from 'vitest';
import { MCAdapter } from '../src/integration/mc/mc-adapter.js';

describe('MCAdapter', () => {
  describe('constructor', () => {
    it('creates adapter with default config', () => {
      const adapter = new MCAdapter({
        projectRoot: '/tmp/test-mc',
        projectId: 'test-project',
      });
      expect(adapter).toBeTruthy();
      adapter.shutdown();
    });

    it('accepts jobTimeoutMs config', () => {
      const adapter = new MCAdapter({
        projectRoot: '/tmp/test-mc',
        projectId: 'test-project',
        jobTimeoutMs: 60_000,
      });
      expect(adapter).toBeTruthy();
      adapter.shutdown();
    });
  });

  describe('execute', () => {
    it('returns error for missing type in payload', () => {
      const adapter = new MCAdapter({
        projectRoot: '/tmp/test-mc',
        projectId: 'test-project',
      });

      const errors: Error[] = [];

      const token = adapter.execute(
        Buffer.from(JSON.stringify({ prompt: 'test' })),
        { recordCpu: () => {}, recordMem: () => {}, startWallTimer: () => {} },
        () => {},
        (err) => errors.push(err),
      );

      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('missing "type" field');

      adapter.shutdown();
    });
  });

  describe('shutdown', () => {
    it('cleans up without crash', () => {
      const adapter = new MCAdapter({
        projectRoot: '/tmp/test-mc',
        projectId: 'test-project',
      });

      adapter.shutdown();
      expect(true).toBe(true);
    });
  });
});