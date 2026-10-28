import { TenantMigrationError } from '../errors/index.js';
import type { TenantMigrationTarget } from '../config/types.js';

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** PostgreSQL silently truncates identifiers longer than NAMEDATALEN-1; refuse instead of guessing. */
const MAX_IDENTIFIER_LENGTH = 63;

function show(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}

export function isReservedSchema(schema: string): boolean {
  return schema === 'public' || schema === 'information_schema' || schema.startsWith('pg_');
}

export function assertSafeIdentifier(
  value: unknown,
  opts: { allowReserved?: boolean; what?: string } = {},
): asserts value is string {
  const what = opts.what ?? 'schema';
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !SAFE_IDENTIFIER.test(value)
  ) {
    throw new TenantMigrationError(
      'UNSAFE_SCHEMA_NAME',
      `Unsafe ${what} name ${show(value)}: only /^[a-z_][a-z0-9_]*$/ up to ${MAX_IDENTIFIER_LENGTH} characters is accepted.`,
    );
  }
  if (!opts.allowReserved && isReservedSchema(value)) {
    throw new TenantMigrationError(
      'UNSAFE_SCHEMA_NAME',
      `The ${what} ${show(value)} is reserved ("public", "information_schema" and "pg_*" can never be a tenant schema).`,
    );
  }
}

export function validateTarget(target: unknown): TenantMigrationTarget {
  if (typeof target !== 'object' || target === null) {
    throw new TenantMigrationError('INVALID_TENANT_TARGET', 'Each tenant must be an object { id, schema }.');
  }
  const { id, schema } = target as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0 || id.length > 200 || id !== id.trim() || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new TenantMigrationError(
      'INVALID_TENANT_TARGET',
      `Invalid tenant id ${show(id)}: expected a non-empty string without surrounding whitespace or control characters.`,
    );
  }
  assertSafeIdentifier(schema);
  return Object.freeze({ id, schema });
}

/** Validates the whole registry up front, so a bad entry anywhere stops the run before any database work. */
export function validateTargets(targets: unknown): readonly TenantMigrationTarget[] {
  if (!Array.isArray(targets)) {
    throw new TenantMigrationError('INVALID_TENANT_TARGET', 'The tenant provider must return an array of { id, schema }.');
  }
  const validated = targets.map(validateTarget);
  const ids = new Set<string>();
  const schemas = new Set<string>();
  for (const t of validated) {
    if (ids.has(t.id)) throw new TenantMigrationError('INVALID_TENANT_TARGET', `Duplicate tenant id ${show(t.id)}.`);
    if (schemas.has(t.schema)) {
      throw new TenantMigrationError('INVALID_TENANT_TARGET', `Duplicate schema ${show(t.schema)} (tenant ${show(t.id)}). Two tenants must never share a schema.`);
    }
    ids.add(t.id);
    schemas.add(t.schema);
  }
  return Object.freeze(validated);
}
