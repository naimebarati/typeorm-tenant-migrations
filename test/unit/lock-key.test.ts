import { describe, expect, it } from 'vitest';
import { computeLockKey } from '../../src/postgres/advisory-lock.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

describe('computeLockKey', () => {
  it('is deterministic', () => {
    expect(computeLockKey('app', 'tenant_a')).toBe(computeLockKey('app', 'tenant_a'));
  });

  it('differs per schema and per database', () => {
    const keys = new Set([
      computeLockKey('app', 'tenant_a'),
      computeLockKey('app', 'tenant_b'),
      computeLockKey('other', 'tenant_a'),
    ]);
    expect(keys.size).toBe(3);
  });

  it('keeps database and schema distinguishable (valid schema names never contain ":")', () => {
    // The only way to collide with the "<db>:<schema>" format is a ":" inside the schema, which
    // validateTarget rejects. Swapping the two parts must still give a different key.
    expect(computeLockKey('alpha', 'beta')).not.toBe(computeLockKey('beta', 'alpha'));
  });

  it('always fits PostgreSQL bigint', () => {
    for (let i = 0; i < 2000; i++) {
      const k = computeLockKey('db', `tenant_${i}`);
      expect(k >= INT64_MIN && k <= INT64_MAX).toBe(true);
    }
  });

  it('is pinned: runner versions must keep agreeing on the key for a tenant', () => {
    // sha256("typeorm-tenant-migrations:app:tenant_alpha"), first 8 bytes, big-endian signed.
    expect(computeLockKey('app', 'tenant_alpha').toString()).toBe('-1063241626000979709');
  });
});
