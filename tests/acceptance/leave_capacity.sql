-- ============================================================================
-- ACCEPTANCE TEST: leave capacity engine + deterministic alternatives
-- ============================================================================
-- Run after the stubs and all three Phase 70 migrations.
-- Branch fixtures: Ketu (3 staff) and Lekki (3 staff).
-- ============================================================================
\set ON_ERROR_STOP on
select public.test_sign_in('a0000000-0000-0000-0000-0000000000f1','super_admin');

insert into public.branches (id, branch_name, branch_code, latitude, longitude, geofence_radius, geofence_active)
values ('11111111-1111-1111-1111-111111111111','Head Office','HO',6.5244,3.3792,200,true),
       ('22222222-2222-2222-2222-222222222222','Ketu Branch','KT',6.6010,3.3500,200,true)
on conflict (id) do nothing;

-- Ketu has exactly 3 staff. Two of them are used for the capacity tests.
insert into public.employees (id, user_id, full_name, employee_number, branch_id, department, position) values
 ('bbbbbbbb-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001','Ketu One','K/1','22222222-2222-2222-2222-222222222222','Operations','Officer'),
 ('bbbbbbbb-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000002','Ketu Two','K/2','22222222-2222-2222-2222-222222222222','Operations','Officer'),
 ('bbbbbbbb-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000003','Ketu Three','K/3','22222222-2222-2222-2222-222222222222','Operations','Officer')
on conflict (id) do nothing;

\echo '=== L1: working-day engine excludes weekends ==='
-- 2026-10-16 is a Friday; the 17th/18th are Saturday/Sunday.
select public.leave_working_days('2026-10-16','2026-10-19','22222222-2222-2222-2222-222222222222') as fri_to_mon_working_days,
       public.leave_is_working_day('2026-10-17','22222222-2222-2222-2222-222222222222') as sat_is_working;

\echo '=== L2: a holiday makes a weekday a non-working day (HR-entered, not invented) ==='
insert into public.leave_holidays (holiday_date, name, scope)
values ('2026-10-20','Staff training day','company')
on conflict do nothing;
select public.leave_working_days('2026-10-19','2026-10-21','22222222-2222-2222-2222-222222222222') as span_with_holiday,
       public.leave_is_working_day('2026-10-20','22222222-2222-2222-2222-222222222222') as holiday_is_working;

\echo '=== L3: no capacity rule configured => AVAILABLE (templates are ignored) ==='
select public.check_leave_availability(
  array['bbbbbbbb-0000-0000-0000-000000000001']::uuid[],
  'annual','2026-11-02','2026-11-04',false) ->> 'verdict' as verdict_no_rules;

\echo '=== L4: Ketu max 2 on leave. 1 booked + 2 requested => CONFLICT, explained ==='
update public.leave_capacity_rules
   set is_template = false, branch_id = '22222222-2222-2222-2222-222222222222',
       max_people_on_leave = 2, max_percent_on_leave = null,
       min_people_on_duty = null, critical_role_restriction = false
 where scope_type = 'branch';

insert into public.leave_requests (employee_name, leave_type, start_date, end_date, status, employee_id, created_by)
values ('Ketu One','annual','2026-11-02','2026-11-04','approved',
        'bbbbbbbb-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001');

select jsonb_pretty(r) from public.check_leave_availability(
  array['bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000003']::uuid[],
  'annual','2026-11-02','2026-11-04',false) r \gset

\echo '=== L5: overlapping leave is detected for the individual ==='
select public.check_leave_availability(
  array['bbbbbbbb-0000-0000-0000-000000000001']::uuid[],
  'annual','2026-11-02','2026-11-04',false) -> 'conflicts' -> 0 ->> 'code' as overlap_code;

\echo '=== L6: fitting request is AVAILABLE (2 on leave, max 2) ==='
select public.check_leave_availability(
  array['bbbbbbbb-0000-0000-0000-000000000002']::uuid[],
  'annual','2026-11-02','2026-11-04',false) ->> 'verdict' as verdict_fits;

