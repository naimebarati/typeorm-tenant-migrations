# Contributing

Correctness and database safety come before features. A change that touches schema isolation, locking, or read-only behavior needs an integration test against real PostgreSQL; mocks don't count as proof for those.

## Setup

```bash
npm ci
export TTM_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
```

The server must enforce passwords on TCP (some tests prove that a wrong password is rejected and does not leak; they fail early with an explanation if pg_hba.conf says `trust`, which is Homebrew's default). The role in `TTM_TEST_PG_URL` must be a superuser (tests create and drop databases and throwaway roles, including a `SUPERUSER` one to prove secrets are scrubbed). Each integration file creates its own database and drops it afterwards.

`TTM_REQUIRE_PGBOUNCER=1` and `TTM_REQUIRE_SSL=1` turn "PgBouncer / TLS not available" from a skip into a failure (CI sets them). Optional locally: install `pgbouncer` (or set `TTM_PGBOUNCER_BIN`) so `pgbouncer.test.ts` runs instead of being skipped. The tests start their own PgBouncer on a free port (as the `postgres` user when run as root, since PgBouncer refuses to run as root).

## Checks

```bash
npm run lint
npm run typecheck
npm test                      # builds dist/ first (CLI tests run the built binary)
npm run coverage              # same suite + coverage gate (see vitest.config.mts)
scripts/test-matrix.sh [versions...]   # default: 0.3.20 0.3.31 1.0.0 1.1.2
scripts/verify-tarball.sh [typeorm-range]
node scripts/load-test.mjs --tenants 300     # load test; builds dist/ first, so it never measures a stale build
npm pack --dry-run
```

`scripts/test-matrix.sh` installs TypeORM versions with `--no-save`; run `npm ci` afterwards to restore the lockfile versions.

## Guidelines

* Public TypeORM API only. If a change needs `MigrationExecutor` or another internal, write down why, and what the alternatives were, in `docs/architecture.md`.
* Don't claim support for something that has no test. The README's compatibility table is filled from runs only.
* New defaults must be at least as conservative as the old ones.

* Coverage thresholds only go up. If a change lowers coverage, add the test; don't lower the threshold.
