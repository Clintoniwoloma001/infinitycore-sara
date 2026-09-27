drop schema if exists public cascade; create schema public;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create schema if not exists auth;
drop table if exists auth.users;
create table auth.users (id uuid primary key, email text);
create table public.hr_platform_settings (id int primary key, default_geofence_radius int, default_work_start_time time, default_work_end_time time, default_grace_period_minutes int, working_days text[]);
insert into public.hr_platform_settings values (1, 150, '08:00','17:00',15, array['mon','tue','wed','thu','fri']);
create table public.branches (id uuid primary key default gen_random_uuid(), branch_name text, branch_code text, latitude numeric, longitude numeric, geofence_radius numeric, geofence_active boolean, work_start_time time, work_end_time time, grace_period_minutes int);
create table public.attendance_geofences (id uuid primary key default gen_random_uuid(), name text not null, branch_id text, location_name text, latitude numeric not null, longitude numeric not null, radius_meters int default 150, active boolean default true, clock_in_allowed boolean default true, clock_out_allowed boolean default true);
create table public.employees (id uuid primary key default gen_random_uuid(), user_id uuid, full_name text, employee_number text, branch_id uuid, branch text, position text, department text, designation_id uuid);
create table public.profiles (id uuid primary key, role text, full_name text);
create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, title text, message text, type text default 'system', read boolean default false, link text, created_at timestamptz default now());
create table public.audit_logs (id uuid primary key default gen_random_uuid(), action text not null, entity_type text, entity_id text, user_name text, details text, severity text default 'info', created_at timestamptz default now());
create table public.attendance_events (id uuid primary key default gen_random_uuid(), employee_id uuid, attendance_record_id uuid, event_type text, event_time timestamptz, source text, verification_method text, verification_status text, metadata jsonb);
create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  attendance_date date,
  clock_in timestamptz, clock_out timestamptz,
  work_hours numeric(6,2), total_minutes int, early_departure_minutes int,
  status text default 'present',
  source text, source_detail text, verification_method text,
  clock_in_lat numeric, clock_in_lng numeric, clock_in_accuracy numeric, clock_in_distance float,
  clock_out_lat numeric, clock_out_lng numeric, clock_out_accuracy numeric, clock_out_distance float,
  geofence_id uuid, geofence_distance float, geofence_status text, location_status text,
  branch_id uuid, device_id uuid, auto_clock_out boolean default false);
alter table public.attendance_records add constraint attendance_records_status_check check (status in ('present','absent','late','early_exit','on_leave','incomplete','corrected'));
create or replace function public.geo_distance(lat1 float, lng1 float, lat2 float, lng2 float) returns float language sql immutable as $$ select 6371000*2*asin(sqrt(power(sin(radians(lat2-lat1)/2),2)+cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lng2-lng1)/2),2))) $$;
create or replace function public.auth_uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select public.auth_uid() $$;
-- Harness helper: emulate a Supabase authenticated session the way PostgREST
-- does, so the SAME code path (auth.uid() + current_role()) is exercised.
create or replace function public.test_sign_in(p_uid uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text,''), false);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text, 'role', p_role)::text, false);
end $$;
create or replace function public.test_sign_out() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claims', '', false);
end $$;
create or replace function public.att_app_timezone() returns text language sql stable as $$ select 'Africa/Lagos' $$;
create or replace function public.current_role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'role','') $$;
create or replace function public.get_area_manager_area_branches(p_employee_id uuid) returns table(branch_id uuid, branch_name text) language sql stable as $$ select null::uuid, null::text where false $$;
-- Leave planner prerequisites.
create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_name text, leave_type text default 'annual',
  start_date date, end_date date, days int, reason text,
  status text default 'pending', approval_level int default 1,
  created_by uuid, created_at timestamptz default now());
create table if not exists public.permissions (id uuid primary key default gen_random_uuid(), permission_key text unique);
create table if not exists public.roles (id uuid primary key default gen_random_uuid(), role_name text unique);
create table if not exists public.role_permissions (role_id uuid, permission_id uuid, updated_by uuid, unique(role_id, permission_id));
create table if not exists public.permission_delegation (id uuid primary key default gen_random_uuid(), grantee_type text, grantee_key text, module text, max_scope text default 'global', unique(grantee_type, grantee_key, module));
create or replace function public.seed_permission(text,text,text,text,text,boolean,text) returns void language sql as $$ insert into public.permissions(permission_key) values ($1) on conflict do nothing $$;
create or replace function public.seed_role_permission(text,text) returns void language sql as $$ insert into public.role_permissions(role_id,permission_id) select r.id,p.id from public.roles r, public.permissions p where r.role_name=$1 and p.permission_key=$2 on conflict do nothing $$;