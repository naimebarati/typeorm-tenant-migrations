import { describe, expect, it, vi } from 'vitest';
import type { TenantMigrationError } from '../../src/errors/index.js';
import {
  silentTypeOrmLogger,
  buildLockDataSourceOptions,
  buildTenantDataSourceOptions,
  collectSecrets,
  resolveBaseOptions,
} from '../../src/postgres/create-tenant-data-source.js';
import { buildSearchPath, mergeStartupOptions, parseSearchPathSetting } from '../../src/postgres/search-path.js';
import type { PostgresOptions } from '../../src/postgres/create-tenant-data-source.js';

const base = (over: Partial<PostgresOptions> = {}): PostgresOptions => ({
  type: 'postgres',
  host: 'h',
  username: 'u',
  password: 'pw-secret',
  database: 'd',
  ...over,
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as TenantMigrationError).code;
  }
};

describe('search path', () => {
  it('tenant-only is exactly the tenant schema, even if fallbacks are passed', () => {
    expect(buildSearchPath('tenant_a', 'tenant-only', ['public'])).toEqual(['tenant_a']);
  });

  it('tenant-first appends the explicit fallbacks', () => {
    expect(buildSearchPath('tenant_a', 'tenant-first', ['shared', 'public'])).toEqual(['tenant_a', 'shared', 'public']);
  });

  it('parses the GUC as PostgreSQL prints it', () => {
    expect(parseSearchPathSetting('tenant_a')).toEqual(['tenant_a']);
    expect(parseSearchPathSetting('tenant_a, public')).toEqual(['tenant_a', 'public']);
    expect(parseSearchPathSetting('"$user", public')).toEqual(['$user', 'public']);
  });

  it('merges into existing startup options and refuses a competing search_path', () => {
    expect(mergeStartupOptions(undefined, ['t'])).toBe('-c search_path=t');
    expect(mergeStartupOptions('-c statement_timeout=5000', ['t', 'public'])).toBe('-c statement_timeout=5000 -c search_path=t,public');
    expect(codeOf(() => mergeStartupOptions('-c search_path=public', ['t']))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => mergeStartupOptions('--SEARCH_PATH=public', ['t']))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => mergeStartupOptions(42, ['t']))).toBe('INVALID_CONFIGURATION');
  });
});

describe('buildTenantDataSourceOptions', () => {
  const spec = { schema: 'tenant_a', searchPath: ['tenant_a'] as const };

  it('sets schema, search_path startup option and safe flags', () => {
    const out = buildTenantDataSourceOptions(base({ synchronize: true, migrationsRun: true, dropSchema: true, installExtensions: true, logging: true }), spec);
    expect(out.schema).toBe('tenant_a');
    expect((out.extra as Record<string, unknown>).options).toBe('-c search_path=tenant_a');
    expect(out).toMatchObject({ synchronize: false, migrationsRun: false, dropSchema: false, installExtensions: false, logging: false });
    expect(out.applicationName).toBe('typeorm-tenant-migrations');
  });

  it('warns when it overrides a dangerous base flag', () => {
    const warn = vi.fn();
    buildTenantDataSourceOptions(base({ synchronize: true }), spec, { warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('synchronize');
  });

  it('does not mutate the base options, including nested extra', () => {
    const extra = { max: 3, options: '-c statement_timeout=1' };
    const original = base({ extra, schema: 'public' });
    const snapshot = JSON.stringify(original);
    Object.freeze(extra);
    Object.freeze(original);
    const out = buildTenantDataSourceOptions(original, spec);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(out.extra).not.toBe(extra);
    expect((out.extra as Record<string, unknown>).max).toBe(3);
    expect(original.schema).toBe('public');
  });

  it('keeps the same migrations / entities references (classes must not be cloned)', () => {
    class M1700000000001 {}
    const out = buildTenantDataSourceOptions(base({ migrations: [M1700000000001] }), spec);
    expect((out.migrations as unknown[])[0]).toBe(M1700000000001);
  });

  it('uses the configured history table name', () => {
    expect(buildTenantDataSourceOptions(base(), { ...spec, migrationsTableName: 'tenant_history' }).migrationsTableName).toBe('tenant_history');
  });

  it('refuses a base that already pins search_path', () => {
    expect(codeOf(() => buildTenantDataSourceOptions(base({ extra: { options: '-c search_path=public' } }), spec))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => buildTenantDataSourceOptions(base({ url: 'postgres://u:p@h/d?options=-c%20search_path%3Dpublic' }), spec))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => buildTenantDataSourceOptions(base({ extra: { connectionString: 'postgres://u:p@h/d?options=x' } }), spec))).toBe('INVALID_CONFIGURATION');
  });

  it('accepts a plain URL', () => {
    expect(() => buildTenantDataSourceOptions(base({ url: 'postgres://u:p@h:5432/d?sslmode=require' }), spec)).not.toThrow();
  });
});

describe('buildLockDataSourceOptions', () => {
  it('is a single-connection source that loads no user code', () => {
    const out = buildLockDataSourceOptions(base({ entities: [class A {}], migrations: [class B1700000000001 {}], extra: { max: 20 } }));
    expect((out.extra as Record<string, unknown>).max).toBe(1);
    expect(out.entities).toEqual([]);
    expect(out.migrations).toEqual([]);
    expect(out.schema).toBeUndefined();
  });
});

describe('resolveBaseOptions', () => {
  it('rejects other drivers and replication', () => {
    expect(codeOf(() => resolveBaseOptions({ type: 'mysql' } as never))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => resolveBaseOptions({ type: 'cockroachdb' } as never))).toBe('INVALID_CONFIGURATION');
    expect(codeOf(() => resolveBaseOptions(base({ replication: { master: {}, slaves: [] } })))).toBe('INVALID_CONFIGURATION');
  });

  it('reads options from a DataSource-like object without touching it', () => {
    const fake = { initialize: () => { throw new Error('must not be called'); }, options: base() };
    expect(resolveBaseOptions(fake as never)).toBe(fake.options);
  });
});

describe('collectSecrets', () => {
  it('gathers password, URL and URL password', () => {
    const s = collectSecrets(base({ password: 'a-pass', url: 'postgres://u:url%20pw@h/d', extra: { password: 'x-pass' } }));
    expect(s).toEqual(expect.arrayContaining(['a-pass', 'postgres://u:url%20pw@h/d', 'url pw', 'url%20pw', 'x-pass']));
  });
});

describe('silentTypeOrmLogger', () => {
  it('implements every TypeORM Logger method and prints nothing, whatever it is given', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      silentTypeOrmLogger.logQuery('SELECT secret', ['p']);
      silentTypeOrmLogger.logQueryError('boom', 'SELECT secret', ['p']);
      silentTypeOrmLogger.logQuerySlow(5000, 'SELECT secret', ['p']);
      silentTypeOrmLogger.logSchemaBuild('schema');
      silentTypeOrmLogger.logMigration('Migration X failed, error: postgres://u:p@h/d');
      silentTypeOrmLogger.log('warn', 'message');
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
