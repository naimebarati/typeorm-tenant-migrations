/**
 * `revert`: exactly one migration of exactly one tenant, only if the caller names it and it is the last executed one.
 * The guards fail closed, so most tests here compare whole-database snapshots before and after: a refusal must change nothing.
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireAdvisoryLock } from '../../src/postgres/advisory-lock.js';
import { isCleanReport } from '../../src/runner/report.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, columnsOf, createTestDatabase, snapshotDatabase, tablesOf, waitForNoSessions } from '../helpers/pg.js';
import { startPgProxy } from '../helpers/proxy.js';
import { ALL, ALPHA, BETA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db));

/** A migration with a real `down`, so that a revert can be seen in the schema and not only in the history table. */
function reversible(
  name: string,
  up: (q: QueryRunner) => Promise<void>,
  down: (q: QueryRunner) => Promise<void>,
  options: { transaction?: boolean } = {},
): new () => MigrationInterface {
  return class implements MigrationInterface {
    name = name;
    transaction = options.transaction;
    up = up;
    down = down;
  };
}

const AddA = reversible(
  'AddA1700000000201',
  async (q) => void (await q.query('ALTER TABLE "orders" ADD COLUMN "a" text')),
  async (q) => void (await q.query('ALTER TABLE "orders" DROP COLUMN "a"')),
);
const CreateT = reversible(
  'CreateT1700000000202',
  async (q) => void (await q.query('CREATE TABLE "t" (id int)')),
  async (q) => void (await q.query('DROP TABLE "t"')),
);
const AddB = reversible(
  'AddB1700000000203',
  async (q) => void (await q.query('ALTER TABLE "orders" ADD COLUMN "b" text')),
  async (q) => void (await q.query('ALTER TABLE "orders" DROP COLUMN "b"')),
);
const migrations = [AddA, CreateT, AddB];
const [A, T, B] = migrations.map((M) => new M().name) as [string, string, string];

const historyOf = async (schema: string) => (await db.client.query(`SELECT name FROM "${schema}".migrations ORDER BY id`)).rows.map((r) => r.name as string);
const migrateAll = () => makeRunner({ db, migrations }).run({ target: ALL });

describe('revert: the one migration that was named', () => {
  it('undoes the last executed migration of one tenant and leaves every other tenant, and public, alone', async () => {
    await migrateAll();
    const betaBefore = { cols: await columnsOf(db.client, 'tenant_beta', 'orders'), history: await historyOf('tenant_beta') };

    const report = await makeRunner({ db, migrations }).revert({ tenant: 'alpha', migration: B });

    expect(report.summary).toEqual({ total: 1, success: 1, failed: 0, locked: 0, skipped: 0, notStarted: 0 });
    expect(report.interrupted).toBeUndefined();
    expect(isCleanReport(report)).toBe(true);
    expect(report.tenants[0]).toMatchObject({ tenantId: 'alpha', schema: 'tenant_alpha', status: 'success', reverted: [B], executed: [], executedKnown: true });
    expect(report.tenants[0]!.error).toBeUndefined();

    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'a']);
    expect(await historyOf('tenant_alpha')).toEqual([A, T]);
    expect(await tablesOf(db.client, 'tenant_alpha')).toContain('t');

    expect({ cols: await columnsOf(db.client, 'tenant_beta', 'orders'), history: await historyOf('tenant_beta') }).toEqual(betaBefore);
    expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id']);
    expect(await tablesOf(db.client, 'public')).toEqual(['orders']);
  });

  it('reverts one migration per call: a second call needs the next name, and `run` re-applies what was reverted', async () => {
    await migrateAll();
    const runner = makeRunner({ db, migrations });
    await runner.revert({ tenant: 'alpha', migration: B });
    const second = await runner.revert({ tenant: 'alpha', migration: T });
    expect(second.tenants[0]).toMatchObject({ status: 'success', reverted: [T] });
    expect(await tablesOf(db.client, 'tenant_alpha')).not.toContain('t');
    expect(await historyOf('tenant_alpha')).toEqual([A]);

    const rerun = await runner.run({ target: { tenants: ['alpha'] } });
    expect(rerun.tenants[0]).toMatchObject({ status: 'success', pendingBeforeRun: [T, B], executed: [T, B] });
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'a', 'b']);
  });

  it('releases the tenant lock and every connection', async () => {
    await migrateAll();
    await makeRunner({ db, migrations }).revert({ tenant: 'alpha', migration: B });
    expect(await advisoryLocksHeld(db)).toEqual([]);
    expect(await waitForNoSessions(db)).toBe(0);
  });
});

