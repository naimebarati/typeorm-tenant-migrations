# Changelog

## Unreleased

* **New: `revert`** (`runner.revert({ tenant, migration, signal? })` and `typeorm-tenant-migrations revert --tenant <id> --migration <name>`): reverts one migration on one tenant, only if the named migration is the last executed one of that tenant's history. Same DataSource, context check and advisory lock as `run`; refuses (`REVERT_REFUSED`, nothing executed) when the name is not the last executed migration, when there is no history (TypeORM's own undo would create the table), or when the migration is not known to this build. No `--all`, no steps. Exports `RevertParams`, `TenantRevertReport`, `TenantRevertResult`.
* New error code `REVERT_REFUSED`.
* **Typing change:** `error.code` in `TenantMigrationResult`, `TenantPlanEntry` and `TenantStatusEntry` is now `TenantMigrationErrorCode` instead of `string`. Code that builds such objects by hand with a plain `string` code no longer compiles.
* README: error-code table and the policy that new codes may be added in a minor release; the CLI's error JSON shape and `INTERNAL_ERROR`; non-goals stated explicitly (cross-tenant atomicity, multi-tenant revert, drift detection, run-at-startup).

## 0.1.0-alpha.3

Unlike `0.1.0-alpha.2`, this one changes the package's code: the first two items below are in `dist/`, the third is documentation only.

* **Every connection of a tenant's pool now proves its `search_path` before it is handed out** (and read-only mode, for `plan`/`status`/preflight). Until now only the connection the runner used was checked, so behind a pooler that drops startup options for some connections (PgBouncer 1.26.1, session pooling, PostgreSQL < 18) a migration that opened a second pooled connection ran its SQL in `public` and the run reported success; a regression test with a TCP proxy reproduced that (a row landed in `public.orders`). A connection that fails the check is closed and the operation that needed it fails with `SCHEMA_CONTEXT_MISMATCH`. Cost: one query per newly opened connection. Implemented as a `pg` client class given to the pool as `extra.Client`; a caller's own `extra.Client` is extended, not replaced (and a non-class `extra.Client` is an `INVALID_CONFIGURATION`).
* Hardening from a security read-through of `src/`: the history query checks its schema and table names itself instead of relying on its callers, the TLS key passphrase is redacted from reports and logs, and tenant ids containing control, invisible formatting or line-separator characters are refused (two limits are documented in `docs/safety.md`).
* README: measured PgBouncer 1.22.0, 1.25.1 and 1.26.1 behavior (`scripts/probe-pgbouncer.mjs`); native-OS and arm64 CI jobs; PostgreSQL below 12 is not supported.

## 0.1.0-alpha.2

No change to the package's code: `dist/` is built from the same sources as `0.1.0-alpha.1`. What differs is how it is published and checked.

* First release published from GitHub Actions (`.github/workflows/release.yml`) through npm trusted publishing, with provenance. The workflow refuses a tag that does not match `package.json`, is not on `main`, or is already published, and runs lint, typecheck and the full test suite against PostgreSQL 16 before `npm publish`.
* CI also runs weekly, retries the Chocolatey PostgreSQL install on Windows, and installs the TypeORM / `pg` versions of each matrix entry in one command and asserts them (before, every job ran TypeORM 0.3.31 whatever the matrix said).
* The TLS test for the read-only inspection connections now observes them for about 1.5 s instead of one `plan`/`status` pass; it could miss every session on a loaded runner.
* The README gives the exact dependency versions and the test counts, including the skipped tests, of the macOS and Windows jobs, read from the CI logs.

## 0.1.0-alpha.1

First alpha. Not production-hardened; see "Known limitations" in the README.

* `TenantMigrationRunner` (`run`, `plan`, `status`) and CLI with the same verbs.
* Per-tenant DataSource with `search_path` set as a connection startup parameter and verified on a live connection (fail-closed).
* Per-tenant TypeORM history table; session-level advisory lock per tenant schema with bounded wait.
* Read-only `plan`/`status` (PostgreSQL-enforced read-only connections).
* Bounded concurrency (default 1), transaction modes `each` (default) / `all` / `none`, fail-fast or `continueOnError`.
* JSON reports, documented exit codes, secret redaction.
* New error code `UNSUPPORTED_CONNECTION_MODE`: after taking a tenant's advisory lock the runner proves from a second connection that the lock is exclusive, and refuses otherwise (transaction pooling). The lock is released explicitly on that path, because behind a pooler closing the connection does not end the server session.
* `plan`/`status`/preflight verify that `default_transaction_read_only` took effect on the connection, instead of assuming a pooler forwarded it.
* Graceful interruption: `run({ signal })` and, in the CLI, the first `SIGINT`/`SIGTERM` finish the tenants already running, start no new ones and print the report (`interrupted: true`, exit code `130`); a second signal aborts immediately.
* Fix: TypeScript configs are now imported through tsx's `tsImport`. The previous attempt to register tsx globally never took effect (wrong loader path, and Node's own type stripping on 22.18+/24 handles `.ts` first); the test for it passed only because Node could load that file by itself. A config using `enum` now loads when tsx is installed.
* Module-loading failures of migration files (TypeScript Node cannot strip, CommonJS/ES module mix-ups) now carry a hint that says what to do.
* Before a run with `concurrency` above 1 the runner logs a warning when `3 × concurrency + 1` connections do not fit into the free slots of the server (it never refuses). Measured: peak connections are 3 at concurrency 1 and about 2.6 × concurrency at 16; memory stays flat over ~9 000 tenant operations.
* `scripts/load-test.mjs` and a scaled-down scale test in the suite.
* `dataSource: null` now fails with `INVALID_CONFIGURATION` instead of a raw `TypeError`; the CLI logger honors the `io.stderr` stream it is given.
