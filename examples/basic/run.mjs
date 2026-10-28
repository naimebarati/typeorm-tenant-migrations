// Programmatic use: the same config as the CLI, driven from your own script or deploy job.
import { createRequire } from 'node:module';
import { TenantMigrationRunner } from 'typeorm-tenant-migrations';

const config = createRequire(import.meta.url)('./tenant-migrations.config.cjs');
const runner = new TenantMigrationRunner(config);

const plan = await runner.plan({ target: { all: true } });
console.log('pending in total:', plan.summary.pendingTotal);

const report = await runner.run({ target: { all: true } });
console.log(JSON.stringify(report.summary));
process.exitCode = report.summary.failed + report.summary.locked + report.summary.notStarted === 0 ? 0 : 1;
