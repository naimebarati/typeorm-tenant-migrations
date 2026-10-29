# typeorm-tenant-migrations

Run your normal **TypeORM migrations** across a PostgreSQL database that uses **one schema per tenant** — one tenant, a few, or all of them — with the guard rails a multi-tenant deploy needs.

> **Status: `0.1.0-alpha.1`.** The behavior described below is covered by automated tests that were run against real PostgreSQL 12 through 18 on Linux, and on macOS and Windows (see [Compatibility](#compatibility)). It is an alpha: read [Known limitations](#known-limitations) before pointing it at production data, and try it on a copy first.

## The problem

With schema-per-tenant (`tenant_acme.orders`, `tenant_globex.orders`, …) every tenant must get the same migrations, each tenant needs its own history, and a migration written as

```ts
await queryRunner.query('ALTER TABLE "orders" ADD COLUMN "status" text');
```

must change *that tenant's* `orders` — not `public.orders`, not another tenant's.

Setting TypeORM's `schema` option is **not enough for that**: it only makes TypeORM qualify the names it generates itself (the history table, `queryRunner.createTable()`, …). Raw SQL still runs with the connection's `search_path`, which is `"$user", public` by default. This is easy to verify and is pinned by a test in this repo ([`test/integration/typeorm-schema-behavior.test.ts`](test/integration/typeorm-schema-behavior.test.ts)): with `schema: 'tenant_alpha'` alone, the statement above alters `public.orders`.

What this package does about it, for every tenant:

| Concern | Behavior |
| --- | --- |
| Wrong schema | A dedicated DataSource per tenant whose connections are **started** with `search_path = <tenant>` (a startup parameter, so *every* pooled connection has it — not a one-off `SET`). Before running anything it verifies `search_path` and `current_schema()` on a live connection and **refuses to run** if they don't match. |
| History | TypeORM's own `migrations` table, **inside each tenant's schema**. Nothing is stored in `public`. |
| Two deploys at once | A session-level **PostgreSQL advisory lock** per tenant schema, with a hard timeout. No lock → no migration. |
| Failure | One tenant failing never corrupts another. The report says exactly what ran. Re-running resumes; it never repeats a recorded migration. |
| `plan` / `status` | Genuinely read-only: they never call TypeORM helpers that create the history table, and their connections are opened with `default_transaction_read_only=on`, so PostgreSQL itself would reject a write. |
| Safe defaults | `concurrency: 1`, `transaction: 'each'`, explicit tenants only, no schema auto-creation, no retries, nothing runs at app startup. |

It uses TypeORM's **public API only** (`DataSource#runMigrations`, `DataSource#migrations`, `QueryRunner`), not `MigrationExecutor`.

**Not for you if:** you use database-per-tenant, a `tenant_id` column, or a database other than PostgreSQL.

## Install

```bash
npm install typeorm-tenant-migrations typeorm pg
```

Peer dependencies: `typeorm` `>=0.3.20 <0.4 || >=1 <2`, `pg` `>=8.5.1 <9`. Node `^20.19 || ^22.13 || >=24.11`.

## Quick start

1. Make sure each tenant schema **exists** (this package never creates one).
2. Write a config. [`examples/basic`](examples/basic) is a complete, runnable project.

```js
// tenant-migrations.config.cjs
const path = require('node:path');
const { DataSource } = require('typeorm');

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  synchronize: false,
  migrationsRun: false,
  migrations: [path.join(__dirname, 'migrations', '*.js')], // classes or globs
});

module.exports = {
  dataSource, // only read for settings + migrations; never initialized or destroyed by the runner
  tenants: [
    { id: 'tenant-001', schema: 'tenant_001' },
    { id: 'tenant-002', schema: 'tenant_002' },
  ],
  options: { concurrency: 1, transaction: 'each', lockTimeoutMs: 30_000 },
};
```

3. Look, then run:

```bash
npx typeorm-tenant-migrations plan   --config ./tenant-migrations.config.cjs --all
npx typeorm-tenant-migrations run    --config ./tenant-migrations.config.cjs --tenant tenant-001
npx typeorm-tenant-migrations run    --config ./tenant-migrations.config.cjs --all
```

`run` demands exactly one of `--all` or `--tenant <id>`; running on everyone is never implicit.

### A migration for every tenant

No schema name appears anywhere:

```js
module.exports = class AddOrderStatus1700000000001 {
  name = 'AddOrderStatus1700000000001';
  async up(queryRunner) {
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN "status" text NOT NULL DEFAULT 'new'`);
  }
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "status"`);
  }
};
```

