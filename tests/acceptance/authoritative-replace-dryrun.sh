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
# unless its v_confirm gate is changed to 'YES'. This script
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

# --- static lint -------------------------------------------------------
# The Supabase SQL Editor understands plain SQL only. psql meta-commands
# (\echo, \i, \set, ...) are a SYNTAX ERROR there, and `set local` is silently
# discarded under autocommit, so a guard built on it behaves differently in the
# editor than in psql. Both classes of bug shipped once already; this catches
# them before anyone reaches the editor.
lint() {
  _fail=0
  for f in "$@"; do
    if grep -nE '^[[:space:]]*\\(echo|i|set|pset|connect|o|timing|gexec)' "$f" >/dev/null 2>&1; then
      echo "FAIL: $(basename "$f") contains psql meta-commands (\\echo, \\i, \\set ...)" >&2
      grep -nE '^[[:space:]]*\\(echo|i|set|pset|connect|o|timing|gexec)' "$f" | head -3 >&2
      _fail=1
    fi
    # "on commit drop" temp tables vanish under autocommit, breaking the next
    # statement. See the hr_branch_* tables in the replace script.
    if grep -niE 'create[[:space:]]+(temp|temporary)[[:space:]]+table.*on[[:space:]]+commit[[:space:]]+drop' "$f" >/dev/null 2>&1; then
      echo "FAIL: $(basename "$f") uses 'on commit drop' on a temp table (breaks under autocommit)" >&2
      _fail=1
    fi
    if grep -nE '^[[:space:]]*(begin|commit);[[:space:]]*$' "$f" >/dev/null 2>&1; then
      echo "FAIL: $(basename "$f") issues its own BEGIN/COMMIT (the SQL Editor already wraps runs)" >&2
      _fail=1
    fi
    if grep -n "current_setting('hr.authoritative" "$f" >/dev/null 2>&1; then
      echo "FAIL: $(basename "$f") gates on a session setting (set local is a no-op under autocommit)" >&2
      _fail=1
    fi
  done
  return $_fail
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

# Uses the REAL staging file that production runs, not a copy of the DDL, so
# this dry run cannot pass against a schema production would reject.
echo "== 0/5  lint: SQL-Editor compatibility of the four production files =="
STAGING="$DIR/supabase/manual/20261101000007a_authoritative_staging_schema.sql"
if lint "$STAGING" "$REPLACE" \
        "$DIR/supabase/migrations/generated/employee_source_values.sql" \
        "$DIR/supabase/migrations/generated/employee_branch_values.sql" \
        "$DIR/supabase/migrations/generated/employee_supervisor_values.sql"; then
  echo "PASS: no psql-only syntax (no \\echo, no BEGIN/COMMIT, no on-commit-drop temp tables)"
else
  echo "FAIL: fix the reported SQL-Editor incompatibilities before running in production" >&2
  exit 1
fi

echo
echo "== 1/5  creating staging tables from the real staging file =="
cat "$DIR/supabase/manual/20261101000007a_authoritative_staging_schema.sql" | run

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
  cat "$REPLACE"
  echo "rollback;"
} | run 2>&1 | grep -q "ABORTED"; then
  echo "PASS: refused while the v_confirm gate is 'NO' (no writes)"
else
  echo "FAIL: the replace script ran while the v_confirm gate was still 'NO'" >&2
  exit 1
fi

echo
echo "== 4/5  FULL REPLACE dry run (staging + replace, then ROLLBACK) =="
{
  echo "begin;"
  cat "$DIR/supabase/migrations/generated/employee_source_values.sql"
  cat "$DIR/supabase/migrations/generated/employee_branch_values.sql"
  cat "$DIR/supabase/migrations/generated/employee_supervisor_values.sql"
  # Flip the literal confirmation gate to 'YES' exactly as an operator would in
  # the file, so this exercises the real code path rather than the abort path.
  # The committed file keeps 'NO', so the guard test above stays meaningful.
  sed "s|v_confirm constant text := 'NO'|v_confirm constant text := 'YES'|" "$REPLACE"
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
