import type { DataSourceOptions } from 'typeorm';
import type { TenantMigrationOptions, TenantMigrationTarget } from '../../src/config/types.js';
import { TenantMigrationRunner } from '../../src/runner/tenant-migration-runner.js';
import type { TenantMigrationLogger } from '../../src/logger/types.js';
import type { TestDatabase } from './pg.js';

export const ALPHA: TenantMigrationTarget = { id: 'alpha', schema: 'tenant_alpha' };
export const BETA: TenantMigrationTarget = { id: 'beta', schema: 'tenant_beta' };
export const GAMMA: TenantMigrationTarget = { id: 'gamma', schema: 'tenant_gamma' };

export interface MakeRunnerInput {
  db: TestDatabase;
  migrations: unknown[];
  tenants?: TenantMigrationTarget[];
  options?: TenantMigrationOptions;
  base?: Record<string, unknown>;
}

export function makeRunner({ db, migrations, tenants = [ALPHA, BETA], options, base }: MakeRunnerInput) {
  return new TenantMigrationRunner({
    dataSource: { ...db.options, migrations, ...base } as DataSourceOptions,
    tenants,
    options,
  });
}

export function capturingLogger(): TenantMigrationLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    lines.push(`${level} ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`);
  };
  return { lines, debug: push('DEBUG'), info: push('INFO'), warn: push('WARN'), error: push('ERROR') };
}

export const ALL = { all: true } as const;
