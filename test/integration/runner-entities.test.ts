/**
 * The DataSource options passed to the runner may carry real entities (the app's own config often
 * does). Entity metadata must not make the runner create, sync or install anything on its own.
 */
import { EntitySchema } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineMigration } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { createTestDatabase, snapshotDatabase, tablesOf } from '../helpers/pg.js';
import { ALL, ALPHA, BETA, makeRunner } from '../helpers/runner.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await seedTenants(db);
  await db.client.query('DROP TABLE IF EXISTS public.orders'); // these tests create "orders" themselves
  for (const schema of ['tenant_alpha', 'tenant_beta']) await db.client.query(`DROP TABLE ${schema}.orders`);
});

const Order = new EntitySchema({
  name: 'Order',
  tableName: 'orders',
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    ref: { type: 'uuid', generated: 'uuid', nullable: true },
    total: { type: 'numeric', nullable: true },
    double: { type: 'numeric', generatedType: 'STORED', asExpression: 'total * 2', nullable: true },
  },
});
const OrderTotals = new EntitySchema({
  name: 'OrderTotals',
  tableName: 'order_totals',
  type: 'view',
  expression: 'SELECT id, total FROM orders',
  columns: { id: { type: Number }, total: { type: 'numeric' } },
});
// A table that exists only as an entity: `synchronize` would create it, no migration does.
const EntityOnly = new EntitySchema({ name: 'EntityOnly', tableName: 'entity_only', columns: { id: { type: Number, primary: true } } });

const CreateOrders = defineMigration('CreateOrders1700000000130', async (q: QueryRunner) => {
  await q.query('CREATE TABLE "orders" (id serial PRIMARY KEY, ref uuid, total numeric, double numeric GENERATED ALWAYS AS (total * 2) STORED)');
  await q.query('CREATE VIEW "order_totals" AS SELECT id, total FROM orders');
});

const withEntities = (extra: Record<string, unknown> = {}) => ({ entities: [Order, OrderTotals, EntityOnly], ...extra });
const relations = async (schema: string) =>
  (await db.client.query(`SELECT table_name || ':' || table_type AS r FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [schema])).rows.map((r) => r.r as string);

describe('a DataSource config that has entities (views, generated columns, uuid generation)', () => {
  it('plan and status are still read-only', async () => {
    const before = await snapshotDatabase(db.client);
    const runner = makeRunner({ db, migrations: [CreateOrders], tenants: [ALPHA, BETA], base: withEntities() });
    expect((await runner.plan({ target: ALL })).summary).toMatchObject({ ok: 2, failed: 0, pendingTotal: 2 });
    expect((await runner.status({ target: ALL })).summary.failed).toBe(0);
    expect(await snapshotDatabase(db.client)).toEqual(before);
  });

  it('run migrates each tenant; TypeORM keeps its own bookkeeping table (typeorm_metadata) in the TENANT schema, never in public', async () => {
    const report = await makeRunner({ db, migrations: [CreateOrders], tenants: [ALPHA, BETA], base: withEntities() }).run({ target: ALL });
    expect(report.summary).toMatchObject({ success: 2, failed: 0 });

    for (const schema of ['tenant_alpha', 'tenant_beta']) {
      expect(await relations(schema)).toEqual(['audit:BASE TABLE', 'migrations:BASE TABLE', 'order_totals:VIEW', 'orders:BASE TABLE', 'typeorm_metadata:BASE TABLE']);
    }
    expect(await relations('public')).toEqual([]);
  });

  it('a second run is a no-op', async () => {
    const runner = makeRunner({ db, migrations: [CreateOrders], tenants: [ALPHA], base: withEntities() });
    await runner.run({ target: ALL });
    expect((await runner.run({ target: ALL })).tenants[0]!.status).toBe('skipped');
  });

  it('entities never turn into tables: synchronize / dropSchema / installExtensions in the base config are overridden', async () => {
    const base = withEntities({ synchronize: true, dropSchema: true, installExtensions: true, migrationsRun: true });
    const report = await makeRunner({ db, migrations: [CreateOrders], tenants: [ALPHA], base }).run({ target: ALL });

    expect(report.tenants[0]!.status).toBe('success');
    expect(await tablesOf(db.client, 'tenant_alpha')).not.toContain('entity_only');
    expect(await tablesOf(db.client, 'public')).not.toContain('entity_only');
    expect((await db.client.query(`SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp'`)).rowCount).toBe(0);
    // dropSchema would have removed the tenant's pre-existing audit table before the migration ran
    expect(await tablesOf(db.client, 'tenant_alpha')).toContain('audit');
  });
});
