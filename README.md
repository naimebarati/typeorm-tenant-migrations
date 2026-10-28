# typeorm-tenant-migrations

Run your normal **TypeORM migrations** across a PostgreSQL database that uses **one schema per tenant** — one tenant, a few, or all of them — with the guard rails a multi-tenant deploy needs.

> **Status: `0.1.0-alpha.1`.** The behavior described below is covered by automated tests that were run against real PostgreSQL (see [Compatibility](#compatibility)). It is an alpha: read [Known limitations](#known-limitations) before pointing it at production data, and try it on a copy first.

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

Config files in TypeScript need `tsx` (`npm i -D tsx`). Without it you get an error telling you so. The TS path is covered by a test using tsx 4.x on Node 22.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every selected tenant ended successfully (`success`, or `skipped` = already up to date). `plan`/`status`: every tenant could be inspected. |
| `1` | At least one tenant failed (migration, connection, missing schema, …) or was not started because another failed. `plan`/`status`: a tenant could not be inspected. |
| `2` | Usage / configuration / tenant-selection error. Nothing was executed. |
| `3` | At least one tenant could not get its lock in time, and nothing failed otherwise. |
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

**Non-transactional migrations** (`transaction = false`, `CREATE INDEX CONCURRENTLY`, `VACUUM`, …) can fail with partial physical state. No tool can make retrying that safe automatically; inspect the tenant, fix it, then re-run.

### `search_path` policy

Default `'tenant-only'`: `search_path` is exactly the tenant schema. An unqualified name that isn't in that schema **fails** (relation does not exist) instead of quietly resolving in `public`. A migration touching a shared table must qualify it: `"shared"."plans"`.

`searchPathMode: 'tenant-first', fallbackSchemas: ['public']` is available when you need it, but understand the risk: a tenant table that is missing (or misspelled) silently resolves to a same-named table in the fallback schema, and the DDL/DML lands there. Prefer qualifying names explicitly.

If you set `extra.options` on your DataSource, the runner appends its own `-c search_path=…` to it. A `search_path` already present in `extra.options`, in a `url` / `extra.connectionString` `options=` parameter, or an `options` parameter in the URL is a configuration **error**, not something to merge. Tenant schema names must match `^[a-z_][a-z0-9_]*$` (max 63 chars); `public`, `information_schema`, `pg_*` are never accepted as a tenant schema.

## Failure behavior

* **Preflight.** Before the first change, `run` inspects *every* selected tenant read-only: schema exists, `search_path` is right, migrations load. If any tenant fails that, nothing is migrated (default) and the rest are reported `not-started`. With `continueOnError`, healthy tenants still run and the broken one is reported `failed`. A DataSource that loads **zero** migrations is a failure (a mistyped glob must not look like success).
* **Lock.** Per tenant: acquire → re-read history *under the lock* → run → release. Not acquired within `lockTimeoutMs` → status `locked` (`CONCURRENT_MIGRATION`), migration not run.
* **During the run.** Default `continueOnError: false`: after the first `failed`/`locked` tenant no *new* tenant is started. Tenants already in flight (with `concurrency > 1`) cannot be cancelled mid-migration and are reported with their real outcome.
* **No automatic retry, no automatic rollback.**
* **Resume.** Fix the cause and run again. Tenants that are up to date are `skipped`; a partially migrated tenant continues from the first migration without a history record. Recorded migrations are never repeated.

Common causes: `SCHEMA_NOT_FOUND` (create the schema), `SCHEMA_CONTEXT_MISMATCH` (see below), `CONCURRENT_MIGRATION` (another deploy is running — wait, or check `pg_locks`/`pg_stat_activity` for a stuck holder; a dead session's lock is released by PostgreSQL), `MIGRATION_FAILED` (the sanitized database error is in the report).

`SCHEMA_CONTEXT_MISMATCH` means a connection did not come up with the requested `search_path`. The classic cause is a connection pooler that does not forward the `options` startup parameter (check your pooler's startup-parameter settings). The runner detects this and refuses to run; this behavior is tested with a TCP proxy that strips the parameter.

## Security notes

* Schema names go through a strict allowlist before they are used in SQL or connection options; the history table name too. Existence checks use bound parameters. See [`docs/safety.md`](docs/safety.md).
* Reports, logs, and CLI errors pass through a redactor: the configured password, the connection URL, anything URL-shaped, and `password=…`-style fragments are removed. SQL text and parameters are never logged, and TypeORM's own console output is silenced on tenant connections (it would otherwise print raw migration errors on stdout). This is *defense in depth* — migrations that print secrets by themselves with `console.log` are outside its reach.
* The database role does not need to be a superuser and never creates schemas or extensions. It is tested with a role that has only `CONNECT` on the database and owns the tenant schemas and their tables; it needs whatever privileges your migrations themselves need on each tenant schema, and nothing on `public`.
* Reporting vulnerabilities: see [SECURITY.md](SECURITY.md).

## Known limitations

* PostgreSQL only (driver type `postgres`). Not CockroachDB, not the `aurora-postgres` driver type, no `replication` (read replicas) configuration — the latter is rejected.
* **Connection poolers.** Per-tenant `search_path` relies on the `options` startup parameter being forwarded. If it isn't, the runner fails closed (`SCHEMA_CONTEXT_MISMATCH`). The advisory lock is session-level, so it needs a direct connection or *session* pooling; transaction-pooling modes are unsupported and untested.
* No cross-tenant atomicity; no `down`/rollback command (use TypeORM's CLI per tenant if you must); no drift detection; no schema/tenant discovery or creation; no run-at-startup helper.
* The runner governs the connection context *before* your migrations. A migration that itself runs `SET search_path` (or schema-qualifies other tenants' names) can still do whatever it likes.
* Pending migrations are determined with TypeORM's rule — by **name**, not by timestamp order — so a migration with an older timestamp than the newest executed one still runs. `plan`'s independent implementation of that rule is checked against what `run` really executes in the tests, on every TypeORM version in the matrix.
* TypeORM's migration loading happens when each tenant DataSource is initialized, so entity/migration files are loaded once per tenant per phase (preflight + run). Keep `entities` empty or small in the config used for migrations.
* `executedKnown: false` (history unreadable after failure) is exercised by a test that cuts the database connection mid-migration.
* Only the first-party read-only/locking guarantees listed here are tested. Anything not listed (other drivers, replication, pgBouncer transaction mode, Windows paths, …) is untested.

## Compatibility

Everything below was **actually run**; nothing is inferred. "Tests" is the full suite (unit + integration + CLI against a real database): 198 tests.

| TypeORM | pg | PostgreSQL | Node | Result |
| --- | --- | --- | --- | --- |
| 0.3.20 *(oldest supported)* | 8.23.1 | 16.15 | 22.22 | 198 / 198 pass |
| 0.3.31 *(latest 0.3.x)* | 8.23.1 | 16.15 | 22.22 | 198 / 198 pass |
| 1.0.0 | 8.23.1 | 16.15 | 22.22 | 198 / 198 pass |
| 1.1.2 *(latest 1.x)* | 8.23.1 | 16.15 | 22.22 | 198 / 198 pass |
| 0.3.31 | 8.5.1 *(oldest supported)* | 16.15 | 22.22 | 198 / 198 pass |
| 0.3.31 | 8.11.5 | 16.15 | 22.22 | 198 / 198 pass |

`pg` 8.0.x fails on current Node versions (even test fixtures), hence the `>=8.5.1` lower bound. Versions between the tested points are expected to behave the same but were not run.

**PostgreSQL 18 and other Node versions:** the CI workflow in this repo defines a PostgreSQL 16/18 × TypeORM matrix, but it had not been executed by GitHub Actions when this table was written, so those cells are intentionally empty here. Update this table from green CI runs.

The installed-from-tarball flow (`scripts/verify-tarball.sh`: pack → install into a clean directory → CLI `plan`/`run`/`status`, CJS `require`, ESM `import`, programmatic API) was run with TypeORM 1.1.2 and 0.3.31.

## Contributing

```bash
npm ci
export TTM_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres   # a superuser; tests create+drop databases and roles
npm run lint && npm run typecheck
npm test                      # builds, then unit + integration (+ CLI against the built dist/)
scripts/test-matrix.sh        # the TypeORM version matrix, one after another
scripts/verify-tarball.sh     # pack, install into a clean dir, run the README flow
```

Every integration file creates (and drops) its own database. More in [CONTRIBUTING.md](CONTRIBUTING.md). Architecture notes: [`docs/architecture.md`](docs/architecture.md).

## License

MIT — see [LICENSE](LICENSE).
