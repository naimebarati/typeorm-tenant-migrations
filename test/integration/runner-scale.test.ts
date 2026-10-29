/**
 * A scaled-down version of scripts/load-test.mjs that runs with every build: many tenants, several
 * concurrency levels, and the properties that matter at scale: every tenant ends up migrated exactly once,
 * connection use stays within the documented bound, nothing is left behind.
 */
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantMigrationTarget } from '../../src/config/types.js';
import { connectionsNeeded } from '../../src/postgres/connection-budget.js';
import { defineMigration } from '../fixtures/migrations.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, createTestDatabase, waitForNoSessions } from '../helpers/pg.js';
import { capturingLogger, makeRunner } from '../helpers/runner.js';

const TENANTS = 60;
let db: TestDatabase;
let tenants: TenantMigrationTarget[];

beforeAll(async () => {
  db = await createTestDatabase();
  tenants = Array.from({ length: TENANTS }, (_, i) => ({ id: `t${i}`, schema: `tenant_s${String(i).padStart(3, '0')}` }));
  for (const t of tenants) {
    await db.client.query(`CREATE SCHEMA ${t.schema}`);
    await db.client.query(`CREATE TABLE ${t.schema}.orders (id serial PRIMARY KEY, total numeric)`);
    await db.client.query(`INSERT INTO ${t.schema}.orders (total) SELECT g FROM generate_series(1, 200) g`);
  }
});
afterAll(async () => {
  await db.drop();
});

/** Fresh migrations per phase (distinct names and objects), so each phase has real work on the same tenants. */
let stamp = 1_700_000_200_000;
function phaseMigrations(tag: string) {
  const make = (suffix: string, sql: string) => {
    const name = `Scale${tag}${suffix}${stamp++}`;
    return defineMigration(name, async (q: QueryRunner) => {
      await q.query(sql);
    });
  };
  return [
    make('A', `ALTER TABLE "orders" ADD COLUMN "c_${tag}" text DEFAULT 'x'`),
    make('B', `CREATE INDEX "orders_c_${tag}_idx" ON "orders" ("c_${tag}")`),
  ];
}
const namesOf = (set: Array<new () => { name?: string }>) => set.map((M) => String(new M().name));

/** Highest number of this run's connections open at one instant, sampled from pg_stat_activity. */
async function peakConnections(application: string, work: () => Promise<unknown>): Promise<number> {
  const o = db.options;
  const sampler = new Client({ host: String(o.host), port: Number(o.port), user: String(o.username), password: String(o.password), database: String(o.database) });
  await sampler.connect();
  let peak = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const { rows } = await sampler.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1', [application]);
      peak = Math.max(peak, rows[0].n as number);
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  try {
    await work();
  } finally {
    running = false;
    await loop;
    await sampler.end();
  }
  return peak;
}

async function everyTenantHasExactly(names: string[]) {
  let wrong = 0;
  for (const t of tenants) {
    const { rows } = await db.client.query(`SELECT name FROM ${t.schema}.migrations WHERE name = ANY($1)`, [names]);
    if (rows.length !== names.length) wrong++;
  }
  expect(wrong).toBe(0);
}

