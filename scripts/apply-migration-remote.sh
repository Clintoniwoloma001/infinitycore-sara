#!/usr/bin/env bash
#
# Throttle-safe Supabase migration applier.
#
# WHY THIS EXISTS
#   The Supabase Dashboard SQL Editor and the Supabase CLI's Management-API
#   path share a platform request throttler. Running several migrations
#   back-to-back returns:
#
#       Error: ThrottlerException: Too Many Requests
#
#   That is an HTTP 429 produced by the platform BEFORE the request reaches
#   Postgres. Nothing is applied and no partial state is left behind, so it is
#   safe to simply re-run. This script sidesteps the throttler by applying the
#   file(s) over a DIRECT Postgres connection (session/direct pooler URI) and
#   retries transient failures with backoff.
#
# USAGE
#   SUPABASE_DB_URL='postgresql://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
#     scripts/apply-migration-remote.sh \
#       supabase/migrations/20260921000008_attendance_device_day_binding_and_email_clockin.sql \
#       supabase/migrations/20260921000009_hr_jobs_archive_edit_delete.sql
#
#   # all pending-looking files in order (explicit list is safer, shown here):
#   SUPABASE_DB_URL='...' scripts/apply-migration-remote.sh supabase/migrations/2026*.sql
#
# ENV
#   SUPABASE_DB_URL   (required) percent-encoded direct/session-pooler URI.
#   PSQL_CONTAINER    container to `docker exec psql` in when local psql is not
#                     installed (default: supabase_db_infinitycore-sara).
#   SINGLE_TRANSACTION  default 1. Each file runs with ON_ERROR_STOP inside one
#                     transaction so a failure leaves nothing partially applied.
#                     Set to 0 for files containing CREATE INDEX CONCURRENTLY.
#   MAX_ATTEMPTS      default 6.
#   RETRY_SECONDS     default 15 (doubles each attempt, capped at 120).
#   SLEEP_BETWEEN     default 5, seconds to wait between files.
#
set -euo pipefail

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "error: SUPABASE_DB_URL is required (direct/session-pooler Postgres URI)" >&2
  echo "       Dashboard -> Project Settings -> Database -> Connection string -> URI" >&2
  exit 2
fi

if [[ $# -eq 0 ]]; then
  echo "error: pass one or more .sql migration files, in the order they must run" >&2
  exit 2
fi

PSQL_CONTAINER="${PSQL_CONTAINER:-supabase_db_infinitycore-sara}"
SINGLE_TRANSACTION="${SINGLE_TRANSACTION:-1}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-6}"
RETRY_SECONDS="${RETRY_SECONDS:-15}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-5}"

run_sql() {
  local file="$1" tx_flags=()
  [[ "$SINGLE_TRANSACTION" == "1" ]] && tx_flags+=(--single-transaction)
  if command -v psql >/dev/null 2>&1; then
    psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "${tx_flags[@]}" -f "$file" 2>&1
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$PSQL_CONTAINER"; then
    docker exec -i "$PSQL_CONTAINER" \
      psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "${tx_flags[@]}" -f - < "$file" 2>&1
  else
    echo "error: no psql found locally and container '$PSQL_CONTAINER' is not running." >&2
    echo "       install psql (brew install libpq) or start the local Supabase stack." >&2
    exit 2
  fi
}

is_transient() {
  grep -qiE 'ThrottlerException|Too Many Requests|429|rate limit|ECONNRESET|ETIMEDOUT|connection (reset|terminated|refused)|server closed the connection|could not connect|timeout expired' <<<"$1"
}

failures=0
for file in "$@"; do
  [[ -f "$file" ]] || { echo "error: no such file: $file" >&2; exit 2; }
  name="$(basename "$file")"
  attempt=1
  delay="$RETRY_SECONDS"
  while :; do
    echo "==> [$name] attempt $attempt/$MAX_ATTEMPTS"
    if out="$(run_sql "$file")"; then
      echo "    OK"
      break
    fi
    if [[ "$attempt" -ge "$MAX_ATTEMPTS" ]] || ! is_transient "$out"; then
      echo "    FAILED (not retryable or attempts exhausted)" >&2
      echo "$out" >&2
      failures=$((failures + 1))
      break
    fi
    echo "    transient failure (throttle/network); retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$(( delay * 2 > 120 ? 120 : delay * 2 ))
  done
  [[ "$SLEEP_BETWEEN" == "0" ]] || sleep "$SLEEP_BETWEEN"
done

if [[ "$failures" -gt 0 ]]; then
  echo "done with $failures failure(s)" >&2
  exit 1
fi
echo "all migrations applied"
