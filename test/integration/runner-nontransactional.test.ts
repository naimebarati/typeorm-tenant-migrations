/**
 * Non-transactional migrations (`transaction = false`, CREATE INDEX CONCURRENTLY, ...).
 * They are the case where "failure rolls everything back" does not hold, so these tests pin down
 * exactly what is and is not guaranteed, and that nothing is repaired or retried behind your back.
 */
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineMigration } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, createTestDatabase, tablesOf, waitForNoSessions } from '../helpers/pg.js';
import { ALL, ALPHA, BETA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db));

const one = { tenants: ['alpha'] } as const;
const rows = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;
const indexState = async (schema: string, name: string) =>
  (
    await rows(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name],
    )
  )[0] as { valid: boolean } | undefined;

const CreateIndex = (transaction: boolean | undefined) =>
  defineMigration(
    'IndexConcurrently1700000000110',
    async (q: QueryRunner) => {
      await q.query('CREATE INDEX CONCURRENTLY "orders_id_idx" ON "orders" ("id")');
    },
    { transaction },
  );

describe('CREATE INDEX CONCURRENTLY', () => {
  it('works when the migration opts out of the transaction, in the default mode', async () => {
    const report = await makeRunner({ db, migrations: [CreateIndex(false)], tenants: [ALPHA, BETA] }).run({ target: ALL });
    expect(report.summary).toMatchObject({ success: 2, failed: 0 });
    expect(await indexState('tenant_alpha', 'orders_id_idx')).toEqual({ valid: true });
    expect(await indexState('tenant_beta', 'orders_id_idx')).toEqual({ valid: true });
    expect(await indexState('public', 'orders_id_idx')).toBeUndefined();
    expect(await rows('SELECT count(*)::int AS n FROM tenant_alpha.migrations')).toEqual([{ n: 1 }]);
  });

  it('works for several tenants at once (concurrency 2): concurrent builds in different schemas do not block each other', async () => {
    const started = Date.now();
    const report = await makeRunner({ db, migrations: [CreateIndex(false)], tenants: [ALPHA, BETA], options: { concurrency: 2 } }).run({ target: ALL });
    expect(report.summary).toMatchObject({ success: 2 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('fails cleanly, and says why, when it was NOT marked non-transactional (PostgreSQL refuses inside a transaction)', async () => {
    const report = await makeRunner({ db, migrations: [CreateIndex(undefined)] }).run({ target: one });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [], error: { code: 'MIGRATION_FAILED' } });
    expect(report.tenants[0]!.error!.message).toMatch(/cannot run inside a transaction block/);
    expect(await indexState('tenant_alpha', 'orders_id_idx')).toBeUndefined();
  });

  it("'all' mode refuses a migration that opted out of the transaction, before running anything", async () => {
    const report = await makeRunner({ db, migrations: [CreateIndex(false)], options: { transaction: 'all' } }).run({ target: one });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [], error: { code: 'MIGRATION_FAILED' } });
    expect(await tablesOf(db.client, 'tenant_alpha')).not.toContain('step_one');
    expect(await indexState('tenant_alpha', 'orders_id_idx')).toBeUndefined();
  });
});

