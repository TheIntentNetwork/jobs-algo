import { describe, it, expect } from 'vitest';
import { MC_TERMINAL_STATES } from '../src/integration/mc/mc-types.js';
import type { MCJobState, MCJobSpec, MCJobTypeDefinition, MCIntegrationManifest } from '../src/integration/mc/mc-types.js';

describe('mc-types', () => {
  describe('MC_TERMINAL_STATES', () => {
    it('includes all terminal job states', () => {
      expect(MC_TERMINAL_STATES.has('completed')).toBe(true);
      expect(MC_TERMINAL_STATES.has('failed')).toBe(true);
      expect(MC_TERMINAL_STATES.has('exhausted')).toBe(true);
      expect(MC_TERMINAL_STATES.has('cancelled')).toBe(true);
      expect(MC_TERMINAL_STATES.has('rejected')).toBe(true);
    });

    it('excludes non-terminal job states', () => {
      expect(MC_TERMINAL_STATES.has('new')).toBe(false);
      expect(MC_TERMINAL_STATES.has('queued')).toBe(false);
      expect(MC_TERMINAL_STATES.has('running')).toBe(false);
    });

    it('contains exactly 5 terminal states', () => {
      expect(MC_TERMINAL_STATES.size).toBe(5);
    });
  });

  describe('MCJobSpec type', () => {
    it('accepts minimal spec with just type', () => {
      const spec: MCJobSpec = { type: '@intent-network/core/ipm-package-build' };
      expect(spec.type).toBe('@intent-network/core/ipm-package-build');
    });

    it('accepts full spec with all optional fields', () => {
      const spec: MCJobSpec = {
        type: '@intent-network/core/ipm-package-validate',
        story_id: 'story_42',
        feature_id: 'feat_1',
        epic_id: 'epic_7',
        prompt: 'Validate the package manifest',
      };
      expect(spec.type).toContain('validate');
      expect(spec.story_id).toBe('story_42');
    });
  });

  describe('MCJobTypeDefinition type', () => {
    it('accepts a job type with loop config', () => {
      const jtype: MCJobTypeDefinition = {
        type: '@intent-network/core/ipm-package-build',
        description: 'Build an IPM package',
        loop: {
          mode: 'interval',
          interval_sec: 10,
          max_iterations: 1,
          on_max_reached: 'completed',
        },
        required_capability: 'implement',
      };
      expect(jtype.loop?.on_max_reached).toBe('completed');
    });
  });

  describe('MCIntegrationManifest type', () => {
    it('accepts a valid manifest', () => {
      const manifest: MCIntegrationManifest = {
        version: 1,
        package: '@intent-network/core',
        domain: 'intent-network',
        subdomain: 'core-plane',
        job_types: [{ path: 'job-types/*.yaml' }],
        providers: { allowed: ['local-process'], default: 'local-process' },
        llm_providers: { allowed: ['ollama-local'], default: 'ollama-local' },
      };
      expect(manifest.version).toBe(1);
      expect(manifest.package).toBe('@intent-network/core');
    });
  });
});


