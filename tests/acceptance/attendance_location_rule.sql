-- ============================================================================
-- ACCEPTANCE TEST: attendance location rule (A1, A2, A12)
-- ============================================================================
-- Run against a scratch PostgreSQL 16 instance, in this order:
--   1. attendance_tracking_stubs.sql
--   2. ../../supabase/migrations/20260926000001_attendance_location_authority.sql
--   3. this file
--
-- The branches below are TEST FIXTURES. The migration itself never hard-codes
-- a location: it reads whatever is registered in public.branches /
-- public.attendance_geofences.
-- ============================================================================
\set ON_ERROR_STOP on
-- Registered locations (NOT hard-coded in the migration; seeded here only as
-- test fixtures): Head Office, Ketu Branch, Lekki Branch.
insert into public.branches (id, branch_name, branch_code, latitude, longitude, geofence_radius, geofence_active)
values ('11111111-1111-1111-1111-111111111111','Head Office','HO',6.5244,3.3792,200,true),
       ('22222222-2222-2222-2222-222222222222','Ketu Branch','KT',6.6010,3.3500,200,true),
       ('33333333-3333-3333-3333-333333333333','Lekki Branch','LK',6.4470,3.4730,200,true);

-- Employee assigned to HEAD OFFICE.
insert into public.employees (id, user_id, full_name, employee_number, branch_id)
values ('aaaaaaaa-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','John Doe','IMFB/24/0001','11111111-1111-1111-1111-111111111111'),
       ('aaaaaaaa-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002','Mary Smith','IMFB/24/0002','22222222-2222-2222-2222-222222222222');

insert into public.profiles values ('a0000000-0000-0000-0000-000000000001','staff','John Doe');
insert into public.profiles values ('a0000000-0000-0000-0000-000000000003','head_of_human_resources','HR Head');

\echo '=== T0: single engine agrees with itself (no second calculation) ==='
select r->>'location_name' as location_name, r->>'inside' as inside, round((r->>'distance_meters')::numeric,1) as dist, r->>'human_label' as human_label
  from public.resolve_employee_location(6.5244,3.3792,'clock_out',null) r;

\echo '=== T1: assigned Ketu, clock-in Ketu, clock-out Ketu => ALLOW ==='
select public.attendance_validate_location('aaaaaaaa-0000-0000-0000-000000000002',6.6010,3.3500,'clock_out','22222222-2222-2222-2222-222222222222',null,false) ->> 'geofence_status' as t1;

\echo '=== T2: assigned HEAD OFFICE, clock-in HO, clock-out KETU => ALLOW (was rejected before) ==='
select public.attendance_validate_location('aaaaaaaa-0000-0000-0000-000000000001',6.6010,3.3500,'clock_out','11111111-1111-1111-1111-111111111111',null,false) ->> 'geofence_status' as t2,
       public.attendance_validate_location('aaaaaaaa-0000-0000-0000-000000000001',6.6010,3.3500,'clock_out','11111111-1111-1111-1111-111111111111',null,false) ->> 'actual_location_name' as t2_at;

\echo '=== T3: assigned HO, clock-out LEKKI (another registered branch) => ALLOW ==='
select public.attendance_validate_location('aaaaaaaa-0000-0000-0000-000000000001',6.4470,3.4730,'clock_out','11111111-1111-1111-1111-111111111111',null,false) ->> 'geofence_status' as t3,
       public.attendance_validate_location('aaaaaaaa-0000-0000-0000-000000000001',6.4470,3.4730,'clock_out','11111111-1111-1111-1111-111111111111',null,false) ->> 'actual_location_name' as t3_at;

\echo '=== T4: random non-geofenced location => REJECT with the exact reason ==='
select case
         when public.attendance_validate_location('aaaaaaaa-0000-0000-0000-000000000001',6.3000,3.1000,'clock_out','11111111-1111-1111-1111-111111111111',null,false) is not null
           then 'UNEXPECTED_ALLOW'
         else 'REJECTED_CORRECTLY'
       end as t4;
