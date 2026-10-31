import type { QueryRunner } from 'typeorm';
import { validateTableName } from '../config/validate-config.js';
import { assertSafeIdentifier } from '../tenants/validate-target.js';

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

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
 * Both identifiers are interpolated as quoted names, so they are checked again here against the
 * same allowlists the configuration uses (the callers have already done it; this function is the
 * one place that builds SQL from them, so it does not rely on that) and any double quote is doubled.
 * Existence is checked with bound parameters.
 *
 * Returns `undefined` when the table does not exist (nothing has ever run for this tenant).
 */
export async function readExecutedMigrations(
  queryRunner: QueryRunner,
  schema: string,
  table: string,
): Promise<ExecutedMigration[] | undefined> {
  assertSafeIdentifier(schema);
  validateTableName('migrationsTableName', table);
  const exists = (await queryRunner.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
    [schema, table],
  )) as unknown[];
  if (exists.length === 0) return undefined;

  const rows = (await queryRunner.query(
    `SELECT "id", "timestamp", "name" FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ORDER BY "id" ASC`,
  )) as Array<{ id: string | number; timestamp: string | number; name: string }>;
  return rows.map((r) => ({ id: Number(r.id), timestamp: Number(r.timestamp), name: r.name }));
}
