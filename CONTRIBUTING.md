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

## CI and releases

* `ci.yml` runs on every push to `main`, on pull requests, on demand, and once a week (Mondays, default branch). The weekly run exists because the matrix installs the newest 0.3.x / 1.x TypeORM and `pg` 8.x: a new upstream release can break this package without any push here.
* Releases go through `release.yml` with npm trusted publishing, so no npm token is stored. One-time setup on npmjs.com: the package's Settings > Trusted Publisher > GitHub Actions, with this repository and the workflow file name `release.yml`.
  1. Set `version` in `package.json`, update `CHANGELOG.md`, merge to `main`, wait for a green `ci.yml`.
  2. `git tag v<version> && git push origin v<version>`. The workflow refuses a tag that does not match `package.json`, is not on `main`, or whose version is already published; it then runs lint, typecheck and the full test suite against PostgreSQL 16 and runs `npm publish --provenance`.
  3. The npm dist-tag comes from the version: `0.2.0-beta.1` is published as `beta`, `1.0.0-rc.1` as `rc`, `1.0.0` as `latest`.
* *Actions > Release > Run workflow* on any branch runs the same checks and ends in `npm publish --dry-run`, so the pipeline can be exercised without publishing.
