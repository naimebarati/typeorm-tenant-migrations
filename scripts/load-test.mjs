#!/usr/bin/env node
// Load test: many tenant schemas, several `concurrency` levels.
//
//   node scripts/load-test.mjs --tenants 200 --concurrency 1,2,4,8 [--rows 2000] [--tables 5] [--json out.json] [--no-build]
//
// Builds dist/ first (skip with --no-build). Needs a PostgreSQL reachable through TTM_TEST_PG_URL
// (default postgres://postgres:postgres@127.0.0.1:5432/postgres; the role must be allowed to create databases).
//
// For every phase it records wall time, the peak number of connections this package had open at the same
// time (sampled from pg_stat_activity every 10 ms), the process's RSS growth, and it verifies the database
// afterwards: every tenant has exactly the expected history, no advisory lock is left, no session is left.
// It exits non-zero if any verification fails.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Always measure the code in src/: a stale dist/ (for example left over from a mutation experiment) would be measured otherwise.
if (!process.argv.includes('--no-build')) execSync('npm run build --silent', { cwd: root, stdio: 'inherit' });
const { TenantMigrationRunner } = require(path.join(root, 'dist', 'index.js'));
const { Client } = require('pg');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []),
);
const TENANTS = Number(args.tenants ?? 200);
const LEVELS = String(args.concurrency ?? '1,2,4,8').split(',').map(Number);
const ROWS = Number(args.rows ?? 2000);
const TABLES = Number(args.tables ?? 5);
const EXTRA_PHASES = args.extra !== 'false';

const adminUrl = new URL(process.env.TTM_TEST_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres');
const conn = (database) => ({
  host: adminUrl.hostname,
  port: Number(adminUrl.port || 5432),
  user: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
  database,
});
const APP = `ttm-load-${randomBytes(3).toString('hex')}`;
const DB = `ttm_load_${randomBytes(4).toString('hex')}`;
const schemaOf = (i) => `tenant_${String(i).padStart(5, '0')}`;
const tenants = Array.from({ length: TENANTS }, (_, i) => ({ id: `t${i}`, schema: schemaOf(i) }));
const mb = (bytes) => Math.round(bytes / 1024 / 1024);

// ---------------------------------------------------------------- migrations (a fresh set per phase)
function migrationSet(tag, ts) {
  const defs = [
    [`A`, (t) => `ALTER TABLE "orders" ADD COLUMN "c_${t}" text DEFAULT 'x'`],
    [`B`, (t) => `CREATE INDEX "orders_c_${t}_idx" ON "orders" ("c_${t}")`],
    [`C`, (t) => `CREATE TABLE "extra_${t}" (id serial PRIMARY KEY, order_id int, note text)`],
  ];
  return defs.map(([s, body], i) => {
    const name = `Load${tag}${s}${ts + i}`;
    return class { constructor() { this.name = name; } async up(q) { await q.query(body(tag)); } async down() {} };
  });
}
let tsCounter = 1_700_000_001_000;
const nextSet = (tag) => { const set = migrationSet(tag, tsCounter); tsCounter += 10; return set; };

// ---------------------------------------------------------------- measuring
let sampler;
async function startSampler() {
  const c = new Client(conn(DB));
  await c.connect();
  const state = { peak: 0, peakOurs: 0, samples: 0, running: true };
  state.loop = (async () => {
    while (state.running) {
      const { rows } = await c.query(
        `SELECT count(*) FILTER (WHERE application_name = $1)::int AS ours, count(*)::int AS total FROM pg_stat_activity WHERE datname = $2 AND pid <> pg_backend_pid()`,
        [APP, DB],
      );
      state.peakOurs = Math.max(state.peakOurs, rows[0].ours);
      state.peak = Math.max(state.peak, rows[0].total);
      state.samples++;
      await new Promise((r) => setTimeout(r, 10));
    }
    await c.end();
  })();
  return state;
}
async function measure(label, fn) {
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const state = await startSampler();
  const started = process.hrtime.bigint();
  let result;
  try {
    result = await fn();
  } finally {
    state.running = false;
    await state.loop;
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  global.gc?.();
  return { label, seconds, peakConnections: state.peakOurs, rssMb: mb(process.memoryUsage().rss), rssGrowthMb: mb(process.memoryUsage().rss - rssBefore), samples: state.samples, result };
}

const results = [];
const problems = [];
const expect = (cond, message) => { if (!cond) { problems.push(message); console.error(`  !! ${message}`); } };

const verifyHistory = async (admin, names, label) => {
  const { rows } = await admin.query(
    `SELECT n.nspname AS schema, (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = 'migrations')::int AS has_table
       FROM pg_namespace n WHERE n.nspname LIKE 'tenant\\_%' ORDER BY 1`,
  );
  let bad = 0;
  for (const { schema, has_table } of rows) {
    if (!has_table) { bad++; continue; }
    const h = await admin.query(`SELECT name FROM "${schema}".migrations WHERE name = ANY($1)`, [names]);
    if (h.rowCount !== names.length) bad++;
  }
  expect(bad === 0, `${label}: ${bad} of ${rows.length} tenants do not have exactly the expected history`);
};
const verifyQuiet = async (admin, label) => {
  const locks = (await admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`)).rows[0].n;
  expect(locks === 0, `${label}: ${locks} advisory locks still held`);
  let sessions = 1;
  for (let i = 0; i < 100 && sessions > 0; i++) {
    sessions = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = $2`, [DB, APP])).rows[0].n;
    if (sessions > 0) await new Promise((r) => setTimeout(r, 50));
  }
  expect(sessions === 0, `${label}: ${sessions} sessions of this package still open`);
};

