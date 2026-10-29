import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { goodMigrations } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, columnsOf, createTestDatabase, snapshotDatabase, tablesOf, waitForNoSessions } from '../helpers/pg.js';
import { ALL, ALPHA, BETA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db));

const names = goodMigrations.map((M) => new M().name);
const historyOf = async (schema: string) =>
  (await db.client.query(`SELECT name FROM "${schema}".migrations ORDER BY id`)).rows.map((r) => r.name as string);

describe('run: one tenant', () => {
  it('changes only the selected schema (raw SQL, createTable, history all in tenant_alpha)', async () => {
    const before = await snapshotDatabase(db.client);
    const report = await makeRunner({ db, migrations: goodMigrations }).run({ target: { tenants: ['alpha'] } });

    expect(report.summary).toEqual({ total: 1, success: 1, failed: 0, locked: 0, skipped: 0, notStarted: 0 });
    expect(report.tenants[0]).toMatchObject({ tenantId: 'alpha', schema: 'tenant_alpha', status: 'success', pendingBeforeRun: names, executed: names, executedKnown: true });

    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'status', 'note']);
    expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'migrations', 'orders', 'things']);
    expect(await historyOf('tenant_alpha')).toEqual(names);

    expect(await columnsOf(db.client, 'tenant_beta', 'orders')).toEqual(['id']);
    expect(await tablesOf(db.client, 'tenant_beta')).toEqual(['audit', 'orders']);
    expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id']);
    expect(await tablesOf(db.client, 'public')).toEqual(['orders']);

    const after = await snapshotDatabase(db.client);
    expect(before.every((x) => after.includes(x))).toBe(true);
    expect(after.filter((x) => !before.includes(x)).every((x) => x.startsWith('tenant_alpha.'))).toBe(true);
  });

  it('does not repeat executed migrations on a second run', async () => {
    const runner = makeRunner({ db, migrations: goodMigrations });
    await runner.run({ target: { tenants: ['alpha'] } });
    const second = await runner.run({ target: { tenants: ['alpha'] } });

    expect(second.tenants[0]).toMatchObject({ status: 'skipped', pendingBeforeRun: [], executed: [] });
    expect(await historyOf('tenant_alpha')).toEqual(names);
  });
});

describe('run: all tenants', () => {
  it('gives each tenant its own independent history', async () => {
    const report = await makeRunner({ db, migrations: goodMigrations }).run({ target: ALL });
    expect(report.summary).toMatchObject({ total: 2, success: 2 });
    expect(await historyOf('tenant_alpha')).toEqual(names);
    expect(await historyOf('tenant_beta')).toEqual(names);
    expect(await tablesOf(db.client, 'public')).toEqual(['orders']);
    expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id']);
  });

  it('migrates only what is pending for a tenant that is partly migrated', async () => {
    await makeRunner({ db, migrations: [goodMigrations[0]!] }).run({ target: { tenants: ['alpha'] } });
    const report = await makeRunner({ db, migrations: goodMigrations }).run({ target: ALL });

    const [alpha, beta] = report.tenants;
    expect(alpha).toMatchObject({ status: 'success', pendingBeforeRun: names.slice(1), executed: names.slice(1) });
    expect(beta).toMatchObject({ status: 'success', pendingBeforeRun: names, executed: names });
    expect(await historyOf('tenant_alpha')).toEqual(names);
  });

  it('keeps provider order in the report', async () => {
    const report = await makeRunner({ db, migrations: goodMigrations, tenants: [BETA, ALPHA] }).run({ target: ALL });
    expect(report.tenants.map((t) => t.tenantId)).toEqual(['beta', 'alpha']);
  });
});

