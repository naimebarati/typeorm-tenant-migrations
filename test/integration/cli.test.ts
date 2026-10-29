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

describe('in-process runCli (success paths, formatting and exit codes)', () => {
  it('--help and --version', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(EXIT.OK);
    expect(help.stdout).toContain('Exit codes:');
    const version = await cli(['-v']);
    expect(version.code).toBe(EXIT.OK);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects a missing/odd command and stray arguments', async () => {
    const p = writeProject({ db, migrations: normal });
    expect((await cli(['--all', '--config', p.config])).code).toBe(EXIT.USAGE);
    expect((await cli(['run', 'extra', '--all', '--config', p.config])).stderr).toContain('Unexpected argument "extra"');
  });

  it('plan: human output, exit 0, database untouched', async () => {
    const p = writeProject({ db, migrations: normal });
    const before = await snapshotDatabase(db.client);
    const r = await cli(['plan', '--all', '--config', p.config]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('pending: 2');
    expect(r.stdout).toContain('Nothing was changed.');
    expect(await snapshotDatabase(db.client)).toEqual(before);
  });

  it('status: json and human', async () => {
    const p = writeProject({ db, migrations: normal });
    await cli(['run', '--tenant', 'alpha', '--config', p.config]);
    const json = JSON.parse((await cli(['status', '--all', '--json', '--config', p.config])).stdout);
    expect(json.tenants.map((t: { historyTableExists: boolean }) => t.historyTableExists)).toEqual([true, false]);
    const human = await cli(['status', '--all', '--config', p.config]);
    expect(human.stdout).toContain('(no history table yet)');
  });

  it('run: human output and flag overrides reach the runner (concurrency, transaction, lock timeout)', async () => {
    const p = writeProject({ db, migrations: normal });
    const r = await cli(['run', '--all', '--concurrency', '2', '--transaction', 'all', '--lock-timeout', '5000', '--config', p.config]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain('Summary: 2 tenant(s) — 2 migrated');
    expect(r.stderr).toContain("concurrency 2, transaction 'all'");
  });

  it('run: exit 1 for a failed tenant, with continue-on-error flag honored', async () => {
    const p = writeProject({ db, migrations: [M.failsOnBeta] });
    const r = await cli(['run', '--all', '--continue-on-error', '--json', '--config', p.config]);
    expect(r.code).toBe(EXIT.TENANT_FAILED);
    expect(JSON.parse(r.stdout).tenants.map((t: { status: string }) => t.status)).toEqual(['success', 'failed']);
  });

  it('run: exit 3 when the lock cannot be taken, 1 if something also failed', async () => {
    const p = writeProject({ db, migrations: normal });
    const holder = await acquireAdvisoryLock({ ...db.options }, { schema: 'tenant_alpha', timeoutMs: 0 });
    try {
      const locked = await cli(['run', '--tenant', 'alpha', '--lock-timeout', '100', '--config', p.config]);
      expect(locked.code).toBe(EXIT.LOCKED);
      expect(locked.stdout).toContain('LOCKED');
    } finally {
      await holder.release();
    }
  });

  it('plan/status exit 1 when a tenant cannot be inspected', async () => {
    const p = writeProject({ db, migrations: normal, tenants: [{ id: 'ghost', schema: 'tenant_ghost' }] });
    expect((await cli(['plan', '--all', '--config', p.config])).code).toBe(EXIT.TENANT_FAILED);
    expect((await cli(['status', '--all', '--config', p.config])).code).toBe(EXIT.TENANT_FAILED);
  });

  it('a first SIGTERM during run stops gracefully (in-process; the second-signal path is covered with a real child process)', async () => {
    await db.client.query('CREATE SCHEMA tenant_gamma; CREATE TABLE tenant_gamma.orders (id int); CREATE TABLE tenant_gamma.audit (note text)');
    const p = writeProject({
      db,
      migrations: [M.slowAudit],
      tenants: [
        { id: 'alpha', schema: 'tenant_alpha' },
        { id: 'beta', schema: 'tenant_beta' },
        { id: 'gamma', schema: 'tenant_gamma' },
      ],
    });
    const before = process.listenerCount('SIGTERM');
    const running = cli(['run', '--all', '--json', '--config', p.config]);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await db.client.query(`SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND state = 'active' AND query LIKE '%pg_sleep(1.2)%' AND pid <> pg_backend_pid()`, [db.name]);
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    process.emit('SIGTERM');
    const r = await running;

    expect(r.code).toBe(EXIT.INTERRUPTED);
    expect(r.stderr).toContain('Received SIGTERM');
    const report = JSON.parse(r.stdout);
    expect(report.interrupted).toBe(true);
    expect(report.tenants.map((t: { status: string }) => t.status)).toEqual(['success', 'not-started', 'not-started']);
    expect(process.listenerCount('SIGTERM')).toBe(before); // handlers are removed once the run is over
    expect(await advisoryLocksHeld(db)).toEqual([]);
  });
});
