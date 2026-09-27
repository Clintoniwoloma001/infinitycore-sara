\set ON_ERROR_STOP on
-- Day 1: John clocks in at Head Office, forgets to clock out.
insert into public.attendance_records (employee_id, attendance_date, clock_in, clock_in_lat, clock_in_lng, source, verification_method)
values ('aaaaaaaa-0000-0000-0000-000000000001', (now() at time zone 'Africa/Lagos')::date - 1,
        (now() at time zone 'Africa/Lagos')::date - 1 + time '08:03', 6.5244, 3.3792, 'web', 'GPS');

-- Location trail: inside HO, then leaves the geofence, then keeps moving.
-- 4 points AFTER leaving + 2 points BEFORE leaving, so a naive "last 3 rows"
-- implementation would return the wrong window.
insert into public.employee_location_events (employee_id, latitude, longitude, accuracy, recorded_at, source, inside_geofence, location_label) values
 ('aaaaaaaa-0000-0000-0000-000000000001',6.5244,3.3792, 6, (now() at time zone 'Africa/Lagos')::date - 1 + time '08:05', 'mobile', true,  'Head Office'),
 ('aaaaaaaa-0000-0000-0000-000000000001',6.5245,3.3795, 7, (now() at time zone 'Africa/Lagos')::date - 1 + time '09:00', 'mobile', true,  'Head Office'),
 ('aaaaaaaa-0000-0000-0000-000000000001',6.5300,3.3900, 8, (now() at time zone 'Africa/Lagos')::date - 1 + time '09:02', 'mobile', false, 'Outside registered locations'),
 ('aaaaaaaa-0000-0000-0000-000000000001',6.5251,3.3801, 9, (now() at time zone 'Africa/Lagos')::date - 1 + time '17:22', 'mobile', false, 'Outside registered locations'),
 ('aaaaaaaa-0000-0000-0000-000000000001',6.5244,3.3792, 8, (now() at time zone 'Africa/Lagos')::date - 1 + time '17:37', 'mobile', true,  'Ketu Branch'),
 ('aaaaaaaa-0000-0000-0000-000000000001',6.5251,3.3801, 8, (now() at time zone 'Africa/Lagos')::date - 1 + time '17:52', 'mobile', true,  'Ketu Branch');

\echo '=== T5: end of day => MISSING_CLOCK_OUT, clock_out stays NULL, HR notified ==='
select public.attendance_mark_missing_clockouts();

\echo '--- record state (clock_out MUST still be null) ---'
select status, clock_out is null as clock_out_is_null, clock_in_location_label
  from public.attendance_records
 where employee_id='aaaaaaaa-0000-0000-0000-000000000001';

\echo '--- HR notification (existing notifications table) ---'
select n.title, n.type, n.message from public.notifications n
  join public.profiles p on p.id = n.user_id where p.role='head_of_human_resources';

\echo '--- audit row carries the last-3 RELEVANT trail ---'
select jsonb_pretty((details::jsonb) -> 'last_three_relevant_locations')
  from public.audit_logs where action='ATTENDANCE_MISSING_CLOCK_OUT';

\echo '=== T5b: next-day clock-in MUST be allowed (yesterday left open) ==='
select case when exists (select 1 from public.attendance_records
        where employee_id='aaaaaaaa-0000-0000-0000-000000000001'
          and attendance_date=(now() at time zone 'Africa/Lagos')::date)
  then 'ALLOWED' else 'ALLOWED_NOT_BLOCKED_BY_PRIOR_OPEN_SESSION' end as t5b;
insert into public.attendance_records (employee_id, attendance_date, clock_in, clock_in_lat, clock_in_lng, source, verification_method)
values ('aaaaaaaa-0000-0000-0000-000000000001', (now() at time zone 'Africa/Lagos')::date,
        (now() at time zone 'Africa/Lagos')::date + time '08:01', 6.5244, 3.3792, 'mobile', 'BIOMETRIC+GPS');
select count(*) as today_rows_created from public.attendance_records
 where employee_id='aaaaaaaa-0000-0000-0000-000000000001'
   and attendance_date=(now() at time zone 'Africa/Lagos')::date;

\echo '=== T5c: sweep is idempotent (does not re-notify or re-mark) ==='
select public.attendance_mark_missing_clockouts() ->> 'marked_missing_clock_out' as second_run_marked;

\echo '=== T6: cross-branch clock-out records BOTH sides (no overwrite) ==='
update public.attendance_records
   set clock_out = (now() at time zone 'Africa/Lagos')::date + time '17:30',
       clock_out_lat = 6.6010, clock_out_lng = 3.3500, clock_out_accuracy = 8
 where employee_id='aaaaaaaa-0000-0000-0000-000000000001'
   and attendance_date=(now() at time zone 'Africa/Lagos')::date;
select clock_in_location_label, clock_out_location_label, clock_out_inside_geofence, clock_in_branch_id is distinct from clock_out_branch_id as branches_differ
  from public.attendance_records
 where employee_id='aaaaaaaa-0000-0000-0000-000000000001'
   and attendance_date=(now() at time zone 'Africa/Lagos')::date;
