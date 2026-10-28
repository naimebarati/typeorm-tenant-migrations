import { TenantMigrationError } from '../errors/index.js';
import { silentLogger } from '../logger/console-logger.js';
import type { TenantMigrationLogger } from '../logger/types.js';
import { assertSafeIdentifier } from '../tenants/validate-target.js';
import type { ResolvedOptions, TenantMigrationOptions } from './types.js';

export const DEFAULT_OPTIONS = {
  concurrency: 1,
  maxConcurrency: 8,
  transaction: 'each',
  continueOnError: false,
  lockTimeoutMs: 30_000,
  searchPathMode: 'tenant-only',
} as const;

const KNOWN_KEYS = new Set([
  'concurrency',
  'maxConcurrency',
  'transaction',
  'continueOnError',
  'lockTimeoutMs',
  'migrationsTableName',
  'searchPathMode',
  'fallbackSchemas',
  'logger',
]);

const MAX_LOCK_TIMEOUT_MS = 3_600_000;
const MAX_ALLOWED_CONCURRENCY = 64;

function invalid(message: string): never {
  throw new TenantMigrationError('INVALID_CONFIGURATION', message);
}

function positiveInt(name: string, value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    invalid(`"${name}" must be an integer between 1 and ${max}.`);
  }
  return value;
}

export function validateOptions(input: TenantMigrationOptions | undefined): {
  options: ResolvedOptions;
  logger: TenantMigrationLogger;
} {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) invalid('"options" must be an object.');

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) invalid(`Unknown option "${key}".`);
  }

  const maxConcurrency =
    raw.maxConcurrency === undefined
      ? DEFAULT_OPTIONS.maxConcurrency
      : positiveInt('maxConcurrency', raw.maxConcurrency, MAX_ALLOWED_CONCURRENCY);
  const concurrency =
    raw.concurrency === undefined
      ? DEFAULT_OPTIONS.concurrency
      : positiveInt('concurrency', raw.concurrency, MAX_ALLOWED_CONCURRENCY);
  if (concurrency > maxConcurrency) {
    invalid(`"concurrency" (${concurrency}) exceeds "maxConcurrency" (${maxConcurrency}). Raise maxConcurrency explicitly if this is intended.`);
  }

  const transaction = raw.transaction ?? DEFAULT_OPTIONS.transaction;
  if (transaction !== 'all' && transaction !== 'each' && transaction !== 'none') {
    invalid(`"transaction" must be 'all', 'each' or 'none'.`);
  }

  const continueOnError = raw.continueOnError ?? DEFAULT_OPTIONS.continueOnError;
  if (typeof continueOnError !== 'boolean') invalid('"continueOnError" must be a boolean.');

  const lockTimeoutMs = raw.lockTimeoutMs ?? DEFAULT_OPTIONS.lockTimeoutMs;
  if (
    typeof lockTimeoutMs !== 'number' ||
    !Number.isInteger(lockTimeoutMs) ||
    lockTimeoutMs < 0 ||
    lockTimeoutMs > MAX_LOCK_TIMEOUT_MS
  ) {
    invalid(`"lockTimeoutMs" must be an integer between 0 and ${MAX_LOCK_TIMEOUT_MS}.`);
  }

  let migrationsTableName: string | undefined;
  if (raw.migrationsTableName !== undefined) {
    migrationsTableName = validateTableName('migrationsTableName', raw.migrationsTableName);
  }

  const searchPathMode = raw.searchPathMode ?? DEFAULT_OPTIONS.searchPathMode;
  if (searchPathMode !== 'tenant-only' && searchPathMode !== 'tenant-first') {
    invalid(`"searchPathMode" must be 'tenant-only' or 'tenant-first'.`);
  }

  let fallbackSchemas: string[] = [];
  if (raw.fallbackSchemas !== undefined) {
    if (!Array.isArray(raw.fallbackSchemas) || raw.fallbackSchemas.some((s) => typeof s !== 'string')) {
      invalid('"fallbackSchemas" must be an array of schema names.');
    }
    fallbackSchemas = raw.fallbackSchemas as string[];
    if (fallbackSchemas.length > 0 && searchPathMode === 'tenant-only') {
      invalid(`"fallbackSchemas" requires searchPathMode: 'tenant-first'. The default 'tenant-only' never falls back to another schema.`);
    }
    for (const schema of fallbackSchemas) {
      assertSafeIdentifier(schema, { allowReserved: true, what: 'fallback schema' });
    }
    if (new Set(fallbackSchemas).size !== fallbackSchemas.length) invalid('"fallbackSchemas" contains duplicates.');
  }
  if (searchPathMode === 'tenant-first' && fallbackSchemas.length === 0) {
    invalid(`searchPathMode 'tenant-first' needs a non-empty "fallbackSchemas" list.`);
  }

  let logger: TenantMigrationLogger = silentLogger;
  if (raw.logger !== undefined) {
    const candidate = raw.logger as Partial<TenantMigrationLogger> | null;
    if (!candidate || typeof candidate.info !== 'function' || typeof candidate.warn !== 'function' || typeof candidate.error !== 'function') {
      invalid('"logger" must implement info(), warn() and error().');
    }
    logger = candidate as TenantMigrationLogger;
  }

  return {
    options: {
      concurrency,
      maxConcurrency,
      transaction,
      continueOnError,
      lockTimeoutMs,
      migrationsTableName,
      searchPathMode,
      fallbackSchemas: Object.freeze([...fallbackSchemas]),
    },
    logger,
  };
}

/** History table names are interpolated into read-only SQL as quoted identifiers, so keep them plain. */
export function validateTableName(name: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    invalid(`"${name}" must match /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.`);
  }
  return value;
}
