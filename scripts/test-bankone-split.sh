#!/usr/bin/env bash
# ===========================================================================
# BankOne branch-split contract: verifies the reported failure and the silent
# bug behind it.
#
# Replays tests/acceptance/bankoneSplitContract.sql, which asserts that
# split_bankone_branch exposes exactly ONE definition with the snake_case
# argument names the frontend sends, that a split actually re-points loans
# (the legacy version reported success while re-pointing ZERO), that it is
# idempotent, and that authorization is still enforced.
#
# Runs in a transaction and ends in ROLLBACK, so no test data survives.
# Local docker only. Set PG_CONTAINER to override the container name.
# ===========================================================================
set -euo pipefail

CONTAINER="${PG_CONTAINER:-supabase_db_infinitycore-sara}"
SQL="tests/acceptance/bankoneSplitContract.sql"
MIGRATION="supabase/migrations/20260931000003_bankone_split_branch_contract.sql"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "SKIP: container '$CONTAINER' is not running."
  echo "      Start it (docker compose -f docker-compose.base44.yml up -d) to run this suite."
  exit 0
fi

echo "==> applying the split-contract migration (idempotent)"
docker cp "$MIGRATION" "$CONTAINER:/tmp/bankone_split.sql" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  -f /tmp/bankone_split.sql >/dev/null

echo "==> replaying the split-contract scenarios"
docker cp "$SQL" "$CONTAINER:/tmp/bankone_split_test.sql" >/dev/null
LOG="$(mktemp)"
if ! docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f /tmp/bankone_split_test.sql >"$LOG" 2>&1; then
  echo "FAILED:"
  grep -E 'ERROR|ASSERTION|CONTEXT|DETAIL' "$LOG" | head -20
  rm -f "$LOG"
  exit 1
fi

grep 'PASS:' "$LOG" | sed -E 's/^psql[^:]*:[0-9]+: *NOTICE:  PASS: /  /' | sed 's/^/  /'
rm -f "$LOG"
echo
echo "All BankOne branch-split contract scenarios passed."
