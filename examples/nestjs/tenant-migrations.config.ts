/**
 * NestJS layout (illustrative: this file is type-checked-by-eye only; no Nest application is
 * built or run in this repository's tests).
 *
 * The idea: keep the DataSource *options* in a module that does not import Nest. The application
 * (`TypeOrmModule.forRoot(dataSourceOptions)`) and the migration CLI both import it. Migrations
 * are not run when the app boots; deployment runs the CLI as a separate step.
 *
 *   // src/database/data-source-options.ts
 *   export const dataSourceOptions: DataSourceOptions = { type: 'postgres', ..., migrations: ['dist/migrations/tenant/*.js'] };
 *
 *   // app.module.ts
 *   TypeOrmModule.forRoot({ ...dataSourceOptions, migrationsRun: false })
 *
 * Deploy step:  npx typeorm-tenant-migrations run --config ./dist/tenant-migrations.config.js --all
 */
import { Client } from 'pg';
import { dataSourceOptions } from './src/database/data-source-options';

export default {
  dataSource: dataSourceOptions, // plain options are accepted too
  tenants: async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string; schema: string }>(
        'SELECT id::text AS id, schema_name AS schema FROM public.tenants WHERE active',
      );
      return rows;
    } finally {
      await client.end();
    }
  },
};
