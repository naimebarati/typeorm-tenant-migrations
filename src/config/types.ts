import type { DataSource, DataSourceOptions } from 'typeorm';
import type { TenantMigrationLogger } from '../logger/types.js';

export interface TenantMigrationTarget {
  /** Logical tenant id; what `--tenant` and `{ tenants: [...] }` match against. */
  id: string;
  /** Existing PostgreSQL schema that holds this tenant's tables. Never auto-created. */
  schema: string;
}

export type TenantProvider =
  | readonly TenantMigrationTarget[]
  | (() => readonly TenantMigrationTarget[] | Promise<readonly TenantMigrationTarget[]>);

export type TenantSelection = { all: true } | { tenants: readonly string[] };

export type TransactionMode = 'all' | 'each' | 'none';
export type SearchPathMode = 'tenant-only' | 'tenant-first';

export interface TenantMigrationOptions {
  /** Tenants migrated in parallel. Default 1. */
  concurrency?: number;
  /** Upper bound accepted for `concurrency`. Default 8. */
  maxConcurrency?: number;
  /** TypeORM migration transaction mode. Default 'each'. */
  transaction?: TransactionMode;
  /** Keep scheduling new tenants after one fails. Default false. */
  continueOnError?: boolean;
  /** How long to wait for a tenant's advisory lock before giving up. Default 30_000. 0 = try once. */
  lockTimeoutMs?: number;
  /** History table name. Default: the base DataSource's `migrationsTableName`, else "migrations". */
  migrationsTableName?: string;
  /** Default 'tenant-only': `search_path` is exactly the tenant schema. */
  searchPathMode?: SearchPathMode;
  /** Only with 'tenant-first': schemas appended after the tenant schema, e.g. ['public']. */
  fallbackSchemas?: readonly string[];
  logger?: TenantMigrationLogger;
}

export interface ResolvedOptions {
  concurrency: number;
  maxConcurrency: number;
  transaction: TransactionMode;
  continueOnError: boolean;
  lockTimeoutMs: number;
  migrationsTableName: string | undefined;
  searchPathMode: SearchPathMode;
  fallbackSchemas: readonly string[];
}

export interface TenantMigrationRunnerConfig {
  /**
   * Source of connection settings and migrations. The runner reads `dataSource.options` and never
   * initializes, mutates or destroys the instance. Plain `DataSourceOptions` are accepted too.
   */
  dataSource: DataSource | DataSourceOptions;
  tenants: TenantProvider;
  options?: TenantMigrationOptions;
}
