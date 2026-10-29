import { randomBytes } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantMigrationRunner } from '../../src/runner/tenant-migration-runner.js';
import { defineMigration, goodMigrations } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { createTestDatabase, requirePasswordAuth, waitForNoSessions } from '../helpers/pg.js';
import { ALL, ALPHA, capturingLogger } from '../helpers/runner.js';

const PASSWORD = 'Sup3r-Secret-Pw-Sample';
const WRONG_PASSWORD = 'Wr0ng-Secret-Pw-Sample';
let db: TestDatabase;
let role: string;

beforeAll(async () => {
  db = await createTestDatabase();
  await requirePasswordAuth(db);
  role = `ttm_sec_${randomBytes(4).toString('hex')}`;
  await db.client.query(`CREATE ROLE ${role} LOGIN SUPERUSER PASSWORD '${PASSWORD}'`);
});
afterAll(async () => {
  await db.drop();
  const { Client } = await import('pg');
  const admin = new Client({ host: String(db.options.host), port: Number(db.options.port), user: String(db.options.username), password: String(db.options.password), database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP ROLE IF EXISTS ${role}`);
  await admin.end();
});
beforeEach(() => seedTenants(db));

const leaky = defineMigration('Leaky1700000000050', async (_q: QueryRunner) => {
  // A migration (or a driver) that puts credentials into its own error message.
  throw new Error(`could not apply using postgres://${role}:${PASSWORD}@localhost:5432/app with password=${PASSWORD}`);
});

const secretsIn = (text: string) => [PASSWORD, WRONG_PASSWORD, 'postgres://', 'postgresql://'].filter((s) => text.includes(s));

describe('secrets never reach reports or logs', () => {
  it('scrubs credentials that a failing migration echoes back', async () => {
    const logger = capturingLogger();
    const runner = new TenantMigrationRunner({
      dataSource: { ...db.options, username: role, password: PASSWORD, migrations: [leaky] },
      tenants: [ALPHA],
      options: { logger },
    });
    const report = await runner.run({ target: ALL });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'MIGRATION_FAILED' } });
    expect(secretsIn(JSON.stringify(report))).toEqual([]);
    expect(secretsIn(logger.lines.join('\n'))).toEqual([]);
  });

  it('does not leak the password or URL when authentication fails', async () => {
    const logger = capturingLogger();
    const { host, port, database } = db.options;
    const url = `postgres://${role}:${WRONG_PASSWORD}@${host}:${port}/${database}`;
    const runner = new TenantMigrationRunner({ dataSource: { type: 'postgres', url, migrations: goodMigrations }, tenants: [ALPHA], options: { logger } });

    const report = await runner.run({ target: ALL });
    expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'DATASOURCE_INITIALIZATION_FAILED' } });
    expect(secretsIn(JSON.stringify(report))).toEqual([]);
    expect(secretsIn(logger.lines.join('\n'))).toEqual([]);

    const plan = await runner.plan({ target: ALL });
    expect(secretsIn(JSON.stringify(plan))).toEqual([]);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('does not leak a password from the options when the same password is used with a separate password field', async () => {
    const runner = new TenantMigrationRunner({
      dataSource: { ...db.options, username: role, password: WRONG_PASSWORD, migrations: goodMigrations },
      tenants: [ALPHA],
    });
    const report = await runner.run({ target: ALL });
    expect(report.tenants[0]!.status).toBe('failed');
    expect(secretsIn(JSON.stringify(report))).toEqual([]);
  });

  it('configuration errors do not echo the connection URL', () => {
    const url = `postgres://${role}:${PASSWORD}@h/d?options=-c%20search_path%3Dpublic`;
    try {
      new TenantMigrationRunner({ dataSource: { type: 'postgres', url, migrations: goodMigrations }, tenants: [ALPHA] });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { code: string }).code).toBe('INVALID_CONFIGURATION');
      expect(secretsIn((e as Error).message)).toEqual([]);
    }
  });
});

describe('SQL is not logged', () => {
  it('prints no statements, neither through the logger nor through TypeORM, even if the base enables logging', async () => {
    const logger = capturingLogger();
    const printed: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalLog = console.log;
    process.stdout.write = ((chunk: string | Uint8Array) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    console.log = (...args: unknown[]) => void printed.push(args.map(String).join(' '));
    try {
      const runner = new TenantMigrationRunner({
        dataSource: { ...db.options, logging: true, migrations: goodMigrations },
        tenants: [ALPHA],
        options: { logger },
      });
      const report = await runner.run({ target: ALL });
      expect(report.summary.success).toBe(1);
    } finally {
      process.stdout.write = originalWrite;
      console.log = originalLog;
    }
    const sql = /ALTER TABLE|INSERT INTO|CREATE TABLE|SELECT /i;
    expect(printed).toEqual([]);
    expect(logger.lines.join('\n')).not.toMatch(sql);
    expect(printed.join('\n')).not.toMatch(sql);
  });
});

describe("TypeORM's own console output", () => {
  it('stays silent when a migration fails (it would otherwise print the raw error on stdout)', async () => {
    const printed: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalLog = console.log;
    process.stdout.write = ((chunk: string | Uint8Array) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    console.log = (...args: unknown[]) => void printed.push(args.map(String).join(' '));
    try {
      const runner = new TenantMigrationRunner({ dataSource: { ...db.options, migrations: [leaky] }, tenants: [ALPHA] });
      expect((await runner.run({ target: ALL })).tenants[0]!.status).toBe('failed');
    } finally {
      process.stdout.write = originalWrite;
      console.log = originalLog;
    }
    expect(printed).toEqual([]);
  });
});

describe('least-privilege role', () => {
  it('works for a non-superuser that can only connect and owns the tenant schemas', async () => {
    const limited = `ttm_lim_${randomBytes(4).toString('hex')}`;
    await db.client.query(`CREATE ROLE ${limited} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'Limited-Role-Pw-1'`);
    await db.client.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${limited}`);
    for (const schema of ['tenant_alpha', 'tenant_beta']) {
      await db.client.query(`ALTER SCHEMA ${schema} OWNER TO ${limited}`);
      await db.client.query(`ALTER TABLE ${schema}.orders OWNER TO ${limited}`);
      await db.client.query(`ALTER TABLE ${schema}.audit OWNER TO ${limited}`);
    }
    try {
      const runner = new TenantMigrationRunner({
        dataSource: { ...db.options, username: limited, password: 'Limited-Role-Pw-1', migrations: goodMigrations },
        tenants: [ALPHA, { id: 'beta', schema: 'tenant_beta' }],
      });
      expect((await runner.plan({ target: ALL })).summary).toMatchObject({ ok: 2, failed: 0, pendingTotal: 6 });
      expect((await runner.run({ target: ALL })).summary).toMatchObject({ success: 2, failed: 0 });
      expect((await runner.status({ target: ALL })).summary).toMatchObject({ ok: 2, pendingTotal: 0 });
      // The role has no rights on public: nothing could have leaked there, and nothing changed.
      expect((await db.client.query('SELECT count(*) FROM public.orders')).rows[0].count).toBe('0');
    } finally {
      await waitForNoSessions(db);
      await db.client.query(`REASSIGN OWNED BY ${limited} TO ${String(db.options.username)}`);
      await db.client.query(`DROP OWNED BY ${limited}`);
      await db.client.query(`DROP ROLE ${limited}`);
    }
  });
});
