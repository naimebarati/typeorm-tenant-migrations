import type { TenantMigrationLogger } from '../logger/types.js';
import type { PostgresOptions } from './create-tenant-data-source.js';
import { buildLockDataSourceOptions, destroyQuietly, initializeOwned } from './create-tenant-data-source.js';

/**
 * Connections this package can hold at once per tenant being migrated: the tenant's own connection, the
 * lock connection and, for a moment, the connection that proves the lock is exclusive. Measured peaks are
 * 3 at concurrency 1 and about 2.6 x concurrency at 16 (see the load test); 3 x concurrency + 1 is the bound.
 */
export const CONNECTIONS_PER_TENANT = 3;

export function connectionsNeeded(concurrency: number): number {
  return CONNECTIONS_PER_TENANT * concurrency + 1;
}

export interface ConnectionFacts {
  max: number;
  reserved: number;
  used: number;
}

/** The warning to show, or undefined when `concurrency` fits into the free connection slots. */
export function assessConnectionBudget(facts: ConnectionFacts, concurrency: number): string | undefined {
  const free = facts.max - facts.reserved - facts.used;
  const needed = connectionsNeeded(concurrency);
  if (needed <= free) return undefined;
  const fits = Math.max(Math.floor((free - 1) / CONNECTIONS_PER_TENANT), 1);
  return (
    `concurrency ${concurrency} can need up to ${needed} connections, but only ${Math.max(free, 0)} are free ` +
    `(max_connections ${facts.max}, ${facts.used} in use, ${facts.reserved} reserved). Tenants may fail with "too many clients" ` +
    `and your application may be starved of connections. Lower the concurrency (about ${fits} would fit now).`
  );
}

/**
 * A run with a high `concurrency` can use up every connection slot, and then the application itself
 * gets "too many clients". Failing tenants are reported cleanly and can simply be re-run, but it is
 * better to say so beforehand. Best effort: any error here is swallowed and never blocks the run.
 */
export async function warnIfConnectionBudgetIsTight(
  base: PostgresOptions,
  concurrency: number,
  logger: Pick<TenantMigrationLogger, 'warn'>,
  redact: (text: string) => string,
): Promise<void> {
  if (concurrency <= 1) return;
  const dataSource = await initializeOwned(buildLockDataSourceOptions(base), redact).catch(() => undefined);
  if (!dataSource) return;
  try {
    const rows = (await dataSource.query(
      `SELECT current_setting('max_connections')::int AS max,
              current_setting('superuser_reserved_connections')::int AS reserved,
              (SELECT count(*)::int FROM pg_stat_activity) AS used`,
    )) as Array<{ max: number; reserved: number; used: number }>;
    const row = rows[0];
    if (!row) return;
    const warning = assessConnectionBudget(row, concurrency);
    if (warning) logger.warn(warning);
  } catch {
    /* advisory only */
  } finally {
    await destroyQuietly(dataSource);
  }
}
