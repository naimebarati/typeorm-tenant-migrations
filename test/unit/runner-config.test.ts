import { describe, expect, it } from 'vitest';
import type { DataSourceOptions } from 'typeorm';
import { TenantMigrationError } from '../../src/errors/index.js';
import { TenantMigrationRunner } from '../../src/runner/tenant-migration-runner.js';

const pg: DataSourceOptions = { type: 'postgres', host: 'h', username: 'u', password: 'secret-pass', database: 'd' };
const tenants = [{ id: 'a', schema: 'tenant_a' }];

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TenantMigrationError);
    return (e as TenantMigrationError).code;
  }
};

describe('TenantMigrationRunner constructor (no database access)', () => {
  it('accepts a minimal valid config and exposes conservative resolved options', () => {
    const runner = new TenantMigrationRunner({ dataSource: pg, tenants });
    expect(runner.resolvedOptions).toMatchObject({ concurrency: 1, transaction: 'each', continueOnError: false, searchPathMode: 'tenant-only' });
  });

  it.each([
    ['missing config', undefined],
    ['missing tenants', { dataSource: pg }],
    ['tenants of wrong type', { dataSource: pg, tenants: 'a' }],
    ['unsupported driver', { dataSource: { type: 'mysql' }, tenants }],
    ['replication', { dataSource: { ...pg, replication: { master: {}, slaves: [] } }, tenants }],
    ['bad option', { dataSource: pg, tenants, options: { concurrency: 0 } }],
    ['unknown option', { dataSource: pg, tenants, options: { retries: 3 } }],
    ['bad history table name', { dataSource: { ...pg, migrationsTableName: 'x"; DROP' }, tenants }],
    ['search_path in extra.options', { dataSource: { ...pg, extra: { options: '-c search_path=public' } }, tenants }],
  ])('throws INVALID_CONFIGURATION for %s', (_label, config) => {
    expect(codeOf(() => new TenantMigrationRunner(config as never))).toBe('INVALID_CONFIGURATION');
  });

  it('does not validate tenant contents until run (provider may be async), but run rejects them before any I/O', async () => {
    const runner = new TenantMigrationRunner({ dataSource: pg, tenants: [{ id: 'x', schema: 'public' }] });
    await expect(runner.run({ target: { all: true } })).rejects.toMatchObject({ code: 'UNSAFE_SCHEMA_NAME' });
  });

  it('warns once, at construction, when the base DataSource enables dangerous flags', () => {
    const lines: string[] = [];
    const logger = { info() {}, error() {}, warn: (m: string) => void lines.push(m) };
    new TenantMigrationRunner({
      dataSource: { ...pg, synchronize: true, migrationsRun: true, dropSchema: true, installExtensions: true },
      tenants,
      options: { logger },
    });
    expect(lines.map((l) => l.match(/"(\w+)"/)?.[1]).sort()).toEqual(['dropSchema', 'installExtensions', 'migrationsRun', 'synchronize']);
  });

  it('error messages do not contain the configured password', () => {
    const msg = (() => {
      try {
        new TenantMigrationRunner({ dataSource: { ...pg, extra: { options: '-c search_path=public' } }, tenants });
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(msg).not.toContain('secret-pass');
  });
});
