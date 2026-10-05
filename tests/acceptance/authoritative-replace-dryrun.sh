#!/bin/sh
# ============================================================================
# DRY RUN of the authoritative employee replace, against LOCAL DOCKER ONLY.
# ============================================================================
#
# Runs the staging load + the replace script inside a single transaction that is
# ALWAYS rolled back, so the numbers can be inspected and nothing persists.
#
#   sh tests/acceptance/authoritative-replace-dryrun.sh
#
# The production run is deliberately a separate, manual step: run the three
# generated value files and then supabase/manual/20261101000008 yourself in the
# Supabase SQL editor. That script lives OUTSIDE supabase/migrations so it can
# never be picked up by `supabase db push`, and it additionally refuses to run
# unless `hr.authoritative_replace_confirmed` is set in the session. This script
# never touches production.
# ============================================================================
set -e

CONTAINER="supabase_db_infinitycore-sara"
DB="postgres"
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REPLACE="$DIR/supabase/manual/20261101000008_authoritative_employee_replace.sql"

# `run` streams SQL on stdin (psql -f -). Passing -c as well would make psql
# wait forever for that stdin, so -c calls go through `query` instead.
run() {
  docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f -
}

query() {
  docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -At -c "$1"
}

# One reusable row-count vector, so the baseline and the post-rollback state are
# measured by IDENTICAL SQL and can be compared as plain strings.
counts() {
  docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -At -F'|' -c "
    select (select count(*) from public.employees),
           (select count(*) from public.employees where coalesce(is_archived,false)),
           (select count(*) from public.employee_digital_files),
           (select count(*) from public.employee_supervisors),
           (select count(*) from public.employee_branch_assignments),
           (select count(*) from public.branches),
           (select count(*) from public.attendance_records),
           (select count(*) from public.profiles);"
}

# Captured BEFORE anything runs, so step 5 can prove the rollback really
# restored everything rather than merely "not erroring".
BASELINE=$(counts)
echo "== baseline (employees|archived|files|supervisors|brchAsgn|branches|attendance|profiles) =="
echo "$BASELINE"

# The staging tables are defined by the replace script, but the generated value
# files must load into them FIRST, so they are created here. `create table if not
# exists` makes this safe whether or not the replace script has run yet.
echo "== 1/5  creating staging tables (idempotent) =="
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -c "
create table if not exists public.stg_hr_employee_source (
  staff_id text primary key, full_name text not null, first_name text,
  last_name text, email text, position text, department text, gender text,
  confirmation_status text, source_row jsonb);
create table if not exists public.stg_hr_employee_branch_source (
  staff_id text not null, branch_label text not null);
create unique index if not exists uq_stg_branch
  on public.stg_hr_employee_branch_source (staff_id, branch_label);
create table if not exists public.stg_hr_employee_supervisor_source (
  staff_id text primary key, supervisor_1 text, supervisor_2 text, supervisor_3 text);"

echo
echo "== 2/5  staging load dry run (load, report, ROLLBACK) =="
{
  echo "begin;"
  cat "$DIR/supabase/migrations/generated/employee_source_values.sql"
  cat "$DIR/supabase/migrations/generated/employee_branch_values.sql"
  cat "$DIR/supabase/migrations/generated/employee_supervisor_values.sql"
  echo "select 'source' as t, count(*) from public.stg_hr_employee_source
   union all select 'branches', count(*) from public.stg_hr_employee_branch_source
   union all select 'supervisors', count(*) from public.stg_hr_employee_supervisor_source;"
  echo "rollback;"
} | run

echo
echo "== 2b/5  staging left behind after rollback (0 rows expected) =="
query "select (select count(*) from public.stg_hr_employee_source) as source,
         (select count(*) from public.stg_hr_employee_branch_source) as branches;"

echo
echo "== 3/5  GUARD: replace must ABORT without the confirmation flag =="
if {
  echo "begin;"
  cat "$DIR/supabase/migrations/generated/employee_source_values.sql"
  sed '$d' "$REPLACE"
  echo "rollback;"
} | run 2>&1 | grep -q "ABORTED"; then
  echo "PASS: refused without hr.authoritative_replace_confirmed (no writes)"
else
  echo "FAIL: the replace script ran WITHOUT the confirmation flag" >&2
  exit 1
fi

echo
echo "== 4/5  FULL REPLACE dry run (staging + replace, then ROLLBACK) =="
{
  echo "begin;"
  # Same flag the production run requires, so this dry run exercises the real
  # code path rather than the abort path.
  echo "set local hr.authoritative_replace_confirmed = 'yes';"
  cat "$DIR/supabase/migrations/generated/employee_source_values.sql"
  cat "$DIR/supabase/migrations/generated/employee_branch_values.sql"
  cat "$DIR/supabase/migrations/generated/employee_supervisor_values.sql"
  # Take the replace script up to (but excluding) its final COMMIT, so the
  # verification report runs and then the transaction is rolled back.
  sed '$d' "$REPLACE"
  echo "rollback;"
} | run

echo
echo "== 5/5  post-rollback state (MUST equal baseline) =="
AFTER=$(counts)
echo "$AFTER"
if [ "$AFTER" = "$BASELINE" ]; then
  echo "PASS: rollback restored every baseline count exactly"
else
  echo "FAIL: post-rollback state differs from baseline" >&2
  echo "  baseline: $BASELINE" >&2
  echo "  after:    $AFTER" >&2
  exit 1
fi
