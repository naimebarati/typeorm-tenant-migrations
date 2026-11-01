import { Client } from 'pg';
import { TenantMigrationError } from '../errors/index.js';
import { parseSearchPathSetting } from './search-path.js';

/** What every connection of a tenant's pool must have, checked on the connection itself before anyone can use it. */
export interface ConnectionExpectation {
  /** Exactly this `search_path`, in this order. */
  searchPath: readonly string[];
  /** The connection must be read-only (`default_transaction_read_only = on`): plan, status and preflight. */
  readOnly: boolean;
}

// The GUCs only; `current_schema()` is not part of this check because it is NULL while the tenant schema does not
// exist, and a missing schema is reported as SCHEMA_NOT_FOUND by the existence check, not as a context mismatch.
const SETTINGS_QUERY = `SELECT current_setting('search_path') AS search_path, current_setting('default_transaction_read_only') AS read_only`;

export function assertConnectionSettings(row: { search_path: string; read_only: string } | undefined, expected: ConnectionExpectation): void {
  const actual = row ? parseSearchPathSetting(row.search_path) : [];
  const same = actual.length === expected.searchPath.length && actual.every((name, i) => name === expected.searchPath[i]);
  if (!row || !same) {
    throw new TenantMigrationError(
      'SCHEMA_CONTEXT_MISMATCH',
      `A connection of the pool has search_path [${actual.join(', ')}], expected [${expected.searchPath.join(', ')}]. Refusing to use it (a connection pooler may be dropping startup parameters for some connections).`,
    );
  }
  if (expected.readOnly && row.read_only !== 'on') {
    throw new TenantMigrationError(
      'SCHEMA_CONTEXT_MISMATCH',
      'A connection of the pool is not read-only although it was requested (a connection pooler may be dropping startup parameters for some connections). Refusing to use it.',
    );
  }
}

export type ClientClass = new (config?: never) => Client;

/**
 * A `pg` client class that proves, right after it connects and before the pool hands it out, that the connection has
 * the requested `search_path` (and read-only mode). It is given to the tenant's pool as `extra.Client`.
 *
 * Why every connection and not just one: with a pooler, the startup options of a connection can be dropped silently
 * for some connections and not others (PgBouncer 1.26.1 in session pooling in front of PostgreSQL < 18 does that to a
 * second client that reuses a server connection). The runner's own check covers the connection it uses; a migration that
 * opens another connection of the pool (through `queryRunner.connection` or an `EntityManager`) would otherwise run in
 * the default `search_path`, with no error.
 *
 * A connection that fails the check is closed and the pool's `connect` fails with SCHEMA_CONTEXT_MISMATCH.
 * `Base` is the caller's own `extra.Client`, if any, so a custom client class keeps working.
 */
export function withVerifiedConnections(Base: ClientClass | undefined, expected: ConnectionExpectation): ClientClass {
  const Parent = (Base ?? Client) as typeof Client;
  return class VerifiedClient extends Parent {
    override connect(): Promise<Client>;
    override connect(callback: (err?: Error) => void): void;
    override connect(callback?: (err?: Error) => void): Promise<Client> | void {
      const verify = async (): Promise<void> => {
        const result = await this.query<{ search_path: string; read_only: string }>(SETTINGS_QUERY);
        assertConnectionSettings(result.rows[0], expected);
      };
      const closeQuietly = (): Promise<void> => this.end().catch(() => undefined);

      if (callback) {
        super.connect((error?: Error) => {
          if (error) return callback(error);
          verify().then(
            () => callback(),
            (failure: unknown) => void closeQuietly().then(() => callback(failure as Error)),
          );
        });
        return;
      }
      return super.connect().then(async () => {
        await verify();
        return this as Client;
      }).catch(async (failure: unknown) => {
        await closeQuietly();
        throw failure;
      });
    }
  } as unknown as ClientClass;
}
