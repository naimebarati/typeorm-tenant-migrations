import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeLockKey } from '../../src/postgres/advisory-lock.js';
import { defineMigration } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, createTestDatabase, waitForNoSessions } from '../helpers/pg.js';
import { ALL, ALPHA, BETA, GAMMA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await seedTenants(db, ['tenant_alpha', 'tenant_beta', 'tenant_gamma']);
  await db.client.query('DROP TABLE IF EXISTS public.progress');
  await db.client.query('CREATE TABLE public.progress (tenant text, started timestamptz, finished timestamptz)');
});

/** Enters its body, records that it did, and stays inside for a while. */
const SlowAudit = defineMigration('SlowAudit1700000000040', async (q: QueryRunner) => {
  await q.query(`INSERT INTO "audit"(note) VALUES ('entered')`);
  await q.query('SELECT pg_sleep(1)');
});

/** Shared-table write is explicitly schema-qualified, as the README says it must be. */
const Timed = defineMigration('Timed1700000000041', async (q: QueryRunner) => {
  await q.query(`INSERT INTO public.progress(tenant, started) VALUES (current_schema(), clock_timestamp())`);
  await q.query('SELECT pg_sleep(0.8)');
  await q.query(`UPDATE public.progress SET finished = clock_timestamp() WHERE tenant = current_schema()`);
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

describe('two runners racing for the same tenant', () => {
  const only = { tenants: ['alpha'] } as const;

  it('serialize: exactly one enters the migration, the other waits and then finds nothing to do', async () => {
    const a = makeRunner({ db, migrations: [SlowAudit], options: { lockTimeoutMs: 15_000 } });
    const b = makeRunner({ db, migrations: [SlowAudit], options: { lockTimeoutMs: 15_000 } });
    const [ra, rb] = await Promise.all([a.run({ target: only }), b.run({ target: only })]);

    const statuses = [ra.tenants[0]!.status, rb.tenants[0]!.status].sort();
    expect(statuses).toEqual(['skipped', 'success']);
    expect(await auditCount('tenant_alpha')).toBe(1); // the migration body ran once
    expect((await db.client.query('SELECT count(*) FROM tenant_alpha.migrations')).rows[0].count).toBe('1');
  });

  it('while one runs, the lock held is the one derived for that schema', async () => {
    const runner = makeRunner({ db, migrations: [SlowAudit] });
    const running = runner.run({ target: only });
    await waitFor(async () => (await advisoryLocksHeld(db)).length > 0);
    expect(await advisoryLocksHeld(db)).toEqual([computeLockKey(db.name, 'tenant_alpha').toString()]);
    await running;
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });

  it('with a short lock timeout the second runner reports locked and changes nothing', async () => {
    const first = makeRunner({ db, migrations: [SlowAudit] });
    const second = makeRunner({ db, migrations: [SlowAudit], options: { lockTimeoutMs: 200 } });

    const running = first.run({ target: only });
    await waitFor(async () => (await advisoryLocksHeld(db)).length > 0);
    const blocked = await second.run({ target: only });
    const finished = await running;

    expect(blocked.tenants[0]).toMatchObject({ status: 'locked', executed: [], error: { code: 'CONCURRENT_MIGRATION' } });
    expect(blocked.summary).toMatchObject({ locked: 1, success: 0 });
    expect(finished.tenants[0]!.status).toBe('success');
    expect(await auditCount('tenant_alpha')).toBe(1);
    expect(await waitForNoSessions(db)).toBe(0);
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });

  it('a locked tenant counts as a failure for fail-fast scheduling', async () => {
    const holder = makeRunner({ db, migrations: [SlowAudit] });
    const blocked = makeRunner({ db, migrations: [SlowAudit], tenants: [ALPHA, BETA], options: { lockTimeoutMs: 100 } });
    const running = holder.run({ target: only });
    await waitFor(async () => (await advisoryLocksHeld(db)).length > 0);
    const report = await blocked.run({ target: ALL });
    await running;
    expect(report.tenants.map((t) => t.status)).toEqual(['locked', 'not-started']);
  });
});

describe('concurrency across independent schemas', () => {
  const spans = async () =>
    (await db.client.query('SELECT tenant, extract(epoch FROM started) s, extract(epoch FROM finished) f FROM public.progress ORDER BY started')).rows.map(
      (r) => ({ tenant: r.tenant as string, s: Number(r.s), f: Number(r.f) }),
    );
  const maxOverlap = (rows: Array<{ s: number; f: number }>) =>
    Math.max(...rows.map((a) => rows.filter((b) => b.s < a.f && a.s < b.f).length));

  it('concurrency 1 (default) never overlaps tenants', async () => {
    await makeRunner({ db, migrations: [Timed], tenants: [ALPHA, BETA, GAMMA] }).run({ target: ALL });
    const rows = await spans();
    expect(rows).toHaveLength(3);
    expect(maxOverlap(rows)).toBe(1);
  });

  it('concurrency 2 runs two tenants at a time and no more', async () => {
    const report = await makeRunner({ db, migrations: [Timed], tenants: [ALPHA, BETA, GAMMA], options: { concurrency: 2 } }).run({ target: ALL });
    expect(report.summary.success).toBe(3);
    expect(maxOverlap(await spans())).toBe(2);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('each tenant still gets its own history and lock under concurrency', async () => {
    await makeRunner({ db, migrations: [Timed], tenants: [ALPHA, BETA], options: { concurrency: 2 } }).run({ target: ALL });
    for (const schema of ['tenant_alpha', 'tenant_beta']) {
      expect((await db.client.query(`SELECT count(*) FROM "${schema}".migrations`)).rows[0].count).toBe('1');
    }
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });
});
