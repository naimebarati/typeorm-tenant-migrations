import type { DataSource, QueryRunner } from 'typeorm';
import type { ResolvedOptions, TenantMigrationTarget } from '../config/types.js';
import { TenantMigrationError, type TenantMigrationErrorCode } from '../errors/index.js';
import { errorMessageOf } from '../errors/sanitize.js';
import type { TenantMigrationLogger } from '../logger/types.js';
import type { ExecutedMigration } from '../migrations/migration-history.js';
import { readExecutedMigrations } from '../migrations/migration-history.js';
import { computePending, computeUnknownExecuted, discoverMigrations } from '../migrations/migration-plan.js';
import { acquireAdvisoryLock, type AdvisoryLock } from '../postgres/advisory-lock.js';
import type { PostgresOptions } from '../postgres/create-tenant-data-source.js';
import { buildTenantDataSourceOptions, destroyQuietly, initializeOwned } from '../postgres/create-tenant-data-source.js';
import { assertSchemaContext } from '../postgres/schema-inspection.js';
import { buildSearchPath } from '../postgres/search-path.js';
import type { TenantMigrationResult } from './report.js';

export interface RunnerContext {
  base: PostgresOptions;
  options: ResolvedOptions;
  logger: TenantMigrationLogger;
  redact: (text: string) => string;
  /** Resolved and validated history table name. */
  historyTable: string;
}

export interface TenantInspection {
  tenantId: string;
  schema: string;
  status: 'ok' | 'failed';
  /** Every migration known to the app, in execution order. */
  known: string[];
  executed: string[];
  pending: string[];
  /** In the history table but not in this build of the app. */
  unknownExecuted: string[];
  historyTableExists: boolean;
  error?: { code: string; message: string };
}

const MAX_MESSAGE_LENGTH = 2000;

function describeError(ctx: RunnerContext, error: unknown, fallback: TenantMigrationErrorCode): { code: string; message: string } {
  const code = error instanceof TenantMigrationError ? error.code : fallback;
  return { code, message: ctx.redact(errorMessageOf(error)).slice(0, MAX_MESSAGE_LENGTH) };
}

function searchPathFor(ctx: RunnerContext, schema: string): string[] {
  return buildSearchPath(schema, ctx.options.searchPathMode, ctx.options.fallbackSchemas);
}

function tenantOptions(ctx: RunnerContext, schema: string, readOnly: boolean) {
  return buildTenantDataSourceOptions(ctx.base, {
    schema,
    searchPath: searchPathFor(ctx, schema),
    migrationsTableName: ctx.historyTable,
    readOnly,
  });
}

/**
 * Short-lived QueryRunner: the connection goes back to the pool before the caller does anything
 * else, so a pool of size 1 can't deadlock against runMigrations() and a connection that died is
 * never reused for the next read.
 */
async function withQueryRunner<T>(dataSource: DataSource, fn: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    return await fn(queryRunner);
  } finally {
    if (!queryRunner.isReleased) await queryRunner.release().catch(() => undefined);
  }
}

/**
 * Read-only look at one tenant. The DataSource is created with `default_transaction_read_only=on`,
 * so PostgreSQL itself rejects any write; a missing history table is reported as "nothing executed"
 * and is never created.
 */
export async function inspectTenant(ctx: RunnerContext, target: TenantMigrationTarget): Promise<TenantInspection> {
  const base = { tenantId: target.id, schema: target.schema };
  let dataSource: DataSource | undefined;
  try {
    dataSource = await initializeOwned(tenantOptions(ctx, target.schema, true), ctx.redact);
    const ds = dataSource;
    const executed = await withQueryRunner(ds, async (queryRunner) => {
      await assertSchemaContext(queryRunner, target.schema, searchPathFor(ctx, target.schema), { readOnly: true });
      return readExecutedMigrations(queryRunner, target.schema, ctx.historyTable);
    });
    const known = discoverMigrations(ds);
    return {
      ...base,
      status: 'ok',
      known: known.map((m) => m.name),
      executed: (executed ?? []).map((m) => m.name),
      pending: computePending(known, executed),
      unknownExecuted: computeUnknownExecuted(known, executed),
      historyTableExists: executed !== undefined,
    };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      known: [],
      executed: [],
      pending: [],
      unknownExecuted: [],
      historyTableExists: false,
      error: describeError(ctx, error, 'MIGRATION_DISCOVERY_FAILED'),
    };
  } finally {
    await destroyQuietly(dataSource);
  }
}

