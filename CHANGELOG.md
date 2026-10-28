# Changelog

## 0.1.0-alpha.1

First alpha. Not production-hardened; see "Known limitations" in the README.

* `TenantMigrationRunner` (`run`, `plan`, `status`) and CLI with the same verbs.
* Per-tenant DataSource with `search_path` set as a connection startup parameter and verified on a live connection (fail-closed).
* Per-tenant TypeORM history table; session-level advisory lock per tenant schema with bounded wait.
* Read-only `plan`/`status` (PostgreSQL-enforced read-only connections).
* Bounded concurrency (default 1), transaction modes `each` (default) / `all` / `none`, fail-fast or `continueOnError`.
* JSON reports, documented exit codes, secret redaction.
