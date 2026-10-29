import { createHash } from 'node:crypto';
import type { QueryRunner } from 'typeorm';
import { TenantMigrationError } from '../errors/index.js';
import type { TenantMigrationLogger } from '../logger/types.js';
import type { PostgresOptions } from './create-tenant-data-source.js';
import { buildLockDataSourceOptions, destroyQuietly, initializeOwned } from './create-tenant-data-source.js';
import { currentDatabase } from './schema-inspection.js';

const LOCK_NAMESPACE = 'typeorm-tenant-migrations';

/**
 * Stable 64-bit key for one schema of one database. Advisory locks are scoped to a database already,
 * but the name is part of the hash so the key is self-describing and survives restoring a dump
 * under another name only if the caller wants it to (it won't, which is the safe direction).
 *
 * The derivation is a compatibility contract between runner versions: two deploys running
 * different versions must still compute the same key for the same tenant, or they would not
 * exclude each other. Changing it requires a major version.
 *
 * The ":" separator is unambiguous because schema names are restricted to /^[a-z_][a-z0-9_]*$/.
 */
export function computeLockKey(database: string, schema: string): bigint {
  const digest = createHash('sha256').update(`${LOCK_NAMESPACE}:${database}:${schema}`).digest();
  return digest.readBigInt64BE(0);
}

export interface AdvisoryLock {
  /** The decimal bigint key held in pg_locks. */
  readonly key: string;
  /** Idempotent. Also ends the lock session, so the lock is gone even if the unlock call itself fails. */
  release(): Promise<void>;
}

export interface AcquireOptions {
  schema: string;
  timeoutMs: number;
  logger?: Pick<TenantMigrationLogger, 'warn'>;
  redact?: (text: string) => string;
  /** Stops waiting for the lock (not a lock already held) when aborted. */
  signal?: AbortSignal;
}

/**
 * A session lock only excludes others if the connection that took it stays the same session. Behind
 * a pooler in transaction mode it doesn't: the server session is handed to other clients, and
 * advisory locks are re-entrant within a session, so a second client "acquires" the same lock.
 *
 * Prove exclusivity instead of assuming it: from a *second* connection, trying the same key must
 * fail while the first connection holds it. Any success means the lock is not exclusive on this
 * connection path and the run must not proceed.
 */
async function assertLockIsExclusive(base: PostgresOptions, key: string, schema: string, redact?: (text: string) => string): Promise<void> {
  const probe = await initializeOwned(buildLockDataSourceOptions(base), redact);
  try {
    const runner = probe.createQueryRunner();
    try {
      const rows = (await runner.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key])) as Array<{ locked: boolean }>;
      if (rows[0]?.locked === true) {
        await runner.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
        throw new TenantMigrationError(
          'UNSUPPORTED_CONNECTION_MODE',
          `The advisory lock for schema "${schema}" is not exclusive on this connection path (a connection pooler in transaction mode?). Connect directly or use session pooling. Refusing to run.`,
        );
      }
    } finally {
      await runner.release().catch(() => undefined);
    }
  } finally {
    await destroyQuietly(probe);
  }
}

const INITIAL_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Takes a session-level advisory lock on a dedicated one-connection DataSource.
 *
 * Why a dedicated DataSource per acquisition: the lock lives as long as that session. With its own
 * pool of exactly one connection, nothing else can borrow the connection while it holds the lock,
 * the migration pool can't deadlock against it, and destroying the DataSource ends the session,
 * which makes PostgreSQL drop the lock no matter how the unlock call went.
 *
 * It polls `pg_try_advisory_lock` with capped backoff instead of blocking in `pg_advisory_lock`, so
 * the wait has a hard deadline and a stuck holder can never hang a deploy.
 */
export async function acquireAdvisoryLock(base: PostgresOptions, opts: AcquireOptions): Promise<AdvisoryLock> {
  const dataSource = await initializeOwned(buildLockDataSourceOptions(base), opts.redact);
  let queryRunner: QueryRunner | undefined;
  let key: string | undefined;
  let held = false;

  const cleanup = async () => {
    if (queryRunner && !queryRunner.isReleased) await queryRunner.release().catch(() => undefined);
    await destroyQuietly(dataSource);
  };

  try {
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();

    key = computeLockKey(await currentDatabase(queryRunner), opts.schema).toString();
    const deadline = Date.now() + opts.timeoutMs;
    let backoff = INITIAL_BACKOFF_MS;

    for (;;) {
      const rows = (await queryRunner.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key])) as Array<{ locked: boolean }>;
      if (rows[0]?.locked === true) {
        held = true;
        break;
      }

      if (opts.signal?.aborted) {
        throw new TenantMigrationError('CONCURRENT_MIGRATION', `Interrupted while waiting for the lock for schema "${opts.schema}".`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new TenantMigrationError(
          'CONCURRENT_MIGRATION',
          `Another migration holds the lock for schema "${opts.schema}"; gave up after ${opts.timeoutMs} ms.`,
        );
      }
      await sleep(Math.min(backoff, remaining));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }

    await assertLockIsExclusive(base, key, opts.schema, opts.redact);

    const runner = queryRunner;
    let released = false;
    return {
      key,
      async release() {
        if (released) return;
        released = true;
        try {
          const rows = (await runner.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [key])) as Array<{ unlocked: boolean }>;
          if (rows[0]?.unlocked !== true) {
            opts.logger?.warn(`Advisory lock for schema "${opts.schema}" was not held at unlock time.`);
          }
        } catch {
          // Connection already gone: the server released the lock with the session.
        } finally {
          await cleanup();
        }
      },
    };
  } catch (error) {
    // Ending our connection normally ends the session and drops the lock. Behind a pooler it may not
    // (the server session is kept and reused), so give the lock back explicitly before leaving.
    if (held && key && queryRunner && !queryRunner.isReleased) {
      await queryRunner.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
    }
    await cleanup();
    throw error;
  }
}
