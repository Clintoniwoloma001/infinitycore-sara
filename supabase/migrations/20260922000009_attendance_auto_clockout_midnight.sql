-- Phase — Midnight auto clock-out @ 17:00 (verified job + visible flag).
-- Run in Supabase SQL Editor after 20260922000006. Idempotent/additive.
--
-- What this does:
--   1. Marks auto-closed attendance records with attendance_records.auto_clock_out
--      so HR can tell a real card-out from a system reconciliation.
--   2. Re-issues attendance_auto_clockout_close_sessions() so an un-clocked
--      session is closed at the shift day's work-end time — 17:00 by default via
--      hr_platform_settings.default_work_end_time (fallback exactly 17:00) — in
--      the employee's attendance timezone (Africa/Lagos). The clock_out timestamp
--      is (attendance_date + work_end), i.e. 17:00 ON THE SHIFT DAY, never the
--      time the job actually ran.
--   3. Registers the pg_cron job that runs it at five past midnight, so "didn't
--      clock out by midnight" is actually enforced automatically (guarded to
--      only apply when pg_cron is available).

-- 1. Visible flag for auto-closed sessions.
alter table public.attendance_records
  add column if not exists auto_clock_out boolean not null default false;

create index if not exists idx_attendance_records_auto_clock_out
  on public.attendance_records(auto_clock_out)
  where auto_clock_out = true;

-- 2. Authoritative reconciler. Work end is read from Platform Settings and
--    falls back to the exact 17:00 the original phase-47 job hard-coded.
create or replace function public.attendance_auto_clockout_close_sessions(
  p_as_of timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text := public.att_app_timezone();
  v_now timestamptz := clock_timestamp();
  v_as_of timestamptz := least(coalesce(p_as_of, clock_timestamp()), v_now);
  v_local_today date := (v_as_of at time zone v_tz)::date;
  v_work_end time;
  v_row record;
  v_clock_out timestamptz;
  v_total integer;
  v_closed integer := 0;
  v_updated jsonb := '[]'::jsonb;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to reconcile attendance sessions.';
  end if;

  select coalesce(max(default_work_end_time), time '17:00')
    into v_work_end
    from public.hr_platform_settings
   where id = 1;

  -- Sessions still open from a STRICTLY PAST day. Today's open sessions are
  -- intentionally left alone until the day turns.
  for v_row in
    select r.id, r.employee_id, r.attendance_date, r.clock_in, r.late_minutes
      from public.attendance_records r
     where r.clock_out is null
       and r.attendance_date < v_local_today
     order by r.attendance_date
     for update skip locked
  loop
    -- Timestamp = work end ON the shift day, in the employee's timezone.
    v_clock_out := (v_row.attendance_date + v_work_end) at time zone v_tz;
    v_total := greatest(0, round(extract(epoch from (v_clock_out - v_row.clock_in)) / 60.0))::integer;

    perform set_config('app.correcting_attendance', 'on', true);
    update public.attendance_records
       set clock_out = v_clock_out,
           total_minutes = v_total,
           work_hours = round(v_total::numeric / 60.0, 2),
           early_departure_minutes = 0,
           source = 'admin', source_detail = 'ADMIN', verification_method = 'NONE',
           geofence_status = coalesce(geofence_status, 'no_geofence'),
           status = case when coalesce(v_row.late_minutes, 0) > 0 then 'late' else 'present' end,
           auto_clock_out = true
     where id = v_row.id;
    perform set_config('app.correcting_attendance', 'off', true);

    insert into public.attendance_events (
      employee_id, attendance_record_id, event_type, event_time, source,
      verification_method, verification_status, late_minutes,
      early_departure_minutes, metadata
    ) values (
      v_row.employee_id, v_row.id, 'CLOCK_OUT', v_clock_out, 'ADMIN',
      'NONE', 'bypassed', v_row.late_minutes, 0,
      jsonb_build_object(
        'auto', true,
        'auto_clock_out', true,
        'reason', 'No manual clock-out recorded before midnight — closed at the scheduled work-end time',
        'scheduled_end', v_work_end::text
      )
    );

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_AUTO_CLOCK_OUT', 'AttendanceRecord', v_row.id::text,
      'System (auto clock-out)',
      jsonb_build_object(
        'attendance_date', v_row.attendance_date,
        'scheduled_end', v_work_end,
        'work_minutes', v_total,
        'auto_clock_out', true,
        'success', true
      )::text,
      'info'
    );

    v_closed := v_closed + 1;
    v_updated := v_updated || jsonb_build_object(
      'id', v_row.id,
      'attendance_date', v_row.attendance_date,
      'clock_out', v_clock_out,
      'work_hours', round(v_total::numeric / 60.0, 2),
      'auto_clock_out', true
    );
  end loop;

  return jsonb_build_object('ok', true, 'closed', v_closed, 'as_of', v_as_of, 'updated', v_updated);
exception
  when others then
    perform set_config('app.correcting_attendance', 'off', true);
    raise;
end;
$$;

revoke all on function public.attendance_auto_clockout_close_sessions(timestamptz) from public;
grant execute on function public.attendance_auto_clockout_close_sessions(timestamptz) to authenticated;

-- 3. Automatic schedule: five minutes after midnight, every day. Self-healing
--    (same job name = upsert), silently skipped where pg_cron is not installed.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'infinitycore-attendance-auto-clockout',
      '5 0 * * *',
      $cmd$ select public.attendance_auto_clockout_close_sessions(); $cmd$
    );
  end if;
exception
  when others then null;
end;
$$;