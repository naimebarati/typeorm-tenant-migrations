import type { TenantMigrationLogger } from './types.js';

/** The library default: say nothing. SQL is never logged by this package in any mode. */
export const silentLogger: TenantMigrationLogger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * Writes to stderr (or the given stream) so that stdout stays reserved for the possibly-JSON
 * result of a CLI command.
 */
export function createConsoleLogger(options: { debug?: boolean; stream?: { write(text: string): unknown } } = {}): TenantMigrationLogger {
  const write = (level: string, message: string, meta?: Record<string, unknown>) => {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    (options.stream ?? process.stderr).write(`[typeorm-tenant-migrations] ${level} ${message}${suffix}\n`);
  };
  return {
    debug: options.debug ? (m, meta) => write('DEBUG', m, meta) : undefined,
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}
