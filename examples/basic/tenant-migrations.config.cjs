const path = require('node:path');
const { DataSource } = require('typeorm');

// Connection settings and migrations only. The runner reads these options; it never initializes this instance.
const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? 'app',
  synchronize: false,
  migrationsRun: false,
  migrations: [path.join(__dirname, 'migrations', '*.js')],
});

module.exports = {
  dataSource,
  // Explicit registry. Replace with a function that reads your own tenants table:
  //   tenants: async () => (await pool.query('SELECT id, schema_name AS schema FROM tenants')).rows
  tenants: [
    { id: 'tenant-001', schema: 'tenant_001' },
    { id: 'tenant-002', schema: 'tenant_002' },
  ],
  options: { concurrency: 1, transaction: 'each', lockTimeoutMs: 30_000 },
};
