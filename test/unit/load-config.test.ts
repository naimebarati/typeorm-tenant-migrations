import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/cli/load-config.js';
import type { TenantMigrationError } from '../../src/errors/index.js';

// Outside the repository on purpose: no `tsx` can be resolved from here, like a project that never installed it.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ttm-config-'));
  mkdirSync(path.join(dir, 'nested'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, text: string) => {
  writeFileSync(path.join(dir, name), text);
  return name;
};
const failure = async (name: string): Promise<TenantMigrationError> => {
  try {
    await loadConfig(name, dir);
  } catch (e) {
    return e as TenantMigrationError;
  }
  throw new Error('expected loadConfig to throw');
};
const shape = `{ dataSource: { type: 'postgres' }, tenants: [{ id: 'a', schema: 'tenant_a' }] }`;

describe('loadConfig: export shapes', () => {
  it.each([
    ['module.exports object', `module.exports = ${shape};`, 'a.cjs'],
    ['module.exports sync function', `module.exports = () => (${shape});`, 'b.cjs'],
    ['module.exports async function', `module.exports = async () => (${shape});`, 'c.cjs'],
    ['ESM default object', `export default ${shape};`, 'd.mjs'],
    ['ESM default async function', `export default async () => (${shape});`, 'e.mjs'],
    ['CJS transpiled ESM (exports.default)', `Object.defineProperty(exports, '__esModule', { value: true }); exports.default = ${shape};`, 'f.cjs'],
    ['module.exports = { default: config }', `module.exports = { default: ${shape} };`, 'g.cjs'],
  ])('%s', async (_label, text, file) => {
    const config = await loadConfig(write(file, text), dir);
    expect(config.tenants).toEqual([{ id: 'a', schema: 'tenant_a' }]);
  });

  it('resolves relative paths against the given cwd', async () => {
    write('nested/rel.cjs', `module.exports = ${shape};`);
    expect((await loadConfig('./nested/rel.cjs', dir)).tenants).toHaveLength(1);
  });
});

describe('loadConfig: errors are INVALID_CONFIGURATION and never echo what the file said', () => {
  it('missing file / empty path / unsupported extension', async () => {
    expect((await failure('nope.cjs')).message).toContain('not found');
    expect((await failure('')).code).toBe('INVALID_CONFIGURATION');
    write('x.json', '{}');
    expect((await failure('x.json')).message).toContain('Unsupported config file type');
  });

  it('a directory is not a config file', async () => {
    expect((await failure('nested')).message).toContain('not found');
  });

  it('wrong shape', async () => {
    write('shape.cjs', `module.exports = { hello: 1 };`);
    expect((await failure('shape.cjs')).message).toContain('{ dataSource, tenants, options? }');
    write('null.cjs', `module.exports = null;`);
    expect((await failure('null.cjs')).code).toBe('INVALID_CONFIGURATION');
  });

  it('a config that throws on import: message omitted (may hold secrets), cause kept', async () => {
    write('throws.cjs', `throw new Error('postgres://u:hunter2@h/d exploded');`);
    const e = await failure('throws.cjs');
    expect(e.message).not.toContain('hunter2');
    expect((e.cause as Error).message).toContain('hunter2');
  });

  it('a config function that throws', async () => {
    write('fn-throws.cjs', `module.exports = () => { throw new Error('password=hunter2'); };`);
    const e = await failure('fn-throws.cjs');
    expect(e.message).toBe('The config function threw an error.');
  });
});

describe('loadConfig: TypeScript without tsx installed (real Node process; vitest would transform .ts itself)', () => {
  const DIST = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'load-config.js');
  const inFreshNode = (file: string) => {
    const script = `require(${JSON.stringify(DIST)}).loadConfig(${JSON.stringify(file)}, ${JSON.stringify(dir)}).then(
      (c) => console.log(JSON.stringify({ ok: true, tenants: c.tenants.length })),
      (e) => console.log(JSON.stringify({ ok: false, code: e.code, message: e.message })))`;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { ok: boolean; code?: string; message?: string; tenants?: number };
  };

  it('non-erasable syntax (enum) fails with a message that tells you to install tsx', () => {
    write('enum.ts', `enum Mode { A = 'a' }\nexport default { dataSource: { type: 'postgres', m: Mode.A }, tenants: [] };`);
    const result = inFreshNode('enum.ts');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_CONFIGURATION');
    expect(result.message).toContain('npm i -D tsx');
    expect(result.message).toContain('compiled .js');
  });

  it('plain type annotations load natively only where Node strips types; elsewhere the same helpful error', () => {
    write('plain.ts', `const c: { dataSource: object; tenants: object[] } = ${shape};\nexport default c;`);
    const result = inFreshNode('plain.ts');
    const nodeStripsTypes = spawnSync(process.execPath, ['-p', 'Boolean(process.features.typescript)'], { encoding: 'utf8' }).stdout.trim() === 'true';
    if (nodeStripsTypes) {
      expect(result).toMatchObject({ ok: true, tenants: 1 });
    } else {
      expect(result.ok).toBe(false);
      expect(result.message).toContain('npm i -D tsx');
    }
  });
});