describe('plan / status parity with run', () => {
  it('plan lists exactly what run then executes, in the same order', async () => {
    const runner = makeRunner({ db, migrations: [...goodMigrations].reverse() }); // declaration order must not matter
    const plan = await runner.plan({ target: ALL });
    const report = await runner.run({ target: ALL });
    for (const [i, entry] of plan.tenants.entries()) {
      expect(entry.pending).toEqual(names);
      expect(entry.pendingCount).toBe(3);
      expect(report.tenants[i]!.executed).toEqual(entry.pending);
    }
    expect(plan.summary).toMatchObject({ total: 2, ok: 2, failed: 0, pendingTotal: 6 });
  });

  it('status reports executed, pending and history-table presence', async () => {
    const runner = makeRunner({ db, migrations: goodMigrations });
    await makeRunner({ db, migrations: goodMigrations.slice(0, 2) }).run({ target: { tenants: ['alpha'] } });
    const status = await runner.status({ target: ALL });
    expect(status.tenants[0]).toMatchObject({ tenantId: 'alpha', historyTableExists: true, executed: names.slice(0, 2), pending: [names[2]], unknownExecuted: [] });
    expect(status.tenants[1]).toMatchObject({ tenantId: 'beta', historyTableExists: false, executed: [], pending: names });
  });

  it('status flags history entries this build does not know about', async () => {
    await makeRunner({ db, migrations: goodMigrations }).run({ target: ALL });
    const older = makeRunner({ db, migrations: goodMigrations.slice(0, 1) });
    const status = await older.status({ target: { tenants: ['alpha'] } });
    expect(status.tenants[0]).toMatchObject({ pending: [], unknownExecuted: names.slice(1) });
  });
});

