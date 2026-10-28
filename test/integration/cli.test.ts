import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireAdvisoryLock } from '../../src/postgres/advisory-lock.js';
import { EXIT, runCli } from '../../src/cli/main.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { advisoryLocksHeld, columnsOf, createTestDatabase, snapshotDatabase, tablesOf, waitForNoSessions } from '../helpers/pg.js';
import { MIGRATION_BODIES as M, REPO_ROOT, runBin, writeProject } from '../helpers/cli-project.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db));

async function cli(args: string[], cwd = REPO_ROOT) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, { stdout: { write: (t) => (stdout += t) }, stderr: { write: (t) => (stderr += t) }, cwd });
  return { code, stdout, stderr };
}
const normal = [M.addStatus, M.createThings];

describe('usage and configuration errors (exit 2, nothing executed)', () => {
  it('requires --config', async () => {
    const r = await cli(['run', '--all']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain('--config');
  });

  it('requires exactly one of --all / --tenant', async () => {
    const p = writeProject({ db, migrations: normal });
    for (const args of [['run', '--config', p.config], ['run', '--config', p.config, '--all', '--tenant', 'alpha']]) {
      const r = await cli(args);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.stderr).toMatch(/exactly one of --all or --tenant/);
    }
  });

  it('rejects an unknown tenant id', async () => {
    const p = writeProject({ db, migrations: normal });
    const r = await cli(['run', '--config', p.config, '--tenant', 'tenant_alpha']); // a schema name is not an id
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain('INVALID_TENANT_TARGET');
  });

  it('reports a missing config file, a broken config and a wrong shape', async () => {
    const p = writeProject({ db, migrations: normal });
    expect((await cli(['run', '--all', '--config', '/nope/missing.cjs'])).code).toBe(EXIT.USAGE);

    const { writeFileSync } = await import('node:fs');
    const broken = `${p.dir}/broken.cjs`;
    writeFileSync(broken, `throw new Error('postgres://u:hunter2@h/d exploded');`);
    const r = await cli(['run', '--all', '--config', broken]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr + r.stdout).not.toContain('hunter2');

    const wrong = `${p.dir}/wrong.cjs`;
    writeFileSync(wrong, `module.exports = { hello: 1 };`);
    expect((await cli(['run', '--all', '--config', wrong])).code).toBe(EXIT.USAGE);
  });

  it('validates numeric flags and flag/command combinations', async () => {
    const p = writeProject({ db, migrations: normal });
    const before = await snapshotDatabase(db.client);
    for (const extra of [['--concurrency', '0'], ['--concurrency', 'abc'], ['--concurrency', '99'], ['--lock-timeout', '-5'], ['--transaction', 'bogus'], ['--nope']]) {
      expect((await cli(['run', '--all', '--config', p.config, ...extra])).code, extra.join(' ')).toBe(EXIT.USAGE);
    }
    expect((await cli(['plan', '--all', '--config', p.config, '--continue-on-error'])).code).toBe(EXIT.USAGE);
    expect((await cli(['frobnicate', '--all', '--config', p.config])).code).toBe(EXIT.USAGE);
    expect(await snapshotDatabase(db.client)).toEqual(before);
  });

  it('prints errors as JSON on stdout in --json mode', async () => {
    const r = await cli(['run', '--json']);
    expect(r.code).toBe(EXIT.USAGE);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: 'INVALID_CONFIGURATION' } });
  });
});

describe('config loading', () => {
  it.each(['cjs', 'mjs', 'async-fn'] as const)('loads a %s config', async (kind) => {
    const p = writeProject({ db, kind, migrations: normal });
    const r = await cli(['plan', '--all', '--json', '--config', p.config]);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.stdout).tenants[0].pending).toEqual(['AddStatus1700000000001', 'CreateThings1700000000002']);
  });

  it('loads a TypeScript config when tsx is installed', async () => {
    const p = writeProject({ db, kind: 'ts', migrations: normal });
    const r = await cli(['plan', '--all', '--json', '--config', p.config]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.stdout).summary).toMatchObject({ total: 2, ok: 2 });
  });
});

