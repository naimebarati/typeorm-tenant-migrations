import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, createTestDatabase, tablesOf, waitForNoSessions } from '../helpers/pg.js';
import { MIGRATION_BODIES as M, runBin, startBin, writeProject } from '../helpers/cli-project.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db, ['tenant_alpha', 'tenant_beta', 'tenant_gamma']));

const SCHEMAS = ['tenant_alpha', 'tenant_beta', 'tenant_gamma'];
const TENANTS = [
  { id: 'alpha', schema: 'tenant_alpha' },
  { id: 'beta', schema: 'tenant_beta' },
  { id: 'gamma', schema: 'tenant_gamma' },
];
const auditCount = async (schema: string) => Number((await db.client.query(`SELECT count(*) FROM "${schema}".audit`)).rows[0].count);
const historyCount = async (schema: string) => Number((await db.client.query(`SELECT count(*) FROM "${schema}".migrations`)).rows[0].count);

/** True once the slow migration statement is executing inside the database. */
async function migrationIsRunning(): Promise<boolean> {
  const { rows } = await db.client.query(
    `SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND state = 'active' AND query LIKE '%pg_sleep(1.2)%' AND pid <> pg_backend_pid()`,
    [db.name],
  );
  return rows.length > 0;
}
async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not reached in time');
}
const quiet = async () => {
  expect(await waitForNoSessions(db, 8000)).toBe(0);
  expect(await advisoryLocksHeld(db)).toEqual([]);
};

const posix = process.platform !== 'win32'; // on Windows child.kill() terminates unconditionally and reports no signal

describe('SIGKILL (cannot be handled) in the middle of a migration', () => {
  it('leaves nothing half-done: transaction rolled back, lock and sessions released, next run completes', async () => {
    const p = writeProject({ db, migrations: [M.slowAudit] });
    const running = startBin(['run', '--tenant', 'alpha', '--json', '--config', p.config]);

    await waitUntil(migrationIsRunning);
    expect(await advisoryLocksHeld(db)).toHaveLength(1);
    running.child.kill('SIGKILL');
    const ended = await running.done;
    if (posix) expect(ended.signal).toBe('SIGKILL');
    else expect(ended.code).not.toBe(0);

    // The server finishes the statement it is in, notices the client is gone, rolls the transaction back and ends the session.
    await quiet();
    expect(await auditCount('tenant_alpha')).toBe(0);
    expect(await tablesOf(db.client, 'tenant_alpha')).toContain('migrations');
    expect(await historyCount('tenant_alpha')).toBe(0);

    const again = await runBin(['run', '--tenant', 'alpha', '--json', '--config', p.config]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).tenants[0]).toMatchObject({ status: 'success', executed: ['SlowAudit1700000000003'] });
    expect(await auditCount('tenant_alpha')).toBe(1);
    expect(await historyCount('tenant_alpha')).toBe(1);
  });
});

describe.skipIf(!posix).each(['SIGINT', 'SIGTERM'] as const)('%s during a multi-tenant run: graceful stop', (signal) => {
  it('finishes the tenant that is running, starts no new one, prints the report, exits 130', async () => {
    const p = writeProject({ db, migrations: [M.slowAudit], tenants: TENANTS });
    const running = startBin(['run', '--all', '--json', '--config', p.config]);

    await waitUntil(migrationIsRunning); // alpha is mid-migration
    running.child.kill(signal);
    const ended = await running.done;

    expect(ended.signal).toBeNull(); // it ended by itself, not by the signal
    expect(ended.code).toBe(130);
    expect(ended.stderr).toContain(`Received ${signal}`);
    const report = JSON.parse(ended.stdout);
    expect(report.interrupted).toBe(true);
    expect(report.tenants.map((t: { status: string }) => t.status)).toEqual(['success', 'not-started', 'not-started']);
    expect(report.summary).toMatchObject({ success: 1, notStarted: 2, failed: 0 });

    // alpha was NOT cut off mid-statement: it committed completely. The others were never touched.
    expect(await auditCount('tenant_alpha')).toBe(1);
    expect(await historyCount('tenant_alpha')).toBe(1);
    for (const schema of SCHEMAS.slice(1)) {
      expect(await tablesOf(db.client, schema)).toEqual(['audit', 'orders']);
    }
    await quiet();

    // Resuming is just running again.
    const again = await runBin(['run', '--all', '--json', '--config', p.config]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).tenants.map((t: { status: string }) => t.status)).toEqual(['skipped', 'success', 'success']);
  });
});

describe.skipIf(!posix)('a second signal aborts immediately', () => {
  it('the process dies at once; PostgreSQL rolls back the open transaction; nothing is left behind', async () => {
    const p = writeProject({ db, migrations: [M.slowAudit], tenants: TENANTS });
    const running = startBin(['run', '--all', '--json', '--config', p.config]);

    await waitUntil(migrationIsRunning);
    running.child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 150));
    const secondAt = Date.now();
    running.child.kill('SIGINT');
    const ended = await running.done;

    expect(ended.signal).toBe('SIGINT');
    expect(Date.now() - secondAt).toBeLessThan(1000);
    await quiet();
    expect(await auditCount('tenant_alpha')).toBe(0);
    expect(await historyCount('tenant_alpha')).toBe(0);
    for (const schema of SCHEMAS.slice(1)) expect(await tablesOf(db.client, schema)).toEqual(['audit', 'orders']);
  });
});
