/**
 * Behavior behind a real PgBouncer. These tests characterize what a pooler does to the two things
 * this package depends on (connection startup parameters, session-level advisory locks) and
 * assert the safety invariant: the runner either works correctly or refuses, and in no case
 * touches the wrong schema or runs two holders of one tenant lock.
 *
 * Skipped when no pgbouncer binary is available (set TTM_PGBOUNCER_BIN, or install the package).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireAdvisoryLock } from '../../src/postgres/advisory-lock.js';
import { goodMigrations } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { PgBouncer, PgBouncerOptions } from '../helpers/pgbouncer.js';
import { findPgBouncer, pgBouncerVersion, startPgBouncer } from '../helpers/pgbouncer.js';
import type { TestDatabase } from '../helpers/pg.js';
import { columnsOf, createTestDatabase, snapshotDatabase, tablesOf, waitForNoSessions, waitForSessionCount } from '../helpers/pg.js';
import { ALL, ALPHA, BETA, makeRunner } from '../helpers/runner.js';

const bin = findPgBouncer();
const sessions: PgBouncer[] = [];
let db: TestDatabase;

beforeAll(async () => {
  if (!bin) return;
  db = await createTestDatabase();
  console.info(`[pgbouncer.test] ${pgBouncerVersion(bin)}`);
});
// A pooler keeps idle server connections open; stop each one after its test so session counts stay meaningful.
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  if (db) await seedTenants(db);
});

async function pooler(options: PgBouncerOptions): Promise<PgBouncer> {
  const p = await startPgBouncer(
    bin!,
    { host: String(db.options.host), port: Number(db.options.port), user: String(db.options.username), password: String(db.options.password) },
    options,
  );
  sessions.push(p);
  return p;
}

const IGNORE_OPTIONS = ['ignore_startup_parameters = options'];
const TRACK_EVERYTHING = ['track_extra_parameters = IntervalStyle, search_path, default_transaction_read_only'];

describe('PgBouncer availability', () => {
  it('is installed when TTM_REQUIRE_PGBOUNCER is set (CI sets it, so these tests cannot be skipped by accident)', () => {
    if (process.env.TTM_REQUIRE_PGBOUNCER) expect(bin).toBeDefined();
  });
});

describe.skipIf(!bin)('tenant migrations through PgBouncer', () => {
  it('default config: PgBouncer itself rejects the search_path startup option, so nothing runs', async () => {
    const p = await pooler({ poolMode: 'session' });
    const before = await snapshotDatabase(db.client);
    const report = await makeRunner({ db, migrations: goodMigrations, base: { port: p.port } }).run({ target: ALL });

    expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'DATASOURCE_INITIALIZATION_FAILED' } });
    expect(report.tenants[0]!.error!.message).toMatch(/unsupported startup parameter/);
    expect(await snapshotDatabase(db.client)).toEqual(before);
  });

  it.each(['session', 'transaction'] as const)(
    '%s pooling with ignore_startup_parameters=options: the dropped search_path is detected (fail-closed), plan/status too',
    async (poolMode) => {
      const p = await pooler({ poolMode, extra: IGNORE_OPTIONS });
      const before = await snapshotDatabase(db.client);
      const runner = makeRunner({ db, migrations: goodMigrations, base: { port: p.port } });

      const report = await runner.run({ target: ALL });
      expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'SCHEMA_CONTEXT_MISMATCH' } });
      expect(report.tenants[1]!.status).toBe('not-started');

      const plan = await runner.plan({ target: ALL });
      expect(plan.tenants.every((t) => t.status === 'failed' && t.error?.code === 'SCHEMA_CONTEXT_MISMATCH')).toBe(true);
      expect(await snapshotDatabase(db.client)).toEqual(before);
    },
  );

  it.each(['session', 'transaction'] as const)(
    '%s pooling with search_path and read-only tracked: either it works correctly or it refuses; never the wrong schema',
    async (poolMode) => {
      const p = await pooler({ poolMode, poolSize: 2, extra: TRACK_EVERYTHING });
      const report = await makeRunner({ db, migrations: goodMigrations, base: { port: p.port } }).run({ target: { tenants: ['alpha'] } });
      const alpha = report.tenants[0]!;

      if (alpha.status === 'success') {
        // A PgBouncer version that really forwards the parameters: isolation must hold exactly as when connected directly.
        expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toContain('status');
        expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id']);
        expect(await columnsOf(db.client, 'tenant_beta', 'orders')).toEqual(['id']);
      } else {
        // PgBouncer 1.22 accepts the parameter but does not apply it: the runner refuses.
        expect(['SCHEMA_CONTEXT_MISMATCH', 'UNSUPPORTED_CONNECTION_MODE', 'DATASOURCE_INITIALIZATION_FAILED']).toContain(alpha.error?.code);
        expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id']);
        expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id']);
        expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'orders']);
      }
    },
  );
});

describe.skipIf(!bin)('advisory lock through PgBouncer', () => {
  const target = () => ({ ...db.options });

  it('session pooling keeps the lock exclusive', async () => {
    const p = await pooler({ poolMode: 'session', extra: IGNORE_OPTIONS });
    const base = { ...target(), port: p.port };
    const first = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 1000 });
    try {
      await expect(acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 300 })).rejects.toMatchObject({ code: 'CONCURRENT_MIGRATION' });
    } finally {
      await first.release();
    }
  });

  it('transaction pooling cannot give an exclusive lock, and the package refuses instead of pretending', async () => {
    // One server connection shared by every client: the worst case, where a second "holder" re-enters the first one's lock.
    const p = await pooler({ poolMode: 'transaction', poolSize: 1, extra: IGNORE_OPTIONS });
    const base = { ...target(), port: p.port };
    const err = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 500 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_CONNECTION_MODE', name: 'TenantMigrationError' });

    // The refusal must not leave the lock behind on the pooler's long-lived server connection.
    const { advisoryLocksHeld } = await import('../helpers/pg.js');
    expect(await advisoryLocksHeld(db)).toEqual([]);
    await p.stop();
    sessions.splice(sessions.indexOf(p), 1);
    expect(await waitForNoSessions(db, 3000)).toBe(0);
  });

  it('control (no pooler): the lock is exclusive and the check does not leave sessions behind', async () => {
    // Sessions of the poolers started by earlier tests close a moment after those poolers are killed.
    expect(await waitForNoSessions(db, 5000)).toBe(0);
    const first = await acquireAdvisoryLock(target(), { schema: 'tenant_alpha', timeoutMs: 1000 });
    expect(await waitForSessionCount(db, 1)).toBe(1);
    await first.release();
    expect(await waitForNoSessions(db)).toBe(0);
  });
});

describe('the read-only guarantee is verified, not assumed (TCP proxy that drops only that startup parameter)', () => {
  it('plan/status/preflight refuse when default_transaction_read_only did not take effect', async () => {
    const { startPgProxy } = await import('../helpers/proxy.js');
    const local = await createTestDatabase();
    try {
      await seedTenants(local);
      const proxy = await startPgProxy({ host: String(local.options.host), port: Number(local.options.port) }, { stripReadOnly: true });
      try {
        const runner = makeRunner({ db: local, migrations: goodMigrations, tenants: [ALPHA, BETA], base: { port: proxy.port } });
        const plan = await runner.plan({ target: ALL });
        expect(plan.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'SCHEMA_CONTEXT_MISMATCH' } });
        expect(plan.tenants[0]!.error!.message).toMatch(/not read-only/);

        const before = await snapshotDatabase(local.client);
        const report = await runner.run({ target: ALL });
        expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'SCHEMA_CONTEXT_MISMATCH' } });
        expect(await snapshotDatabase(local.client)).toEqual(before);
      } finally {
        await proxy.close();
      }
    } finally {
      await local.drop();
    }
  });
});
