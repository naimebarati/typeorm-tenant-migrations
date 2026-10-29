import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireAdvisoryLock } from '../../src/postgres/advisory-lock.js';
import { defineMigration, goodMigrations } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, createTestDatabase, snapshotDatabase, tablesOf, waitForNoSessions } from '../helpers/pg.js';
import { ALL, ALPHA, BETA, GAMMA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db, ['tenant_alpha', 'tenant_beta', 'tenant_gamma']));

const Slow = defineMigration('SlowAbort1700000000100', async (q: QueryRunner) => {
  await q.query(`INSERT INTO "audit"(note) VALUES ('done')`);
  await q.query('SELECT pg_sleep(0.8)');
});
const auditCount = async (schema: string) => Number((await db.client.query(`SELECT count(*) FROM "${schema}".audit`)).rows[0].count);
const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached');
};
const statuses = (r: { tenants: Array<{ status: string }> }) => r.tenants.map((t) => t.status);
const three = [ALPHA, BETA, GAMMA];

describe('run({ signal })', () => {
  it('an already-aborted signal: nothing is started and no connection is opened', async () => {
    const before = await snapshotDatabase(db.client);
    const c = new AbortController();
    c.abort();
    const report = await makeRunner({ db, migrations: goodMigrations, tenants: three }).run({ target: ALL, signal: c.signal });

    expect(statuses(report)).toEqual(['not-started', 'not-started', 'not-started']);
    expect(report.interrupted).toBe(true);
    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('abort while the first tenant is migrating: it completes, the rest are not started', async () => {
    const c = new AbortController();
    const running = makeRunner({ db, migrations: [Slow], tenants: three }).run({ target: ALL, signal: c.signal });
    await waitFor(async () => (await advisoryLocksHeld(db)).length > 0);
    c.abort();
    const report = await running;

    expect(statuses(report)).toEqual(['success', 'not-started', 'not-started']);
    expect(report.interrupted).toBe(true);
    expect(report.summary).toMatchObject({ success: 1, notStarted: 2 });
    expect(await auditCount('tenant_alpha')).toBe(1);
    expect(await tablesOf(db.client, 'tenant_beta')).toEqual(['audit', 'orders']);
    expect(await waitForNoSessions(db)).toBe(0);
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });

  it('with concurrency 2, both in-flight tenants finish and the third never starts', async () => {
    const c = new AbortController();
    const running = makeRunner({ db, migrations: [Slow], tenants: three, options: { concurrency: 2 } }).run({ target: ALL, signal: c.signal });
    await waitFor(async () => (await advisoryLocksHeld(db)).length === 2);
    c.abort();
    const report = await running;

    expect(statuses(report)).toEqual(['success', 'success', 'not-started']);
    expect(await auditCount('tenant_gamma')).toBe(0);
  });

  it('abort while waiting for a lock: gives up at once, the tenant is not-started (not locked, not failed), the holder is untouched', async () => {
    const holder = await acquireAdvisoryLock({ ...db.options }, { schema: 'tenant_alpha', timeoutMs: 0 });
    try {
      const c = new AbortController();
      const started = Date.now();
      const running = makeRunner({ db, migrations: [Slow], tenants: [ALPHA], options: { lockTimeoutMs: 30_000 } }).run({ target: ALL, signal: c.signal });
      await new Promise((r) => setTimeout(r, 400));
      c.abort();
      const report = await running;

      expect(Date.now() - started).toBeLessThan(3000); // not the 30 s lock timeout
      expect(report.tenants[0]).toMatchObject({ status: 'not-started', executed: [] });
      expect(report.tenants[0]!.error).toBeUndefined();
      expect(report.tenants[0]!.startedAt).toBeUndefined();
      expect(report.interrupted).toBe(true);
      expect(await auditCount('tenant_alpha')).toBe(0);
    } finally {
      await holder.release();
    }
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('an interrupted report is never "clean", and an uninterrupted one has no `interrupted` key', async () => {
    const { isCleanReport } = await import('../../src/runner/report.js');
    const c = new AbortController();
    c.abort();
    const runner = makeRunner({ db, migrations: goodMigrations, tenants: [ALPHA] });
    expect(isCleanReport(await runner.run({ target: ALL, signal: c.signal }))).toBe(false);

    const normal = await runner.run({ target: ALL });
    expect('interrupted' in normal).toBe(false);
    expect(isCleanReport(normal)).toBe(true);
  });
});