describe('plan / status through the real binary', () => {
  it('are read-only, exit 0, and keep stdout pure JSON with --json', async () => {
    const p = writeProject({ db, migrations: normal });
    const before = await snapshotDatabase(db.client);
    for (const command of ['plan', 'status']) {
      const r = await runBin([command, '--all', '--json', '--config', p.config]);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout); // throws if anything but JSON is on stdout
      expect(parsed.summary).toMatchObject({ total: 2, failed: 0, pendingTotal: 4 });
    }
    expect(await snapshotDatabase(db.client)).toEqual(before);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('plan exits 1 when a tenant cannot be inspected', async () => {
    const p = writeProject({ db, migrations: normal, tenants: [{ id: 'ghost', schema: 'tenant_ghost' }] });
    const r = await runBin(['plan', '--all', '--config', p.config]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('SCHEMA_NOT_FOUND');
  });
});

describe('run through the real binary', () => {
  it('migrates one tenant, exits 0, human-readable output', async () => {
    const p = writeProject({ db, migrations: normal });
    const r = await runBin(['run', '--tenant', 'alpha', '--config', p.config]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OK\s+alpha \(tenant_alpha\)/);
    expect(r.stdout).toContain('AddStatus1700000000001');
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'status']);
    expect(await columnsOf(db.client, 'tenant_beta', 'orders')).toEqual(['id']);
    expect(await tablesOf(db.client, 'public')).toEqual(['orders']);
  });

  it('--all --json: report on stdout, logs on stderr, rerun is a no-op', async () => {
    const p = writeProject({ db, migrations: normal });
    const first = await runBin(['run', '--all', '--json', '--config', p.config]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).summary).toMatchObject({ success: 2, failed: 0 });
    expect(first.stderr).toContain('[typeorm-tenant-migrations]');

    const second = await runBin(['run', '--all', '--json', '--config', p.config]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).summary).toMatchObject({ skipped: 2, success: 0 });
  });

  it('exits 1 on a tenant failure; --continue-on-error still reports every tenant', async () => {
    const tenants = [
      { id: 'alpha', schema: 'tenant_alpha' },
      { id: 'beta', schema: 'tenant_beta' },
    ];
    await db.client.query('CREATE SCHEMA tenant_gamma; CREATE TABLE tenant_gamma.orders (id int); CREATE TABLE tenant_gamma.audit (note text)');
    const withGamma = [...tenants, { id: 'gamma', schema: 'tenant_gamma' }];
    const p = writeProject({ db, migrations: [M.failsOnBeta], tenants: withGamma });

    const failFast = await runBin(['run', '--all', '--json', '--config', p.config]);
    expect(failFast.code).toBe(1);
    expect(JSON.parse(failFast.stdout).tenants.map((t: { status: string }) => t.status)).toEqual(['success', 'failed', 'not-started']);

    const cont = await runBin(['run', '--all', '--json', '--continue-on-error', '--config', p.config]);
    expect(cont.code).toBe(1);
    expect(JSON.parse(cont.stdout).tenants.map((t: { status: string }) => t.status)).toEqual(['skipped', 'failed', 'success']);
  });

  it('exits 3 when a tenant is locked by someone else', async () => {
    const p = writeProject({ db, migrations: normal });
    const holder = await acquireAdvisoryLock({ ...db.options }, { schema: 'tenant_alpha', timeoutMs: 0 });
    try {
      const r = await runBin(['run', '--tenant', 'alpha', '--lock-timeout', '200', '--json', '--config', p.config]);
      expect(r.code).toBe(3);
      expect(JSON.parse(r.stdout).tenants[0]).toMatchObject({ status: 'locked', error: { code: 'CONCURRENT_MIGRATION' } });
      expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'orders']);
    } finally {
      await holder.release();
    }
  });

  it('two separate OS processes migrating the same tenant never both enter the migration', async () => {
    const p = writeProject({ db, migrations: [M.slowAudit], options: { lockTimeoutMs: 20_000 } });
    const args = ['run', '--tenant', 'alpha', '--json', '--config', p.config];
    const [a, b] = await Promise.all([runBin(args), runBin(args)]);

    expect([a.code, b.code]).toEqual([0, 0]);
    const statuses = [a, b].map((r) => JSON.parse(r.stdout).tenants[0].status).sort();
    expect(statuses).toEqual(['skipped', 'success']);
    expect((await db.client.query('SELECT count(*) FROM tenant_alpha.audit')).rows[0].count).toBe('1');
    expect(await advisoryLocksHeld(db)).toEqual([]);
    expect(await waitForNoSessions(db)).toBe(0);
  });

  it('never prints the password, even when the connection fails', async () => {
    const p = writeProject({ db, migrations: normal, dbOverrides: { password: 'Wr0ng-Sample-Secret-Pw' } });
    const r = await runBin(['run', '--all', '--config', p.config]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain('Wr0ng-Sample-Secret-Pw');
    expect(r.stdout).toContain('DATASOURCE_INITIALIZATION_FAILED');
  });
});

describe('--help / --version', () => {
  it('exit 0', async () => {
    expect((await runBin(['--help'])).code).toBe(0);
    const v = await runBin(['--version']);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
