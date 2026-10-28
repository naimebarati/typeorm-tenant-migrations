import type { SearchPathMode } from '../config/types.js';
import { TenantMigrationError } from '../errors/index.js';

export function buildSearchPath(schema: string, mode: SearchPathMode, fallbackSchemas: readonly string[]): string[] {
  // 'tenant-only' never carries a fallback, whatever the caller passed: the safe default can't be widened by accident.
  return mode === 'tenant-first' ? [schema, ...fallbackSchemas] : [schema];
}

/** Value of the `search_path` GUC as PostgreSQL reports it, parsed to a list of names. */
export function parseSearchPathSetting(setting: string): string[] {
  return setting
    .split(',')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .filter((part) => part.length > 0);
}

/**
 * Merges `-c search_path=...` into an existing libpq `options` startup string. A user-supplied
 * `search_path` is refused rather than merged: two sources of truth for it is exactly the kind of
 * ambiguity that sends SQL to the wrong schema.
 *
 * Every schema name has already passed the `^[a-z_][a-z0-9_]*$` check, so no quoting or escaping is needed.
 */
export function mergeStartupOptions(existing: unknown, searchPath: readonly string[], extraFlags: readonly string[] = []): string {
  if (existing !== undefined && typeof existing !== 'string') {
    throw new TenantMigrationError('INVALID_CONFIGURATION', 'The base DataSource "extra.options" must be a string.');
  }
  if (existing && /search_path/i.test(existing)) {
    throw new TenantMigrationError(
      'INVALID_CONFIGURATION',
      'The base DataSource sets search_path in "extra.options". Remove it: this package controls search_path per tenant (use searchPathMode/fallbackSchemas to widen it).',
    );
  }
  const ours = [`-c search_path=${searchPath.join(',')}`, ...extraFlags].join(' ');
  return existing && existing.trim() ? `${existing.trim()} ${ours}` : ours;
}

/** Connection strings can carry `options=` too, and node-postgres lets the URL win over `extra`. */
export function assertUrlHasNoStartupOptions(url: unknown, where: string): void {
  if (url === undefined || url === null) return;
  if (typeof url !== 'string') {
    throw new TenantMigrationError('INVALID_CONFIGURATION', `The base DataSource "${where}" must be a string.`);
  }
  let hasOptions = /[?&]options=/i.test(url) || /[?&]search_path=/i.test(url);
  try {
    const params = new URL(url).searchParams;
    hasOptions ||= params.has('options') || params.has('search_path');
  } catch {
    // Not a parseable URL: the regex above is the best we can do; the driver will reject it with its own error.
  }
  if (hasOptions) {
    throw new TenantMigrationError(
      'INVALID_CONFIGURATION',
      `The base DataSource "${where}" contains an "options" or "search_path" parameter, which would override the per-tenant search_path. Remove it from the URL.`,
    );
  }
}
