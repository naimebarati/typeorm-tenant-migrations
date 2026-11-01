import { describe, expect, it } from 'vitest';
import { isTenantMigrationError } from '../../src/errors/index.js';
import { assertConnectionSettings, withVerifiedConnections, type ClientClass } from '../../src/postgres/verified-client.js';

/** Stands in for pg.Client: connects at once and answers the settings query with whatever `FakeClient.row` holds. */
class FakeClient {
  static row: { search_path: string; read_only: string } | undefined = { search_path: 'tenant_a', read_only: 'off' };
  static connectError: Error | undefined;
  queries: string[] = [];
  ended = 0;
  connect(callback?: (err?: Error) => void): Promise<this> | void {
    if (callback) return void queueMicrotask(() => callback(FakeClient.connectError));
    return FakeClient.connectError ? Promise.reject(FakeClient.connectError) : Promise.resolve(this);
  }
  async query(sql: string): Promise<{ rows: unknown[] }> {
    this.queries.push(sql);
    return { rows: FakeClient.row ? [FakeClient.row] : [] };
  }
  async end(): Promise<void> {
    this.ended += 1;
  }
}

const Fake = FakeClient as unknown as ClientClass;
const verified = (searchPath: string[], readOnly = false) => withVerifiedConnections(Fake, { searchPath, readOnly });
const connectWithCallback = (client: { connect(cb: (err?: Error) => void): void }) => new Promise<Error | undefined>((resolve) => client.connect(resolve));

describe('assertConnectionSettings', () => {
  const ok = { search_path: 'tenant_a', read_only: 'off' };
  it('accepts the requested search_path, parsed the way PostgreSQL prints it', () => {
    expect(() => assertConnectionSettings(ok, { searchPath: ['tenant_a'], readOnly: false })).not.toThrow();
    expect(() => assertConnectionSettings({ search_path: 'tenant_a, public', read_only: 'off' }, { searchPath: ['tenant_a', 'public'], readOnly: false })).not.toThrow();
    expect(() => assertConnectionSettings({ search_path: '"tenant_a", "public"', read_only: 'off' }, { searchPath: ['tenant_a', 'public'], readOnly: false })).not.toThrow();
  });

  it.each([
    ['the default search_path', { search_path: '"$user", public', read_only: 'off' }, ['tenant_a']],
    ['an extra schema', { search_path: 'tenant_a, public', read_only: 'off' }, ['tenant_a']],
    ['the right schemas in the wrong order', { search_path: 'public, tenant_a', read_only: 'off' }, ['tenant_a', 'public']],
    ['another tenant', { search_path: 'tenant_b', read_only: 'off' }, ['tenant_a']],
    ['no row at all', undefined, ['tenant_a']],
  ])('refuses %s', (_label, row, expected) => {
    try {
      assertConnectionSettings(row, { searchPath: expected, readOnly: false });
      throw new Error('did not throw');
    } catch (error) {
      expect(isTenantMigrationError(error) && error.code).toBe('SCHEMA_CONTEXT_MISMATCH');
    }
  });

  it('refuses a writable connection when read-only was requested, and accepts it when it is', () => {
    expect(() => assertConnectionSettings({ search_path: 'tenant_a', read_only: 'off' }, { searchPath: ['tenant_a'], readOnly: true })).toThrow(/not read-only/);
    expect(() => assertConnectionSettings({ search_path: 'tenant_a', read_only: 'on' }, { searchPath: ['tenant_a'], readOnly: true })).not.toThrow();
    expect(() => assertConnectionSettings({ search_path: 'tenant_a', read_only: 'on' }, { searchPath: ['tenant_a'], readOnly: false })).not.toThrow();
  });
});

describe('withVerifiedConnections', () => {
  const reset = () => {
    FakeClient.row = { search_path: 'tenant_a', read_only: 'off' };
    FakeClient.connectError = undefined;
  };

  it('lets a connection with the requested search_path through (callback form, as pg.Pool uses it)', async () => {
    reset();
    const client = new (verified(['tenant_a']))() as unknown as FakeClient;
    expect(await connectWithCallback(client as never)).toBeUndefined();
    expect(client.queries).toHaveLength(1);
    expect(client.ended).toBe(0);
  });

  it('closes a connection with the wrong search_path and fails the connect with SCHEMA_CONTEXT_MISMATCH', async () => {
    reset();
    FakeClient.row = { search_path: '"$user", public', read_only: 'off' };
    const client = new (verified(['tenant_a']))() as unknown as FakeClient;
    const error = await connectWithCallback(client as never);
    expect(isTenantMigrationError(error) && error.code).toBe('SCHEMA_CONTEXT_MISMATCH');
    expect(client.ended).toBe(1); // the pool does not close a client whose connect failed, so the client does it itself
  });

  it('closes a writable connection when read-only was requested', async () => {
    reset();
    const client = new (verified(['tenant_a'], true))() as unknown as FakeClient;
    const error = await connectWithCallback(client as never);
    expect(isTenantMigrationError(error) && error.code).toBe('SCHEMA_CONTEXT_MISMATCH');
    expect(client.ended).toBe(1);
  });

  it('works in the promise form too', async () => {
    reset();
    const good = new (verified(['tenant_a']))() as unknown as { connect(): Promise<unknown> };
    await expect(good.connect()).resolves.toBe(good);

    FakeClient.row = { search_path: 'tenant_b', read_only: 'off' };
    const bad = new (verified(['tenant_a']))() as unknown as FakeClient & { connect(): Promise<unknown> };
    await expect(bad.connect()).rejects.toMatchObject({ code: 'SCHEMA_CONTEXT_MISMATCH' });
    expect(bad.ended).toBe(1);
  });

  it('passes a connection error through untouched and runs no query', async () => {
    reset();
    const failure = new Error('ECONNREFUSED');
    FakeClient.connectError = failure;
    const client = new (verified(['tenant_a']))() as unknown as FakeClient;
    expect(await connectWithCallback(client as never)).toBe(failure);
    expect(client.queries).toEqual([]);
    reset();
  });

  it("extends the caller's own client class, so a custom pg client keeps working", async () => {
    reset();
    class Custom extends FakeClient {
      tag = 'custom';
    }
    const Wrapped = withVerifiedConnections(Custom as unknown as ClientClass, { searchPath: ['tenant_a'], readOnly: false });
    const client = new Wrapped() as unknown as Custom;
    expect(client).toBeInstanceOf(Custom);
    expect(client.tag).toBe('custom');
    expect(await connectWithCallback(client as never)).toBeUndefined();
  });
});
