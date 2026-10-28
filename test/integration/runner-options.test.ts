import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineMigration, goodMigrations } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, columnsOf, createTestDatabase, tablesOf, waitForNoSessions } from '../helpers/pg.js';
import { ALL, ALPHA, BETA, GAMMA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db, ['tenant_alpha', 'tenant_beta', 'tenant_gamma']));

const names = goodMigrations.map((M) => new M().name);
const one = { tenants: ['alpha'] } as const;
const rows = async (sql: string) => (await db.client.query(sql)).rows;

describe('custom history table name', () => {
  it('option: history lives under that name in the tenant schema, and run/plan/status all use it', async () => {
    const runner = makeRunner({ db, migrations: goodMigrations, options: { migrationsTableName: 'tenant_history' } });
    expect((await runner.plan({ target: one })).tenants[0]!.pending).toEqual(names);

    expect((await runner.run({ target: one })).tenants[0]).toMatchObject({ status: 'success', executed: names });
    expect(await tablesOf(db.client, 'tenant_alpha')).toContain('tenant_history');
    expect(await tablesOf(db.client, 'tenant_alpha')).not.toContain('migrations');
    expect((await rows('SELECT name FROM tenant_alpha.tenant_history ORDER BY id')).map((r) => r.name)).toEqual(names);

    expect((await runner.run({ target: one })).tenants[0]!.status).toBe('skipped');
    expect((await runner.status({ target: one })).tenants[0]).toMatchObject({ historyTableExists: true, executed: names, pending: [] });
  });

  it('the base DataSource migrationsTableName is honored, and the option wins over it', async () => {
    await makeRunner({ db, migrations: goodMigrations, base: { migrationsTableName: 'from_base' } }).run({ target: one });
    expect(await tablesOf(db.client, 'tenant_alpha')).toContain('from_base');

    await makeRunner({ db, migrations: goodMigrations, base: { migrationsTableName: 'from_base' }, options: { migrationsTableName: 'from_option' } }).run({ target: { tenants: ['beta'] } });
    expect(await tablesOf(db.client, 'tenant_beta')).toContain('from_option');
    expect(await tablesOf(db.client, 'tenant_beta')).not.toContain('from_base');
  });

  it('a different table name is a different history (nothing is shared with the default one)', async () => {
    await makeRunner({ db, migrations: goodMigrations }).run({ target: one });
    const status = await makeRunner({ db, migrations: goodMigrations, options: { migrationsTableName: 'other' } }).status({ target: one });
    expect(status.tenants[0]).toMatchObject({ historyTableExists: false, pending: names });
  });
});

describe("searchPathMode 'tenant-first' (the documented hazard, proven)", () => {
  const AlterOrders = defineMigration('AlterOrders1700000000070', async (q: QueryRunner) => {
    await q.query('ALTER TABLE "orders" ADD COLUMN "leak" text');
  });
  const CreateHere = defineMigration('CreateHere1700000000071', async (q: QueryRunner) => {
    await q.query('CREATE TABLE "made_here" (id int)');
  });
  // tenant_gamma has no "orders" table of its own; public.orders exists.
  const gamma = { tenants: ['gamma'] } as const;

  it("default 'tenant-only': a missing tenant table is an error and public is untouched", async () => {
    await db.client.query('DROP TABLE tenant_gamma.orders');
    const report = await makeRunner({ db, migrations: [AlterOrders], tenants: [GAMMA] }).run({ target: gamma });

    expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [], error: { code: 'MIGRATION_FAILED' } });
    expect(report.tenants[0]!.error!.message).toMatch(/relation "orders" does not exist/);
    expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id']);
    expect(await rows('SELECT count(*)::int AS n FROM tenant_gamma.migrations')).toEqual([{ n: 0 }]);
  });

  it("'tenant-first' with a public fallback: the same migration silently alters public.orders", async () => {
    await db.client.query('DROP TABLE tenant_gamma.orders');
    const runner = makeRunner({ db, migrations: [AlterOrders], tenants: [GAMMA], options: { searchPathMode: 'tenant-first', fallbackSchemas: ['public'] } });
    const report = await runner.run({ target: gamma });

    expect(report.tenants[0]!.status).toBe('success'); // verified: path is [tenant_gamma, public]
    expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id', 'leak']); // <- lands in the fallback
    expect(await tablesOf(db.client, 'tenant_gamma')).toEqual(['audit', 'migrations']);
  });

  it("'tenant-first': new objects are still created in the tenant schema (first in path), history too", async () => {
    await makeRunner({ db, migrations: [CreateHere], tenants: [GAMMA], options: { searchPathMode: 'tenant-first', fallbackSchemas: ['public'] } }).run({ target: gamma });
    expect(await tablesOf(db.client, 'tenant_gamma')).toContain('made_here');
    expect(await tablesOf(db.client, 'public')).not.toContain('made_here');
    expect(await tablesOf(db.client, 'tenant_gamma')).toContain('migrations');
  });

  it("'tenant-first' plan/status work and use the same path", async () => {
    const runner = makeRunner({ db, migrations: [CreateHere], tenants: [GAMMA], options: { searchPathMode: 'tenant-first', fallbackSchemas: ['public'] } });
    expect((await runner.plan({ target: gamma })).tenants[0]).toMatchObject({ status: 'ok', pending: ['CreateHere1700000000071'] });
  });
});

