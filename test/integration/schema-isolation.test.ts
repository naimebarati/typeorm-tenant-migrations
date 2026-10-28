import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantMigrationError } from '../../src/errors/index.js';
import {
  buildTenantDataSourceOptions,
  destroyQuietly,
  initializeOwned,
} from '../../src/postgres/create-tenant-data-source.js';
import { assertSchemaContext } from '../../src/postgres/schema-inspection.js';
import { goodMigrations } from '../fixtures/migrations.js';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { columnsOf, createTestDatabase, snapshotDatabase, tablesOf } from '../helpers/pg.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db));

const base = () => ({ ...db.options, migrations: goodMigrations });
const spec = (schema: string, searchPath: string[] = [schema]) => ({ schema, searchPath });

describe('tenant DataSource isolation', () => {
  it('runs unqualified raw SQL and createTable only in the target schema', async () => {
    const before = await snapshotDatabase(db.client);
    const ds = await initializeOwned(buildTenantDataSourceOptions(base(), spec('tenant_alpha')));
    try {
      await assertSchemaContext(ds.createQueryRunner(), 'tenant_alpha', ['tenant_alpha']);
      await ds.runMigrations({ transaction: 'each' });
    } finally {
      await destroyQuietly(ds);
    }

    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id', 'status', 'note']);
    expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'migrations', 'orders', 'things']);

    // Everything else is byte-for-byte what it was.
    expect(await columnsOf(db.client, 'tenant_beta', 'orders')).toEqual(['id']);
    expect(await tablesOf(db.client, 'tenant_beta')).toEqual(['audit', 'orders']);
    expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id']);
    expect(await tablesOf(db.client, 'public')).toEqual(['orders']);

    const after = await snapshotDatabase(db.client);
    const added = after.filter((x) => !before.includes(x));
    expect(added.every((x) => x.startsWith('tenant_alpha.'))).toBe(true);
    expect(before.every((x) => after.includes(x))).toBe(true);
  });

  it('keeps each tenant history independent', async () => {
    for (const schema of ['tenant_alpha', 'tenant_beta']) {
      const ds = await initializeOwned(buildTenantDataSourceOptions(base(), spec(schema)));
      try {
        await ds.runMigrations({ transaction: 'each' });
      } finally {
        await destroyQuietly(ds);
      }
    }
    for (const schema of ['tenant_alpha', 'tenant_beta']) {
      const { rows } = await db.client.query(`SELECT name FROM "${schema}".migrations ORDER BY id`);
      expect(rows.map((r) => r.name)).toEqual(goodMigrations.map((M) => new M().name));
    }
    expect(await tablesOf(db.client, 'public')).toEqual(['orders']);
  });

  it('works for connection URLs without options', async () => {
    const { host, port, username, password, database } = db.options;
    const url = `postgres://${username}:${encodeURIComponent(String(password))}@${host}:${port}/${database}`;
    const ds = await initializeOwned(
      buildTenantDataSourceOptions({ type: 'postgres', url, migrations: goodMigrations }, spec('tenant_beta')),
    );
    try {
      await assertSchemaContext(ds.createQueryRunner(), 'tenant_beta', ['tenant_beta']);
    } finally {
      await destroyQuietly(ds);
    }
  });

  it('supports an explicit tenant-first fallback and verifies it', async () => {
    const ds = await initializeOwned(buildTenantDataSourceOptions(base(), spec('tenant_alpha', ['tenant_alpha', 'public'])));
    try {
      await assertSchemaContext(ds.createQueryRunner(), 'tenant_alpha', ['tenant_alpha', 'public']);
      await expect(assertSchemaContext(ds.createQueryRunner(), 'tenant_alpha', ['tenant_alpha'])).rejects.toMatchObject({ code: 'SCHEMA_CONTEXT_MISMATCH' });
    } finally {
      await destroyQuietly(ds);
    }
  });
});

describe('assertSchemaContext fails closed', () => {
  it('rejects a connection whose search_path is the server default', async () => {
    // Deliberately built WITHOUT this package's builder: only TypeORM's `schema` option.
    const ds = await initializeOwned({ ...db.options, schema: 'tenant_alpha', migrations: goodMigrations });
    try {
      const qr = ds.createQueryRunner();
      const err = await assertSchemaContext(qr, 'tenant_alpha', ['tenant_alpha']).catch((e: unknown) => e);
      await qr.release();
      expect(err).toBeInstanceOf(TenantMigrationError);
      expect((err as TenantMigrationError).code).toBe('SCHEMA_CONTEXT_MISMATCH');
    } finally {
      await destroyQuietly(ds);
    }
  });

  it('rejects a connection pointed at a different tenant', async () => {
    const ds = await initializeOwned(buildTenantDataSourceOptions(base(), spec('tenant_beta')));
    try {
      const qr = ds.createQueryRunner();
      await expect(assertSchemaContext(qr, 'tenant_alpha', ['tenant_alpha'])).rejects.toMatchObject({ code: 'SCHEMA_CONTEXT_MISMATCH' });
      await qr.release();
    } finally {
      await destroyQuietly(ds);
    }
  });

  it('reports a missing schema before anything else', async () => {
    const ds = await initializeOwned(buildTenantDataSourceOptions(base(), spec('tenant_ghost')));
    try {
      const before = await snapshotDatabase(db.client);
      const qr = ds.createQueryRunner();
      await expect(assertSchemaContext(qr, 'tenant_ghost', ['tenant_ghost'])).rejects.toMatchObject({ code: 'SCHEMA_NOT_FOUND' });
      await qr.release();
      expect(await snapshotDatabase(db.client)).toEqual(before);
    } finally {
      await destroyQuietly(ds);
    }
  });
});

describe('DataSource safety overrides', () => {
  it('does not synchronize, create tables or schemas even if the base asks to', async () => {
    const before = await snapshotDatabase(db.client);
    const ds = await initializeOwned(
      buildTenantDataSourceOptions({ ...base(), synchronize: true, migrationsRun: true, dropSchema: true, installExtensions: true }, spec('tenant_alpha')),
    );
    await destroyQuietly(ds);
    expect(await snapshotDatabase(db.client)).toEqual(before);
  });
});

describe('read-only DataSource (used by plan/status)', () => {
  it('makes PostgreSQL itself reject writes on every connection', async () => {
    const ds = await initializeOwned(buildTenantDataSourceOptions({ ...base(), extra: { max: 3 } }, { ...spec('tenant_alpha'), readOnly: true }));
    try {
      const runners = [ds.createQueryRunner(), ds.createQueryRunner()];
      for (const qr of runners) {
        await qr.connect();
        await expect(qr.query('CREATE TABLE tenant_alpha.sneaky (id int)')).rejects.toThrow(/read-only transaction/);
        await expect(qr.query('INSERT INTO tenant_alpha.orders VALUES (1)')).rejects.toThrow(/read-only transaction/);
        expect(await qr.query('SELECT count(*)::int AS n FROM tenant_alpha.orders')).toEqual([{ n: 0 }]);
        await qr.release();
      }
    } finally {
      await destroyQuietly(ds);
    }
    expect(await tablesOf(db.client, 'tenant_alpha')).toEqual(['audit', 'orders']);
  });

  it('control: the normal DataSource can write', async () => {
    const ds = await initializeOwned(buildTenantDataSourceOptions(base(), spec('tenant_alpha')));
    try {
      await ds.query('INSERT INTO tenant_alpha.orders VALUES (1)');
    } finally {
      await destroyQuietly(ds);
    }
  });
});
