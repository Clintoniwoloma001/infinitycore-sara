-- ============================================================
-- PHASE 46 — AUTO CLOCK-OUT FOR UN-CLOSED ATTENDANCE SESSIONS
-- (idempotent, additive)
--
-- Behaviour:
--   A session left open past its working day is force-closed. Once the
--   local business date (app timezone) has moved past the session's
--   attendance_date, clock_out is stamped at the configured official
--   17:00 local time (5:00 PM), independent of the device clock or the
--   time at which the reconciliation job happens to run.
--
-- Delivery:
--   1. Lazy reconciliation RPC — the SPA calls it once per browser
--      session (any authenticated user); it closes every stale session
--      platform-wide, not only the caller's.
--   2. Optional nightly pg_cron job registered below when pg_cron is
--      available (Supabase enables it per-project; local may not have it).
--
-- The attendance_update_rules() BEFORE UPDATE trigger would stamp
-- clock_out = now(), so we bypass it with the same app-supplied-time
-- flag that correct_attendance() uses — the recorded clock-out is the
-- end-of-shift time, not the reconciliation moment.
-- ============================================================

create or replace function public.attendance_auto_clockout_close_sessions(
  p_as_of timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tz         text := public.att_app_timezone();
  v_now        timestamptz := clock_timestamp();
  v_local_today date;
  v_row        record;
  v_work_end   time;
  v_clock_out  timestamptz;
  v_total_min  int;
  v_closed     int := 0;
  v_updated    jsonb := '[]'::jsonb;
begin
  p_as_of := least(coalesce(p_as_of, v_now), v_now);
  v_local_today := (p_as_of at time zone public.att_app_timezone())::date;

  for v_row in
    select r.id, r.employee_id, r.attendance_date, r.clock_in, r.late_minutes, r.branch_id, r.status
      from public.attendance_records r
     where r.clock_out is null
       and r.attendance_date is not null
       and r.attendance_date < v_local_today
      order by r.attendance_date
      for update skip locked
  loop
    v_work_end := time '17:00';

    v_clock_out := (v_row.attendance_date + v_work_end) at time zone v_tz;
    v_total_min := greatest(0, round(extract(epoch from (v_clock_out - v_row.clock_in)) / 60.0)::int);

    -- Bypass the clock-out stamping trigger so the official end-of-shift
    -- time is stored; recompute session metrics explicitly.
    perform set_config('app.correcting_attendance', 'on', true);
    update public.attendance_records
       set clock_out = v_clock_out,
           total_minutes = v_total_min,
           work_hours = round(v_total_min::numeric / 60.0, 2),
           early_departure_minutes = 0,
           source = 'admin',
           source_detail = 'ADMIN',
           geofence_status = coalesce(geofence_status, 'no_geofence'),
           status = case when coalesce(v_row.late_minutes, 0) > 0 then 'late' else 'present' end
     where id = v_row.id;
    perform set_config('app.correcting_attendance', 'off', true);

    insert into public.attendance_events (
      employee_id, attendance_record_id, event_type, event_time, source,
      verification_method, verification_status, late_minutes, early_departure_minutes, metadata
    ) values (
      v_row.employee_id, v_row.id, 'CLOCK_OUT', v_clock_out, 'ADMIN',
      'NONE', 'bypassed', v_row.late_minutes, 0,
      jsonb_build_object(
        'auto', true,
        'reason', 'No manual clock-out recorded before end of day',
        'scheduled_end', v_work_end::text
      )
    );

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_AUTO_CLOCK_OUT', 'AttendanceRecord', v_row.id::text,
      'System (auto clock-out)',
      format('Auto clock-out for attendance date %s at %s. Timezone: %s.', v_row.attendance_date, v_clock_out, v_tz),
      'info'
    );

    v_closed := v_closed + 1;
    v_updated := v_updated || jsonb_build_object(
      'id', v_row.id,
      'attendance_date', v_row.attendance_date,
      'clock_out', v_clock_out,
      'work_hours', round(v_total_min::numeric / 60.0, 2)
    );
  end loop;

  return jsonb_build_object('ok', true, 'closed', v_closed, 'as_of', p_as_of, 'updated', v_updated);
exception
  when others then
    perform set_config('app.correcting_attendance', 'off', true);
    raise;
end; $$;

revoke all on function public.attendance_auto_clockout_close_sessions(timestamptz) from public;
grant execute on function public.attendance_auto_clockout_close_sessions(timestamptz) to authenticated;

-- ------------------------------------------------------------
-- Optional nightly scheduler (pg_cron when available).
-- ------------------------------------------------------------
do $phase46$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'cron' and p.proname = 'schedule') then
    begin
      perform cron.unschedule('infinitycore-attendance-auto-clockout');
    exception when others then null; end;
    perform cron.schedule(
      'infinitycore-attendance-auto-clockout',
      '5 0 * * *',
      $croncmd$ select public.attendance_auto_clockout_close_sessions(); $croncmd$
    );
  end if;
end $phase46$;
