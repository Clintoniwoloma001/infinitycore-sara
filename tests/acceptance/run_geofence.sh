#!/bin/sh
# ============================================================================
# Geofence management + tracking RBAC acceptance run
# ============================================================================
# Boots a throwaway PostgreSQL 16, applies the shared stubs plus the geofence
# overlay, applies the migrations the feature depends on (including the new
# 20261102000001 twice, to prove idempotency), then runs the behavioural
# assertions in geofence_management.sql. Nothing touches a real database.
#
#   sh tests/acceptance/run_geofence.sh
# ============================================================================
set -e

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PG=${PG:-imfb-geofence-pg}
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
run "$DIR/geofence_overlay_stubs.sql" >/dev/null

echo "== prerequisite migrations =="
run "$ROOT/supabase/migrations/20260926000001_attendance_location_authority.sql" >/dev/null
run "$ROOT/supabase/migrations/20260926000002_employee_tracking_access.sql" >/dev/null
run "$ROOT/supabase/migrations/20260929000003_tracking_geofence_context_and_map.sql" >/dev/null

echo "== legacy branch_geofences shape (as deployed by the mobile migration) =="
run "$DIR/geofence_legacy_shape.sql" >/dev/null

echo "== migration 20261102000001 (geofence management + rbac) =="
run "$ROOT/supabase/migrations/20261102000001_geofence_management_rbac.sql" >/dev/null

echo "== idempotency (migration re-applied) =="
run "$ROOT/supabase/migrations/20261102000001_geofence_management_rbac.sql" >/dev/null

echo ""
echo "############ geofence_management ############"
# ON_ERROR_STOP is OFF for the assertion script and its exit code is ignored,
# because several assertions prove that a call IS rejected. The script itself
# raises at the end if any recorded check failed.
docker cp "$DIR/geofence_management.sql" "$PG:/tmp/geofence_management.sql" >/dev/null
docker exec "$PG" psql -U postgres -d imfb -f "/tmp/geofence_management.sql" || true

docker rm -f "$PG" >/dev/null 2>&1 || true
echo ""
echo "Geofence acceptance run complete."