\echo '=== L7: minimum-staffing rule (Ketu has 3 staff, min 2 on duty) ==='
update public.leave_capacity_rules
   set max_people_on_leave = null, min_people_on_duty = 2
 where scope_type = 'branch';
select public.check_leave_availability(
  array['bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000003']::uuid[],
  'annual','2026-11-09','2026-11-11',false) -> 'conflicts' -> 0 ->> 'code' as staffing_code;

\echo '=== L8: percentage rule (max 50% of 3 staff) ==='
update public.leave_capacity_rules
   set min_people_on_duty = null, max_percent_on_leave = 50
 where scope_type = 'branch';
select public.check_leave_availability(
  array['bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000003']::uuid[],
  'annual','2026-11-16','2026-11-18',false) -> 'conflicts' -> 0 ->> 'code' as percent_code;

\echo '=== L9: the SAME inputs always give the SAME verdict (deterministic) ==='
select a ->> 'verdict' as run1, b ->> 'verdict' as run2,
       (a -> 'conflicts') = (b -> 'conflicts') as identical
  from public.check_leave_availability(
         array['bbbbbbbb-0000-0000-0000-000000000002']::uuid[],'annual','2026-11-23','2026-11-25',false) a,
       public.check_leave_availability(
         array['bbbbbbbb-0000-0000-0000-000000000002']::uuid[],'annual','2026-11-23','2026-11-25',false) b;

\echo '=== L10: a conflict no date shift can clear is explained, not silently empty ==='
-- A critical-role restriction conflicts on ANY overlap. Proposing "shift it a
-- week" would be a lie, so the server explains that instead.
update public.leave_capacity_rules
   set max_percent_on_leave = 10, critical_role_restriction = true
 where scope_type = 'branch';
select a ->> 'verdict' as verdict,
       jsonb_array_length(a -> 'alternatives') as alt_count,
       a -> 'warnings' -> 0 ->> 'code' as warning_code,
       a -> 'warnings' -> 0 ->> 'message' as warning_message
  from public.check_leave_availability(
    array['bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000003']::uuid[],
    'annual','2026-11-16','2026-11-18',false) a;

\echo '=== L10b: alternatives are stable across repeated calls ==='
select (a -> 'alternatives') = (b -> 'alternatives') as alternatives_identical
  from public.check_leave_availability(
         array['bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000003']::uuid[],
         'annual','2026-11-16','2026-11-18',false) a,
       public.check_leave_availability(
         array['bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000003']::uuid[],
         'annual','2026-11-16','2026-11-18',false) b;

\echo '=== L12: rule precedence is data, not code ==='
-- Both a global and a branch rule match. With the global cap at 1 and one
-- already booked, a second person breaches the GLOBAL rule, and the response
-- names the rule that actually fired.
update public.leave_capacity_rules
   set critical_role_restriction = false, max_people_on_leave = 3
 where scope_type = 'branch';
update public.leave_capacity_rules
   set is_template = false, max_people_on_leave = 1
 where scope_type = 'global' and name = 'Global leave capacity';
select public.check_leave_availability(
  array['bbbbbbbb-0000-0000-0000-000000000002']::uuid[],
  'annual','2026-11-02','2026-11-04',false) ->> 'verdict' as verdict_global_cap_1,
  public.check_leave_availability(
  array['bbbbbbbb-0000-0000-0000-000000000002']::uuid[],
  'annual','2026-11-02','2026-11-04',false) -> 'conflicts' -> 0 ->> 'rule' as which_rule_fired;

\echo '=== L13: leave_requests.employee_id backfilled from created_by ==='
select lr.employee_name, lr.employee_id, e.full_name
  from public.leave_requests lr
  left join public.employees e on e.id = lr.employee_id;

\echo '=== L11: checker never mutates leave ==='
select count(*) as leave_rows_unchanged from public.leave_requests;