describe('user startup options are merged, not replaced', () => {
  const Probe = defineMigration('Probe1700000000080', async (q: QueryRunner) => {
    await q.query(`INSERT INTO "audit"(note) SELECT 'timeout=' || current_setting('statement_timeout') || ' path=' || current_setting('search_path')`);
  });
  const Sleepy = defineMigration('Sleepy1700000000081', async (q: QueryRunner) => {
    await q.query('SELECT pg_sleep(2)');
  });

  it("the user's -c statement_timeout and our search_path are both in effect on the migration connection", async () => {
    const base = { extra: { options: '-c statement_timeout=450' } };
    await makeRunner({ db, migrations: [Probe], base }).run({ target: one });
    expect((await rows('SELECT note FROM tenant_alpha.audit')).map((r) => r.note)).toEqual(['timeout=450ms path=tenant_alpha']);
  });

  it('the timeout really applies (a slow migration is cancelled and reported, nothing is recorded)', async () => {
    const base = { extra: { options: '-c statement_timeout=300' } };
    const report = await makeRunner({ db, migrations: [Sleepy], base }).run({ target: one });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [], error: { code: 'MIGRATION_FAILED' } });
    expect(report.tenants[0]!.error!.message).toMatch(/statement timeout/);
    expect(await rows('SELECT count(*)::int AS n FROM tenant_alpha.migrations')).toEqual([{ n: 0 }]);
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });

  it('plan/status keep the user options as well as read-only', async () => {
    const base = { extra: { options: '-c statement_timeout=450' } };
    const status = await makeRunner({ db, migrations: [Probe], base }).status({ target: one });
    expect(status.tenants[0]!.status).toBe('ok');
  });
});

describe("transaction 'all' on success", () => {
  const txOf = async () => (await rows('SELECT count(DISTINCT xmin::text)::int AS n FROM tenant_alpha.migrations'))[0]!.n as number;

  it("'all' commits every migration in ONE transaction, 'each' in one per migration", async () => {
    const all = await makeRunner({ db, migrations: goodMigrations, options: { transaction: 'all' } }).run({ target: one });
    expect(all.tenants[0]).toMatchObject({ status: 'success', executed: names });
    expect(await txOf()).toBe(1);

    await seedTenants(db, ['tenant_alpha', 'tenant_beta', 'tenant_gamma']);
    const each = await makeRunner({ db, migrations: goodMigrations, options: { transaction: 'each' } }).run({ target: one });
    expect(each.tenants[0]!.status).toBe('success');
    expect(await txOf()).toBe(3);
  });

  it("'none' also succeeds and records everything", async () => {
    const r = await makeRunner({ db, migrations: goodMigrations, options: { transaction: 'none' } }).run({ target: one });
    expect(r.tenants[0]).toMatchObject({ status: 'success', executed: names });
  });
});

describe('concurrency > 1 with a failure', () => {
  // beta fails at once; alpha is slow and healthy; gamma is only reachable after a free lane.
  const SlowOrFail = defineMigration('SlowOrFail1700000000090', async (q: QueryRunner) => {
    const [row] = (await q.query('SELECT current_schema() AS s')) as Array<{ s: string }>;
    if (row?.s === 'tenant_beta') throw new Error('beta fails at once');
    await q.query('SELECT pg_sleep(1)');
    await q.query(`INSERT INTO "audit"(note) VALUES ('finished')`);
  });
  const finished = async (schema: string) => (await rows(`SELECT count(*)::int AS n FROM ${schema}.audit`))[0]!.n as number;

  it('fail-fast: the tenant already in flight completes and is reported; the next one is never started', async () => {
    const runner = makeRunner({ db, migrations: [SlowOrFail], tenants: [ALPHA, BETA, GAMMA], options: { concurrency: 2 } });
    const report = await runner.run({ target: ALL });

    expect(report.tenants.map((t) => [t.tenantId, t.status])).toEqual([
      ['alpha', 'success'],
      ['beta', 'failed'],
      ['gamma', 'not-started'],
    ]);
    expect(await finished('tenant_alpha')).toBe(1); // alpha was not cancelled mid-migration
    expect(await finished('tenant_gamma')).toBe(0);
    expect(await tablesOf(db.client, 'tenant_gamma')).toEqual(['audit', 'orders']);
    expect(await waitForNoSessions(db)).toBe(0);
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });

  it('continueOnError: every tenant gets its real outcome', async () => {
    const runner = makeRunner({ db, migrations: [SlowOrFail], tenants: [ALPHA, BETA, GAMMA], options: { concurrency: 2, continueOnError: true } });
    const report = await runner.run({ target: ALL });
    expect(report.tenants.map((t) => t.status)).toEqual(['success', 'failed', 'success']);
    expect(report.summary).toMatchObject({ success: 2, failed: 1, notStarted: 0 });
  });
});

describe('migration discovery failures are reported per tenant and change nothing', () => {
  it('a migration whose class name has no timestamp', async () => {
    const Bad = defineMigration('NoTimestampHere', async () => {});
    const report = await makeRunner({ db, migrations: [Bad] }).run({ target: one });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'MIGRATION_DISCOVERY_FAILED' } });
    expect(report.tenants[0]!.error!.message).toContain('13-digit');
    expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'orders']);
  });

  it('two migrations with the same name', async () => {
    const A = defineMigration('Same1700000000099', async () => {});
    const B = defineMigration('Same1700000000099', async () => {});
    const report = await makeRunner({ db, migrations: [A, B] }).run({ target: one });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'MIGRATION_DISCOVERY_FAILED' } });
    expect(report.tenants[0]!.error!.message).toContain('Duplicate migration name');
    expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'orders']);
  });

  it('plan reports the same failure instead of listing a bogus plan', async () => {
    const Bad = defineMigration('NoTimestampHere', async () => {});
    const plan = await makeRunner({ db, migrations: [Bad] }).plan({ target: one });
    expect(plan.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'MIGRATION_DISCOVERY_FAILED' } });
  });
});
