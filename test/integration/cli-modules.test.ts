/**
 * Module formats, through the real binary: ES-module migrations, one file exporting several migrations,
 * top-level await in configs, TypeScript configs (via tsx) and TypeScript migrations (loaded by Node itself).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedTenants } from '../helpers/fixtures.js';
import type { TestDatabase } from '../helpers/pg.js';
import { columnsOf, createTestDatabase } from '../helpers/pg.js';
import { MIGRATION_BODIES as M, runBin, writeProject } from '../helpers/cli-project.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});
beforeEach(() => seedTenants(db));

const migrations = [M.addStatus, M.createThings];
const NAMES = migrations.map((m) => m.name);
const nodeStripsTypes = Boolean(process.features.typescript);

async function planAndRun(p: { config: string }) {
  const plan = await runBin(['plan', '--all', '--json', '--config', p.config]);
  const run = await runBin(['run', '--all', '--json', '--config', p.config]);
  const again = await runBin(['run', '--all', '--json', '--config', p.config]);
  return { plan, run, again };
}

describe('ES module migrations', () => {
  it.each([['esm'], ['esm-one-file']] as const)('%s: discovered, planned in timestamp order, run once, not repeated', async (migrationFormat) => {
    const p = writeProject({ db, migrationFormat, kind: 'mjs', migrations: [...migrations].reverse() });
    const { plan, run, again } = await planAndRun(p);

    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.stdout).tenants[0].pending).toEqual(NAMES);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).tenants[0]).toMatchObject({ status: 'success', executed: NAMES });
    expect(JSON.parse(again.stdout).summary).toMatchObject({ skipped: 2, success: 0 });
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toContain('status');
    expect(await columnsOf(db.client, 'public', 'orders')).toEqual(['id']);
  });

  it('a config with top-level await', async () => {
    const p = writeProject({ db, kind: 'mjs-tla', migrations });
    expect((await runBin(['plan', '--all', '--json', '--config', p.config])).code).toBe(0);
  });
});

describe('TypeScript', () => {
  it('a config using syntax Node cannot strip (enum) loads through tsx', async () => {
    const p = writeProject({ db, kind: 'ts-enum', migrations });
    const { plan, run } = await planAndRun(p);
    expect(plan.code, plan.stderr + plan.stdout).toBe(0);
    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(JSON.parse(run.stdout).summary).toMatchObject({ success: 2 });
  });

  it('TypeScript migrations Node can strip (plain annotations) work where Node strips types, and say why otherwise', async () => {
    const p = writeProject({ db, kind: 'cjs', migrationFormat: 'ts', migrations });
    const plan = await runBin(['plan', '--all', '--json', '--config', p.config]);
    if (nodeStripsTypes) {
      expect(plan.code, plan.stderr).toBe(0);
      expect(JSON.parse(plan.stdout).tenants[0].pending).toEqual(NAMES);
      expect((await runBin(['run', '--all', '--config', p.config])).code).toBe(0);
    } else {
      expect(plan.code).toBe(1);
      expect(plan.stdout).toContain('Hint');
    }
  });

  it('TypeScript migrations Node cannot load (enum) fail per tenant with a hint, and change nothing', async () => {
    const p = writeProject({ db, kind: 'cjs', migrationFormat: 'ts-enum', migrations });
    const run = await runBin(['run', '--all', '--json', '--config', p.config]);
    expect(run.code).toBe(1);
    const report = JSON.parse(run.stdout);
    expect(report.tenants[0]).toMatchObject({ status: 'failed', error: { code: 'DATASOURCE_INITIALIZATION_FAILED' } });
    expect(report.tenants[0].error.message).toContain('Hint');
    expect(report.tenants[0].error.message).toContain('compiled JavaScript');
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id']);
  });
});

describe('CommonJS / ES module mix-ups explain themselves', () => {
  it('a CommonJS migration inside a "type": "module" project', async () => {
    const p = writeProject({ db, kind: 'cjs', migrationFormat: 'cjs', migrations });
    writeFileSync(path.join(p.dir, 'package.json'), '{ "type": "module" }\n');
    const run = await runBin(['run', '--all', '--json', '--config', p.config]);
    expect(run.code).toBe(1);
    const message = JSON.parse(run.stdout).tenants[0].error.message as string;
    expect(message).toMatch(/module is not defined|require is not defined|exports is not defined/);
    expect(message).toContain('Hint');
    expect(await columnsOf(db.client, 'tenant_alpha', 'orders')).toEqual(['id']);
  });
});