describe('revert: guards (each one refuses, and the database is exactly as it was)', () => {
  const refused = async (params: { tenant: string; migration: string }, runner = makeRunner({ db, migrations })) => {
    const before = await snapshotDatabase(db.client);
    const historyBefore = (await tablesOf(db.client, 'tenant_alpha')).includes('migrations') ? await historyOf('tenant_alpha') : undefined;
    const report = await runner.revert(params);
    expect(await snapshotDatabase(db.client)).toEqual(before);
    if (historyBefore) expect(await historyOf('tenant_alpha')).toEqual(historyBefore);
    expect(report.summary).toMatchObject({ success: 0, failed: 1 });
    expect(isCleanReport(report)).toBe(false);
    expect(report.tenants[0]).toMatchObject({ status: 'failed', reverted: [], error: { code: 'REVERT_REFUSED' } });
    expect(await advisoryLocksHeld(db)).toEqual([]);
    return report.tenants[0]!.error!.message;
  };

  it('refuses an earlier migration than the last executed one, and says which one is the last', async () => {
    await migrateAll();
    const message = await refused({ tenant: 'alpha', migration: T });
    expect(message).toContain(`"${B}"`);
    expect(message).toContain('Only the last executed migration');
  });

  it('refuses a name that matches nothing', async () => {
    await migrateAll();
    await refused({ tenant: 'alpha', migration: 'Nope1700000000999' });
  });

  it('refuses a tenant that never ran a migration, and does not create a history table for it (TypeORM would)', async () => {
    const message = await refused({ tenant: 'alpha', migration: B });
    expect(message).toContain('no executed migration');
    expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'orders']);
  });

  it('refuses a tenant whose history table is empty', async () => {
    await migrateAll();
    await db.client.query('DELETE FROM tenant_alpha.migrations');
    await refused({ tenant: 'alpha', migration: B });
  });

  it('refuses when the last executed migration is not known to this build (its down() is not available)', async () => {
    await migrateAll();
    await db.client.query(`INSERT INTO tenant_alpha.migrations ("timestamp", "name") VALUES (1700000000999, 'FromANewerRelease1700000000999')`);
    const message = await refused({ tenant: 'alpha', migration: 'FromANewerRelease1700000000999' });
    expect(message).toContain('not known to this build');
  });

  it('refuses when the schema does not exist (SCHEMA_NOT_FOUND from the same context check as `run`)', async () => {
    const report = await makeRunner({ db, migrations, tenants: [ALPHA, { id: 'ghost', schema: 'tenant_ghost' }] }).revert({ tenant: 'ghost', migration: B });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'SCHEMA_NOT_FOUND' } });
  });
});

