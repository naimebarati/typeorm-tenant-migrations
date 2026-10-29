# Changelog

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
