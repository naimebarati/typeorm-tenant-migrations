import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { DataSourceOptions } from 'typeorm';

type PostgresConnectionOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

const adminUrl = new URL(
  process.env.TTM_TEST_PG_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
);

export interface TestDatabase {
  name: string;
  password: string;
  /** Plain connection options (no schema/search_path); spread into a DataSource. */
  options: Pick<
    PostgresConnectionOptions,
    'type' | 'host' | 'port' | 'username' | 'password' | 'database'
  >;
  /** Direct `pg` client for fixtures and assertions; independent of TypeORM. */
  client: Client;
  /** Open sessions on this database, excluding the helper's own client. */
  countOtherSessions(): Promise<number>;
  drop(): Promise<void>;
}

function connectionConfig(database: string) {
  return {
    host: adminUrl.hostname,
    port: Number(adminUrl.port || 5432),
    user: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
    database,
  };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `ttm_test_${randomBytes(6).toString('hex')}`;
  const admin = new Client(connectionConfig(adminUrl.pathname.slice(1) || 'postgres'));
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const cfg = connectionConfig(name);
  const client = new Client(cfg);
  await client.connect();

  return {
    name,
    password: cfg.password,
    options: {
      type: 'postgres',
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      password: cfg.password,
      database: name,
    },
    client,
    async countOtherSessions() {
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name],
      );
      return rows[0].n as number;
    },
    async drop() {
      await client.end();
      const dropper = new Client(connectionConfig(adminUrl.pathname.slice(1) || 'postgres'));
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } catch {
        // PostgreSQL 12 has no WITH (FORCE): end the sessions by hand, then drop.
        await dropper.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
        await dropper.query(`DROP DATABASE IF EXISTS ${name}`);
      }
      await dropper.end();
    },
  };
}

/** Every user-visible `schema.table.column`, for before/after comparison of the whole database. */
export async function snapshotDatabase(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ s: string }>(`
    SELECT n.nspname || '.' || c.relname || '.' || coalesce(a.attname, '') AS s
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    UNION ALL
    SELECT 'schema:' || nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%'
    ORDER BY 1`);
  return rows.map((r) => r.s);
}

export async function columnsOf(client: Client, schema: string, table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, table],
  );
  return rows.map((r) => r.column_name);
}

export async function tablesOf(client: Client, schema: string): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
    [schema],
  );
  return rows.map((r) => r.table_name);
}

/**
 * pg_stat_activity lags a hair behind a closed socket (the backend exits a moment after the client
 * disconnects), so "exactly N sessions" can only be asserted by waiting for N. Returns the last count seen.
 */
export async function waitForSessionCount(db: TestDatabase, expected: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let n = await db.countOtherSessions();
  while (n !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    n = await db.countOtherSessions();
  }
  return n;
}

export const waitForNoSessions = (db: TestDatabase, timeoutMs = 3000) => waitForSessionCount(db, 0, timeoutMs);

export async function advisoryLocksHeld(db: TestDatabase): Promise<string[]> {
  const { rows } = await db.client.query(
    `SELECT ((classid::bigint << 32) | objid::bigint)::text AS key
     FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  );
  return rows.map((r) => r.key as string);
}

/**
 * Several tests prove that a wrong password is rejected and that secrets do not leak from the resulting
 * error. On a server whose pg_hba.conf says `trust` for TCP (Homebrew's default) any password is accepted
 * and those tests would fail in a confusing way, so check the precondition and say what is wrong.
 */
export async function requirePasswordAuth(db: TestDatabase): Promise<void> {
  const o = db.options;
  const client = new Client({ host: String(o.host), port: Number(o.port), user: String(o.username), password: 'definitely-the-wrong-password', database: String(o.database) });
  let accepted = false;
  try {
    await client.connect();
    accepted = true;
    await client.end();
  } catch {
    /* rejected, as required */
  }
  if (accepted) {
    throw new Error('The test PostgreSQL accepts a wrong password (pg_hba.conf uses "trust" for TCP connections). These tests need password authentication; see CONTRIBUTING.md.');
  }
}
