# Safety model

What is guaranteed, how, and which test pins it. If a row has no test, it isn't a guarantee.

| Guarantee | Mechanism | Test |
| --- | --- | --- |
| Unqualified SQL hits only the target schema | `search_path` set as connection startup parameter on every pooled connection | `schema-isolation.test.ts`, `runner.test.ts`, `typeorm-schema-behavior.test.ts` (shows the problem without it) |
| Wrong context ⇒ nothing runs | live check of `search_path` + `current_schema()` before locking/migrating | `runner-failure.test.ts` (TCP proxy that strips the startup option) |
| No SQL injection through names | schema `^[a-z_][a-z0-9_]*$`, ≤ 63 chars, reserved names refused; history table `^[A-Za-z_][A-Za-z0-9_]{0,62}$`; existence checks with bind parameters | `targets.test.ts`, `options.test.ts` |
| `public` / system schemas never targeted | reserved-name check on every tenant at validation time | `targets.test.ts`, `runner.test.ts` |
| Schemas are never created | no `CREATE SCHEMA` anywhere; missing schema ⇒ `SCHEMA_NOT_FOUND` | `runner.test.ts` |
| `plan`/`status` write nothing | no TypeORM helper that creates the table; read-only startup parameter makes PostgreSQL reject writes | `runner.test.ts` (whole-database snapshots), `schema-isolation.test.ts` |
| One migrator per tenant | session advisory lock, bounded wait, fail closed | `advisory-lock.test.ts`, `runner-concurrency.test.ts`, `cli.test.ts` (two OS processes) |
| Lock is really exclusive on this connection path | after locking, a second connection must fail to take the same key; otherwise `UNSUPPORTED_CONNECTION_MODE` and explicit unlock | `pgbouncer.test.ts` (real PgBouncer, transaction pooling) |
| Read-only inspection is really read-only | `default_transaction_read_only` startup parameter, and a check that it took effect | `schema-isolation.test.ts`, `pgbouncer.test.ts` |
| Interrupted run leaves nothing half-done | graceful stop; PostgreSQL rolls back an open transaction when the client dies | `cli-interrupt.test.ts` (real SIGKILL / SIGINT / SIGTERM), `runner-abort.test.ts` |
| Lock never outlives the run | dedicated 1-connection DataSource destroyed in `finally`; crashed holder's lock dies with its session | `advisory-lock.test.ts`, `runner.test.ts`, `runner-failure.test.ts` |
| No leaked connections | every DataSource/QueryRunner the runner opens is released in `finally` | `waitForNoSessions` assertions throughout |
| Caller's DataSource untouched | options copied (incl. `extra`), instance never initialized/destroyed | `runner.test.ts`, `tenant-data-source-options.test.ts` |
| Secrets not in reports/logs/CLI output | redactor on every message; SQL and TypeORM console output silenced | `runner-security.test.ts`, `cli.test.ts` |
| No automatic retry/rollback | none implemented | failure tests (`runner-failure.test.ts`) |

## What is not protected

* A migration that changes its own `search_path`, or schema-qualifies another tenant's objects.
* Atomicity across tenants.
* `transaction: 'none'` and non-transactional statements leave partial state on failure (demonstrated in `runner-failure.test.ts`).
* Poolers in transaction mode: detected and refused, not supported.
* Non-transactional statements interrupted by a second signal or `SIGKILL`.
* Anything that connects without going through this runner.

## Operating checklist

1. `plan` first; read it.
2. Back up (or test on a clone). Migrations are your SQL; this tool constrains *where* it runs, not *what* it does.
3. Prefer the default `tenant-only` path and qualify shared tables explicitly.
4. Keep `transaction: 'each'` unless you've read the section on `all`/`none`.
5. Deploy via the CLI as a separate step, never from application startup.
6. After a failure, read the report, fix, re-run. Check the tenant's physical state first if a non-transactional migration was involved.
