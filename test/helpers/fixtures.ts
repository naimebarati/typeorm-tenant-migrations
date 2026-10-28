import type { TestDatabase } from './pg.js';

/** Two tenants with an identically named table, plus the same table in public as the "shared" decoy. */
export async function seedTenants(db: TestDatabase, schemas: string[] = ['tenant_alpha', 'tenant_beta']): Promise<void> {
  const existing = await db.client.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'`);
  for (const row of existing.rows as Array<{ nspname: string }>) {
    await db.client.query(`DROP SCHEMA "${row.nspname}" CASCADE`);
  }
  await db.client.query('DROP TABLE IF EXISTS public.orders, public.things, public.migrations CASCADE');
  await db.client.query('CREATE TABLE public.orders (id int)');
  for (const schema of schemas) {
    await db.client.query(`CREATE SCHEMA "${schema}"`);
    await db.client.query(`CREATE TABLE "${schema}".orders (id int)`);
    await db.client.query(`CREATE TABLE "${schema}".audit (note text)`);
  }
}