async function main() {
  const adminDb = new Client(conn(adminUrl.pathname.slice(1) || 'postgres'));
  await adminDb.connect();
  await adminDb.query(`CREATE DATABASE ${DB}`);
  const maxConn = Number((await adminDb.query('SHOW max_connections')).rows[0].max_connections);
  const version = (await adminDb.query('SHOW server_version')).rows[0].server_version;
  const admin = new Client(conn(DB));
  await admin.connect();

  console.log(`PostgreSQL ${version}, max_connections=${maxConn}; Node ${process.version}; ${TENANTS} tenants x ${TABLES} tables, ${ROWS} rows in "orders"`);
  const t0 = Date.now();
  await admin.query('SET synchronous_commit = off');
  for (let i = 0; i < TENANTS; i++) {
    const s = schemaOf(i);
    await admin.query(`CREATE SCHEMA ${s}`);
    await admin.query(`CREATE TABLE ${s}.orders (id serial PRIMARY KEY, total numeric)`);
    await admin.query(`INSERT INTO ${s}.orders (total) SELECT g FROM generate_series(1, ${ROWS}) g`);
    for (let t = 2; t <= TABLES; t++) await admin.query(`CREATE TABLE ${s}.t${t} (id serial PRIMARY KEY, v text)`);
  }
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

  const base = { type: 'postgres', host: conn(DB).host, port: conn(DB).port, username: conn(DB).user, password: conn(DB).password, database: DB, applicationName: APP };
  const runnerFor = (migrations, options = {}) => new TenantMigrationRunner({ dataSource: { ...base, migrations }, tenants, options: { maxConcurrency: 64, ...options } });
  const record = (m, extra = {}) => {
    results.push({ phase: m.label, seconds: +m.seconds.toFixed(2), perTenantMs: +((m.seconds * 1000) / TENANTS).toFixed(1), peakConnections: m.peakConnections, rssMb: m.rssMb, rssGrowthMb: m.rssGrowthMb, ...extra });
    const r = results.at(-1);
    console.log(`${r.phase.padEnd(34)} ${String(r.seconds).padStart(7)} s  ${String(r.perTenantMs).padStart(7)} ms/tenant  peak conn ${String(r.peakConnections).padStart(3)}  rss ${String(r.rssMb).padStart(4)} MB (${r.rssGrowthMb >= 0 ? '+' : ''}${r.rssGrowthMb})`);
  };

  // ---- plan / status on the unmigrated database
  const probeSet = nextSet('Probe');
  for (const c of [1, 8]) {
    const m = await measure(`plan, concurrency ${c}`, () => runnerFor(probeSet, { concurrency: c }).plan({ target: { all: true } }));
    expect(m.result.summary.failed === 0 && m.result.summary.pendingTotal === TENANTS * 3, `plan c=${c}: unexpected summary ${JSON.stringify(m.result.summary)}`);
    record(m);
  }

  // ---- run at each concurrency level, each level with its own fresh migrations
  const levelSets = new Map();
  for (const c of LEVELS) {
    const set = nextSet(`C${c}`);
    levelSets.set(c, set);
    const m = await measure(`run, concurrency ${c}`, () => runnerFor(set, { concurrency: c }).run({ target: { all: true } }));
    const names = set.map((K) => new K().name);
    expect(m.result.summary.success === TENANTS && m.result.summary.failed === 0, `run c=${c}: ${JSON.stringify(m.result.summary)}`);
    expect(m.peakConnections <= 3 * c + 1, `run c=${c}: peak ${m.peakConnections} connections exceeds 3*concurrency+1`);
    await verifyHistory(admin, names, `run c=${c}`);
    await verifyQuiet(admin, `run c=${c}`);
    record(m, { perConcurrencyThroughput: +(TENANTS / m.seconds).toFixed(1) });
  }

  if (EXTRA_PHASES) {
    const last = LEVELS.at(-1);
    const lastSet = levelSets.get(last);
    // ---- nothing to do: every tenant is up to date
    const again = await measure(`rerun (all up to date), c=${last}`, () => runnerFor(lastSet, { concurrency: last }).run({ target: { all: true } }));
    expect(again.result.summary.skipped === TENANTS, `rerun: ${JSON.stringify(again.result.summary)}`);
    record(again);
    const status = await measure(`status, concurrency ${last}`, () => runnerFor(lastSet, { concurrency: last }).status({ target: { all: true } }));
    expect(status.result.summary.failed === 0 && status.result.summary.pendingTotal === 0, `status: ${JSON.stringify(status.result.summary)}`);
    record(status);

    // ---- failures at scale: every 10th tenant has a poisoned table, continueOnError keeps going
    const poison = nextSet('Poison');
    const victims = tenants.filter((_, i) => i % 10 === 0).map((t) => t.schema);
    for (const s of victims) await admin.query(`CREATE TABLE ${s}."extra_Poison" (x int)`); // collides with migration C's CREATE TABLE
    const failing = await measure(`run with ${victims.length} failing tenants, c=${last}`, () => runnerFor(poison, { concurrency: last, continueOnError: true }).run({ target: { all: true } }));
    expect(failing.result.summary.failed === victims.length && failing.result.summary.success === TENANTS - victims.length, `poisoned: ${JSON.stringify(failing.result.summary)}`);
    await verifyQuiet(admin, 'poisoned run');
    record(failing);

    // ---- connection ceiling: concurrency above what max_connections can serve
    const ceiling = Math.max(2, Math.floor(maxConn / 3) + 8);
    const storm = nextSet('Storm');
    const stormRun = await measure(`run, concurrency ${ceiling} (max_connections ${maxConn})`, () => runnerFor(storm, { concurrency: Math.min(ceiling, 64), continueOnError: true }).run({ target: { all: true } }));
    const s = stormRun.result.summary;
    const tooMany = stormRun.result.tenants.filter((t) => t.status === 'failed');
    console.log(`   -> ${s.success} succeeded, ${s.failed} failed, ${s.notStarted} not started; error codes: ${[...new Set(tooMany.map((t) => t.error?.code))].join(', ') || '-'}`);
    expect(tooMany.every((t) => /too many|remaining connection slots|sorry/i.test(t.error?.message ?? '')), 'connection exhaustion produced an error other than "too many connections"');
    await verifyQuiet(admin, 'connection-ceiling run');
    // whatever failed can simply be re-run, with sane concurrency, and completes
    const heal = await measure(`re-run after the ceiling, c=4`, () => runnerFor(storm, { concurrency: 4 }).run({ target: { all: true } }));
    expect(heal.result.summary.failed === 0 && heal.result.summary.success + heal.result.summary.skipped === TENANTS, `heal: ${JSON.stringify(heal.result.summary)}`);
    await verifyHistory(admin, storm.map((K) => new K().name), 'after re-run');
    record(stormRun, { succeeded: s.success, failed: s.failed });
    record(heal);
  }

  await admin.end();
  await adminDb.query(`DROP DATABASE ${DB} WITH (FORCE)`);
  await adminDb.end();

  const out = { postgres: version, maxConnections: maxConn, node: process.version, tenants: TENANTS, tables: TABLES, rows: ROWS, results, problems };
  if (args.json) writeFileSync(args.json, JSON.stringify(out, null, 2));
  console.log(problems.length ? `\nFAILED: ${problems.length} problem(s)` : '\nall verifications passed');
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
