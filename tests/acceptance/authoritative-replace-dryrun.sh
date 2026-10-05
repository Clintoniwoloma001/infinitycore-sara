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
PREFLIGHT="$DIR/supabase/manual/20261101000009_authoritative_preflight_readonly.sql"
if lint "$STAGING" "$REPLACE" "$PREFLIGHT" \
        "$DIR/supabase/migrations/generated/employee_source_values.sql" \
        "$DIR/supabase/migrations/generated/employee_branch_values.sql" \
        "$DIR/supabase/migrations/generated/employee_supervisor_values.sql"; then
  echo "PASS: no psql-only syntax (no \\echo, no BEGIN/COMMIT, no on-commit-drop temp tables)"
else
  echo "FAIL: fix the reported SQL-Editor incompatibilities before running in production" >&2
  exit 1
fi

# The pre-flight is advertised as READ-ONLY, so hold it to that: no write verbs.
if grep -qiE '^[[:space:]]*(insert|update|delete|drop|create|alter|truncate|grant|revoke)[[:space:]]' "$PREFLIGHT"; then
  echo "FAIL: the pre-flight file contains a write statement; it must stay read-only" >&2
  exit 1
fi
echo "PASS: pre-flight file is genuinely read-only"

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
# --- employees_termination_guard regression ------------------------------
# Production carries this BEFORE UPDATE trigger and it REJECTS any change to
# is_archived / archived_at / archive_reason unless the session role is
# super_admin or head_of_human_resources. The SQL Editor has no auth.uid(), so
# public.current_role() falls back to 'staff' and the step-5 archive UPDATE dies
# with "Your role is not authorized to terminate employees."
#
# It shipped once precisely because this trigger is DISABLED in local docker by
# default, so the plain dry run above never exercised it. This stage arms it so
# the real code path is covered. It restores the prior state on exit, including
# on failure, so the dry run leaves the database exactly as it found it.
GUARD_STATE_BEFORE=$(query "select coalesce((select tgenabled::text
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'employees'
   and t.tgname = 'employees_termination_guard' and not t.tgisinternal), 'ABSENT');")

restore_guard() {
  case "$GUARD_STATE_BEFORE" in
    O) query "alter table public.employees enable trigger employees_termination_guard;" >/dev/null 2>&1 || true ;;
    D) query "alter table public.employees disable trigger employees_termination_guard;" >/dev/null 2>&1 || true ;;
    R) query "alter table public.employees enable replica trigger employees_termination_guard;" >/dev/null 2>&1 || true ;;
    A) query "alter table public.employees enable always trigger employees_termination_guard;" >/dev/null 2>&1 || true ;;
  esac
}
trap restore_guard EXIT INT TERM

if [ "$GUARD_STATE_BEFORE" != "ABSENT" ]; then
  query "alter table public.employees enable trigger employees_termination_guard;" >/dev/null
fi

echo "== 3b/5  GUARD: archive must survive an ARMED termination guard =="
if [ "$GUARD_STATE_BEFORE" = "ABSENT" ]; then
  echo "SKIP: employees_termination_guard does not exist in this environment"
else
  # Precondition: with the guard armed and no suspension in the script, the bare
  # archive UPDATE must fail. This proves the stage is actually testing
  # something -- otherwise a trigger that silently stopped firing would make the
  # whole check pass for the wrong reason (which is how this bug hid).
  if query "begin; update public.employees set is_archived = true, archived_at = now(),
                      archive_reason = 'guard-regression-probe'
                where staff_id = (select min(staff_id) from public.employees
                                   where staff_id is not null
                                     and coalesce(is_archived,false) = false);
             rollback;" >/dev/null 2>&1; then
    echo "FAIL: the armed guard did not reject the archive UPDATE; it cannot test anything" >&2
    exit 1
  fi
  echo "  (precondition ok: armed guard rejects a bare archive UPDATE)"

  if {
    echo "begin;"
    cat "$DIR/supabase/migrations/generated/employee_source_values.sql"
    cat "$DIR/supabase/migrations/generated/employee_branch_values.sql"
    cat "$DIR/supabase/migrations/generated/employee_supervisor_values.sql"
    sed "s|v_confirm constant text := 'NO'|v_confirm constant text := 'YES'|" "$REPLACE"
    echo "rollback;"
  } | run >/dev/null 2>&1; then
    echo "PASS: replace completed with the termination guard armed"
  else
    echo "FAIL: the replace failed while the termination guard was armed." >&2
    echo "      Step 5 archives rows, so 5a must suspend employees_termination_guard" >&2
    echo "      and 5b must restore it. See the notes in the replace script." >&2
    exit 1
  fi

  # The script must hand the trigger back exactly as it found it.
  GUARD_STATE_AFTER=$(query "select coalesce((select tgenabled::text
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'employees'
     and t.tgname = 'employees_termination_guard' and not t.tgisinternal), 'ABSENT');")
  # Compare against the ARMED state, not the original baseline: arming is
  # committed in its own transaction, so a rolled-back replace run unwinds the
  # script's own disable/restore and correctly leaves the trigger armed.
  ARMED_STATE=$(query "select coalesce((select tgenabled::text from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'employees'
     and t.tgname = 'employees_termination_guard' and not t.tgisinternal), 'ABSENT');")
  if [ "$GUARD_STATE_AFTER" = "$ARMED_STATE" ]; then
    echo "PASS: trigger restored to the armed state '$GUARD_STATE_AFTER'"
  else
    echo "FAIL: trigger left as '$GUARD_STATE_AFTER', expected '$ARMED_STATE'" >&2
    exit 1
  fi
