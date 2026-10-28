import { describe, expect, it } from 'vitest';
import { TenantMigrationError } from '../../src/errors/index.js';
import { resolveTenants } from '../../src/tenants/tenant-provider.js';
import { selectTargets } from '../../src/tenants/select-targets.js';
import { validateTargets } from '../../src/tenants/validate-target.js';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as TenantMigrationError).code;
  }
  return undefined;
};

const ok = [
  { id: 'tenant-001', schema: 'tenant_001' },
  { id: 'tenant-002', schema: 'tenant_002' },
];

describe('validateTargets', () => {
  it('accepts well-formed targets and returns frozen copies', () => {
    const input = [{ id: 'a', schema: 'tenant_a' }];
    const out = validateTargets(input);
    expect(out).toEqual(input);
    expect(Object.isFrozen(out[0])).toBe(true);
    expect(out[0]).not.toBe(input[0]);
  });

  it('rejects duplicate ids and duplicate schemas', () => {
    expect(codeOf(() => validateTargets([ok[0], { id: 'tenant-001', schema: 'other' }]))).toBe('INVALID_TENANT_TARGET');
    expect(codeOf(() => validateTargets([ok[0], { id: 'x', schema: 'tenant_001' }]))).toBe('INVALID_TENANT_TARGET');
  });

  it.each([
    ['uppercase', 'Tenant_A'],
    ['quote injection', 'a"; DROP SCHEMA public; --'],
    ['space', 'tenant a'],
    ['dash', 'tenant-a'],
    ['leading digit', '1tenant'],
    ['empty', ''],
    ['dot', 'a.b'],
    ['unicode', 'tënant'],
    ['64 chars', 'a'.repeat(64)],
  ])('rejects unsafe schema (%s)', (_label, schema) => {
    expect(codeOf(() => validateTargets([{ id: 'x', schema }]))).toBe('UNSAFE_SCHEMA_NAME');
  });

  it.each(['public', 'information_schema', 'pg_catalog', 'pg_toast', 'pg_temp_1', 'pg_anything'])(
    'rejects reserved schema %s',
    (schema) => {
      expect(codeOf(() => validateTargets([{ id: 'x', schema }]))).toBe('UNSAFE_SCHEMA_NAME');
    },
  );

  it('accepts a 63 character schema and underscore-leading names', () => {
    expect(() => validateTargets([{ id: 'x', schema: 'a'.repeat(63) }, { id: 'y', schema: '_t1' }])).not.toThrow();
  });

  it.each([
    ['not an array', {}],
    ['entry not an object', ['x']],
    ['null entry', [null]],
    ['empty id', [{ id: '', schema: 'a' }]],
    ['non-string id', [{ id: 5, schema: 'a' }]],
    ['padded id', [{ id: ' a', schema: 'a' }]],
    ['control char id', [{ id: 'a\nb', schema: 'a' }]],
    ['missing schema', [{ id: 'a' }]],
  ])('rejects malformed input (%s)', (_label, input) => {
    expect(codeOf(() => validateTargets(input))).toMatch(/INVALID_TENANT_TARGET|UNSAFE_SCHEMA_NAME/);
  });

  it('does not echo unbounded user input in messages', () => {
    try {
      validateTargets([{ id: 'x', schema: 'A'.repeat(500) }]);
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(300);
    }
  });
});

describe('resolveTenants', () => {
  it('accepts arrays, sync and async providers', async () => {
    expect(await resolveTenants(ok)).toEqual(ok);
    expect(await resolveTenants(() => ok)).toEqual(ok);
    expect(await resolveTenants(async () => ok)).toEqual(ok);
  });

  it('wraps provider failure without leaking its message', async () => {
    const err = (await resolveTenants(() => {
      throw new Error('postgres://u:hunter2@db/x unreachable');
    }).catch((e: unknown) => e)) as TenantMigrationError;
    expect(err).toBeInstanceOf(TenantMigrationError);
    expect(err.code).toBe('INVALID_CONFIGURATION');
    expect(err.message).not.toContain('hunter2');
    expect((err.cause as Error).message).toContain('unreachable');
  });
});

describe('selectTargets', () => {
  const all = validateTargets(ok);

  it('selects all, in provider order', () => {
    expect(selectTargets(all, { all: true }).map((t) => t.id)).toEqual(['tenant-001', 'tenant-002']);
  });

  it('selects by logical id, in requested order, deduplicated', () => {
    expect(selectTargets(all, { tenants: ['tenant-002', 'tenant-001', 'tenant-002'] }).map((t) => t.id)).toEqual(['tenant-002', 'tenant-001']);
  });

  it('does not match a schema name as an id', () => {
    expect(codeOf(() => selectTargets(all, { tenants: ['tenant_001'] }))).toBe('INVALID_TENANT_TARGET');
  });

  it('rejects unknown ids', () => {
    expect(codeOf(() => selectTargets(all, { tenants: ['nope'] }))).toBe('INVALID_TENANT_TARGET');
  });

  it('requires exactly one selector', () => {
    expect(codeOf(() => selectTargets(all, undefined))).toBe('INVALID_TENANT_TARGET');
    expect(codeOf(() => selectTargets(all, {} as never))).toBe('INVALID_TENANT_TARGET');
    expect(codeOf(() => selectTargets(all, { all: true, tenants: ['tenant-001'] } as never))).toBe('INVALID_TENANT_TARGET');
    expect(codeOf(() => selectTargets(all, { all: false } as never))).toBe('INVALID_TENANT_TARGET');
    expect(codeOf(() => selectTargets(all, { tenants: [] }))).toBe('INVALID_TENANT_TARGET');
  });

  it('refuses --all on an empty registry', () => {
    expect(codeOf(() => selectTargets([], { all: true }))).toBe('INVALID_TENANT_TARGET');
  });
});
