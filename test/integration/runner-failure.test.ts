import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import { defineMigration, FailsAfterWork1700000000004, goodMigrations } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, columnsOf, createTestDatabase, tablesOf, waitForNoSessions } from '../helpers/pg.js';
import { startPgProxy } from '../helpers/proxy.js';
import { ALL, ALPHA, BETA, GAMMA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db, ['tenant_alpha', 'tenant_beta', 'tenant_gamma']));

const [m1, m2] = goodMigrations.map((M) => new M().name);
const historyOf = async (schema: string) =>
  (await db.client.query(`SELECT name FROM "${schema}".migrations ORDER BY id`)).rows.map((r) => r.name as string);

describe("transaction modes on a failing migration (schema tenant_alpha: [good, good, fails after work])", () => {
  const migrations = [...goodMigrations.slice(0, 2), FailsAfterWork1700000000004];

  it("'each' (default): earlier migrations stay committed, the failing one is fully rolled back", async () => {
    const report = await makeRunner({ db, migrations }).run({ target: { tenants: ['alpha'] } });
    const alpha = report.tenants[0]!;

    expect(alpha).toMatchObject({ status: 'failed', executed: [m1, m2], executedKnown: true, error: { code: 'MIGRATION_FAILED' } });
    expect(alpha.error!.message).toContain('boom: intentional test failure');
    expect(await historyOf('tenant_alpha')).toEqual([m1, m2]);
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'status']); // no half_done
  });

  it("'all': nothing from the batch survives", async () => {
    const report = await makeRunner({ db, migrations, options: { transaction: 'all' } }).run({ target: { tenants: ['alpha'] } });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [], error: { code: 'MIGRATION_FAILED' } });
    expect(await historyOf('tenant_alpha')).toEqual([]);
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id']);
    expect(await tablesOf(db.client, 'tenant_alpha')).not.toContain('things');
  });

  it("'none': the failing migration's partial work is NOT rolled back (documented hazard)", async () => {
    const report = await makeRunner({ db, migrations, options: { transaction: 'none' } }).run({ target: { tenants: ['alpha'] } });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [m1, m2] });
    expect(await historyOf('tenant_alpha')).toEqual([m1, m2]);
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toContain('half_done'); // physical state ahead of history
  });

  it("'all' refuses a migration that overrides the transaction mode (TypeORM rule), and reports it", async () => {
    const nonTx = defineMigration('NonTx1700000000009', async (q: QueryRunner) => {
      await q.query('SELECT 1');
    }, { transaction: false });
    const report = await makeRunner({ db, migrations: [...goodMigrations, nonTx], options: { transaction: 'all' } }).run({ target: { tenants: ['alpha'] } });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [], error: { code: 'MIGRATION_FAILED' } });
    expect(await historyOf('tenant_alpha')).toEqual([]);
  });

  it('a failure is not retried or rolled back automatically: the next run resumes exactly after the last committed migration', async () => {
    await makeRunner({ db, migrations }).run({ target: { tenants: ['alpha'] } });
    // Same failing set again: m1, m2 are not repeated, only the failing one is attempted (and fails again).
    const again = await makeRunner({ db, migrations }).run({ target: { tenants: ['alpha'] } });
    expect(again.tenants[0]).toMatchObject({ status: 'failed', pendingBeforeRun: ['FailsAfterWork1700000000004'], executed: [] });
    expect(await historyOf('tenant_alpha')).toEqual([m1, m2]);
  });
});

/** Fails only on tenant_beta, and counts how often it ran in each tenant (inside that tenant's own schema). */
const state = { failBeta: true };
const FlakyOnBeta = defineMigration('FlakyOnBeta1700000000010', async (q: QueryRunner) => {
  await q.query(`INSERT INTO "audit"(note) VALUES ('flaky ran')`);
  const rows = (await q.query('SELECT current_schema() AS s')) as Array<{ s: string }>;
  if (rows[0]?.s === 'tenant_beta' && state.failBeta) throw new Error('beta is broken');
});