Standard TypeORM migrations; the class name must end with a 13-digit timestamp, as TypeORM requires. Generate them with TypeORM's own CLI.

## Programmatic API

```ts
import { TenantMigrationRunner } from 'typeorm-tenant-migrations';

const runner = new TenantMigrationRunner({
  dataSource,                       // a DataSource (not initialized) or plain DataSourceOptions
  tenants: async () => loadTenants(), // array, or sync/async function (e.g. read your tenant registry)
  options: { concurrency: 1, transaction: 'each', continueOnError: false, lockTimeoutMs: 30_000 },
});

const plan   = await runner.plan({ target: { all: true } });               // read-only
const status = await runner.status({ target: { tenants: ['tenant-001'] } }); // read-only
const report = await runner.run({ target: { all: true } });
if (report.summary.failed || report.summary.locked || report.summary.notStarted) process.exitCode = 1;
```

* The constructor validates the whole configuration synchronously and throws `TenantMigrationError` (`INVALID_CONFIGURATION`, …) before any connection is opened.
* `run()` throws only for configuration/selection problems (bad tenant list, unknown id, unsafe schema name). Everything that happens *per tenant* is returned in the report; nothing per-tenant is thrown.
* `plan()` and `status()` return `{ startedAt, finishedAt, summary, tenants }`.

### NestJS

There is no Nest dependency. Put your `DataSourceOptions` in a module that doesn't import Nest, use it for `TypeOrmModule.forRoot({ ...options, migrationsRun: false })` and for the migration config, and run the CLI as a **deploy step** — not at application startup. See [`examples/nestjs`](examples/nestjs/tenant-migrations.config.ts) (illustrative; no Nest application is built in this repo's tests).

## CLI