describe('plan / status are read-only', () => {
  it('create nothing when no history table exists, and say so', async () => {
    const before = await snapshotDatabase(db.client);
    const runner = makeRunner({ db, migrations: goodMigrations });
    const plan = await runner.plan({ target: ALL });
    const status = await runner.status({ target: ALL });

    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect(plan.tenants.every((t) => t.pending.length === 3)).toBe(true);
    expect(status.tenants.every((t) => t.historyTableExists === false)).toBe(true);
    expect(await tablesOf(db.client, 'tenant_alpha')).not.toContain('migrations');
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('change nothing when the history table exists either', async () => {
    const runner = makeRunner({ db, migrations: goodMigrations });
    await runner.run({ target: ALL });
    const before = await snapshotDatabase(db.client);
    const rowsBefore = (await db.client.query('SELECT * FROM tenant_alpha.migrations ORDER BY id')).rows;
    await runner.plan({ target: ALL });
    await runner.status({ target: ALL });
    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect((await db.client.query('SELECT * FROM tenant_alpha.migrations ORDER BY id')).rows).toEqual(rowsBefore);
  });

  it('fail for a missing schema without creating it', async () => {
    const before = await snapshotDatabase(db.client);
    const runner = makeRunner({ db, migrations: goodMigrations, tenants: [ALPHA, { id: 'ghost', schema: 'tenant_ghost' }] });
    const plan = await runner.plan({ target: ALL });
    expect(plan.tenants[1]).toMatchObject({ tenantId: 'ghost', status: 'failed', error: { code: 'SCHEMA_NOT_FOUND' } });
    expect(plan.summary).toMatchObject({ ok: 1, failed: 1 });
    expect(await snapshotDatabase(db.client)).toEqual(before);
  });
});

describe('preflight', () => {
  it('stops before any change when a schema is missing (default fail-fast)', async () => {
    const before = await snapshotDatabase(db.client);
    const runner = makeRunner({ db, migrations: goodMigrations, tenants: [ALPHA, { id: 'ghost', schema: 'tenant_ghost' }, BETA] });
    const report = await runner.run({ target: ALL });

    expect(report.tenants.map((t) => [t.tenantId, t.status])).toEqual([
      ['alpha', 'not-started'],
      ['ghost', 'failed'],
      ['beta', 'not-started'],
    ]);
    expect(report.tenants[1]!.error?.code).toBe('SCHEMA_NOT_FOUND');
    expect(await snapshotDatabase(db.client)).toEqual(before); // not even alpha was migrated
  });

  it('with continueOnError, migrates the healthy tenants and fails only the broken one', async () => {
    const runner = makeRunner({
      db,
      migrations: goodMigrations,
      tenants: [ALPHA, { id: 'ghost', schema: 'tenant_ghost' }, BETA],
      options: { continueOnError: true },
    });
    const report = await runner.run({ target: ALL });
    expect(report.tenants.map((t) => t.status)).toEqual(['success', 'failed', 'success']);
    expect(report.summary).toMatchObject({ success: 2, failed: 1 });
    expect(await tablesOf(db.client, 'tenant_ghost')).toEqual([]);
  });

  it('refuses public and system schemas before connecting', async () => {
    const before = await snapshotDatabase(db.client);
    for (const schema of ['public', 'pg_catalog', 'information_schema', 'pg_temp_1']) {
      const runner = makeRunner({ db, migrations: goodMigrations, tenants: [{ id: 'x', schema }] });
      await expect(runner.run({ target: ALL })).rejects.toMatchObject({ code: 'UNSAFE_SCHEMA_NAME' });
      await expect(runner.plan({ target: ALL })).rejects.toMatchObject({ code: 'UNSAFE_SCHEMA_NAME' });
    }
    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('refuses an unknown tenant id and a missing selection before connecting', async () => {
    const runner = makeRunner({ db, migrations: goodMigrations });
    await expect(runner.run({ target: { tenants: ['nope'] } })).rejects.toMatchObject({ code: 'INVALID_TENANT_TARGET' });
    await expect(runner.run({} as never)).rejects.toMatchObject({ code: 'INVALID_TENANT_TARGET' });
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('fails when the app has no migrations loaded (a mistyped glob must not look like success)', async () => {
    const before = await snapshotDatabase(db.client);
    const report = await makeRunner({ db, migrations: [] }).run({ target: ALL });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'MIGRATION_DISCOVERY_FAILED' } });
    expect(await snapshotDatabase(db.client)).toEqual(before);
  });
});

describe('ownership of the caller DataSource', () => {
  it('never initializes an uninitialized DataSource and never mutates its options', async () => {
    const ds = new DataSource({ ...db.options, migrations: goodMigrations, schema: 'public', extra: { max: 3 } });
    const optionsBefore = structuredCloneable(ds.options);
    const { TenantMigrationRunner } = await import('../../src/runner/tenant-migration-runner.js');
    const runner = new TenantMigrationRunner({ dataSource: ds, tenants: [ALPHA] });
    const result = await runner.run({ target: ALL });
    expect(result.summary.success).toBe(1);
    expect(ds.isInitialized).toBe(false);
    expect(structuredCloneable(ds.options)).toEqual(optionsBefore);
    expect((ds.options as { extra?: { options?: string } }).extra?.options).toBeUndefined();
  });

  it('leaves an initialized DataSource initialized and usable', async () => {
    const ds = new DataSource({ ...db.options, migrations: goodMigrations });
    await ds.initialize();
    try {
      const { TenantMigrationRunner } = await import('../../src/runner/tenant-migration-runner.js');
      await new TenantMigrationRunner({ dataSource: ds, tenants: [ALPHA] }).run({ target: ALL });
      expect(ds.isInitialized).toBe(true);
      expect(await ds.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      expect((await ds.query('SHOW search_path'))[0].search_path).not.toContain('tenant_alpha');
    } finally {
      await ds.destroy();
    }
  });

  it('works with a pool of one connection (no self-deadlock between verification and migration)', async () => {
    const report = await makeRunner({ db, migrations: goodMigrations, base: { extra: { max: 1 } } }).run({ target: ALL });
    expect(report.summary).toMatchObject({ success: 2 });
  });
});

describe('resource cleanup', () => {
  it('leaves no sessions and no advisory locks after plain runs', async () => {
    const runner = makeRunner({ db, migrations: goodMigrations });
    await runner.plan({ target: ALL });
    await runner.run({ target: ALL });
    await runner.run({ target: ALL });
    expect(await waitForNoSessions(db)).toBe(0);
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });
});

/** Options contain class references; compare their JSON-visible shape only. */
function structuredCloneable(options: unknown): unknown {
  return JSON.parse(JSON.stringify(options, (_k, v) => (typeof v === 'function' ? `fn:${v.name}` : v)));
}
