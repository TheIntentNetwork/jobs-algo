import { describe, it, expect } from 'vitest';
import { mcJobSignature, buildMCJobPayload } from '../src/integration/mc/mc-bridge.js';
import { computeSignature } from '../src/algorithm/signature.js';

describe('mc-bridge', () => {
  describe('mcJobSignature', () => {
    it('produces a deterministic signature from type, entity, argSchema', () => {
      const sig1 = mcJobSignature('@intent-network/core/ipm-package-build', 'package', { package_path: 'string' });
      const sig2 = mcJobSignature('@intent-network/core/ipm-package-build', 'package', { package_path: 'string' });
      expect(sig1).toBe(sig2);
    });

    it('produces different signatures for different types', () => {
      const sigBuild = mcJobSignature('@intent-network/core/ipm-package-build', 'package', { package_path: 'string' });
      const sigValidate = mcJobSignature('@intent-network/core/ipm-package-validate', 'package', { package_path: 'string' });
      expect(sigBuild).not.toBe(sigValidate);
    });

    it('is consistent with computeSignature', () => {
      const sig = mcJobSignature('fact', 'query', { q: 'string' });
      const expected = computeSignature({ type: 'fact', entity: 'query', argSchema: { q: 'string' } });
      expect(sig).toBe(expected);
    });
  });

  describe('buildMCJobPayload', () => {
    it('builds a JSON buffer with type and prompt', () => {
      const payload = buildMCJobPayload({
        type: '@intent-network/core/ipm-package-build',
        prompt: 'Build the package',
      });
      const parsed = JSON.parse(payload.toString('utf8'));
      expect(parsed.type).toBe('@intent-network/core/ipm-package-build');
      expect(parsed.prompt).toBe('Build the package');
    });

    it('includes optional fields when provided', () => {
      const payload = buildMCJobPayload({
        type: '@intent-network/core/ipm-package-validate',
        story_id: 'story_42',
        prompt: 'Validate everything',
      });
      const parsed = JSON.parse(payload.toString('utf8'));
      expect(parsed.story_id).toBe('story_42');
    });

    it('omits undefined optional fields', () => {
      const payload = buildMCJobPayload({
        type: '@intent-network/core/ipm-package-publish',
      });
      const parsed = JSON.parse(payload.toString('utf8'));
      expect(parsed).not.toHaveProperty('story_id');
      expect(parsed).not.toHaveProperty('chain_id');
    });
  });
});
