/**
 * Acme Data Pipeline — Example test for ETL validation signature.
 */

import { describe, it, expect } from 'vitest';
import { computeSignature } from '../../../dist/algorithm/signature.js';

describe('Acme Data Pipeline signatures', () => {
  it('computes deterministic signature for etl-validate', () => {
    const sig1 = computeSignature({
      type: 'etl-validate',
      entity: 'dataset',
      argSchema: { datasetId: 'string', format: 'string' },
    });
    const sig2 = computeSignature({
      type: 'etl-validate',
      entity: 'dataset',
      argSchema: { datasetId: 'string', format: 'string' },
    });
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64); // SHA-256 hex
  });

  it('produces different signatures for different types', () => {
    const validate = computeSignature({
      type: 'etl-validate',
      entity: 'dataset',
      argSchema: { datasetId: 'string', format: 'string' },
    });
    const transform = computeSignature({
      type: 'etl-transform',
      entity: 'dataset',
      argSchema: { datasetId: 'string', format: 'string' },
    });
    expect(validate).not.toBe(transform);
  });
});