function namesAdded(before: readonly ExecutedMigration[] | undefined, after: readonly ExecutedMigration[] | undefined): string[] {
  const had = new Set((before ?? []).map((m) => m.name));
  return (after ?? []).filter((m) => !had.has(m.name)).map((m) => m.name);
}

/**
 * Migrates one tenant. Never throws: every outcome is a result, so one tenant can't take the
 * batch down and the batch can still report on it.
 *
 * Order matters: verify the connection context, take the lock, then read history *under the
 * lock* (that's the authoritative pending list), run, read history again. Cleanup runs in
 * `finally` in the opposite order, ending with the lock session.
 */
export async function executeTenant(ctx: RunnerContext, target: TenantMigrationTarget, signal?: AbortSignal): Promise<TenantMigrationResult> {
  const startedAtMs = Date.now();
  const result: TenantMigrationResult = {
    tenantId: target.id,
    schema: target.schema,
    status: 'failed',
    pendingBeforeRun: [],
    executed: [],
    executedKnown: true,
    startedAt: new Date(startedAtMs).toISOString(),
  };

  let dataSource: DataSource | undefined;
  let lock: AdvisoryLock | undefined;
  let before: ExecutedMigration[] | undefined;
  let migrationStarted = false;
  let neverStarted = false;

  if (signal?.aborted) {
    return { ...result, status: 'not-started', startedAt: undefined };
  }

  try {
    dataSource = await initializeOwned(tenantOptions(ctx, target.schema, false), ctx.redact);
    const ds = dataSource;
    await withQueryRunner(ds, (queryRunner) => assertSchemaContext(queryRunner, target.schema, searchPathFor(ctx, target.schema)));

    lock = await acquireAdvisoryLock(ctx.base, {
      schema: target.schema,
      timeoutMs: ctx.options.lockTimeoutMs,
      logger: ctx.logger,
      redact: ctx.redact,
      signal,
    });

    const known = discoverMigrations(ds);
    before = await withQueryRunner(ds, (queryRunner) => readExecutedMigrations(queryRunner, target.schema, ctx.historyTable));
    result.pendingBeforeRun = computePending(known, before);

    if (result.pendingBeforeRun.length === 0) {
      result.status = 'skipped';
      return result;
    }

    migrationStarted = true;
    ctx.logger.info(`Running ${result.pendingBeforeRun.length} migration(s) on tenant "${target.id}" (schema "${target.schema}").`);
    const returned = await ds.runMigrations({ transaction: ctx.options.transaction });

    const after = await withQueryRunner(ds, (queryRunner) => readExecutedMigrations(queryRunner, target.schema, ctx.historyTable)).catch(() => undefined);
    // The history table is the source of truth; TypeORM's return value is the fallback if it can't be re-read.
    result.executed = after ? namesAdded(before, after) : returned.map((m) => m.name);
    result.status = 'success';
    return result;
  } catch (error) {
    const fallback: TenantMigrationErrorCode = migrationStarted ? 'MIGRATION_FAILED' : 'DATASOURCE_INITIALIZATION_FAILED';
    result.error = describeError(ctx, error, fallback);
    result.status = result.error.code === 'CONCURRENT_MIGRATION' ? 'locked' : 'failed';

    if (signal?.aborted && !migrationStarted && result.error.code === 'CONCURRENT_MIGRATION') {
      // Interrupted while still waiting for the lock: this tenant was never touched.
      neverStarted = true;
      result.status = 'not-started';
      result.error = undefined;
      return result;
    }

    if (migrationStarted) {
      // What did commit before the failure? Only the history table can say; if we can't read it, say so.
      try {
        const after = await withQueryRunner(dataSource!, (queryRunner) => readExecutedMigrations(queryRunner, target.schema, ctx.historyTable));
        result.executed = namesAdded(before, after);
      } catch {
        result.executed = [];
        result.executedKnown = false;
      }
    }
    ctx.logger.error(`Tenant "${target.id}" ${result.status}: ${result.error.message}`);
    return result;
  } finally {
    await destroyQuietly(dataSource);
    await lock?.release();
    if (neverStarted) {
      result.startedAt = undefined;
    } else {
      const finishedAtMs = Date.now();
      result.finishedAt = new Date(finishedAtMs).toISOString();
      result.durationMs = finishedAtMs - startedAtMs;
    }
  }
}
