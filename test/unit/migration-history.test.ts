import type { QueryRunner } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { readExecutedMigrations } from '../../src/migrations/migration-history.js';

/** A QueryRunner that records every statement; the point is what reaches (or never reaches) the database. */
function recorder(rows: unknown[] = [{ one: 1 }]) {
  const statements: string[] = [];
  const queryRunner = {
    query: async (sql: string) => {
      statements.push(sql);
      return rows;
    },
  } as unknown as QueryRunner;
  return { queryRunner, statements };
}

describe('readExecutedMigrations builds SQL only from checked identifiers', () => {
  it.each([
    ['a quote in the schema', 'tenant"; DROP TABLE x; --', 'migrations'],
    ['an uppercase schema', 'Tenant', 'migrations'],
    ['a reserved schema', 'public', 'migrations'],
    ['a quote in the table', 'tenant_a', 'm"; DROP TABLE x; --'],
    ['a dot in the table', 'tenant_a', 'other.migrations'],
    ['an empty table', 'tenant_a', ''],
  ])('refuses %s before any statement reaches the database', async (_label, schema, table) => {
    const { queryRunner, statements } = recorder();
    await expect(readExecutedMigrations(queryRunner, schema, table)).rejects.toThrow(/Unsafe|reserved|must match/);
    expect(statements).toEqual([]);
  });

  it('quotes the identifiers it accepts', async () => {
    const { queryRunner, statements } = recorder([{ id: '1', timestamp: '1700000000001', name: 'A1700000000001' }]);
    const executed = await readExecutedMigrations(queryRunner, 'tenant_a', 'Migrations_1');
    expect(statements[1]).toContain('FROM "tenant_a"."Migrations_1"');
    expect(executed).toEqual([{ id: 1, timestamp: 1700000000001, name: 'A1700000000001' }]);
  });

  it('says "nothing ran" (undefined) when the history table does not exist, without querying it', async () => {
    const { queryRunner, statements } = recorder([]);
    expect(await readExecutedMigrations(queryRunner, 'tenant_a', 'migrations')).toBeUndefined();
    expect(statements).toHaveLength(1);
  });
});