```
typeorm-tenant-migrations <plan|status|run> --config <file> (--all | --tenant <id> [--tenant <id>...]) [options]
```

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--config <file>` | all | Required. `.js` / `.cjs` / `.mjs`, or `.ts` if [`tsx`](https://tsx.is) is installed in your project. Exports `{ dataSource, tenants, options? }` as default / `module.exports`, or a (possibly async) function returning that. |
| `--all` / `--tenant <id>` | all | Exactly one form is required. `--tenant` matches the logical `id`, never a schema name; repeatable. |
| `--json` | all | Report as JSON on **stdout**. Logs always go to **stderr**, so stdout stays machine-readable. |
| `--concurrency <n>` | all | Tenants processed in parallel. Default `1`; capped by `options.maxConcurrency` (default 8). |
| `--continue-on-error` | run | Keep scheduling tenants after a failure. Default: stop scheduling new ones. |
| `--transaction <all\|each\|none>` | run | Default `each`. |
| `--lock-timeout <ms>` | run | How long to wait for a tenant's lock. Default `30000`; `0` = try once. |

CLI flags override `options` from the config file. Relative migration globs are resolved by TypeORM against the **current working directory**; use absolute paths (as the examples do) to be independent of where you start the process.

### Module formats

* **Config files.** `.js` / `.cjs` / `.mjs` (including top-level `await`) and `.ts`. TypeScript configs are imported with [`tsx`](https://tsx.is)'s `tsImport` when `tsx` can be resolved from the working directory (tested with tsx 4.x, including syntax Node cannot strip, such as `enum`). Without `tsx`, Node's own type stripping loads configs that use only erasable type syntax (Node 22.18+ / 24+; verified on 22.22); anything else fails with `INVALID_CONFIGURATION` and a message telling you to install `tsx` or point `--config` at a compiled `.js` file.
* **Migration files** are *not* loaded by this tool: TypeORM imports them through Node itself, so what Node can load is what works. Tested through the real binary: CommonJS `.js`, ES modules `.mjs` (default export, one class per file; and several named exports in one file), and TypeScript migrations that Node can strip (plain type annotations, Node 22.18+ / 24+). **TypeScript that needs a transform (`enum`, decorators, …) is not loaded, even if `tsx` is installed**; compile your migrations to JavaScript (the usual production setup) and point `migrations` at the output. When loading fails, the per-tenant error says so (`DATASOURCE_INITIALIZATION_FAILED` with a hint), e.g. a CommonJS migration inside a `"type": "module"` project.
* Migration globs are resolved by TypeORM against the current working directory; use absolute paths to be independent of it. On Windows write globs with forward slashes (`path.join(...).split(path.sep).join('/')`): a backslash is a glob escape character.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every selected tenant ended successfully (`success`, or `skipped` = already up to date). `plan`/`status`: every tenant could be inspected. |
| `1` | At least one tenant failed (migration, connection, missing schema, …) or was not started because another failed. `plan`/`status`: a tenant could not be inspected. |
| `2` | Usage / configuration / tenant-selection error. Nothing was executed. |
| `3` | At least one tenant could not get its lock in time, and nothing failed otherwise. |
| `130` | `run` was interrupted by `SIGINT`/`SIGTERM`; tenants that had not started were left untouched (see [Interruption](#interruption)). |
| `70` | Unexpected internal error. |

### Example output

Human-readable (`plan`; tenant 4's schema is missing):

```
OK       tenant-001 (tenant_001)  pending: 0
OK       tenant-002 (tenant_002)  pending: 2
      - AddOrderStatus1700000000001
      - CreateInvoices1700000000002
OK       tenant-003 (tenant_003)  pending: 2
      - AddOrderStatus1700000000001
      - CreateInvoices1700000000002
FAILED   tenant-004 (tenant_004)  pending: 0
    SCHEMA_NOT_FOUND: Schema "tenant_004" does not exist. Create it first; this package never creates schemas.
