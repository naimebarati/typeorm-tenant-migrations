#!/usr/bin/env bash
# Runs typecheck + the full test suite against specific TypeORM / pg versions, one after another.
# Usage: scripts/test-matrix.sh [typeorm_version ...]   (default: the compatibility matrix below)
# Needs a reachable PostgreSQL (see TTM_TEST_PG_URL in CONTRIBUTING.md). Leaves the last version installed
# (without touching package.json); `npm ci` restores the lockfile versions.
set -u
cd "$(dirname "$0")/.."

VERSIONS=("$@")
if [ ${#VERSIONS[@]} -eq 0 ]; then
  VERSIONS=(0.3.20 0.3.31 1.0.0 1.1.2)
fi

status=0
for v in "${VERSIONS[@]}"; do
  echo "=== typeorm@$v ==="
  npm install --no-save --no-audit --no-fund "typeorm@$v" >/dev/null 2>&1 || { echo "install failed"; status=1; continue; }
  installed=$(node -e "console.log(JSON.parse(require('fs').readFileSync('node_modules/typeorm/package.json','utf8')).version)")
  echo "installed: $installed"
  if npx tsc -p tsconfig.test.json && npx vitest run; then
    echo "RESULT typeorm@$installed: PASS"
  else
    echo "RESULT typeorm@$installed: FAIL"
    status=1
  fi
done
exit $status
