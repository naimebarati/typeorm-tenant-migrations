import type { DataSource } from 'typeorm';
import { TenantMigrationError } from '../errors/index.js';
import type { ExecutedMigration } from './migration-history.js';

export interface LoadedMigration {
  name: string;
  timestamp: number;
}

/**
 * The migrations TypeORM would consider, with the same naming and ordering rules it applies in
 * `MigrationExecutor.getMigrations()` (name = `migration.name || constructor.name`; timestamp = the
 * last 13 characters of the name; ascending by timestamp, ties keep declaration order).
 *
 * Reimplemented here on top of the public `dataSource.migrations` because the executor is not
 * public API. The integration tests assert that this plan equals what `runMigrations()` really
 * executes, which is what keeps the two from drifting apart across TypeORM versions.
 */
export function discoverMigrations(dataSource: DataSource): LoadedMigration[] {
  const instances = dataSource.migrations ?? [];
  if (instances.length === 0) {
    throw new TenantMigrationError(
      'MIGRATION_DISCOVERY_FAILED',
      'The DataSource has no migrations loaded. Check the "migrations" option (class list or glob; globs resolve against the current working directory).',
    );
  }

  const loaded = instances.map((instance) => {
    const name = (instance as { name?: string }).name || instance.constructor.name;
    const timestamp = parseInt(name.slice(-13), 10);
    if (!timestamp || Number.isNaN(timestamp)) {
      throw new TenantMigrationError(
        'MIGRATION_DISCOVERY_FAILED',
        `Migration "${name}" has an invalid name: the class name must end with a 13-digit JavaScript timestamp.`,
      );
    }
    return { name, timestamp };
  });

  const seen = new Set<string>();
  for (const { name } of loaded) {
    if (seen.has(name)) {
      throw new TenantMigrationError('MIGRATION_DISCOVERY_FAILED', `Duplicate migration name "${name}".`);
    }
    seen.add(name);
  }

  return loaded.sort((a, b) => a.timestamp - b.timestamp);
}

/** TypeORM runs every known migration whose name is not in the history table, regardless of timestamp. */
export function computePending(all: readonly LoadedMigration[], executed: readonly ExecutedMigration[] | undefined): string[] {
  const done = new Set((executed ?? []).map((m) => m.name));
  return all.filter((m) => !done.has(m.name)).map((m) => m.name);
}

/** Names recorded in the history table that this build of the app doesn't know (e.g. a rollback to an older release). */
export function computeUnknownExecuted(all: readonly LoadedMigration[], executed: readonly ExecutedMigration[] | undefined): string[] {
  const known = new Set(all.map((m) => m.name));
  return (executed ?? []).filter((m) => !known.has(m.name)).map((m) => m.name);
}
