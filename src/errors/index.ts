export const ERROR_CODES = [
  'INVALID_CONFIGURATION',
  'INVALID_TENANT_TARGET',
  'UNSAFE_SCHEMA_NAME',
  'SCHEMA_NOT_FOUND',
  'SCHEMA_CONTEXT_MISMATCH',
  'CONCURRENT_MIGRATION',
  'UNSUPPORTED_CONNECTION_MODE',
  'MIGRATION_FAILED',
  'DATASOURCE_INITIALIZATION_FAILED',
  'MIGRATION_DISCOVERY_FAILED',
] as const;

export type TenantMigrationErrorCode = (typeof ERROR_CODES)[number];

/**
 * Every failure this package raises on purpose. `message` is written to be safe to print; the
 * original error (which may contain driver details) is kept on `cause` and is never part of `message`.
 */
export class TenantMigrationError extends Error {
  readonly code: TenantMigrationErrorCode;

  constructor(code: TenantMigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TenantMigrationError';
    this.code = code;
  }
}

export function isTenantMigrationError(error: unknown): error is TenantMigrationError {
  return error instanceof TenantMigrationError;
}