Summary: 4 tenant(s) — 4 pending migration(s) in total, 1 tenant(s) could not be inspected. Nothing was changed.
```

`run … --json` (abridged; one tenant already up to date, one migrated, one failed in preflight):

```json
{
  "runId": "d8bed6dc-32ec-47d5-bbe7-e5c5a032dbac",
  "startedAt": "2026-10-28T17:33:31.801Z",
  "finishedAt": "2026-10-28T17:33:31.969Z",
  "summary": { "total": 4, "success": 2, "failed": 1, "locked": 0, "skipped": 1, "notStarted": 0 },
  "tenants": [
    { "tenantId": "tenant-001", "schema": "tenant_001", "status": "skipped", "pendingBeforeRun": [], "executed": [], "executedKnown": true },
    {
      "tenantId": "tenant-002", "schema": "tenant_002", "status": "success",
      "pendingBeforeRun": ["AddOrderStatus1700000000001", "CreateInvoices1700000000002"],
      "executed": ["AddOrderStatus1700000000001", "CreateInvoices1700000000002"],
      "executedKnown": true, "startedAt": "2026-10-28T17:33:31.887Z", "finishedAt": "2026-10-28T17:33:31.932Z", "durationMs": 45
    },
    {
      "tenantId": "tenant-004", "schema": "tenant_004", "status": "failed",
      "pendingBeforeRun": [], "executed": [], "executedKnown": true,
      "error": { "code": "SCHEMA_NOT_FOUND", "message": "Schema \"tenant_004\" does not exist. Create it first; this package never creates schemas." }
    }
  ]
}
```

Tenant statuses: `success` (migrations ran), `skipped` (nothing pending), `failed`, `locked` (lock not obtained in time), `not-started` (never scheduled because an earlier tenant failed). `executed` is computed from the tenant's history table before vs. after — what actually committed — not from timing or from what was attempted. If the history cannot be read back after a failure (for example the database disappeared), `executedKnown` is `false` and `executed` is empty rather than guessed.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `concurrency` | `1` | Tenants in parallel, ≤ `maxConcurrency`. Each running tenant uses one lock connection plus its migration pool. Measure connection and DDL load before raising it. |
| `maxConcurrency` | `8` | Ceiling accepted for `concurrency` (hard limit 64). |
| `transaction` | `'each'` | See below. |
| `continueOnError` | `false` | See [Failure behavior](#failure-behavior). |
| `lockTimeoutMs` | `30000` | `0` = try once. There is deliberately no "wait forever". |
| `migrationsTableName` | base option, else `"migrations"` | Plain identifier only (`^[A-Za-z_][A-Za-z0-9_]{0,62}$`). |
| `searchPathMode` | `'tenant-only'` | `'tenant-first'` appends `fallbackSchemas`. |
| `fallbackSchemas` | none | Only with `'tenant-first'`. |
| `logger` | silent | `{ info, warn, error, debug? }`. The CLI uses a stderr logger. |

Unknown option names are rejected (a typo like `concurency` must not silently fall back to the default).

### Transaction modes

Passed straight to TypeORM's `runMigrations({ transaction })`:

* **`each`** *(default)* – every migration runs in its own transaction. A failing migration is rolled back completely; migrations before it stay committed and recorded.
* **`all`** – all pending migrations of a tenant in one transaction: all-or-nothing *for that tenant*. TypeORM refuses it if a pending migration sets its own `transaction` property.
* **`none`** – no transactions. A migration that fails halfway **leaves its partial changes behind** and records nothing. Tested, and documented here as a hazard.

None of these make a *batch across tenants* atomic: PostgreSQL cannot commit one migration atomically on many schemas. Some tenants may be migrated while others are not; that is exactly what the report and the resume behavior are for.

**Non-transactional migrations** (`transaction = false`, `CREATE INDEX CONCURRENTLY`, `VACUUM`, …) can fail with partial physical state. No tool can make retrying that safe automatically; inspect the tenant, fix it, then re-run. What is tested, against real PostgreSQL:

* A migration with `transaction = false` that runs `CREATE INDEX CONCURRENTLY` works in the default `each` mode, also for several tenants at once (`concurrency: 2`); the index lands in the tenant schema only.
* The same statement in a migration that did *not* opt out fails with PostgreSQL's "cannot run inside a transaction block"; nothing is recorded. In `all` mode TypeORM refuses such a migration before running anything.
* A non-transactional migration that fails halfway keeps what it already did. Example from the tests: statement 1 creates a table, statement 2 `CREATE UNIQUE INDEX CONCURRENTLY` hits duplicate data. Result: the migration is `failed`, **nothing is recorded in the history, the table stays, and PostgreSQL leaves an INVALID index behind**. Running again does *not* repair it: the migration starts over, hits "already exists", and fails again; `plan` keeps listing it as pending. After you drop the leftovers and fix the data, the same command succeeds and records it once. Other tenants in a `continueOnError` batch are unaffected.
* `transaction: 'none'` does not roll back a failing migration's earlier statements either (the contrast with `each` is tested).

Practical rule: keep non-transactional migrations to a single statement each, so a failure has nothing to leave behind except that statement's own residue (for example an invalid index you drop and recreate).

### `search_path` policy

Default `'tenant-only'`: `search_path` is exactly the tenant schema. An unqualified name that isn't in that schema **fails** (relation does not exist) instead of quietly resolving in `public`. A migration touching a shared table must qualify it: `"shared"."plans"`.

`searchPathMode: 'tenant-first', fallbackSchemas: ['public']` is available when you need it, but understand the risk: a tenant table that is missing (or misspelled) silently resolves to a same-named table in the fallback schema, and the DDL/DML lands there. This is not hypothetical: a test runs `ALTER TABLE "orders"` against a tenant that has no `orders` table and shows it altering `public.orders` under `tenant-first`, while the default `tenant-only` fails with `relation "orders" does not exist`. Prefer qualifying names explicitly.

If you set `extra.options` on your DataSource, the runner appends its own `-c search_path=…` to it. A `search_path` already present in `extra.options`, in a `url` / `extra.connectionString` `options=` parameter, or an `options` parameter in the URL is a configuration **error**, not something to merge. Tenant schema names must match `^[a-z_][a-z0-9_]*$` (max 63 chars); `public`, `information_schema`, `pg_*` are never accepted as a tenant schema.

## Interruption

* **Programmatic:** `runner.run({ target, signal })` takes an `AbortSignal`. When it aborts, no further tenant is started (they are reported `not-started`), a tenant that is only *waiting* for its lock gives up at once, and tenants already migrating **run to completion** — a migration is never cancelled midway. The report then has `interrupted: true` and is never "clean".
* **CLI:** the first `SIGINT`/`SIGTERM` during `run` does exactly that, prints the report and exits `130`. A second signal terminates the process immediately; if a transaction was open, PostgreSQL rolls it back when it notices the client is gone. `SIGKILL` (cannot be handled) behaves like that second signal.
* Tested with real signals sent to the real binary in the middle of a migration: after `SIGKILL` or a double `SIGINT`, the transaction is rolled back, the lock and the sessions are gone, and the same command completes on the next run. A migration that is not transactional (`transaction: 'none'`, `CREATE INDEX CONCURRENTLY`, …) gets no rollback in any of these cases; that is the reason the first signal waits instead of killing.

## Failure behavior

* **Preflight.** Before the first change, `run` inspects *every* selected tenant read-only: schema exists, `search_path` is right, migrations load. If any tenant fails that, nothing is migrated (default) and the rest are reported `not-started`. With `continueOnError`, healthy tenants still run and the broken one is reported `failed`. A DataSource that loads **zero** migrations is a failure (a mistyped glob must not look like success).
* **Lock.** Per tenant: acquire → re-read history *under the lock* → run → release. Not acquired within `lockTimeoutMs` → status `locked` (`CONCURRENT_MIGRATION`), migration not run.
* **During the run.** Default `continueOnError: false`: after the first `failed`/`locked` tenant no *new* tenant is started. Tenants already in flight (with `concurrency > 1`) cannot be cancelled mid-migration and are reported with their real outcome.
* **No automatic retry, no automatic rollback.**
* **Resume.** Fix the cause and run again. Tenants that are up to date are `skipped`; a partially migrated tenant continues from the first migration without a history record. Recorded migrations are never repeated.

Common causes: `SCHEMA_NOT_FOUND` (create the schema), `SCHEMA_CONTEXT_MISMATCH` (see below), `UNSUPPORTED_CONNECTION_MODE` (the advisory lock is not exclusive on this connection path, see [Connection poolers](#connection-poolers)), `CONCURRENT_MIGRATION` (another deploy is running — wait, or check `pg_locks`/`pg_stat_activity` for a stuck holder; a dead session's lock is released by PostgreSQL), `MIGRATION_FAILED` (the sanitized database error is in the report).

`SCHEMA_CONTEXT_MISMATCH` means a connection did not come up with the requested `search_path`. The classic cause is a connection pooler that does not forward the `options` startup parameter. The runner detects this and refuses to run; this is tested with a TCP proxy that strips the parameter and with a real PgBouncer. `plan`/`status` additionally verify that their `default_transaction_read_only` startup parameter took effect, and refuse otherwise.

### Connection poolers

Tested with **PgBouncer 1.22.0** (the build in Ubuntu 24.04), connecting the runner through it:

| PgBouncer setup | What happens | Safe? |
| --- | --- | --- |
| default | PgBouncer itself rejects `options=-c search_path=…` (`unsupported startup parameter`). Runner: `DATASOURCE_INITIALIZATION_FAILED`. | yes, nothing runs |
| `ignore_startup_parameters = options` (session or transaction pooling) | The parameter is silently dropped. Runner: `SCHEMA_CONTEXT_MISMATCH`. | yes, nothing runs |
| `track_extra_parameters` including `search_path` and `default_transaction_read_only` | PgBouncer 1.22 accepts but does not apply them. Runner: `SCHEMA_CONTEXT_MISMATCH`. A PgBouncer that does apply them would pass, and the tests assert isolation in that case too. | yes |
| transaction pooling, lock only | A session advisory lock is **not exclusive** here (a second client re-enters the same server session's lock). The runner proves exclusivity with a second connection after taking the lock and fails with `UNSUPPORTED_CONNECTION_MODE`. | yes, refused |

In short: **connect the migration runner directly to PostgreSQL** (or through a TCP-level proxy), not through PgBouncer. Using PgBouncer for the application and a direct connection for deploys is the normal setup anyway.

## TLS

`ssl`, `url` (`sslmode=…`) and `extra` from your DataSource are inherited by **every** connection this package opens: the tenant pool, the lock connection, the lock-exclusivity probe and the read-only inspection connections. The tests prove it by sampling `pg_stat_ssl` for all sessions of the run (a control run without `ssl` shows plaintext sessions, so the check can tell the difference), for `ssl: { … }` and for a URL with `sslmode=no-verify`.

Certificate verification itself is done by `pg` and Node, not by this package, and it is not relaxed: with an explicit CA that did not sign the server certificate, nothing runs and the report shows the TLS error (without credentials). Two things worth knowing from the test runs:

* In `pg` 8.23.1 `sslmode=require` in a URL means full verification (`verify-full`) and prints a deprecation warning about future libpq semantics; use an explicit `sslmode` or an `ssl` object.
* Hostname checking differs between `pg` versions inside the supported range. Against a server whose certificate has no matching name for the IP address in `host`, `pg` 8.23.1 refused `rejectUnauthorized: true`, while 8.5.1 and 8.11.5 connected (the 8.23.1 failure was an IP/altname mismatch, so the chain itself had been accepted in that environment). If you rely on hostname verification, pin it yourself with `ssl.ca` and a `checkServerIdentity` of your own, or use a recent `pg`.

TLS tests need a server with `ssl = on` (Debian/Ubuntu packages have it; stock docker images do not). CI turns it on in a dedicated `tls` job with a self-signed certificate and sets `TTM_REQUIRE_SSL=1`, which turns "server has no TLS" into a failure instead of a silent skip.

## Security notes

* Schema names go through a strict allowlist before they are used in SQL or connection options; the history table name too. Existence checks use bound parameters. See [`docs/safety.md`](docs/safety.md).
* Reports, logs, and CLI errors pass through a redactor: the configured password, the connection URL, anything URL-shaped, and `password=…`-style fragments are removed. SQL text and parameters are never logged, and TypeORM's own console output is silenced on tenant connections (it would otherwise print raw migration errors on stdout). This is *defense in depth* — migrations that print secrets by themselves with `console.log` are outside its reach.
* The database role does not need to be a superuser and never creates schemas or extensions. It is tested with a role that has only `CONNECT` on the database and owns the tenant schemas and their tables; it needs whatever privileges your migrations themselves need on each tenant schema, and nothing on `public`.
* Reporting vulnerabilities: see [SECURITY.md](SECURITY.md).

## Known limitations

* PostgreSQL only (driver type `postgres`). Not CockroachDB, not the `aurora-postgres` driver type, no `replication` (read replicas) configuration — the latter is rejected.
* **Connection poolers.** Per-tenant `search_path` relies on the `options` startup parameter being forwarded. If it isn't, the runner fails closed (`SCHEMA_CONTEXT_MISMATCH`). The advisory lock is session-level, so it needs a direct connection or *session* pooling; transaction pooling is unsupported (the runner detects that the lock is not exclusive and refuses). See [Connection poolers](#connection-poolers).
* No cross-tenant atomicity; no `down`/rollback command (use TypeORM's CLI per tenant if you must); no drift detection; no schema/tenant discovery or creation; no run-at-startup helper.
* The runner governs the connection context *before* your migrations. A migration that itself runs `SET search_path` (or schema-qualifies other tenants' names) can still do whatever it likes.
* Pending migrations are determined with TypeORM's rule — by **name**, not by timestamp order — so a migration with an older timestamp than the newest executed one still runs. `plan`'s independent implementation of that rule is checked against what `run` really executes in the tests, on every TypeORM version in the matrix.
* TypeORM loads entity and migration files when each tenant DataSource is initialized, so they are loaded once per tenant per phase (preflight + run); keep `entities` small in the config you use for migrations. Entities in the config are fine: with entities that include views, generated columns or uuid generation, `plan`/`status` stay read-only, `synchronize` / `dropSchema` / `installExtensions` from your config are overridden (no entity-only table is created, no extension installed), and TypeORM's own bookkeeping table `typeorm_metadata` is created **inside each tenant schema** (never in `public`) when `run` executes against such entities. All tested.
* `executedKnown: false` (history unreadable after failure) is exercised by a test that cuts the database connection mid-migration.
* Only the first-party read-only/locking guarantees listed here are tested. Anything not listed (other drivers, replication, pgBouncer transaction mode, Windows paths, …) is untested.

## Compatibility

Everything below was **actually run**; nothing is inferred. The suite is unit + integration + CLI tests against a real database.

### GitHub Actions (last verified at commit `cebfec9`: all 20 jobs green)

| TypeORM | pg | PostgreSQL | Node | Result |
| --- | --- | --- | --- | --- |
| 0.3.20 *(oldest supported)* | latest 8.x | 16 | 22 | pass |
| 0.3.20 | latest 8.x | 18 | 22 | pass |
| latest 0.3.x | latest 8.x | 16 | 22 | pass |
| latest 0.3.x | latest 8.x | 18 | 22 | pass |
| latest 0.3.x | 8.5.1 *(oldest supported)* | 16 | 22 | pass |
| latest 1.x | latest 8.x | 16 | 22 | pass |
| latest 1.x | latest 8.x | 18 | 22 | pass |
| latest 1.x | latest 8.x | 16 | 20 | pass |
| latest 1.x | latest 8.x | 16 | 24 | pass |
| latest 1.x | latest 8.x | 12 | 22 | pass |
| latest 1.x | latest 8.x | 13 | 22 | pass |
| latest 1.x | latest 8.x | 14 | 22 | pass |
| latest 1.x | latest 8.x | 15 | 22 | pass |
| latest 1.x | latest 8.x | 17 | 22 | pass |

All rows run on Ubuntu with the `postgres:<major>` image as a service container. Two more jobs run on other operating systems, with PostgreSQL installed natively (service containers exist only on Linux):

| OS (GitHub-hosted `-latest`) | PostgreSQL | Node | TypeORM / pg | Result | Not exercised there |
| --- | --- | --- | --- | --- | --- |
| macOS | 16 (Homebrew; password auth enabled in `pg_hba.conf`) | 22 | `npm ci` lockfile versions (TypeORM 0.3.31) | pass | PgBouncer and TLS tests (no PgBouncer, server without TLS) |
| Windows | 16 (Chocolatey) | 22 | `npm ci` lockfile versions (TypeORM 0.3.31) | pass | PgBouncer and TLS tests (same reason); the real-signal tests (`SIGINT`/`SIGTERM` to a child process are an unconditional terminate on Windows, so graceful interruption by signal is **not tested on Windows**) |

The run found and fixed Windows problems that Linux could not show: `tsImport` needs a file URL rather than a `D:\…` path, and migration globs must use forward slashes (see [Module formats](#module-formats)).

"latest" means whatever npm resolved when the job ran (`typeorm@0.3`, `typeorm@1`, `pg@8`), and PostgreSQL/Node are the `postgres:16` / `postgres:18` images and `setup-node` major versions; the exact patch versions were not recorded from the job logs. The test jobs install PgBouncer and run with `TTM_REQUIRE_PGBOUNCER=1`, so the PgBouncer tests cannot be skipped silently; a separate `tls` job turns TLS on in the PostgreSQL service and runs the TLS tests with `TTM_REQUIRE_SSL=1`. Two more jobs install the packed tarball into a clean directory with TypeORM 0.3 and 1 and run the README flow (CLI `plan`/`run`/`status`, CJS `require`, ESM `import`, programmatic API) against PostgreSQL 16, and one job runs lint, typecheck, build and `npm pack --dry-run`.

### Local runs with exact versions (301 tests each)

| TypeORM | pg | PostgreSQL | Node | Result |
| --- | --- | --- | --- | --- |
| 0.3.20 | 8.23.1 | 16.15 | 22.22 | 301 / 301 pass |
| 0.3.31 | 8.23.1 | 16.15 | 22.22 | 301 / 301 pass |
| 1.0.0 | 8.23.1 | 16.15 | 22.22 | 301 / 301 pass |
| 1.1.2 | 8.23.1 | 16.15 | 22.22 | 301 / 301 pass |
| 0.3.31 | 8.5.1 | 16.15 | 22.22 | 301 / 301 pass |
| 0.3.31 | 8.11.5 | 16.15 | 22.22 | 301 / 301 pass |

`pg` 8.0.x fails on current Node versions (even test fixtures), hence the `>=8.5.1` lower bound. Versions between the tested points are expected to behave the same but were not run. Not covered: PostgreSQL below 12, PostgreSQL 18 on macOS/Windows, Node other than 20/22/24 (Node 20/24 only on Linux), other architectures, TLS and PgBouncer on macOS/Windows, graceful interruption by signal on Windows, connection poolers other than PgBouncer 1.22.

## Contributing

```bash
npm ci
export TTM_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres   # a superuser; tests create+drop databases and roles
npm run lint && npm run typecheck
npm test                      # builds, then unit + integration (+ CLI against the built dist/)
scripts/test-matrix.sh        # the TypeORM version matrix, one after another
scripts/verify-tarball.sh     # pack, install into a clean dir, run the README flow
```

`npm run coverage` runs the whole suite with V8 coverage and enforces minimum thresholds (statements 96 %, branches 94 %, functions 93 %, lines 98 %; measured: 96.9 / 94.8 / 93.3 / 98.3). The thresholds are a ratchet: raise them when coverage rises. What is still uncovered are defensive fallbacks that need fault injection to reach (for example `QueryRunner#release()` itself failing, or the history table becoming unreadable right after a *successful* run). The two-line `bin.ts` entry point is excluded; it is exercised through the real spawned binary. Tests that need a real PgBouncer are skipped when no `pgbouncer` binary is found (`TTM_PGBOUNCER_BIN` overrides the lookup); locally and in CI one is installed so they run.

Every integration file creates (and drops) its own database. More in [CONTRIBUTING.md](CONTRIBUTING.md). Architecture notes: [`docs/architecture.md`](docs/architecture.md).

## License

MIT — see [LICENSE](LICENSE).
