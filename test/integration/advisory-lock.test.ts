import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeLockKey } from '../../src/postgres/advisory-lock.js';
import { acquireAdvisoryLock } from '../../src/postgres/advisory-lock.js';
import type { PostgresOptions } from '../../src/postgres/create-tenant-data-source.js';
import type { TestDatabase } from '../helpers/pg.js';
import { createTestDatabase, requirePasswordAuth } from '../helpers/pg.js';

let db: TestDatabase;
let base: PostgresOptions;
beforeAll(async () => {
  db = await createTestDatabase();
  await requirePasswordAuth(db);
  base = { ...db.options };
});
afterAll(async () => {
  await db.drop();
});

async function advisoryLocksHeld(): Promise<string[]> {
  const { rows } = await db.client.query(
    `SELECT ((classid::bigint << 32) | objid::bigint)::text AS key, granted FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  );
  return rows.filter((r) => r.granted).map((r) => r.key as string);
}

const settle = async () => {
  // pg_stat_activity lags a hair behind a closed socket.
  for (let i = 0; i < 40; i++) {
    if ((await db.countOtherSessions()) === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('acquireAdvisoryLock', () => {
  it('holds exactly the key derived from database + schema, and releases it', async () => {
    const lock = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 1000 });
    expect(lock.key).toBe(computeLockKey(db.name, 'tenant_alpha').toString());
    expect(await advisoryLocksHeld()).toEqual([lock.key]);
    expect(await db.countOtherSessions()).toBe(1);

    await lock.release();
    expect(await advisoryLocksHeld()).toEqual([]);
    await settle();
    expect(await db.countOtherSessions()).toBe(0);
  });

  it('release is idempotent', async () => {
    const lock = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 1000 });
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('refuses a second holder for the same schema once the timeout passes', async () => {
    const first = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 1000 });
    try {
      const started = Date.now();
      const err = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 400 }).catch((e: unknown) => e);
      const waited = Date.now() - started;
      expect(err).toMatchObject({ code: 'CONCURRENT_MIGRATION', name: 'TenantMigrationError' });
      expect(waited).toBeGreaterThanOrEqual(380);
      expect(waited).toBeLessThan(3000);
    } finally {
      await first.release();
    }
    // The loser left nothing behind, and the winner's lock was untouched until it released.
    await settle();
    expect(await db.countOtherSessions()).toBe(0);
    expect(await advisoryLocksHeld()).toEqual([]);
  });

  it('with timeout 0 tries exactly once', async () => {
    const first = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 1000 });
    try {
      const started = Date.now();
      await expect(acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 0 })).rejects.toMatchObject({ code: 'CONCURRENT_MIGRATION' });
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await first.release();
    }
  });

  it('does not block a different schema', async () => {
    const a = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 0 });
    const b = await acquireAdvisoryLock(base, { schema: 'tenant_beta', timeoutMs: 0 });
    expect((await advisoryLocksHeld()).sort()).toEqual([a.key, b.key].sort());
    await Promise.all([a.release(), b.release()]);
    expect(await advisoryLocksHeld()).toEqual([]);
  });

  it('a waiting runner gets the lock as soon as the holder releases (serialization)', async () => {
    const first = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 1000 });
    const events: string[] = [];
    const second = acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 5000 }).then((l) => {
      events.push('second-acquired');
      return l;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);
    events.push('first-releasing');
    await first.release();
    const secondLock = await second;
    expect(events).toEqual(['first-releasing', 'second-acquired']);
    await secondLock.release();
  });

  it('frees the lock when the holder session dies (crashed deployer)', async () => {
    const first = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 1000 });
    await db.client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [db.name],
    );
    const second = await acquireAdvisoryLock(base, { schema: 'tenant_alpha', timeoutMs: 3000 });
    expect(second.key).toBe(first.key);
    await second.release();
    // Releasing the dead handle must not throw nor leave sessions.
    await expect(first.release()).resolves.toBeUndefined();
    await settle();
    expect(await db.countOtherSessions()).toBe(0);
  });

  it('leaves no session behind when it cannot connect', async () => {
    const err = await acquireAdvisoryLock({ ...base, password: 'definitely-wrong-password' }, { schema: 'tenant_alpha', timeoutMs: 100 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DATASOURCE_INITIALIZATION_FAILED' });
    expect((err as Error).message).not.toContain('definitely-wrong-password');
    await settle();
    expect(await db.countOtherSessions()).toBe(0);
  });
});
