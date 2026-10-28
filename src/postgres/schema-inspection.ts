import type { QueryRunner } from 'typeorm';
import { TenantMigrationError } from '../errors/index.js';
import { parseSearchPathSetting } from './search-path.js';

export async function schemaExists(queryRunner: QueryRunner, schema: string): Promise<boolean> {
  const rows = (await queryRunner.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])) as unknown[];
  return rows.length > 0;
}

export async function currentDatabase(queryRunner: QueryRunner): Promise<string> {
  const rows = (await queryRunner.query('SELECT current_database() AS db')) as Array<{ db: string }>;
  return rows[0]!.db;
}

/**
 * Proves, on a real connection, that unqualified names will resolve in the tenant schema: the
 * session's `search_path` is exactly what was requested and `current_schema()` is the tenant schema.
 * Anything else is SCHEMA_CONTEXT_MISMATCH and the caller must not run a migration.
 */
export async function assertSchemaContext(
  queryRunner: QueryRunner,
  schema: string,
  expectedSearchPath: readonly string[],
): Promise<void> {
  if (!(await schemaExists(queryRunner, schema))) {
    throw new TenantMigrationError('SCHEMA_NOT_FOUND', `Schema "${schema}" does not exist. Create it first; this package never creates schemas.`);
  }
  const rows = (await queryRunner.query(
    `SELECT current_setting('search_path') AS search_path, current_schema() AS current_schema`,
  )) as Array<{ search_path: string; current_schema: string | null }>;
  const row = rows[0];
  const actual = row ? parseSearchPathSetting(row.search_path) : [];
  const same = actual.length === expectedSearchPath.length && actual.every((s, i) => s === expectedSearchPath[i]);
  if (!row || !same || row.current_schema !== schema) {
    throw new TenantMigrationError(
      'SCHEMA_CONTEXT_MISMATCH',
      `Connection search_path is [${actual.join(', ')}] (current_schema=${row?.current_schema ?? 'none'}), expected [${expectedSearchPath.join(', ')}] for schema "${schema}". Refusing to run.`,
    );
  }
}
