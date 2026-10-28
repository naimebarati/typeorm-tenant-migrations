import { describe, expect, it } from 'vitest';
import type { TenantMigrationOptions } from '../../src/config/types.js';
import { validateOptions } from '../../src/config/validate-config.js';
import { errorMessageOf } from '../../src/errors/sanitize.js';
import { resolveBaseOptions } from '../../src/postgres/create-tenant-data-source.js';
import { assertUrlHasNoStartupOptions } from '../../src/postgres/search-path.js';
import { runPool } from '../../src/runner/worker-pool.js';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe('runPool', () => {
  it('never exceeds the concurrency bound and returns results by index', async () => {
    let active = 0;
    let peak = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return n * 10;
    }, () => false);
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });

  it('stops starting items once shouldStop() is true, but lets in-flight items finish', async () => {
    const started: number[] = [];
    let stop = false;
    const out = await runPool([1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      if (n === 2) stop = true;
      await new Promise((r) => setTimeout(r, 20));
      return n;
    }, () => stop);
    expect(started).toEqual([1, 2]);
    expect(out).toEqual([1, 2, undefined, undefined]);
  });

  it('a worker that throws (a bug: workers must not) surfaces after the in-flight work settles', async () => {
    let finished = false;
    const result = runPool([1, 2], 2, async (n) => {
      if (n === 1) throw new Error('worker bug');
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
      return n;
    }, () => false);
    await expect(result).rejects.toThrow('worker bug');
    expect(finished).toBe(true);
  });

  it('handles an empty list', async () => {
    expect(await runPool([], 4, async () => 1, () => false)).toEqual([]);
  });
});

describe('errorMessageOf', () => {
  it('handles Error, string and anything else', () => {
    expect(errorMessageOf(new Error('x'))).toBe('x');
    expect(errorMessageOf('plain')).toBe('plain');
    expect(errorMessageOf({ weird: true })).toBe('Unknown error');
    expect(errorMessageOf(undefined)).toBe('Unknown error');
  });
});

describe('defensive validation', () => {
  it('options must be an object; fallbackSchemas must be a list of strings', () => {
    expect(codeOf(() => validateOptions([] as unknown as TenantMigrationOptions))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => validateOptions({ searchPathMode: 'tenant-first', fallbackSchemas: 'public' } as never))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => validateOptions({ searchPathMode: 'tenant-first', fallbackSchemas: [1] } as never))).toBe('INVALID_CONFIGURATION');
  });

  it('dataSource must be a DataSource or options object', () => {
    expect(codeOf(() => resolveBaseOptions(null as never))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => resolveBaseOptions('postgres://x' as never))).toBe('INVALID_CONFIGURATION');
  });

  it('url / extra.connectionString must be strings when present', () => {
    expect(codeOf(() => assertUrlHasNoStartupOptions(42, 'url'))).toBe('INVALID_CONFIGURATION');
    expect(() => assertUrlHasNoStartupOptions(undefined, 'url')).not.toThrow();
    expect(() => assertUrlHasNoStartupOptions(null, 'url')).not.toThrow();
  });

  it('a URL that cannot be parsed still gets the textual check', () => {
    expect(codeOf(() => assertUrlHasNoStartupOptions('not a url?options=x', 'url'))).toBe('INVALID_CONFIGURATION');
    expect(() => assertUrlHasNoStartupOptions('not a url', 'url')).not.toThrow();
  });
});
