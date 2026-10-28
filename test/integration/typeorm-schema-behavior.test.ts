/**
 * Phase 0 canary. These tests use plain TypeORM (none of this package's code) and pin down the
 * behavior the whole design rests on:
 *
 *   1. `schema` alone does NOT move raw, unqualified SQL: it runs against `public`.
 *   2. `schema` alone DOES put the history table and `queryRunner.createTable()` in the tenant schema.
 *   3. A connection startup parameter (`options=-c search_path=<schema>`) fixes (1) for every
 *      connection of the pool, without any per-connection `SET`.
 *
 * They run against every TypeORM version in the CI matrix; if TypeORM changes this behavior,
 * this file is where it shows up first.
 */
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { DataSource, Table } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDatabase } from '../helpers/pg.js';
import { columnsOf, createTestDatabase, tablesOf } from '../helpers/pg.js';

class RawSql1700000000001 implements MigrationInterface {
  name = 'RawSql1700000000001';
  async up(q: QueryRunner) {
    await q.query('ALTER TABLE "orders" ADD COLUMN "status" text');
  }
  async down() {}
}

class ApiCreateTable1700000000002 implements MigrationInterface {
  name = 'ApiCreateTable1700000000002';
  async up(q: QueryRunner) {
    await q.createTable(new Table({ name: 'things', columns: [{ name: 'id', type: 'int', isPrimary: true }] }));
  }
  async down() {}
}

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.client.query(`
    DROP SCHEMA IF EXISTS tenant_alpha CASCADE;
    DROP SCHEMA IF EXISTS tenant_beta CASCADE;
    DROP TABLE IF EXISTS public.orders, public.things, public.migrations CASCADE;
    CREATE SCHEMA tenant_alpha;
    CREATE SCHEMA tenant_beta;
    CREATE TABLE tenant_alpha.orders (id int);
    CREATE TABLE tenant_beta.orders (id int);
    CREATE TABLE public.orders (id int);
  `);
});

function dataSource(extra?: Record<string, unknown>) {
  return new DataSource({
    ...db.options,
    schema: 'tenant_alpha',
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    migrations: [RawSql1700000000001, ApiCreateTable1700000000002],
    extra,
  });
}

describe('TypeORM `schema` option without search_path (the problem)', () => {
  it('leaves search_path at the server default', async () => {
    const ds = dataSource();
    await ds.initialize();
    try {
      const rows = (await ds.query('SELECT current_schema() AS s')) as Array<{ s: string }>;
      expect(rows[0]?.s).toBe('public');
    } finally {
      await ds.destroy();
    }
  });

  it('applies unqualified raw SQL to public, while history and createTable use the tenant schema', async () => {
    const ds = dataSource();
    await ds.initialize();
    try {
      await ds.runMigrations({ transaction: 'each' });
    } finally {
      await ds.destroy();
    }
    // The wrong-schema write that this package exists to prevent:
    expect(await columnsOf(db.client, 'public', 'orders')).toContain('status');
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).not.toContain('status');
    // Parts that TypeORM does qualify itself:
    expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(expect.arrayContaining(['things', 'migrations']));
    expect(await tablesOf(db.client, 'public')).not.toContain('migrations');
  });
});

describe('connection startup parameter search_path (the fix)', () => {
  it('applies unqualified raw SQL and createTable to the tenant schema only', async () => {
    const ds = dataSource({ options: '-c search_path=tenant_alpha' });
    await ds.initialize();
    try {
      await ds.runMigrations({ transaction: 'each' });
    } finally {
      await ds.destroy();
    }
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toContain('status');
    expect(await columnsOf(db.client, 'tenant_beta', 'orders')).not.toContain('status');
    expect(await columnsOf(db.client, 'public', 'orders')).not.toContain('status');
    expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(expect.arrayContaining(['things', 'migrations']));
    expect(await tablesOf(db.client, 'tenant_beta')).toEqual(['orders']);
    expect(await tablesOf(db.client, 'public')).toEqual(['orders']);
  });

  it('holds on every connection of the pool, not just the first one', async () => {
    const ds = dataSource({ options: '-c search_path=tenant_alpha', max: 4 });
    await ds.initialize();
    try {
      const runners = await Promise.all([1, 2, 3, 4].map(async () => {
        const qr = ds.createQueryRunner();
        await qr.connect();
        return qr;
      }));
      try {
        const pids = new Set<number>();
        for (const qr of runners) {
          const [row] = (await qr.query('SELECT pg_backend_pid() AS pid, current_setting(\'search_path\') AS sp')) as Array<{ pid: number; sp: string }>;
          pids.add(row!.pid);
          expect(row!.sp).toBe('tenant_alpha');
        }
        expect(pids.size).toBe(4);
      } finally {
        await Promise.all(runners.map((qr) => qr.release()));
      }
    } finally {
      await ds.destroy();
    }
  });
});
