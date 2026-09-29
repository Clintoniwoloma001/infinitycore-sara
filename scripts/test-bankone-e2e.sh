#!/usr/bin/env bash
# ===========================================================================
# BankOne import end-to-end acceptance against a live Postgres.
#
# Replays tests/acceptance/bankoneImportEndToEnd.sql, which builds a 2,725-row
# dataset with the real file's characteristics and asserts the whole pipeline:
# parse -> branch accept -> officer decisions -> publish -> snapshot integrity.
#
# It proves the reported bug is fixed: branch "Accept" used to run an UPDATE
# that matched ZERO rows (JS and SQL normalized branch names differently) and
# still reported success. Every scenario asserts on rows ACTUALLY changed.
#
# The SQL runs in a transaction and ends in ROLLBACK, so no test data survives.
#
# Local docker only. Set PG_CONTAINER to override the container name.
# ===========================================================================
set -euo pipefail

CONTAINER="${PG_CONTAINER:-supabase_db_infinitycore-sara}"
SQL="tests/acceptance/bankoneImportEndToEnd.sql"
MIGRATION="supabase/migrations/20260931000002_bankone_import_lifecycle_and_publish.sql"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "SKIP: container '$CONTAINER' is not running."
  echo "      Start it (docker compose -f docker-compose.base44.yml up -d) to run this suite."
  exit 0
fi

echo "==> applying the lifecycle migration (idempotent)"
docker cp "$MIGRATION" "$CONTAINER:/tmp/bankone_lifecycle.sql" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  -f /tmp/bankone_lifecycle.sql >/dev/null

echo "==> replaying the end-to-end scenarios"
docker cp "$SQL" "$CONTAINER:/tmp/bankone_e2e.sql" >/dev/null
LOG="$(mktemp)"
if ! docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f /tmp/bankone_e2e.sql >"$LOG" 2>&1; then
  echo "FAILED:"
  grep -E 'ERROR|ASSERTION|CONTEXT|DETAIL' "$LOG" | head -20
  rm -f "$LOG"
  exit 1
fi

grep 'PASS:' "$LOG" | sed 's/^psql[^:]*:[0-9]*: *NOTICE:  //' | sed 's/^/  /'
rm -f "$LOG"
echo
echo "All BankOne import end-to-end scenarios passed."