describe(`${TENANTS} tenants`, () => {
  it.each([1, 4, 8])('concurrency %i: all migrated once, connections within the bound, nothing left behind', async (concurrency) => {
    const set = phaseMigrations(`C${concurrency}`);
    const app = `ttm-scale-${randomBytes(3).toString('hex')}`;
    let report!: Awaited<ReturnType<ReturnType<typeof makeRunner>['run']>>;
    const peak = await peakConnections(app, async () => {
      report = await makeRunner({ db, migrations: set, tenants, base: { applicationName: app }, options: { concurrency } }).run({ target: { all: true } });
    });

    expect(report.summary).toMatchObject({ total: TENANTS, success: TENANTS, failed: 0, locked: 0, notStarted: 0 });
    expect(peak).toBeGreaterThanOrEqual(concurrency); // it really ran that wide (sampling could miss the very top, so only a floor)
    expect(peak).toBeLessThanOrEqual(connectionsNeeded(concurrency));
    await everyTenantHasExactly(namesOf(set));
    expect(await waitForNoSessions(db)).toBe(0);
    expect(await advisoryLocksHeld(db)).toEqual([]);

    // and a second run finds nothing to do
    const again = await makeRunner({ db, migrations: set, tenants, options: { concurrency } }).run({ target: { all: true } });
    expect(again.summary).toMatchObject({ skipped: TENANTS, success: 0 });
  });

  it('plan and status at this size are read-only and agree with run', async () => {
    const set = phaseMigrations('Plan');
    const runner = makeRunner({ db, migrations: set, tenants, options: { concurrency: 8 } });
    const before = (await db.client.query('SELECT count(*)::int AS n FROM pg_class')).rows[0].n;
    const plan = await runner.plan({ target: { all: true } });
    expect(plan.summary).toMatchObject({ ok: TENANTS, failed: 0, pendingTotal: TENANTS * 2 });
    expect((await db.client.query('SELECT count(*)::int AS n FROM pg_class')).rows[0].n).toBe(before);
    const report = await runner.run({ target: { all: true } });
    expect(report.tenants.every((t, i) => t.executed.join() === plan.tenants[i]!.pending.join())).toBe(true);
  });

  it('a failure in every 10th tenant does not disturb the others, and the failed ones can be re-run after the fix', async () => {
    const set = phaseMigrations('Poison');
    const victims = tenants.filter((_, i) => i % 10 === 0);
    const second = namesOf(set)[1]!;
    for (const v of victims) await db.client.query(`CREATE INDEX "orders_c_Poison_idx" ON ${v.schema}.orders (id)`); // the name migration B wants
    const runner = makeRunner({ db, migrations: set, tenants, options: { concurrency: 8, continueOnError: true } });

    const report = await runner.run({ target: { all: true } });
    expect(report.summary).toMatchObject({ success: TENANTS - victims.length, failed: victims.length });
    expect(report.tenants.filter((t) => t.status === 'failed').map((t) => t.tenantId).sort()).toEqual(victims.map((v) => v.id).sort());
    for (const t of report.tenants.filter((x) => x.status === 'failed')) expect(t.executed).toEqual([namesOf(set)[0]]); // A committed, B did not

    for (const v of victims) await db.client.query(`DROP INDEX ${v.schema}."orders_c_Poison_idx"`);
    const healed = await runner.run({ target: { all: true } });
    expect(healed.summary).toMatchObject({ failed: 0, success: victims.length, skipped: TENANTS - victims.length });
    expect(healed.tenants.find((t) => t.status === 'success')!.executed).toEqual([second]);
    expect(await waitForNoSessions(db)).toBe(0);
  });
});

describe('connection budget warning', () => {
  it('is raised, with numbers, when the concurrency cannot fit; the run itself still works', async () => {
    const logger = capturingLogger();
    const two = tenants.slice(0, 2);
    const report = await makeRunner({
      db,
      migrations: phaseMigrations('Budget'),
      tenants: two,
      options: { concurrency: 64, maxConcurrency: 64, logger },
    }).run({ target: { all: true } });
    expect(report.summary.success).toBe(2);
    const warnings = logger.lines.filter((l) => l.startsWith('WARN') && l.includes('connections'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('concurrency 64 can need up to 193 connections');
  });

  it('is not raised for a sensible concurrency, nor for concurrency 1', async () => {
    const logger = capturingLogger();
    for (const concurrency of [1, 4]) {
      await makeRunner({ db, migrations: phaseMigrations(`Quiet${concurrency}`), tenants: tenants.slice(0, 2), options: { concurrency, logger } }).run({ target: { all: true } });
    }
    expect(logger.lines.filter((l) => l.startsWith('WARN'))).toEqual([]);
  });
});
