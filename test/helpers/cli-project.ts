import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { TestDatabase } from './pg.js';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const BIN = path.join(REPO_ROOT, 'dist', 'cli', 'bin.js');
const SCRATCH = path.join(REPO_ROOT, '.tmp');

export interface Project {
  dir: string;
  config: string;
}

export const MIGRATION_BODIES = {
  addStatus: { name: 'AddStatus1700000000001', body: `await q.query('ALTER TABLE "orders" ADD COLUMN "status" text');` },
  createThings: { name: 'CreateThings1700000000002', body: `await q.query('CREATE TABLE "things" (id int)');` },
  // Sleeps inside the tenant's lock and records every entry in the tenant's own audit table.
  slowAudit: { name: 'SlowAudit1700000000003', body: `await q.query("INSERT INTO \\"audit\\"(note) VALUES ('entered')"); await q.query('SELECT pg_sleep(1.2)');` },
  failsOnBeta: {
    name: 'FailsOnBeta1700000000004',
    body: `const r = await q.query('SELECT current_schema() AS s'); if (r[0].s === 'tenant_beta') throw new Error('beta is broken');`,
  },
} as const;

export interface ProjectOptions {
  db: TestDatabase;
  kind?: 'cjs' | 'mjs' | 'ts' | 'async-fn';
  migrations: Array<{ name: string; body: string }>;
  tenants?: Array<{ id: string; schema: string }>;
  options?: Record<string, unknown>;
  dbOverrides?: Record<string, unknown>;
}

export function writeProject({ db, kind = 'cjs', migrations, tenants, options, dbOverrides }: ProjectOptions): Project {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(path.join(SCRATCH, 'cli-'));
  mkdirSync(path.join(dir, 'migrations'));
  for (const m of migrations) {
    writeFileSync(
      path.join(dir, 'migrations', `${m.name}.js`),
      `module.exports = class ${m.name} { constructor() { this.name = '${m.name}'; } async up(q) { ${m.body} } async down() {} };\n`,
    );
  }
  const body = {
    dataSource: {
      ...db.options,
      migrations: [path.join(dir, 'migrations', '*.js')],
      ...dbOverrides,
    },
    tenants: tenants ?? [
      { id: 'alpha', schema: 'tenant_alpha' },
      { id: 'beta', schema: 'tenant_beta' },
    ],
    options,
  };
  const json = JSON.stringify(body, null, 2);
  const file = { cjs: 'tenants.config.cjs', mjs: 'tenants.config.mjs', ts: 'tenants.config.ts', 'async-fn': 'tenants.config.js' }[kind];
  const text = {
    cjs: `module.exports = ${json};\n`,
    mjs: `export default ${json};\n`,
    ts: `const config: { dataSource: object; tenants: Array<{ id: string; schema: string }>; options?: object } = ${json};\nexport default config;\n`,
    'async-fn': `module.exports = async () => (${json});\n`,
  }[kind];
  writeFileSync(path.join(dir, file), text);
  return { dir, config: path.join(dir, file) };
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The real binary, as a user's shell or CI would start it. */
export function runBin(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd ?? REPO_ROOT, env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export interface RunningBin {
  child: ChildProcess;
  /** Resolves when the process has ended; `signal` is set when it was ended by a signal. */
  done: Promise<ProcessResult & { signal: NodeJS.Signals | null }>;
}

/** Starts the real binary without waiting for it, so a test can signal it mid-run. */
export function startBin(args: string[], opts: { cwd?: string } = {}): RunningBin {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd ?? REPO_ROOT, env: process.env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d));
  child.stderr.on('data', (d: Buffer) => (stderr += d));
  const done = new Promise<ProcessResult & { signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
