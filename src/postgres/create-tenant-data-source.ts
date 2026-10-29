import type { DataSource, DataSourceOptions, Logger } from 'typeorm';
import { DataSource as DataSourceClass } from 'typeorm';
import { TenantMigrationError } from '../errors/index.js';
import type { TenantMigrationLogger } from '../logger/types.js';
import { assertUrlHasNoStartupOptions, mergeStartupOptions } from './search-path.js';

export type PostgresOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

export const APPLICATION_NAME = 'typeorm-tenant-migrations';

/**
 * TypeORM prints migration progress and failure messages ("Migration X failed, error: ...") on
 * stdout regardless of `logging: false`. That would corrupt `--json` output and bypass this
 * package's redaction, so TypeORM's own logger is replaced with one that says nothing. Results
 * and sanitized errors are reported through the report and the configured logger instead.
 */
const silentTypeOrmLogger: Logger = {
  logQuery() {},
  logQueryError() {},
  logQuerySlow() {},
  logSchemaBuild() {},
  logMigration() {},
  log() {},
};

export function resolveBaseOptions(source: DataSource | DataSourceOptions): PostgresOptions {
  if (!source || typeof source !== 'object') {
    throw new TenantMigrationError('INVALID_CONFIGURATION', '"dataSource" must be a DataSource or DataSourceOptions.');
  }
  const options: DataSourceOptions =
    typeof (source as DataSource).initialize === 'function' ? (source as DataSource).options : (source as DataSourceOptions);
  if (!options || typeof options !== 'object') {
    throw new TenantMigrationError('INVALID_CONFIGURATION', '"dataSource" must be a DataSource or DataSourceOptions.');
  }
  if (options.type !== 'postgres') {
    throw new TenantMigrationError(
      'INVALID_CONFIGURATION',
      `Only the "postgres" driver is supported (got ${JSON.stringify(String(options.type))}).`,
    );
  }
  if (options.replication) {
    throw new TenantMigrationError(
      'INVALID_CONFIGURATION',
      'DataSource "replication" is not supported: migrations and locks must run against one primary.',
    );
  }
  return options;
}

/** Values that must never reach a report, a log line or CLI output. */
export function collectSecrets(base: PostgresOptions): string[] {
  const secrets: Array<string | undefined> = [];
  if (typeof base.password === 'string') secrets.push(base.password);
  if (typeof base.url === 'string') {
    secrets.push(base.url);
    try {
      const u = new URL(base.url);
      secrets.push(decodeURIComponent(u.password), u.password);
    } catch {
      /* not a URL; the full string is already covered */
    }
  }
  const extra = base.extra as Record<string, unknown> | undefined;
  for (const key of ['password', 'connectionString']) {
    const v = extra?.[key];
    if (typeof v === 'string') secrets.push(v);
  }
  return secrets.filter((s): s is string => !!s);
}

const DANGEROUS_FLAGS = ['synchronize', 'migrationsRun', 'dropSchema'] as const;

function checkStartupOptionSources(base: PostgresOptions): void {
  assertUrlHasNoStartupOptions(base.url, 'url');
  assertUrlHasNoStartupOptions((base.extra as Record<string, unknown> | undefined)?.connectionString, 'extra.connectionString');
}

export interface TenantDataSourceSpec {
  schema: string;
  /** Already validated, tenant schema first. */
  searchPath: readonly string[];
  migrationsTableName?: string;
  /**
   * Makes PostgreSQL itself refuse writes on every connection (`default_transaction_read_only`).
   * Used for plan/status so "read-only" does not depend on this package having no bugs.
   */
  readOnly?: boolean;
}

/**
 * Options for the DataSource that runs one tenant's migrations. Pure: the base options (including
 * the nested `extra`) are copied, never mutated.
 *
 * `search_path` is passed as a connection startup parameter so that *every* connection the pool
 * opens already has it. Running `SET search_path` once would only affect whichever pooled
 * connection happened to execute it.
 */
export function buildTenantDataSourceOptions(
  base: PostgresOptions,
  spec: TenantDataSourceSpec,
  logger?: Pick<TenantMigrationLogger, 'warn'>,
): PostgresOptions {
  checkStartupOptionSources(base);

  for (const flag of DANGEROUS_FLAGS) {
    if (base[flag]) {
      logger?.warn(`The base DataSource has "${flag}" enabled; it is forced off for tenant connections.`);
    }
  }
  if (base.installExtensions) {
    logger?.warn('The base DataSource has "installExtensions" enabled; it is forced off for tenant connections.');
  }

  const extra = { ...(base.extra as Record<string, unknown> | undefined) };
  extra.options = mergeStartupOptions(extra.options, spec.searchPath, spec.readOnly ? ['-c default_transaction_read_only=on'] : []);

  return {
    ...base,
    schema: spec.schema,
    ...(spec.migrationsTableName ? { migrationsTableName: spec.migrationsTableName } : {}),
    extra,
    applicationName: base.applicationName ?? APPLICATION_NAME,
    // Safety overrides: constructing/initializing this DataSource must not change the database.
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    installExtensions: false,
    // SQL, parameters and TypeORM's own migration messages are never printed by this package.
    logging: false,
    logger: silentTypeOrmLogger,
  };
}

/**
 * Options for the single-connection DataSource that only holds the advisory lock. It loads no
 * entities or migrations, and its pool is exactly one connection: when it is destroyed the session
 * ends and PostgreSQL releases the lock, whatever else went wrong.
 */
export function buildLockDataSourceOptions(base: PostgresOptions): PostgresOptions {
  checkStartupOptionSources(base);
  const extra = { ...(base.extra as Record<string, unknown> | undefined), max: 1 };
  return {
    ...base,
    schema: undefined,
    extra,
    applicationName: base.applicationName ?? APPLICATION_NAME,
    entities: [],
    migrations: [],
    subscribers: [],
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    installExtensions: false,
    logging: false,
    logger: silentTypeOrmLogger,
    cache: false,
  };
}

/**
 * Migration files are imported by TypeORM through Node itself, not through this tool or tsx. The
 * errors this produces (TypeScript Node cannot strip, CommonJS vs ES module mix-ups) are easy to
 * mistake for connection problems, so say what to do.
 */
const MODULE_LOADING_ERROR =
  /TypeScript|strip-only|ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension|\.ts\b|Cannot use import statement|require is not defined|module is not defined|exports is not defined|ERR_REQUIRE_ESM/i;
function moduleLoadingHint(message: string): string {
  return MODULE_LOADING_ERROR.test(message)
    ? ' (Hint: this looks like a migration file Node could not load. Point "migrations" at compiled JavaScript, or use TypeScript Node can strip, and keep CommonJS and ES modules consistent.)'
    : '';
}

export async function initializeOwned(options: DataSourceOptions, redact: (text: string) => string = (t) => t): Promise<DataSource> {
  const dataSource = new DataSourceClass(options);
  try {
    await dataSource.initialize();
  } catch (cause) {
    // A partially initialized DataSource may still hold a pool.
    if (dataSource.isInitialized) await dataSource.destroy().catch(() => undefined);
    const detail = cause instanceof Error && cause.message ? `: ${redact(cause.message).slice(0, 500)}${moduleLoadingHint(cause.message)}` : '';
    throw new TenantMigrationError('DATASOURCE_INITIALIZATION_FAILED', `Could not initialize the DataSource (connection or migration loading failed)${detail}`, { cause });
  }
  return dataSource;
}

export async function destroyQuietly(dataSource: DataSource | undefined): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy().catch(() => undefined);
}
