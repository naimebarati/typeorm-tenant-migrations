import type { QueryRunner } from 'typeorm';

export interface ExecutedMigration {
  id: number;
  timestamp: number;
  name: string;
}

/**
 * Reads TypeORM's history table without ever creating it. This deliberately avoids
 * `DataSource.showMigrations()`, which calls `createMigrationsTableIfNotExist` in the versions we
 * support, and TypeORM's internal MigrationExecutor.
 *
 * Both identifiers are interpolated as quoted names; `schema` has passed the tenant-name
 * allowlist and `table` the table-name allowlist before reaching here. Existence is checked with
 * bound parameters.
 *
 * Returns `undefined` when the table does not exist (nothing has ever run for this tenant).
 */
export async function readExecutedMigrations(
  queryRunner: QueryRunner,
  schema: string,
  table: string,
): Promise<ExecutedMigration[] | undefined> {
  const exists = (await queryRunner.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
    [schema, table],
  )) as unknown[];
  if (exists.length === 0) return undefined;

  const rows = (await queryRunner.query(
    `SELECT "id", "timestamp", "name" FROM "${schema}"."${table}" ORDER BY "id" ASC`,
  )) as Array<{ id: string | number; timestamp: string | number; name: string }>;
  return rows.map((r) => ({ id: Number(r.id), timestamp: Number(r.timestamp), name: r.name }));
}