describe('failure across tenants', () => {
  beforeEach(() => {
    state.failBeta = true;
  });
  const auditCount = async (schema: string) => Number((await db.client.query(`SELECT count(*) FROM "${schema}".audit`)).rows[0].count);

  it('fail-fast (default): stops scheduling after the first failure, reports the rest as not-started', async () => {
    const report = await makeRunner({ db, migrations: [FlakyOnBeta], tenants: [ALPHA, BETA, GAMMA] }).run({ target: ALL });
    expect(report.tenants.map((t) => [t.tenantId, t.status])).toEqual([
      ['alpha', 'success'],
      ['beta', 'failed'],
      ['gamma', 'not-started'],
    ]);
    expect(report.summary).toEqual({ total: 3, success: 1, failed: 1, locked: 0, skipped: 0, notStarted: 1 });
    expect(await tablesOf(db.client, 'tenant_gamma')).toEqual(['audit', 'orders']); // untouched
  });

  it('continueOnError: reports every tenant', async () => {
    const report = await makeRunner({ db, migrations: [FlakyOnBeta], tenants: [ALPHA, BETA, GAMMA], options: { continueOnError: true } }).run({ target: ALL });
    expect(report.tenants.map((t) => t.status)).toEqual(['success', 'failed', 'success']);
  });

  it('after a partial failure, re-running does not re-run what already succeeded', async () => {
    const runner = makeRunner({ db, migrations: [FlakyOnBeta], tenants: [ALPHA, BETA, GAMMA] });
    await runner.run({ target: ALL });
    expect(await auditCount('tenant_alpha')).toBe(1);
    expect(await auditCount('tenant_beta')).toBe(0); // its insert rolled back with the failed transaction

    state.failBeta = false; // "fix" the bug
    const second = await runner.run({ target: ALL });
    expect(second.tenants.map((t) => t.status)).toEqual(['skipped', 'success', 'success']);
    expect(await auditCount('tenant_alpha')).toBe(1); // NOT 2: alpha was not repeated
    expect(await auditCount('tenant_beta')).toBe(1);
    expect(await auditCount('tenant_gamma')).toBe(1);
  });

  it('releases every lock and connection after failures', async () => {
    await makeRunner({ db, migrations: [FlakyOnBeta], tenants: [ALPHA, BETA, GAMMA], options: { continueOnError: true } }).run({ target: ALL });
    expect(await waitForNoSessions(db)).toBe(0);
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });
});

describe('fail-closed on search_path', () => {
  it('does not run any migration when the connection path silently drops the search_path option', async () => {
    // A pooler that ignores startup options: the client asked for tenant_alpha, the server never heard it.
    const proxy = await startPgProxy({ host: String(db.options.host), port: Number(db.options.port) }, { stripOptions: true });
    try {
      const marker = defineMigration('Marker1700000000020', async (q: QueryRunner) => {
        await q.query(`INSERT INTO "orders"(id) VALUES (999)`); // would land in public.orders
      });
      const runner = makeRunner({ db, migrations: [marker], base: { port: proxy.port } });
      const report = await runner.run({ target: ALL });

      expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'SCHEMA_CONTEXT_MISMATCH' } });
      expect(report.tenants[1]!.status).toBe('not-started');
      expect((await db.client.query('SELECT count(*) FROM public.orders')).rows[0].count).toBe('0');
      expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'orders']);
      expect(await tablesOf(db.client, 'public')).toEqual(['orders']);

      const plan = await runner.plan({ target: ALL });
      expect(plan.tenants.every((t) => t.status === 'failed' && t.error?.code === 'SCHEMA_CONTEXT_MISMATCH')).toBe(true);
    } finally {
      await proxy.close();
    }
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('control: the same proxy without stripping works', async () => {
    const proxy = await startPgProxy({ host: String(db.options.host), port: Number(db.options.port) }, { stripOptions: false });
    try {
      const report = await makeRunner({ db, migrations: goodMigrations, base: { port: proxy.port } }).run({ target: { tenants: ['alpha'] } });
      expect(report.summary.success).toBe(1);
    } finally {
      await proxy.close();
    }
  });
});

describe('losing the database mid-migration', () => {
  it('reports failure and, when the history cannot be read back, says executed is unknown instead of guessing', async () => {
    const proxy = await startPgProxy({ host: String(db.options.host), port: Number(db.options.port) }, { stripOptions: false });
    try {
      const slow = defineMigration('Slow1700000000030', async (q: QueryRunner) => {
        await q.query(`ALTER TABLE "orders" ADD COLUMN "slow" text`);
        await q.query('SELECT pg_sleep(1.5)');
      });
      setTimeout(() => proxy.cut(), 500);
      const report = await makeRunner({ db, migrations: [slow], base: { port: proxy.port } }).run({ target: { tenants: ['alpha'] } });
      expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [], executedKnown: false });
      expect(report.tenants[0]!.error?.code).toBe('MIGRATION_FAILED');
    } finally {
      await proxy.close();
    }
    // The server rolled the transaction back when the client vanished.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id']);
    expect(await waitForNoSessions(db, 4000)).toBe(0);
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });
});