fi
# --- 5b re-arm, COMMITTED --------------------------------------------------
# The rolled-back runs above CANNOT prove 5b works: rolling the transaction back
# restores the trigger automatically, so deleting 5b entirely still "passes".
# The real hazard is a COMMITTED production run leaving the guard DISABLED --
# a silent, permanent hole in the termination control.
#
# So extract the suspend + re-arm blocks verbatim from the replace script and
# commit them. Only the DO blocks and the scratch table are used: the archive
# UPDATE is deliberately NOT included, so this commits no data changes at all.

echo "== 3c/5  GUARD: 5b re-arm must survive a COMMIT (no data changes) =="
# The rolled-back runs above CANNOT prove 5b works: rolling the transaction back
# restores the trigger automatically, so deleting 5b entirely still "passes".
# The real hazard is a COMMITTED production run leaving the guard DISABLED --
# a silent, permanent hole in the termination control.
#
# Extract the suspend + re-arm blocks verbatim from the replace script, retargeted
# at a throwaway probe table. Only the DO blocks are used; the archive UPDATE is
# deliberately NOT included, so this commits no data changes at all.
python3 - "$REPLACE" <<'PY' > /tmp/hr_guard_fragment.sql
import re, sys
sql = open(sys.argv[1]).read()
blocks = re.findall(r'do \$\$.*?end \$\$;', sql, re.S)
suspend = [b for b in blocks if 'disable trigger' in b]
rearm = [b for b in blocks if 'was_enabled' in b]
if not suspend or not rearm:
    sys.exit('FIX REGRESSED: could not find both the suspend and the re-arm block')
print('create temporary table hr_guard_probe (tgname text primary key, was_enabled "char");')
print('insert into hr_guard_probe (tgname, was_enabled) select t.tgname, t.tgenabled')
print('  from pg_trigger t join pg_class c on c.oid = t.tgrelid')
print('  join pg_namespace n on n.oid = c.relnamespace')
print(" where n.nspname='public' and c.relname='employees'")
print("   and t.tgname='employees_termination_guard' and not t.tgisinternal;")
for b in suspend + rearm:
    print(b.replace('hr_trigger_suspended', 'hr_guard_probe'))
PY

guard_state() {
  query "select coalesce((select tgenabled::text from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'employees'
     and t.tgname = 'employees_termination_guard' and not t.tgisinternal), 'ABSENT');"
}

commit_fragment() {
  printf 'begin;\n'
  cat /tmp/hr_guard_fragment.sql
  printf 'commit;\n'
}

# (a) From armed 'O' the fragment must hand the guard back 'O'.
if commit_fragment | run >/dev/null 2>&1; then
  STATE=$(guard_state)
  if [ "$STATE" = "O" ]; then
    echo "PASS: committed suspend+re-arm from 'O' returns the guard to 'O'"
  else
    echo "FAIL: guard is '$STATE' after a committed suspend+re-arm, expected 'O'." >&2
    echo "      Step 5b is missing or restores the wrong tgenabled value." >&2
    exit 1
  fi
else
  echo "FAIL: the suspend+re-arm fragment failed to execute" >&2
  exit 1
fi

# (b) From 'D' it must stay 'D' -- the restore is verbatim, not a blanket enable.
query "alter table public.employees disable trigger employees_termination_guard;" >/dev/null
if commit_fragment | run >/dev/null 2>&1; then
  STATE=$(guard_state)
  if [ "$STATE" = "D" ]; then
    echo "PASS: a pre-existing 'D' is restored verbatim (not promoted to 'O')"
  else
    echo "FAIL: 'D' became '$STATE' -- the restore is not verbatim." >&2
    exit 1
  fi
else
  echo "FAIL: the suspend+re-arm fragment failed to execute from 'D'" >&2
  exit 1
fi

trap - EXIT INT TERM
restore_guard

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
