// Diagnostic, not part of the test suite: what does THIS PgBouncer do with the `options` startup parameter
// (`-c search_path=...`), in front of THIS PostgreSQL? It prints one JSON line per scenario (prefix PROBE) and
// PgBouncer's own log (prefix PGBLOG), so a CI log shows the raw answers instead of the runner's interpretation.
//
//   TTM_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres TTM_PGBOUNCER_BIN=/usr/sbin/pgbouncer \
//     node scripts/probe-pgbouncer.mjs
//
// It creates the schema `ttm_probe` in the database of the URL and drops it again.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

const bin = process.env.TTM_PGBOUNCER_BIN || 'pgbouncer';
const target = new URL(process.env.TTM_TEST_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres');
const creds = { user: decodeURIComponent(target.username), password: decodeURIComponent(target.password), database: target.pathname.slice(1) || 'postgres' };
const STARTUP_OPTIONS = '-c search_path=ttm_probe -c default_transaction_read_only=on';

const SCENARIOS = [
  { name: 'default', extra: [] },
  { name: 'ignore_startup_parameters=options', extra: ['ignore_startup_parameters = options'] },
  { name: 'track_extra_parameters=search_path,default_transaction_read_only', extra: ['track_extra_parameters = IntervalStyle, search_path, default_transaction_read_only'] },
];

const summary = [];
const emit = (kind, value) => console.log(`${kind} ${typeof value === 'string' ? value : JSON.stringify(value)}`);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForPort(port, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pgbouncer exited early with code ${child.exitCode}`);
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('pgbouncer did not start listening');
}

async function startPgBouncer(poolMode, extra) {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'ttm-probe-'));
  chmodSync(dir, 0o755);
  const log = path.join(dir, 'pgbouncer.log');
  writeFileSync(path.join(dir, 'userlist.txt'), `"${creds.user}" "${creds.password}"\n`);
  writeFileSync(
    path.join(dir, 'pgbouncer.ini'),
    [
      '[databases]',
      `* = host=${target.hostname} port=${target.port || 5432}`,
      '[pgbouncer]',
      'listen_addr = 127.0.0.1',
      `listen_port = ${port}`,
      'unix_socket_dir =',
      'auth_type = plain',
      `auth_file = ${path.join(dir, 'userlist.txt')}`,
      `pool_mode = ${poolMode}`,
      'default_pool_size = 2',
      'max_client_conn = 100',
      `logfile = ${log}`,
      'log_connections = 1',
      'log_disconnections = 1',
      'verbose = 2',
      ...extra,
      '',
    ].join('\n'),
  );
  const child = spawn(bin, [path.join(dir, 'pgbouncer.ini')], { stdio: 'ignore' });
  try {
    await waitForPort(port, child);
  } catch (error) {
    child.kill('SIGKILL');
    let text = '';
    try { text = readFileSync(log, 'utf8'); } catch { /* no log */ }
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`${error.message}\n${text}`);
  }
  return {
    port,
    log: () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } },
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const QUERY = `SELECT current_setting('search_path') AS search_path, current_schema() AS current_schema,
  current_setting('default_transaction_read_only') AS read_only, current_setting('server_version') AS server_version, pg_backend_pid() AS backend_pid`;

async function connectOnce(port) {
  const client = new pg.Client({ host: '127.0.0.1', port, ...creds, options: STARTUP_OPTIONS, ssl: false, connectionTimeoutMillis: 5000 });
  client.on('error', () => {});
  try {
    await client.connect();
    const first = (await client.query(QUERY)).rows[0];
    const second = (await client.query(QUERY)).rows[0];
    return { ok: true, first, second_same_backend: second.backend_pid === first.backend_pid };
  } catch (error) {
    return { ok: false, code: error.code, severity: error.severity, message: String(error.message).slice(0, 200) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

const direct = new pg.Client({ host: target.hostname, port: Number(target.port || 5432), ...creds, ssl: false });
await direct.connect();
const meta = (await direct.query(`SELECT current_setting('server_version') AS server_version`)).rows[0];
await direct.query('CREATE SCHEMA IF NOT EXISTS ttm_probe');
emit('PROBE', { what: 'environment', pgbouncer: execFileSync(bin, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim(), postgres: meta.server_version, node: process.version, pgDriver: (await import('pg/package.json', { with: { type: 'json' } })).default.version, platform: `${process.platform}/${process.arch}` });

try {
  for (const poolMode of ['session', 'transaction']) {
    for (const scenario of SCENARIOS) {
      let bouncer;
      try {
        bouncer = await startPgBouncer(poolMode, scenario.extra);
        // Two separate client connections: the second one may be handed a server connection the first one used.
        const a = await connectOnce(bouncer.port);
        const b = await connectOnce(bouncer.port);
        emit('PROBE', { what: 'startup-options', poolMode, scenario: scenario.name, client1: a, client2: b });
        summary.push({ poolMode, scenario: scenario.name, a, b });
        const lines = bouncer.log().split('\n').filter((l) => /startup|options|search_path|parameter|ignor|unsupported|error|warn/i.test(l)).slice(-12);
        for (const l of lines) emit('PGBLOG', `[${poolMode}/${scenario.name}] ${l.slice(0, 220)}`);
      } catch (error) {
        emit('PROBE', { what: 'startup-options', poolMode, scenario: scenario.name, harness_error: String(error.message).slice(0, 300) });
        summary.push({ poolMode, scenario: scenario.name, harness_error: String(error.message).slice(0, 120) });
      } finally {
        await bouncer?.stop();
      }
    }
  }
  // One line per scenario and client, readable without the JSON above.
  const describe = (c) => (c.ok ? `search_path=${c.first.search_path} current_schema=${c.first.current_schema} read_only=${c.first.read_only}` : `REFUSED (${c.message})`);
  console.log(`RESULT ${execFileSync(bin, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim()} in front of PostgreSQL ${meta.server_version.split(' ')[0]}`);
  for (const row of summary) {
    if (row.harness_error) console.log(`RESULT   ${row.poolMode} / ${row.scenario}: HARNESS ERROR ${row.harness_error}`);
    else console.log(`RESULT   ${row.poolMode} / ${row.scenario}: client1 ${describe(row.a)}${JSON.stringify(row.a) === JSON.stringify(row.b) ? '' : `; client2 ${describe(row.b)}`}`);
  }
} finally {
  await direct.query('DROP SCHEMA IF EXISTS ttm_probe CASCADE').catch(() => undefined);
  await direct.end().catch(() => undefined);
}
