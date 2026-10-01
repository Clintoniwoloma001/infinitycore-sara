begin;

-- ===========================================================================
-- Employee Tracking — history access checks the SUBJECT
--
-- THE BUG THIS PROVES
--   employee_location_history() called employee_tracking_access() with NO
--   ARGUMENT, so the decision was made about the caller rather than about the
--   employee whose history was being read. Production's overload takes that
--   argument as p_employee_id, so the caller's own id was evaluated as though
--   it were the subject, the grant lookup missed, and a SUPER ADMIN was told
--   "Employee tracking requires an explicit grant from the Super Admin".
--
-- The two cases that must both hold:
--   * a Super Admin reads ANY employee's history, with no grant at all
--   * an ungranted viewer is still refused for that same employee
--
-- The second case matters as much as the first: fixing the first by simply
-- removing the check would have opened every employee's history to everybody.
-- ============================================================================

-- Minimal prerequisites: only what the function under test touches.
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  branch_name text not null
);

alter table public.profiles add column if not exists timezone text;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text, entity_type text, entity_id text, user_name text,
  details text, severity text, created_at timestamptz not null default now()
);

-- employees and employee_location_events already exist here; add what the
-- migration under test selects.
alter table public.employees
  add column if not exists position text,
  add column if not exists department text;

alter table public.employee_location_events
  add column if not exists resolved_place text,
  add column if not exists nearest_location_name text,
  add column if not exists nearest_distance numeric(12, 2),
  add column if not exists nearest_radius numeric(12, 2),
  add column if not exists detected_branch_id uuid;

-- This database keys profiles and employees at auth.users, which is not
-- available here. A local stand-in lets the fixture insert its own accounts,
-- and the employee triggers are suspended for the same reason as the previous
-- acceptance test. WITHOUT this the seed is rejected and every later assertion
-- silently tests an empty table.
do $$
declare
  t record;
begin
  if to_regclass('public.test_auth_users') is null then
    execute 'create table public.test_auth_users (id uuid primary key)';
    alter table public.profiles drop constraint if exists profiles_id_fkey;
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references public.test_auth_users(id) not valid;
  end if;

  if exists (select 1 from pg_constraint
              where conrelid = 'public.employees'::regclass
                and conname = 'employees_user_id_fkey') then
    alter table public.employees drop constraint employees_user_id_fkey;
    alter table public.employees
      add constraint employees_user_id_fkey
      foreign key (user_id) references public.test_auth_users(id) not valid;
  end if;

  for t in
    select tgname from pg_trigger
     where tgrelid = 'public.employees'::regclass and not tgisinternal
  loop
    execute format('alter table public.employees disable trigger %I', t.tgname);
  end loop;
end
$$;

create table if not exists public.tracking_access_grants (
  id uuid primary key default gen_random_uuid(),
  target_type text not null,
  target_user_id uuid,
  target_role text,
  expires_at timestamptz,
  revoked_at timestamptz
);

-- The application timezone helper the history function calls at declaration
-- time. A fixed zone keeps the date filter deterministic.
create or replace function public.att_app_timezone() returns text
language sql immutable as $$ select 'Africa/Lagos' $$;

