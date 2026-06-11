import crypto from 'node:crypto';
import type { Signature } from '../types/index.js';

interface SignatureInput {
  type: string;
  entity: string;
  argSchema: Record<string, string>;
}

/** Deterministic signature from structural identity (type + entity + arg schema shape, not values) */
export function computeSignature(input: SignatureInput): Signature {
  const canonical = JSON.stringify({
    t: input.type,
    e: input.entity,
    a: Object.entries(input.argSchema)
      .sort(([a], [b]) => a.localeCompare(b))
      .reduce<Record<string, string>>((acc, [k, v]) => { acc[k] = v; return acc; }, {}),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
