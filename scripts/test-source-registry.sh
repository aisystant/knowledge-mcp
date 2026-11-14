#!/usr/bin/env bash
set -euo pipefail

: "${TEST_ADMIN_DATABASE_URL:?set TEST_ADMIN_DATABASE_URL to a disposable PostgreSQL admin database}"
if [[ "$TEST_ADMIN_DATABASE_URL" == *\?* ]]; then
  echo "TEST_ADMIN_DATABASE_URL with query parameters is not supported; use connection environment variables instead" >&2
  exit 2
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DB_NAME="wp604_source_registry_$(date +%s)_$$"
PSQL=(psql "$TEST_ADMIN_DATABASE_URL" -X --no-password -v ON_ERROR_STOP=1)

cleanup() {
  if [[ "${TEST_KEEP_DATABASE:-0}" == "1" ]]; then
    echo "Kept test database: $DB_NAME"
  else
    "${PSQL[@]}" -c "DROP DATABASE IF EXISTS $DB_NAME" >/dev/null
  fi
}
trap cleanup EXIT

set_db_url() {
  if [[ "$TEST_ADMIN_DATABASE_URL" == */* ]]; then
    DB_URL="${TEST_ADMIN_DATABASE_URL%/*}/$DB_NAME"
  else
    DB_URL="$DB_NAME"
  fi
}

"${PSQL[@]}" -c "CREATE DATABASE $DB_NAME" >/dev/null
set_db_url
run_sql() {
  psql "$DB_URL" -X --no-password -v ON_ERROR_STOP=1 "$@"
}

run_sql -c "CREATE SCHEMA knowledge"
run_sql -f "$ROOT/migrations/033-source-registry.sql"
run_sql -f "$ROOT/scripts/check-source-registry.sql"
if run_sql -f "$ROOT/migrations/033-source-registry-down.sql" >/dev/null 2>&1; then
  echo "FAIL: down migration dropped a non-empty audit journal" >&2
  exit 1
fi
if [[ $(run_sql -Atc "SELECT count(*) FROM knowledge.source_access_decisions") != "1" ]]; then
  echo "FAIL: refused down migration damaged the audit journal" >&2
  exit 1
fi

cleanup
if [[ "${TEST_KEEP_DATABASE:-0}" == "1" ]]; then
  DB_NAME="${DB_NAME}_empty"
fi
"${PSQL[@]}" -c "CREATE DATABASE $DB_NAME" >/dev/null
set_db_url
run_sql -c "CREATE SCHEMA knowledge"
run_sql -f "$ROOT/migrations/033-source-registry.sql"
run_sql -f "$ROOT/migrations/033-source-registry-down.sql"
run_sql -c "CREATE SCHEMA IF NOT EXISTS knowledge"
run_sql -f "$ROOT/migrations/033-source-registry.sql"
run_sql -f "$ROOT/migrations/033-source-registry-down.sql"
cleanup

echo "OK: source registry checks and empty up/down/up cycle passed"