describe('revert: input errors throw before anything is opened', () => {
  it('needs exactly one existing tenant and a migration name', async () => {
    const runner = makeRunner({ db, migrations });
    const before = await snapshotDatabase(db.client);
    const call = (params: unknown) => runner.revert(params as { tenant: string; migration: string });
    await expect(call({ tenant: 'nobody', migration: B })).rejects.toMatchObject({ code: 'INVALID_TENANT_TARGET' });
    await expect(call({ tenant: '', migration: B })).rejects.toMatchObject({ code: 'INVALID_TENANT_TARGET' });
    await expect(call({ migration: B })).rejects.toMatchObject({ code: 'INVALID_TENANT_TARGET' });
    await expect(call({ tenant: ['alpha', 'beta'], migration: B })).rejects.toMatchObject({ code: 'INVALID_TENANT_TARGET' });
    await expect(call({ target: { all: true }, migration: B })).rejects.toMatchObject({ code: 'INVALID_TENANT_TARGET' });
    await expect(call({ tenant: 'alpha' })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await expect(call({ tenant: 'alpha', migration: '' })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await expect(call({ tenant: 'alpha', migration: 'x'.repeat(256) })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await expect(call(undefined)).rejects.toMatchObject({ code: 'INVALID_TENANT_TARGET' });
    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect(await waitForNoSessions(db)).toBe(0);
  });
});

describe('revert: when down() fails or the tenant is busy', () => {
  it('a failing down() inside the transaction rolls back completely: nothing reverted, history intact, the error says MIGRATION_FAILED', async () => {
    const Broken = reversible(
      'Broken1700000000204',
      async (q) => void (await q.query('ALTER TABLE "orders" ADD COLUMN "c" text')),
      async (q) => {
        await q.query('ALTER TABLE "orders" DROP COLUMN "c"');
        throw new Error('down exploded');
      },
    );
    const withBroken = [...migrations, Broken];
    await makeRunner({ db, migrations: withBroken }).run({ target: { tenants: ['alpha'] } });
    const before = await snapshotDatabase(db.client);

    const report = await makeRunner({ db, migrations: withBroken }).revert({ tenant: 'alpha', migration: 'Broken1700000000204' });

    expect(report.tenants[0]).toMatchObject({ status: 'failed', reverted: [], executedKnown: true, error: { code: 'MIGRATION_FAILED' } });
    expect(report.tenants[0]!.error!.message).toContain('down exploded');
    expect(await snapshotDatabase(db.client)).toEqual(before); // the DROP COLUMN inside the failed down() was rolled back
    expect(await historyOf('tenant_alpha')).toEqual([A, T, B, 'Broken1700000000204']);
    expect(await advisoryLocksHeld(db)).toEqual([]);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('is reported as locked, and changes nothing, while another session holds the tenant lock', async () => {
    await migrateAll();
    const before = await snapshotDatabase(db.client);
    const holder = await acquireAdvisoryLock({ ...db.options }, { schema: 'tenant_alpha', timeoutMs: 0 });
    try {
      const report = await makeRunner({ db, migrations, options: { lockTimeoutMs: 200 } }).revert({ tenant: 'alpha', migration: B });
      expect(report.tenants[0]).toMatchObject({ status: 'locked', reverted: [], error: { code: 'CONCURRENT_MIGRATION' } });
      expect(report.summary).toMatchObject({ locked: 1, success: 0 });
    } finally {
      await holder.release();
    }
    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect(await historyOf('tenant_alpha')).toEqual([A, T, B]);
  });

  it('a signal that aborts while the revert waits for the lock: gives up at once, notStarted, the holder untouched', async () => {
    await migrateAll();
    const before = await snapshotDatabase(db.client);
    const holder = await acquireAdvisoryLock({ ...db.options }, { schema: 'tenant_alpha', timeoutMs: 0 });
    try {
      const controller = new AbortController();
      const started = Date.now();
      const running = makeRunner({ db, migrations, options: { lockTimeoutMs: 30_000 } }).revert({ tenant: 'alpha', migration: B, signal: controller.signal });
      await new Promise((r) => setTimeout(r, 400));
      controller.abort();
      const report = await running;

      expect(Date.now() - started).toBeLessThan(3000); // not the 30 s lock timeout
      expect(report.interrupted).toBe(true);
      expect(report.tenants[0]).toMatchObject({ status: 'notStarted', reverted: [] });
      expect(report.tenants[0]!.error).toBeUndefined();
      expect(report.tenants[0]!.startedAt).toBeUndefined();
    } finally {
      await holder.release();
    }
    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('losing the database in the middle of down(): failed, and `executedKnown: false` instead of a guess about what was reverted', async () => {
    const SlowDown = reversible(
      'SlowDown1700000000207',
      async (q) => void (await q.query('ALTER TABLE "orders" ADD COLUMN "slow" text')),
      async (q) => {
        await q.query('ALTER TABLE "orders" DROP COLUMN "slow"');
        await q.query('SELECT pg_sleep(1.5)');
      },
    );
    await makeRunner({ db, migrations: [SlowDown] }).run({ target: { tenants: ['alpha'] } });
    const proxy = await startPgProxy({ host: String(db.options.host), port: Number(db.options.port) }, { stripOptions: false });
    try {
      setTimeout(() => proxy.cut(), 500);
      const report = await makeRunner({ db, migrations: [SlowDown], base: { port: proxy.port } }).revert({ tenant: 'alpha', migration: 'SlowDown1700000000207' });
      expect(report.tenants[0]).toMatchObject({ status: 'failed', reverted: [], executedKnown: false, error: { code: 'MIGRATION_FAILED' } });
    } finally {
      await proxy.close();
    }
    await new Promise((r) => setTimeout(r, 1500)); // the server rolls the transaction back once it notices the client is gone
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'slow']);
    expect(await historyOf('tenant_alpha')).toEqual(['SlowDown1700000000207']);
  });

  it('a down() that drops the history table itself: failed, and nothing is claimed about what was reverted', async () => {
    const DropsHistory = reversible(
      'DropsHistory1700000000208',
      async (q) => void (await q.query('SELECT 1')),
      async (q) => void (await q.query('DROP TABLE "migrations"')),
      { transaction: false },
    );
    await makeRunner({ db, migrations: [DropsHistory] }).run({ target: { tenants: ['alpha'] } });
    const report = await makeRunner({ db, migrations: [DropsHistory] }).revert({ tenant: 'alpha', migration: 'DropsHistory1700000000208' });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', reverted: [], executedKnown: false, error: { code: 'MIGRATION_FAILED' } });
    expect(await tablesOf(db.client, 'tenant_alpha')).not.toContain('migrations');
  });

  it('a signal that is already aborted starts nothing', async () => {
    await migrateAll();
    const before = await snapshotDatabase(db.client);
    const controller = new AbortController();
    controller.abort();
    const report = await makeRunner({ db, migrations }).revert({ tenant: 'alpha', migration: B, signal: controller.signal });
    expect(report.interrupted).toBe(true);
    expect(report.tenants[0]).toMatchObject({ status: 'notStarted', reverted: [] });
    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect(await historyOf('tenant_alpha')).toEqual([A, T, B]);
  });
});

describe('revert: transaction modes', () => {
  const idx = (transaction: boolean | undefined) =>
    reversible(
      'IndexConcurrently1700000000205',
      async (q) => void (await q.query('CREATE INDEX CONCURRENTLY "orders_id_idx" ON "orders" ("id")')),
      async (q) => void (await q.query('DROP INDEX CONCURRENTLY "orders_id_idx"')),
      { transaction },
    );
  const indexExists = async () =>
    (await db.client.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'tenant_alpha' AND indexname = 'orders_id_idx'`)).rowCount === 1;

  it('a migration that opted out of the transaction (`transaction = false`) is reverted without one, as it was run', async () => {
    const M = idx(false);
    await makeRunner({ db, migrations: [M] }).run({ target: { tenants: ['alpha'] } });
    expect(await indexExists()).toBe(true);

    const report = await makeRunner({ db, migrations: [M] }).revert({ tenant: 'alpha', migration: 'IndexConcurrently1700000000205' });
    expect(report.tenants[0]).toMatchObject({ status: 'success', reverted: ['IndexConcurrently1700000000205'] });
    expect(await indexExists()).toBe(false);
  });

  it('without that opt-out PostgreSQL refuses DROP INDEX CONCURRENTLY inside the transaction; the failure is clean and the history stays', async () => {
    // `up` has to run outside a transaction to create the index at all, so build it with the opt-out and revert the same class without it.
    const Up = idx(false);
    await makeRunner({ db, migrations: [Up] }).run({ target: { tenants: ['alpha'] } });
    const Down = idx(undefined);

    const report = await makeRunner({ db, migrations: [Down] }).revert({ tenant: 'alpha', migration: 'IndexConcurrently1700000000205' });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', reverted: [], error: { code: 'MIGRATION_FAILED' } });
    expect(report.tenants[0]!.error!.message).toMatch(/transaction block/);
    expect(await indexExists()).toBe(true);
    expect(await historyOf('tenant_alpha')).toEqual(['IndexConcurrently1700000000205']);
  });

  const failingDown = (transaction: boolean | undefined) =>
    reversible(
      'FailingDown1700000000206',
      async (q) => void (await q.query('ALTER TABLE "orders" ADD COLUMN "c" text')),
      async (q) => {
        await q.query('ALTER TABLE "orders" DROP COLUMN "c"');
        throw new Error('down exploded');
      },
      { transaction },
    );

  it('options.transaction "none" leaves a failed down() half done, and says nothing was reverted (history row still there)', async () => {
    const M = failingDown(undefined);
    await makeRunner({ db, migrations: [M] }).run({ target: { tenants: ['alpha'] } });
    const report = await makeRunner({ db, migrations: [M], options: { transaction: 'none' } }).revert({ tenant: 'alpha', migration: 'FailingDown1700000000206' });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', reverted: [], error: { code: 'MIGRATION_FAILED' } });
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id']); // the DROP COLUMN stayed: physical state and history now disagree
    expect(await historyOf('tenant_alpha')).toEqual(['FailingDown1700000000206']);
  });

  it('a migration that sets `transaction = true` keeps a transaction even when options.transaction is "none"', async () => {
    const M = failingDown(true);
    await makeRunner({ db, migrations: [M] }).run({ target: { tenants: ['alpha'] } });
    const report = await makeRunner({ db, migrations: [M], options: { transaction: 'none' } }).revert({ tenant: 'alpha', migration: 'FailingDown1700000000206' });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', reverted: [], error: { code: 'MIGRATION_FAILED' } });
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'c']); // rolled back
    expect(await historyOf('tenant_alpha')).toEqual(['FailingDown1700000000206']);
  });

  it('transaction "none" from the options works for an ordinary migration', async () => {
    await migrateAll();
    const report = await makeRunner({ db, migrations, options: { transaction: 'none' } }).revert({ tenant: 'alpha', migration: B });
    expect(report.tenants[0]).toMatchObject({ status: 'success', reverted: [B] });
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'a']);
  });
});

describe('revert: schema isolation', () => {
  it('an unqualified down() hits the tenant schema and never public or another tenant', async () => {
    await migrateAll();
    await db.client.query('ALTER TABLE public.orders ADD COLUMN b text'); // the decoy a wrong search_path would drop
    await makeRunner({ db, migrations, tenants: [ALPHA, BETA] }).revert({ tenant: 'beta', migration: B });
    expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id', 'b']);
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'a', 'b']);
    expect(await columnsOf(db.client, 'tenant_beta', 'orders')).toEqual(['id', 'a']);
  });
});
