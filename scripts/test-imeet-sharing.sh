#!/usr/bin/env bash
# ===========================================================================
# I-Meet folder sharing + Clean APIs provider.
#
# Replays tests/acceptance/imeetFolderSharing.sql, which proves:
#   - a stranger sees nothing,
#   - a member cannot re-share, cannot enumerate members, cannot revoke,
#   - the OWNER can revoke at any time and the revoke is IMMEDIATE,
#   - re-granting reuses the row (no duplicate memberships),
#   - view-only sharing can read but not download,
#   - Clean APIs is registered with the exact dashboard model ids,
#   - no API key is ever stored in the database.
#
# Runs in a transaction and ends in ROLLBACK, so no test data survives.
# Local docker only. Set PG_CONTAINER to override the container name.
# ===========================================================================
set -euo pipefail

CONTAINER="${PG_CONTAINER:-supabase_db_infinitycore-sara}"
SQL="tests/acceptance/imeetFolderSharing.sql"
M1="supabase/migrations/20260930000001_imeet_meeting_intelligence.sql"
M2="supabase/migrations/20260930000002_imeet_cleanapis_provider_and_sharing.sql"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "SKIP: container '$CONTAINER' is not running."
  echo "      Start it (docker compose -f docker-compose.base44.yml up -d) to run this suite."
  exit 0
fi

echo "==> applying the I-Meet migrations (idempotent)"
for m in "$M1" "$M2"; do
  docker cp "$m" "$CONTAINER:/tmp/imeet_migration.sql" >/dev/null
  docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
    -f /tmp/imeet_migration.sql >/dev/null
done

echo "==> replaying the sharing scenarios"
docker cp "$SQL" "$CONTAINER:/tmp/imeet_share_test.sql" >/dev/null
LOG="$(mktemp)"
if ! docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f /tmp/imeet_share_test.sql >"$LOG" 2>&1; then
  echo "FAILED:"
  grep -E 'ERROR|ASSERTION|CONTEXT|DETAIL' "$LOG" | head -20
  rm -f "$LOG"
  exit 1
fi

grep 'PASS:' "$LOG" | sed -E 's/^psql[^:]*:[0-9]+: *NOTICE:  PASS: /  /' | sed 's/^/  /'
rm -f "$LOG"
echo
echo "All I-Meet folder sharing scenarios passed."
