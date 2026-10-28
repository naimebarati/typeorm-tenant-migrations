# Architecture

```
CLI / public API
      |
TenantMigrationRunner            validates config in the constructor (no I/O)
      |
resolveTenants -> selectTargets  whole registry validated first; selection must be explicit
      |
Preflight   (bounded pool, read-only)   inspectTenant per tenant
      |
Execute     (bounded pool)              executeTenant per tenant
      |
Report (+ exit code in the CLI)
```

## Per tenant

`inspectTenant` (plan, status, preflight) — no lock, no writes:

1. Build tenant DataSource options: copy of the base options, `schema = <tenant>`, `extra.options += -c search_path=<…> -c default_transaction_read_only=on`, dangerous flags off, TypeORM logger silent.
2. `initialize()` the DataSource (the runner owns it).
3. On a short-lived QueryRunner: schema exists? `search_path` and `current_schema()` as expected? Otherwise `SCHEMA_NOT_FOUND` / `SCHEMA_CONTEXT_MISMATCH`.
4. Read the history table *only if it exists* (`pg_class` lookup, then a plain `SELECT`), otherwise "nothing executed".
5. Compare with `dataSource.migrations` using TypeORM's naming/ordering rule.
6. `destroy()` in `finally`.

`executeTenant` (run):

1. Same options but writable. Initialize. Verify schema + context (short-lived QueryRunner, released immediately, so a pool of size 1 cannot deadlock).
2. **Acquire the advisory lock** on a separate one-connection DataSource (below).
3. Re-read history under the lock; this is the authoritative `pendingBeforeRun`. Nothing pending → `skipped`.
4. `dataSource.runMigrations({ transaction })`.
5. Read history again; `executed = after − before`. If that read fails after a failure: `executedKnown = false`.
6. `finally`, in this order: destroy migration DataSource, release lock (which destroys the lock DataSource).

It never throws; every outcome is a `TenantMigrationResult`.

## Why a DataSource per tenant, and why a startup parameter

TypeORM's `schema` option qualifies names TypeORM generates; it does not set `search_path`. A one-off `SET search_path` would affect only the pooled connection that executed it, and `runMigrations()` may take any other. Passing `options=-c search_path=…` in the startup packet applies to every connection the pool ever opens. The runner still *checks* the result on a live connection rather than trusting it, because poolers can drop startup parameters; the check fails closed.

## Advisory lock

* Key: first 8 bytes (big-endian, signed) of `sha256("typeorm-tenant-migrations:<database>:<schema>")`, passed as a `bigint` bind parameter. Pinned by a unit test: it is a compatibility contract between runner versions.
* One DataSource with a pool of exactly **one** connection per tenant run. The lock therefore lives in a session nobody else can borrow, can't deadlock with the migration pool, and **destroying the DataSource ends the session**, which makes PostgreSQL drop the lock even if `pg_advisory_unlock` itself failed.
* `pg_try_advisory_lock` in a loop with capped exponential backoff (25 ms → 500 ms) until `lockTimeoutMs`. No unbounded blocking.
* A killed session or a crashed process releases the lock server-side (tested with `pg_terminate_backend`).

## Why not `MigrationExecutor`

It is not public API, and a read-only `plan` needs behavior it doesn't offer (`showMigrations()` creates the history table; `getExecutedMigrations()` checks existence but is internal). The public surface used is `DataSource#migrations`, `DataSource#runMigrations({ transaction })` and `QueryRunner#query`. The one piece of TypeORM logic that is reimplemented — which migrations are pending, and in what order — is small (`src/migrations/migration-plan.ts`), and the integration tests assert that `plan` equals what `run` executes, per TypeORM version in the matrix.

`runMigrations()` throws away the list of migrations that succeeded before a failure. That is why `executed` is derived from the history table instead of from its return value (which is used only as a fallback after a successful run whose history can't be re-read).

## Layout

| Path | Responsibility |
| --- | --- |
| `src/config` | public option types, option validation and defaults |
| `src/tenants` | tenant provider, target validation (allowlist, duplicates, reserved schemas), selection |
| `src/postgres` | tenant/lock DataSource options, `search_path`, context verification, advisory lock |
| `src/migrations` | read-only history reader, pending computation |
| `src/runner` | per-tenant workers, bounded pool, runner, report |
| `src/cli` | argument parsing, config loading, formatting, exit codes |
| `test/integration` | everything that needs a real PostgreSQL, including the real built CLI |
