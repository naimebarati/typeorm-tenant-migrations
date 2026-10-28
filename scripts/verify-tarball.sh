#!/usr/bin/env bash
# Packs the project, installs the tarball into a clean directory like a user would, and runs the
# README flow against a real PostgreSQL: CLI plan/status/run, rerun, ESM and CJS imports, programmatic API.
# Usage: TTM_TEST_PG_URL=postgres://user:pass@host:5432/postgres scripts/verify-tarball.sh [typeorm_range]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TYPEORM_RANGE=${1:-latest}
PG_URL=${TTM_TEST_PG_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}

WORK="$ROOT/.tmp/verify-$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

npm run build --silent
TARBALL=$(npm pack --silent --pack-destination "$WORK" | tail -1)
echo "packed: $TARBALL"

# A scratch database so nothing else is touched.
DBNAME="ttm_verify_$$"
PSQL_ADMIN=(psql "$PG_URL" -v ON_ERROR_STOP=1 -q)
"${PSQL_ADMIN[@]}" -c "CREATE DATABASE $DBNAME"
trap '"${PSQL_ADMIN[@]}" -c "DROP DATABASE IF EXISTS $DBNAME WITH (FORCE)" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
DB_URL=$(node -e "const u=new URL(process.argv[1]); u.pathname='/'+process.argv[2]; console.log(u.toString())" "$PG_URL" "$DBNAME")
export DB_HOST=$(node -e "console.log(new URL(process.argv[1]).hostname)" "$PG_URL")
export DB_PORT=$(node -e "console.log(new URL(process.argv[1]).port||5432)" "$PG_URL")
export DB_USER=$(node -e "console.log(decodeURIComponent(new URL(process.argv[1]).username))" "$PG_URL")
export DB_PASSWORD=$(node -e "console.log(decodeURIComponent(new URL(process.argv[1]).password))" "$PG_URL")
export DB_NAME=$DBNAME

PROJECT="$WORK/project"
cp -r examples/basic "$PROJECT"
cd "$PROJECT"
npm install --silent --no-audit --no-fund "$WORK/$TARBALL" "typeorm@$TYPEORM_RANGE" pg >/dev/null
echo "installed: typeorm $(node -p "require('typeorm/package.json').version" 2>/dev/null || grep -m1 '"version"' node_modules/typeorm/package.json) / $(grep -m1 '"version"' node_modules/typeorm-tenant-migrations/package.json)"

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f setup.sql

BIN=./node_modules/.bin/typeorm-tenant-migrations
CFG=./tenant-migrations.config.cjs

echo "--- bin is executable and prints its version"
$BIN --version

echo "--- packed files are importable (CJS require, ESM import)"
node -e "const m=require('typeorm-tenant-migrations'); for (const k of ['TenantMigrationRunner','TenantMigrationError','ERROR_CODES','isCleanReport','createConsoleLogger']) if(!(k in m)) throw new Error('missing export '+k); console.log('cjs ok')"
node --input-type=module -e "import { TenantMigrationRunner, TenantMigrationError } from 'typeorm-tenant-migrations'; if (typeof TenantMigrationRunner !== 'function') throw new Error('esm named import failed'); console.log('esm ok')"

echo "--- plan (read-only): history tables must not appear"
$BIN plan --config $CFG --all
if [ "$(psql "$DB_URL" -tA -c "select count(*) from information_schema.tables where table_name='migrations'")" != "0" ]; then echo "plan created a history table"; exit 1; fi

echo "--- run one tenant, then all"
$BIN run --config $CFG --tenant tenant-001
$BIN run --config $CFG --all --json > run-all.json
node -e "const r=require('./run-all.json'); if (r.summary.skipped!==1||r.summary.success!==1) throw new Error('unexpected summary '+JSON.stringify(r.summary)); console.log('json summary ok', JSON.stringify(r.summary))"

echo "--- rerun is a no-op, status agrees"
$BIN run --config $CFG --all
$BIN status --config $CFG --all

echo "--- programmatic API from the example"
node run.mjs

echo "--- isolation check"
test "$(psql "$DB_URL" -tA -c "select count(*) from information_schema.columns where table_schema='public'")" = "0"
test "$(psql "$DB_URL" -tA -c "select count(*) from tenant_001.migrations")" = "2"
test "$(psql "$DB_URL" -tA -c "select count(*) from tenant_002.migrations")" = "2"
echo "VERIFY OK"
