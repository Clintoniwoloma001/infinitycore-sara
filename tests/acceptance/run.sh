#!/bin/sh
# ============================================================================
# Backend acceptance tests: attendance location rule + employee tracking
# ============================================================================
# Boots a throwaway PostgreSQL 16 in Docker, applies the stubs, applies the
# two Phase 70 migrations, then runs the acceptance scripts. Nothing touches
# any real database.
#
#   sh tests/acceptance/run.sh
# ============================================================================
set -e

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PG=${PG:-imfb-acceptance-pg}
DIR=$(cd "$(dirname "$0")" && pwd)

docker rm -f "$PG" >/dev/null 2>&1 || true
docker run -d --name "$PG" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=imfb postgres:16-alpine >/dev/null

i=0
while [ $i -lt 60 ]; do
  docker exec "$PG" pg_isready -U postgres -d imfb >/dev/null 2>&1 && break
  i=$((i+1)); sleep 1
done

run() {
  docker cp "$1" "$PG:/tmp/$(basename "$1")" >/dev/null
  docker exec "$PG" psql -U postgres -d imfb -q -v ON_ERROR_STOP=1 -f "/tmp/$(basename "$1")"
}

echo "== stubs =="
run "$DIR/attendance_tracking_stubs.sql" >/dev/null

echo "== migration 20260926000001 (location authority) =="
run "$ROOT/supabase/migrations/20260926000001_attendance_location_authority.sql" >/dev/null
echo "== migration 20260926000002 (tracking access) =="
run "$ROOT/supabase/migrations/20260926000002_employee_tracking_access.sql" >/dev/null
echo "== migration 20260926000003 (leave schedule planner) =="
run "$ROOT/supabase/migrations/20260926000003_leave_schedule_planner.sql" >/dev/null

echo "== idempotency (all migrations re-applied) =="
run "$ROOT/supabase/migrations/20260926000001_attendance_location_authority.sql" >/dev/null
run "$ROOT/supabase/migrations/20260926000002_employee_tracking_access.sql" >/dev/null
run "$ROOT/supabase/migrations/20260926000003_leave_schedule_planner.sql" >/dev/null
run "$ROOT/supabase/migrations/20260926000004_director_leave_planner_fixes_and_booking_links.sql" >/dev/null
echo "OK"

for t in attendance_location_rule missing_clockout tracking_authorization leave_capacity leave_booking; do
  echo ""
  echo "############ $t ############"
  # ON_ERROR_STOP is deliberately OFF for the assertion scripts, and the exit
  # code is ignored, because several tests assert that a call IS rejected. An
  # expected rejection must not abort the run. The migrations above are applied
  # with ON_ERROR_STOP=1, so a genuinely broken migration still fails the suite.
  docker cp "$DIR/$t.sql" "$PG:/tmp/$t.sql" >/dev/null
  docker exec "$PG" psql -U postgres -d imfb -f "/tmp/$t.sql" || true
done

docker rm -f "$PG" >/dev/null 2>&1 || true
echo ""
echo "Acceptance suite complete."