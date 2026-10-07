#!/usr/bin/env bash
# ===========================================================================
# BankOne publish department rollup + snapshot-sourced executive financials
# acceptance against a live Postgres (migration 20261102000001).
#
# Applies (idempotently):
#   1. 20260931000002 — bankone import lifecycle + publish (authoritative
#      publish body; re-applied first so this suite works on a fresh DB).
#   2. 20261102000001 — the rollup/aggregates/director-sync migration.
# Then replays tests/acceptance/bankoneDepartmentRollup.sql, which asserts
# publish aggregates, department rows, the PAR gate, rollup idempotency,
# supersede-on-republish, and a live get_director_executive_snapshot call
# whose figures come from the published snapshot.
#
# The SQL runs in a transaction and ends in ROLLBACK, so no test data
# survives. Local docker only. Set PG_CONTAINER to override the container.
#
# NOTE: scripts/test-bankone-e2e.sh re-applies 20260931000002, which
# temporarily reverts publish to the pre-rollup body — re-run this script
# afterwards to restore the re-issued publish in the local DB.
# ===========================================================================
set -euo pipefail

CONTAINER="${PG_CONTAINER:-supabase_db_infinitycore-sara}"
SQL="tests/acceptance/bankoneDepartmentRollup.sql"
MIGRATION_BASE="supabase/migrations/20260931000002_bankone_import_lifecycle_and_publish.sql"
MIGRATION="supabase/migrations/20261102000001_bankone_publish_rollup_and_executive_sync.sql"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "SKIP: container '$CONTAINER' is not running."
  echo "      Start it (docker compose -f docker-compose.base44.yml up -d) to run this suite."
  exit 0
fi

echo "==> applying the lifecycle migration (idempotent)"
docker cp "$MIGRATION_BASE" "$CONTAINER:/tmp/bankone_lifecycle.sql" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  -f /tmp/bankone_lifecycle.sql >/dev/null

echo "==> applying the rollup + executive sync migration (idempotent)"
docker cp "$MIGRATION" "$CONTAINER:/tmp/bankone_rollup.sql" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  -f /tmp/bankone_rollup.sql >/dev/null

echo "==> replaying the rollup acceptance scenarios"
docker cp "$SQL" "$CONTAINER:/tmp/bankone_rollup_test.sql" >/dev/null
LOG="$(mktemp)"
if ! docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f /tmp/bankone_rollup_test.sql >"$LOG" 2>&1; then
  echo "FAILED:"
  grep -E 'ERROR|ASSERTION|CONTEXT|DETAIL' "$LOG" | head -30
  rm -f "$LOG"
  exit 1
fi

grep 'PASS:' "$LOG" | sed 's/^psql[^:]*:[0-9]*: *NOTICE:  //' | sed 's/^/  /'
rm -f "$LOG"
echo
echo "All BankOne rollup + executive sync scenarios passed."