-- The gate, with the SUBJECT-aware signature production actually uses:
-- the argument is the employee being viewed, and the caller's identity comes
-- from auth.uid(). This is the shape that made the Super Admin fail.
create or replace function public.employee_tracking_access(p_employee_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text;
  v_grant record;
begin
  select p.role into v_role from public.profiles p where p.id = auth.uid();

  -- Super Admin: full access, no grant required. Checked FIRST.
  if coalesce(v_role, '') = 'super_admin' then
    return jsonb_build_object('can_view', true, 'can_manage', true,
      'via', 'super_admin', 'expires_at', null, 'reason', null);
  end if;

  select g.* into v_grant
    from public.tracking_access_grants g
   where g.revoked_at is null
     and (g.expires_at is null or g.expires_at > now())
     and ((g.target_type = 'role' and g.target_role = v_role)
       or (g.target_type = 'user' and g.target_user_id = p_employee_id))
   order by g.expires_at asc nulls last
   limit 1;

  if found then
    return jsonb_build_object('can_view', true, 'can_manage', false,
      'via', 'delegated:' || v_grant.target_type,
      'expires_at', v_grant.expires_at, 'reason', null);
  end if;

  return jsonb_build_object('can_view', false, 'can_manage', false, 'via', 'none',
    'expires_at', null,
    'reason', 'Employee tracking requires an explicit grant from the Super Admin.');
end;
$$;

\echo '--- applying the migration under test ---'
\i supabase/migrations/20261101000004_tracking_history_access_checks_subject.sql

-- ============================================================================
-- FIXTURE
--   SUPER   - role super_admin, the person who was refused
--   VIEWER   - role staff, no grant at all
--   EMPLOYEE - the subject whose history is read
-- ============================================================================
\echo '--- seeding ---'

insert into public.test_auth_users (id) values
  ('a2222222-2222-2222-2222-222222222222'),
  ('a3333333-3333-3333-3333-333333333333'),
  ('a4444444-4444-4444-4444-444444444444'),
  ('a5555555-5555-5555-5555-555555555555')
on conflict (id) do nothing;

insert into public.branches (id, branch_name)
values ('a1111111-1111-1111-1111-111111111111', 'Head Office')
on conflict (id) do nothing;

delete from public.employee_location_events where employee_id = 'e1111111-1111-1111-1111-111111111111';
delete from public.employees where id = 'e1111111-1111-1111-1111-111111111111';
delete from public.tracking_access_grants;
delete from public.profiles where id in (
  'a2222222-2222-2222-2222-222222222222',  -- super admin
  'a3333333-3333-3333-3333-333333333333'   -- ungranted viewer
);

insert into public.profiles (id, full_name, role, timezone) values
  ('a2222222-2222-2222-2222-222222222222', 'Super Admin User', 'super_admin', 'Africa/Lagos'),
  ('a3333333-3333-3333-3333-333333333333', 'Ungranted Viewer', 'staff', 'Africa/Lagos');

insert into public.employees
  (id, user_id, full_name, employee_number, position, department, branch_id)
values (
  'e1111111-1111-1111-1111-111111111111',
  'a4444444-4444-4444-4444-444444444444',
  'Tracked Employee', 'INF/00/001', 'Officer', 'Operations',
  'a1111111-1111-1111-1111-111111111111'
);

insert into public.employee_location_events
  (employee_id, latitude, longitude, recorded_at, location_label, inside_geofence)
values (
  'e1111111-1111-1111-1111-111111111111',
  6.605829, 3.392538, now(), 'HEAD OFFICE', true
);

-- Sign in as the Super Admin. `false` = session scoped, so the claim survives
-- to the next statement (psql autocommits between statements).
select set_config('request.jwt.claims',
  '{"sub":"a2222222-2222-2222-2222-222222222222","role":"authenticated"}', false);

\echo '--- 1. a SUPER ADMIN reads the history with NO grant ---'
select case when public.employee_location_history(
               'e1111111-1111-1111-1111-111111111111',
               (now() at time zone 'Africa/Lagos')::date
             ) ->> 'ok' = 'true'
       then 'PASS' else 'FAIL: the Super Admin was still refused' end as super_admin_reads_history;

\echo '--- 2. the points actually come back ---'
select case when (
    select jsonb_array_length(
      public.employee_location_history(
        'e1111111-1111-1111-1111-111111111111',
        (now() at time zone 'Africa/Lagos')::date
      ) -> 'points')
  ) = 1
       then 'PASS' else 'FAIL: no points returned' end as points_returned;

\echo '--- 3. resolved_place is exposed on every point ---'
select case when exists (
    select 1 from jsonb_array_elements(
      public.employee_location_history(
        'e1111111-1111-1111-1111-111111111111',
        (now() at time zone 'Africa/Lagos')::date
      ) -> 'points'
  ) p where p ? 'resolved_place'
) then 'PASS' else 'FAIL: resolved_place missing' end as point_exposes_place;

-- ============================================================================
-- The access decision is about the SUBJECT, so an ungranted viewer must STILL
-- be refused. Without this the "fix" would have been to delete the check.
-- ============================================================================
\echo '--- 4. an UNGRANTED viewer is still refused ---'
select set_config('request.jwt.claims',
  '{"sub":"a3333333-3333-3333-3333-333333333333","role":"authenticated"}', false);

do $$
begin
  perform public.employee_location_history(
    'e1111111-1111-1111-1111-111111111111',
    (now() at time zone 'Africa/Lagos')::date
  );
  raise notice 'UNGRANTED VIEWER WAS ALLOWED - the gate was removed, not fixed';
exception when others then
  if sqlerrm like '%TRACKING_FORBIDDEN%' then
    raise notice 'PASS: ungranted viewer refused (%)', sqlerrm;
  else
    raise notice 'FAIL: refused for the wrong reason (%)', sqlerrm;
  end if;
end
$$;

-- ============================================================================
-- 5. A per-user grant DOES open that specific employee, and only that one.
-- ============================================================================
\echo '--- 5. a targeted grant opens only the granted employee ---'
insert into public.tracking_access_grants (target_type, target_user_id)
values ('user', 'e1111111-1111-1111-1111-111111111111');

do $$
begin
  perform public.employee_location_history(
    'e1111111-1111-1111-1111-111111111111',
    (now() at time zone 'Africa/Lagos')::date
  );
  raise notice 'PASS: the granted employee is now readable';
exception when others then
  raise notice 'FAIL: a valid grant was still refused (%)', sqlerrm;
end
$$;

\echo '--- 6. the same viewer is refused for a DIFFERENT employee ---'
insert into public.employees
  (id, user_id, full_name, employee_number, position, department, branch_id)
values (
  'e2222222-2222-2222-2222-222222222222',
  'a5555555-5555-5555-5555-555555555555',
  'Other Employee', 'INF/00/002', 'Officer', 'Operations',
  'a1111111-1111-1111-1111-111111111111'
);

do $$
begin
  perform public.employee_location_history(
    'e2222222-2222-2222-2222-222222222222',
    (now() at time zone 'Africa/Lagos')::date
  );
  raise notice 'FAIL: the grant leaked to a different employee';
exception when others then
  if sqlerrm like '%TRACKING_FORBIDDEN%' then
    raise notice 'PASS: refused for the ungranted employee';
  else
    raise notice 'FAIL: refused for the wrong reason (%)', sqlerrm;
  end if;
end
$$;

rollback;