describe('a non-transactional migration that fails halfway (the documented hazard)', () => {
  // Two statements, no transaction. The second fails on duplicate data and leaves an INVALID index behind.
  const HalfDone = defineMigration(
    'HalfDone1700000000111',
    async (q: QueryRunner) => {
      await q.query('CREATE TABLE "step_one" (id int)');
      await q.query('CREATE UNIQUE INDEX CONCURRENTLY "orders_id_uq" ON "orders" ("id")');
    },
    { transaction: false },
  );

  beforeEach(async () => {
    await db.client.query('INSERT INTO tenant_alpha.orders VALUES (1), (1)'); // duplicates: the unique build must fail
  });

  it('reports the failure, records nothing, and leaves the physical state ahead of the history', async () => {
    const report = await makeRunner({ db, migrations: [HalfDone] }).run({ target: one });

    expect(report.tenants[0]).toMatchObject({ status: 'failed', executed: [], executedKnown: true, pendingBeforeRun: ['HalfDone1700000000111'], error: { code: 'MIGRATION_FAILED' } });
    expect(report.tenants[0]!.error!.message).toMatch(/could not create unique index|duplicate key/);
    expect(await rows('SELECT count(*)::int AS n FROM tenant_alpha.migrations')).toEqual([{ n: 0 }]);

    // ... but the first statement is committed and PostgreSQL left an INVALID index.
    expect(await tablesOf(db.client, 'tenant_alpha')).toContain('step_one');
    expect(await indexState('tenant_alpha', 'orders_id_uq')).toEqual({ valid: false });
    expect(await waitForNoSessions(db)).toBe(0);
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });

  it('is not retried or repaired automatically: the same run fails again, and plan still lists it as pending', async () => {
    const runner = makeRunner({ db, migrations: [HalfDone] });
    await runner.run({ target: one });
    const again = await runner.run({ target: one });

    expect(again.tenants[0]).toMatchObject({ status: 'failed', pendingBeforeRun: ['HalfDone1700000000111'], executed: [] });
    expect(again.tenants[0]!.error!.message).toMatch(/already exists/); // it ran its first statement again and hit the leftover
    expect((await runner.plan({ target: one })).tenants[0]!.pending).toEqual(['HalfDone1700000000111']);
    expect(await indexState('tenant_alpha', 'orders_id_uq')).toEqual({ valid: false }); // untouched by us
  });

  it('after manual cleanup and a data fix, the same command completes and records the migration once', async () => {
    const runner = makeRunner({ db, migrations: [HalfDone] });
    await runner.run({ target: one });

    await db.client.query('DROP INDEX tenant_alpha.orders_id_uq; DROP TABLE tenant_alpha.step_one; DELETE FROM tenant_alpha.orders');
    const fixed = await runner.run({ target: one });

    expect(fixed.tenants[0]).toMatchObject({ status: 'success', executed: ['HalfDone1700000000111'] });
    expect(await indexState('tenant_alpha', 'orders_id_uq')).toEqual({ valid: true });
    expect(await rows('SELECT count(*)::int AS n FROM tenant_alpha.migrations')).toEqual([{ n: 1 }]);
  });

  it('does not affect other tenants in a continue-on-error batch', async () => {
    const report = await makeRunner({ db, migrations: [HalfDone], tenants: [ALPHA, BETA], options: { continueOnError: true } }).run({ target: ALL });
    expect(report.tenants.map((t) => t.status)).toEqual(['failed', 'success']);
    expect(await indexState('tenant_beta', 'orders_id_uq')).toEqual({ valid: true });
    expect(await indexState('tenant_alpha', 'orders_id_uq')).toEqual({ valid: false });
  });
});

describe("transaction: 'none' with a transactional-looking migration", () => {
  it("is not rolled back on failure (the mode's whole point, and its hazard)", async () => {
    const TwoSteps = defineMigration('TwoSteps1700000000112', async (q: QueryRunner) => {
      await q.query('CREATE TABLE "kept_after_failure" (id int)');
      await q.query('SELECT 1/0');
    });
    const none = await makeRunner({ db, migrations: [TwoSteps], options: { transaction: 'none' } }).run({ target: one });
    expect(none.tenants[0]).toMatchObject({ status: 'failed', executed: [] });
    expect(await tablesOf(db.client, 'tenant_alpha')).toContain('kept_after_failure');

    await seedTenants(db);
    const each = await makeRunner({ db, migrations: [TwoSteps] }).run({ target: one });
    expect(each.tenants[0]).toMatchObject({ status: 'failed', executed: [] });
    expect(await tablesOf(db.client, 'tenant_alpha')).not.toContain('kept_after_failure');
  });
});
