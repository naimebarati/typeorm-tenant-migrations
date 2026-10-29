/**
 * TLS. Needs a PostgreSQL with `ssl = on`; skipped otherwise (the Debian/Ubuntu packages ship it enabled
 * with a self-signed certificate, stock docker images do not).
 *
 * The point is not that TypeORM can do TLS but that EVERY connection this package opens on its own
 * (tenant pool, lock connection, exclusivity probe, read-only inspection) inherits the caller's TLS
 * settings, so a deployment that requires TLS never gets a plaintext side channel.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineMigration, goodMigrations } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { createTestDatabase, snapshotDatabase, waitForNoSessions } from '../helpers/pg.js';
import { ALL, ALPHA, BETA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
let serverHasSsl = false;

beforeAll(async () => {
  db = await createTestDatabase();
  serverHasSsl = (await db.client.query('SHOW ssl')).rows[0].ssl === 'on';
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db));

const APP = () => `ttm-ssl-${randomBytes(4).toString('hex')}`;
const Slow = defineMigration('SlowSsl1700000000120', async (q: QueryRunner) => {
  await q.query('SELECT pg_sleep(0.8)');
});

/** Polls pg_stat_ssl for sessions of one application name while `work` runs; returns every ssl flag seen. */
async function sampleSsl(application: string, work: () => Promise<unknown>): Promise<boolean[]> {
  const o = db.options;
  const sampler = new Client({ host: String(o.host), port: Number(o.port), user: String(o.username), password: String(o.password), database: String(o.database) });
  await sampler.connect();
  const seen: boolean[] = [];
  let running = true;
  const poll = (async () => {
    while (running) {
      const { rows } = await sampler.query(
        `SELECT coalesce(s.ssl, false) AS ssl FROM pg_stat_activity a LEFT JOIN pg_stat_ssl s ON s.pid = a.pid WHERE a.application_name = $1 AND a.pid <> pg_backend_pid()`,
        [application],
      );
      for (const r of rows) seen.push(r.ssl as boolean);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  try {
    await work();
  } finally {
    running = false;
    await poll;
    await sampler.end();
  }
  return seen;
}

describe('TLS (each test is skipped when the server has ssl = off)', () => {
  const needsSsl = (fn: () => Promise<void>) => async (ctx: { skip: () => void }) => {
    if (!serverHasSsl) {
      // CI sets TTM_REQUIRE_SSL so that a server without TLS fails the build instead of silently skipping these tests.
      if (process.env.TTM_REQUIRE_SSL) throw new Error('TTM_REQUIRE_SSL is set but the PostgreSQL server has ssl = off');
      return ctx.skip();
    }
    await fn();
  };

  it(
    'run: tenant pool, lock connection and exclusivity probe all use TLS',
    needsSsl(async () => {
      const app = APP();
      let report!: Awaited<ReturnType<ReturnType<typeof makeRunner>['run']>>;
      const seen = await sampleSsl(app, async () => {
        report = await makeRunner({ db, migrations: [Slow], tenants: [ALPHA, BETA], base: { ssl: { rejectUnauthorized: false }, applicationName: app } }).run({ target: ALL });
      });
      expect(report.summary).toMatchObject({ success: 2, failed: 0 });
      expect(seen.length).toBeGreaterThanOrEqual(4); // several sessions were observed, repeatedly
      expect(seen.every((ssl) => ssl === true)).toBe(true);
    }),
  );

  it(
    'plan and status: the read-only inspection connections use TLS too',
    needsSsl(async () => {
      const app = APP();
      const tenants = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, schema: `tenant_t${i}` }));
      await seedTenants(db, tenants.map((t) => t.schema));
      const runner = makeRunner({ db, migrations: goodMigrations, tenants, base: { ssl: { rejectUnauthorized: false }, applicationName: app } });
      // One plan + status takes about 200 ms and the inspection connections live for a few milliseconds each, so a
      // single pass is observed only 5-9 times, and once (CI, run 25) not at all. Keep inspecting for about a second
      // and a half so that "TLS was observed" does not depend on the sampler's timing.
      const until = Date.now() + 1500;
      const seen = await sampleSsl(app, async () => {
        do {
          expect((await runner.plan({ target: ALL })).summary.failed).toBe(0);
          expect((await runner.status({ target: ALL })).summary.failed).toBe(0);
        } while (Date.now() < until);
      });
      expect(seen.length).toBeGreaterThanOrEqual(20);
      expect(seen.every((ssl) => ssl === true)).toBe(true);
    }),
  );

  it(
    'control: without ssl the same sampler sees plaintext sessions (so the check above can tell the difference)',
    needsSsl(async () => {
      const app = APP();
      const seen = await sampleSsl(app, async () => {
        await makeRunner({ db, migrations: [Slow], tenants: [ALPHA], base: { applicationName: app } }).run({ target: ALL });
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((ssl) => ssl === false)).toBe(true);
    }),
  );

  it(
    'a connection URL with sslmode=no-verify is honored by every connection as well',
    needsSsl(async () => {
      const app = APP();
      const { host, port, username, password, database } = db.options;
      const url = `postgres://${username}:${encodeURIComponent(String(password))}@${host}:${port}/${database}?sslmode=no-verify`;
      const runner = makeRunner({ db, migrations: [Slow], tenants: [ALPHA], base: { url, applicationName: app, host: undefined, port: undefined, username: undefined, password: undefined, database: undefined } });
      const seen = await sampleSsl(app, async () => {
        expect((await runner.run({ target: ALL })).summary.success).toBe(1);
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((ssl) => ssl === true)).toBe(true);
    }),
  );

  it(
    'certificate verification is not silently relaxed: with a CA that did not sign the server certificate, nothing runs and nothing leaks',
    needsSsl(async () => {
      // An explicit, unrelated CA makes the outcome independent of the machine trust store and of the pg version.
      const unrelatedCa = readFileSync(path.resolve(__dirname, '..', 'fixtures', 'unrelated-ca.pem'), 'utf8');
      const before = await snapshotDatabase(db.client);
      const runner = makeRunner({ db, migrations: goodMigrations, base: { ssl: { rejectUnauthorized: true, ca: unrelatedCa } } });

      const report = await runner.run({ target: ALL });
      expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'DATASOURCE_INITIALIZATION_FAILED' } });
      expect(report.tenants[0]!.error!.message).toMatch(/self.signed|unable to (get|verify)|certificate/i);
      expect(JSON.stringify(report)).not.toContain(String(db.password));
      expect((await runner.plan({ target: ALL })).tenants[0]!.status).toBe('failed');
      expect(await snapshotDatabase(db.client)).toEqual(before);
      expect(await waitForNoSessions(db)).toBe(0);
    }),
  );
});
