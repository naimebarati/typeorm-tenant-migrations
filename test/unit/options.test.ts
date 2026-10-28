import { describe, expect, it } from 'vitest';
import { validateOptions } from '../../src/config/validate-config.js';
import type { TenantMigrationOptions } from '../../src/config/types.js';
import { TenantMigrationError } from '../../src/errors/index.js';

const fails = (opts: unknown) => {
  try {
    validateOptions(opts as TenantMigrationOptions);
  } catch (e) {
    expect(e).toBeInstanceOf(TenantMigrationError);
    return (e as TenantMigrationError).code;
  }
  return undefined;
};

describe('validateOptions', () => {
  it('defaults are conservative', () => {
    const { options } = validateOptions(undefined);
    expect(options).toMatchObject({
      concurrency: 1,
      transaction: 'each',
      continueOnError: false,
      lockTimeoutMs: 30_000,
      searchPathMode: 'tenant-only',
      migrationsTableName: undefined,
    });
    expect(options.fallbackSchemas).toEqual([]);
  });

  it.each([0, -1, 1.5, '2', NaN, Infinity, 65])('rejects concurrency %s', (c) => {
    expect(fails({ concurrency: c, maxConcurrency: 64 })).toBe('INVALID_CONFIGURATION');
  });

  it('enforces the configurable concurrency cap', () => {
    expect(fails({ concurrency: 9 })).toBe('INVALID_CONFIGURATION');
    expect(validateOptions({ concurrency: 9, maxConcurrency: 16 }).options.concurrency).toBe(9);
  });

  it.each(['ALL', 'true', true, undefined === 1])('rejects transaction %s', (t) => {
    if (t === undefined) return;
    expect(fails({ transaction: t })).toBe('INVALID_CONFIGURATION');
  });

  it.each(['all', 'each', 'none'] as const)('accepts transaction %s', (t) => {
    expect(validateOptions({ transaction: t }).options.transaction).toBe(t);
  });

  it.each([-1, 1.5, '1000', NaN, Infinity, 3_600_001])('rejects lockTimeoutMs %s', (v) => {
    expect(fails({ lockTimeoutMs: v })).toBe('INVALID_CONFIGURATION');
  });

  it('allows lockTimeoutMs 0 (try once)', () => {
    expect(validateOptions({ lockTimeoutMs: 0 }).options.lockTimeoutMs).toBe(0);
  });

  it('rejects non-boolean continueOnError', () => {
    expect(fails({ continueOnError: 'yes' })).toBe('INVALID_CONFIGURATION');
  });

  it('rejects unknown options (typos must not silently fall back to defaults)', () => {
    expect(fails({ concurency: 4 })).toBe('INVALID_CONFIGURATION');
  });

  it.each(['mig"; DROP', '1abc', 'a-b', '', 'a'.repeat(64), 'a b'])('rejects migrationsTableName %j', (n) => {
    expect(fails({ migrationsTableName: n })).toBe('INVALID_CONFIGURATION');
  });

  it('accepts a plain migrationsTableName', () => {
    expect(validateOptions({ migrationsTableName: 'Tenant_Migrations' }).options.migrationsTableName).toBe('Tenant_Migrations');
  });

  describe('search path policy', () => {
    it('refuses fallback schemas unless tenant-first is explicit', () => {
      expect(fails({ fallbackSchemas: ['public'] })).toBe('INVALID_CONFIGURATION');
      expect(fails({ searchPathMode: 'tenant-first' })).toBe('INVALID_CONFIGURATION');
      expect(fails({ searchPathMode: 'tenant-first', fallbackSchemas: [] })).toBe('INVALID_CONFIGURATION');
    });

    it('accepts explicit public fallback', () => {
      const { options } = validateOptions({ searchPathMode: 'tenant-first', fallbackSchemas: ['public', 'shared'] });
      expect(options.fallbackSchemas).toEqual(['public', 'shared']);
    });

    it('validates fallback names and rejects duplicates', () => {
      expect(fails({ searchPathMode: 'tenant-first', fallbackSchemas: ['Shared'] })).toBe('UNSAFE_SCHEMA_NAME');
      expect(fails({ searchPathMode: 'tenant-first', fallbackSchemas: ['a"b'] })).toBe('UNSAFE_SCHEMA_NAME');
      expect(fails({ searchPathMode: 'tenant-first', fallbackSchemas: ['public', 'public'] })).toBe('INVALID_CONFIGURATION');
      expect(fails({ searchPathMode: 'bogus' })).toBe('INVALID_CONFIGURATION');
    });
  });

  it('validates the logger shape', () => {
    expect(fails({ logger: {} })).toBe('INVALID_CONFIGURATION');
    expect(fails({ logger: { info() {}, warn() {} } })).toBe('INVALID_CONFIGURATION');
    const logger = { info() {}, warn() {}, error() {} };
    expect(validateOptions({ logger }).logger).toBe(logger);
  });
});
