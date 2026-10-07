begin;

-- =========================================================================
-- Geofence Management, RBAC and the distance utility
--
-- WHY THIS FILE EXISTS
--   Geofence configuration lived in two places that could disagree:
--     * branches.{latitude,longitude,geofence_radius,geofence_active}
--       (Platform Settings -> Geofence, and the branch fallback both apps read)
--     * attendance_geofences (Attendance Settings -> Geofencing tab)
--   plus a third, `branch_geofences`, introduced by the mobile repo's
--   20261006170000_location_tracking_batch_sync.sql that nothing wrote to.
--   A radius changed on one surface kept showing the old value on the other,
--   so "what radius is this branch covered by?" had no single answer.
--
--   This migration makes `branch_geofences` the CANONICAL record for a branch
--   geofence and keeps the two legacy readers in step from the same write, so
--   every surface (attendance clock-in, Employee Tracking map, both apps)
--   renders the value that was saved — there is no second copy to drift.
--
-- WHAT IT PROVIDES
--   1. branch_geofences reconciled to the agreed columns:
--        id, branch_id, latitude, longitude, radius_meters, is_active,
--        created_by, created_at, updated_at
--      Legacy centre columns (center_lat/center_lng/active) are kept as
--      mirrors by a BEFORE trigger, because the earlier mobile migration and
--      its PostGIS `geom` column are generated from them. One write fills
--      whichever shape the deployed table has; readers of either shape see
--      the same numbers.
--   2. Role gates. Geofence management is Super Admin / Head of Human
--      Resources ONLY. Every management RPC raises SQLSTATE 42501
--      (insufficient_privilege), which PostgREST answers as HTTP 403
--      Forbidden — the API-level refusal, not just a hidden menu item.
--   3. check_is_within_geofence(lat, lng, branch_id) -> {within, distance_meters}
--      The shared distance utility, built on public.geo_distance (the same
--      haversine resolve_employee_location() uses, so a test in the app can
--      never disagree with the server's own verdict).
--   4. employee_tracking_access() re-issued so the roles the product defines
--      as tracking viewers — Super Admin, Head of HR, MD/CEO, Director,
--      Chairman — are admitted by role instead of needing an admin to issue a
--      grant to each of them. Super Admin keeps can_manage; nobody else can
--      ever re-share tracking, grant or not.
--
-- IDEMPOTENT AND ADDITIVE. Safe to run twice; no data is deleted.
-- =========================================================================

-- ---------------------------------------------------------------------------
-- 0. PostGIS, best effort
--     The earlier migration declared a generated `geom` column. It is an
--     optimisation (GiST index for spatial joins), not a dependency: every
--     distance in this file goes through public.geo_distance, which is plain
--     SQL. If the extension cannot be created the whole block is skipped
--     notice-and-continue instead of failing the migration.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists postgis;
  exception when others then
    raise notice 'geofence: postgis extension unavailable (%)', sqlerrm;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 1. THE CANONICAL TABLE
-- ---------------------------------------------------------------------------
create table if not exists public.branch_geofences (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references public.branches(id) on delete cascade,
  latitude      numeric(10,6) not null,
  longitude     numeric(10,6) not null,
  radius_meters numeric(10,2) not null default 100,
  is_active     boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Reconcile with the shape deployed by 20261006170000 (center_lat/center_lng/
-- active, no latitude/longitude/is_active/created_by). Every statement is
-- IF NOT EXISTS, so a database that already has the canonical shape is a no-op.
alter table public.branch_geofences add column if not exists latitude numeric(10,6);
alter table public.branch_geofences add column if not exists longitude numeric(10,6);
alter table public.branch_geofences add column if not exists is_active boolean;
alter table public.branch_geofences add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.branch_geofences add column if not exists created_at timestamptz not null default now();
alter table public.branch_geofences add column if not exists updated_at timestamptz not null default now();
alter table public.branch_geofences add column if not exists center_lat numeric(10,6);
alter table public.branch_geofences add column if not exists center_lng numeric(10,6);
alter table public.branch_geofences add column if not exists active boolean;

-- Backfill canonical <- legacy, then lock the canonical columns down when the
-- data allows it. A legacy database with genuinely null centres keeps the
-- column nullable rather than failing the migration: the trigger below refuses
-- such a row from here on, so the constraint tightens for writes either way.
update public.branch_geofences
   set latitude  = center_lat
 where latitude is null and center_lat is not null;
update public.branch_geofences
   set longitude = center_lng
 where longitude is null and center_lng is not null;
update public.branch_geofences
   set is_active = coalesce(active, true)
 where is_active is null;

do $$
begin
  alter table public.branch_geofences alter column latitude set not null;
  alter table public.branch_geofences alter column longitude set not null;
exception when others then
  raise notice 'geofence: legacy rows without coordinates kept nullable (%)', sqlerrm;
end $$;

-- Generated spatial column + index, only when PostGIS is actually present.
do $$
begin
  alter table public.branch_geofences
    add column if not exists geom geography(point, 4326)
    generated always as (st_setsrid(st_makepoint(center_lng, center_lat), 4326)::geography) stored;
  create index if not exists idx_branch_geofences_geom
    on public.branch_geofences using gist (geom);
exception when others then
  raise notice 'geofence: generated geom skipped (%)', sqlerrm;
end $$;

create index if not exists idx_branch_geofences_branch_id on public.branch_geofences(branch_id);
create index if not exists idx_branch_geofences_active on public.branch_geofences(is_active);

-- ---------------------------------------------------------------------------
-- 2. ONE WRITE, BOTH SHAPES
--     BEFORE INSERT OR UPDATE: the canonical columns win when they are set and
--     the legacy centre columns win when they are not, then both are written.
--     That is what makes a table deployed with center_lat/center_lng/active
--     and a table deployed with latitude/longitude/is_active behave identically
--     for every caller, including the PostGIS geom column, which is generated
--     from the legacy centre columns.
-- ---------------------------------------------------------------------------
create or replace function public.branch_geofences_normalize()
returns trigger
language plpgsql
as $$
begin
  new.latitude  := coalesce(new.latitude,  new.center_lat);
  new.longitude := coalesce(new.longitude, new.center_lng);
  new.is_active := coalesce(new.is_active, new.active, true);

  if new.branch_id is null then
    raise exception 'GEOFENCE_INVALID: branch_id is required.'
      using errcode = '22023';
  end if;
  if new.latitude is null or new.longitude is null
     or new.latitude <> new.latitude or new.longitude <> new.longitude
     or new.latitude < -90 or new.latitude > 90
     or new.longitude < -180 or new.longitude > 180 then
    raise exception 'GEOFENCE_INVALID: valid latitude and longitude are required.'
      using errcode = '22023';
  end if;
  if new.radius_meters is null or new.radius_meters < 10 or new.radius_meters > 5000 then
    raise exception 'GEOFENCE_INVALID_RADIUS: radius must be between 10 and 5000 meters.'
      using errcode = '22023';
  end if;

  new.center_lat   := new.latitude;
  new.center_lng   := new.longitude;
  new.active       := new.is_active;
  new.created_by   := coalesce(new.created_by, auth.uid());
  new.updated_at   := now();
  return new;
end;
$$;

drop trigger if exists branch_geofences_normalize on public.branch_geofences;
create trigger branch_geofences_normalize
  before insert or update on public.branch_geofences
  for each row execute function public.branch_geofences_normalize();

-- Direct table access is closed. Everything goes through the SECURITY DEFINER
-- RPCs below, which is where the role gate lives; RLS with no policy is the
-- backstop that keeps a client from writing the table around the gate.
alter table public.branch_geofences enable row level security;
revoke all on public.branch_geofences from anon;
revoke all on public.branch_geofences from authenticated;

-- ---------------------------------------------------------------------------
-- 3. THE ROLE GATES
--     Geofence Settings & Management: Super Admin and Head of Human Resources
--     only — the same two roles the mobile app's /bound-devices screen uses.
--     `hr_manager` is accepted alongside `head_of_human_resources` for the same
--     reason is_communication_admin() accepts both: the two platforms have
--     historically spelled that role two ways, and a rename must not silently
--     lock the Head of HR out of her own settings page.
-- ---------------------------------------------------------------------------
create or replace function public.is_geofence_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.role in ('super_admin', 'head_of_human_resources', 'hr_manager')
      from public.profiles p
     where p.id = auth.uid()
  ), false);
$$;

comment on function public.is_geofence_admin() is
  'True when the caller may administer branch geofences. Mirrors the mobile canManageGeofences() and the web GEOFENCE_ADMIN_ROLES gate — the RPC gate below is the boundary those two only hide UI behind.';

create or replace function public.require_geofence_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_geofence_admin() then
    raise exception 'GEOFENCE_FORBIDDEN: Geofence settings and management are restricted to Super Admin and Head of Human Resources.'
      using errcode = '42501';  -- insufficient_privilege -> HTTP 403 Forbidden
  end if;
end;
$$;

comment on function public.require_geofence_admin() is
  'Raises SQLSTATE 42501 (HTTP 403 Forbidden) unless the caller is Super Admin or Head of HR. Every /geofences management endpoint runs it first.';

-- ---------------------------------------------------------------------------
-- 4. LIST — read is gated too: the settings page is a management surface, and
--     enumerating every branch fence with its radius is configuration data.
--     (Employee attendance and the Employee Tracking map do NOT come through
--     here; they read branches / attendance_geofences / list_tracking_geofences
--     exactly as before, so no other feature depends on this gate.)
-- ---------------------------------------------------------------------------
create or replace function public.list_branch_geofences()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.require_geofence_admin();

  select coalesce(jsonb_agg(to_jsonb(x) order by x.branch_name, x.branch_code), '[]'::jsonb)
    into v_rows
    from (
      select bg.id,
             bg.branch_id,
             b.branch_name,
             b.branch_code,
             bg.latitude::float   as latitude,
             bg.longitude::float  as longitude,
             bg.radius_meters::float as radius_meters,
             coalesce(bg.is_active, bg.active, true) as is_active,
             coalesce(bg.is_active, bg.active, true) as active,
             bg.latitude::float   as center_lat,
             bg.longitude::float  as center_lng,
             bg.created_by,
             bg.created_at,
             bg.updated_at,
             (
               select count(*)
                 from public.employees e
                where e.branch_id = bg.branch_id
                  and coalesce(e.is_archived, false) = false
             ) as assigned_employees
        from public.branch_geofences bg
        join public.branches b on b.id = bg.branch_id
    ) x;

  return jsonb_build_object('ok', true, 'geofences', coalesce(v_rows, '[]'::jsonb));
end;
$$;

comment on function public.list_branch_geofences() is
  'All branch geofences with branch name/code, centre, radius, active flag and assigned-employee count. Super Admin / Head of HR only; other roles get HTTP 403.';

-- ---------------------------------------------------------------------------
-- 5. SAVE (create or correct) — the one write that keeps every reader in step
-- ---------------------------------------------------------------------------
create or replace function public.save_branch_geofence(
  p_branch_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_radius_meters numeric,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch record;
  v_id uuid;
  v_active boolean := coalesce(p_is_active, true);
  v_radius numeric := round(p_radius_meters::numeric, 2);
begin
  perform public.require_geofence_admin();

  if p_branch_id is null then
    raise exception 'GEOFENCE_INVALID: branch_id is required.' using errcode = '22023';
  end if;
  if p_latitude is null or p_longitude is null
     or p_latitude < -90 or p_latitude > 90
     or p_longitude < -180 or p_longitude > 180 then
    raise exception 'GEOFENCE_INVALID: valid latitude and longitude are required.' using errcode = '22023';
  end if;
  if v_radius is null or v_radius < 10 or v_radius > 5000 then
    raise exception 'GEOFENCE_INVALID_RADIUS: radius must be between 10 and 5000 meters.' using errcode = '22023';
  end if;

  select * into v_branch from public.branches b where b.id = p_branch_id;
  if not found then
    raise exception 'GEOFENCE_BRANCH_NOT_FOUND: no branch with that id.' using errcode = 'P0002';
  end if;

  -- (a) canonical row: one per branch, updated in place when present.
  select id into v_id
    from public.branch_geofences
   where branch_id = p_branch_id
   order by updated_at desc nulls last
   limit 1;

  if v_id is null then
    insert into public.branch_geofences (branch_id, latitude, longitude, radius_meters, is_active, created_by)
    values (p_branch_id, p_latitude, p_longitude, v_radius, v_active, auth.uid())
    returning id into v_id;
  else
    update public.branch_geofences
       set latitude = p_latitude,
           longitude = p_longitude,
           radius_meters = v_radius,
           is_active = v_active
     where id = v_id;
  end if;

  -- (b) branches: the fallback every attendance and tracking reader uses on
  --     BOTH platforms. Written in the same breath as the canonical row so the
  --     two can never hold different numbers.
  update public.branches
     set latitude = p_latitude,
         longitude = p_longitude,
         geofence_radius = v_radius::int,
         geofence_active = v_active,
         updated_at = now()
   where id = p_branch_id;

  -- (c) attendance_geofences: updated ONLY when the branch already has one, so
  --     a geofence configured here is never duplicated into the Attendance
  --     Settings list. Creating rows there is that module's own business.
  update public.attendance_geofences
     set latitude = p_latitude,
         longitude = p_longitude,
         radius_meters = v_radius::int,
         active = v_active,
         updated_at = now()
   where branch_id = p_branch_id::text
      or branch_id = v_branch.branch_name;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'GEOFENCE_SAVED',
    'Branch',
    p_branch_id::text,
    coalesce((select p.full_name from public.profiles p where p.id = auth.uid()), 'system'),
    jsonb_build_object(
      'branch', v_branch.branch_name,
      'latitude', p_latitude, 'longitude', p_longitude,
      'radius_meters', v_radius, 'is_active', v_active
    )::text,
    'info'
  );

  return public.list_branch_geofences()
         || jsonb_build_object('ok', true, 'saved_id', v_id, 'branch_id', p_branch_id);
end;
$$;

comment on function public.save_branch_geofence(uuid, numeric, numeric, numeric, boolean) is
  'Create or correct ONE branch geofence. Writes branch_geofences (canonical) and mirrors the same numbers onto branches and any existing attendance_geofences row, so attendance, tracking and both apps read back what was saved. Super Admin / Head of HR only; other roles get HTTP 403.';

-- ---------------------------------------------------------------------------
-- 6. TOGGLE — deactivate without destroying anything
-- ---------------------------------------------------------------------------
create or replace function public.set_branch_geofence_active(
  p_branch_id uuid,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active boolean := coalesce(p_is_active, true);
  v_found boolean := false;
begin
  perform public.require_geofence_admin();

  if p_branch_id is null then
    raise exception 'GEOFENCE_INVALID: branch_id is required.' using errcode = '22023';
  end if;

  update public.branch_geofences set is_active = v_active where branch_id = p_branch_id;
  v_found := found;

  update public.branches set geofence_active = v_active, updated_at = now() where id = p_branch_id;
  v_found := v_found or found;

  update public.attendance_geofences set active = v_active, updated_at = now()
   where branch_id = p_branch_id::text
      or branch_id = (select branch_name from public.branches where id = p_branch_id);
  v_found := v_found or found;

  if not v_found then
    raise exception 'GEOFENCE_NOT_FOUND: no geofence is configured for that branch.' using errcode = 'P0002';
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    case when v_active then 'GEOFENCE_ENABLED' else 'GEOFENCE_DISABLED' end,
    'Branch',
    p_branch_id::text,
    coalesce((select p.full_name from public.profiles p where p.id = auth.uid()), 'system'),
    jsonb_build_object('is_active', v_active)::text,
    'info'
  );

  return public.list_branch_geofences()
         || jsonb_build_object('ok', true, 'branch_id', p_branch_id, 'is_active', v_active);
end;
$$;

comment on function public.set_branch_geofence_active(uuid, boolean) is
  'Activate or disable a branch geofence everywhere at once. Disabling stops enforcement immediately but keeps the row and every historical location log intact. Super Admin / Head of HR only; other roles get HTTP 403.';

-- ---------------------------------------------------------------------------
-- 7. DELETE — canonical row goes, historical evidence does not
--     The branches / attendance_geofences copies are switched off rather than
--     erased: attendance records already reference them, and erasing the
--     centre coordinates would change what past clock-ins were verified
--     against. Nothing here touches employee_location_events.
-- ---------------------------------------------------------------------------
create or replace function public.delete_branch_geofence(
  p_branch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int := 0;
  v_configured boolean := false;
  v_branch_name text;
begin
  perform public.require_geofence_admin();

  if p_branch_id is null then
    raise exception 'GEOFENCE_INVALID: branch_id is required.' using errcode = '22023';
  end if;

  select branch_name into v_branch_name from public.branches where id = p_branch_id;

  -- Refuse up front when this branch has no geofence anywhere: switching the
  -- branches copy off below would otherwise "succeed" and report a deletion
  -- that removed nothing.
  select (
      exists (select 1 from public.branch_geofences where branch_id = p_branch_id)
      or exists (select 1 from public.branches
                  where id = p_branch_id and coalesce(geofence_active, false))
      or exists (select 1 from public.attendance_geofences
                  where (branch_id = p_branch_id::text or branch_id = v_branch_name)
                    and coalesce(active, false))
    ) into v_configured;

  if not v_configured then
    raise exception 'GEOFENCE_NOT_FOUND: no geofence is configured for that branch.' using errcode = 'P0002';
  end if;

  delete from public.branch_geofences where branch_id = p_branch_id;
  get diagnostics v_deleted = row_count;

  update public.branches set geofence_active = false, updated_at = now() where id = p_branch_id;

  update public.attendance_geofences set active = false, updated_at = now()
   where branch_id = p_branch_id::text or branch_id = v_branch_name;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'GEOFENCE_DELETED',
    'Branch',
    p_branch_id::text,
    coalesce((select p.full_name from public.profiles p where p.id = auth.uid()), 'system'),
    jsonb_build_object('branch', v_branch_name)::text,
    'info'
  );

  return public.list_branch_geofences()
         || jsonb_build_object('ok', true, 'branch_id', p_branch_id, 'deleted', v_deleted);
end;
$$;

comment on function public.delete_branch_geofence(uuid) is
  'Delete a branch geofence. The canonical row is removed and the legacy copies are disabled (never erased) so historical attendance and location logs keep resolving. Super Admin / Head of HR only; other roles get HTTP 403.';

-- ---------------------------------------------------------------------------
-- 8. THE DISTANCE UTILITY
--     check_is_within_geofence(lat, lng, branch_id) -> {within, distance_meters}
--
--     Uses public.geo_distance — the SAME haversine resolve_employee_location()
--     uses — so the "Test My Coverage" readout in either app reports the number
--     the server would enforce, not an approximation that could disagree with
--     a clock-in verdict.
--
--     Readable by any authenticated user: it answers a question about the
--     CALLER's own coordinates, and branch centres/radii are already visible to
--     employees for clock-in. It is not a management endpoint, so it is not
--     behind require_geofence_admin().
-- ---------------------------------------------------------------------------
create or replace function public.check_is_within_geofence(
  p_lat numeric,
  p_lng numeric,
  p_branch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lat numeric;
  v_lng numeric;
  v_radius numeric;
  v_source text;
  v_distance numeric;
begin
  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    return jsonb_build_object(
      'ok', false, 'within', false,
      'distance_meters', null, 'radius_meters', null,
      'error', 'INVALID_COORDINATES');
  end if;

  if p_branch_id is null then
    return jsonb_build_object(
      'ok', false, 'within', false,
      'distance_meters', null, 'radius_meters', null,
      'error', 'INVALID_BRANCH');
  end if;

  -- 1. canonical fence
  select bg.latitude, bg.longitude, bg.radius_meters, 'branch_geofences'
    into v_lat, v_lng, v_radius, v_source
    from public.branch_geofences bg
   where bg.branch_id = p_branch_id
     and coalesce(bg.is_active, bg.active, true)
   order by bg.updated_at desc nulls last
   limit 1;

  -- 2. branch row (the fallback both apps read)
  if v_lat is null then
    select b.latitude, b.longitude, b.geofence_radius, 'branches'
      into v_lat, v_lng, v_radius, v_source
      from public.branches b
     where b.id = p_branch_id
       and coalesce(b.geofence_active, false)
       and b.latitude is not null
       and b.longitude is not null
     limit 1;
  end if;

  -- 3. attendance geofence row for the same branch
  if v_lat is null then
    select g.latitude, g.longitude, g.radius_meters, 'attendance_geofences'
      into v_lat, v_lng, v_radius, v_source
      from public.attendance_geofences g
     where (g.branch_id = p_branch_id::text
            or g.branch_id = (select branch_name from public.branches where id = p_branch_id))
       and coalesce(g.active, false)
       and g.latitude is not null
       and g.longitude is not null
     limit 1;
  end if;

  if v_lat is null then
    return jsonb_build_object(
      'ok', true, 'within', false,
      'distance_meters', null, 'radius_meters', null,
      'branch_id', p_branch_id,
      'has_geofence', false,
      'reason', 'No active geofence is configured for this branch.');
  end if;

  v_distance := round(public.geo_distance(p_lat::float, p_lng::float, v_lat::float, v_lng::float)::numeric, 1);

  return jsonb_build_object(
    'ok', true,
    'within', v_distance <= v_radius,
    'distance_meters', v_distance,
    'radius_meters', v_radius::numeric,
    'branch_id', p_branch_id,
    'has_geofence', true,
    'source', v_source,
    'meters_outside', case when v_distance > v_radius
                           then round(v_distance - v_radius, 1)
                           else 0 end);
end;
$$;

comment on function public.check_is_within_geofence(numeric, numeric, uuid) is
  'Is (p_lat, p_lng) inside the branch''s active geofence? Returns within (boolean) and distance_meters (the exact haversine distance to the centre), plus radius_meters, metres still outside, and which store answered. Reads the same three sources the enforcement engine reads, in the same order of preference.';

-- ---------------------------------------------------------------------------
-- 9. TRACKING ACCESS — the five roles the product defines as tracking viewers
--
--     employee_tracking_access() is THE single tracking authorization
--     decision (20261101000005). Every tracking reader already calls it, so
--     admitting these roles here is what makes Employee Tracking reachable for
--     Head of HR, MD/CEO, Director and Chairman on web AND mobile without a
--     per-person grant — the mobile nav gate, the web trackingGate and the
--     server now agree instead of each being stricter than the last.
--
--     can_manage stays Super Admin ONLY: viewing staff location is not the
--     authority to hand that view to somebody else.
--
--     Reproduced from 20261101000005 with ONE addition: the baseline role
--     branch between the super-admin short circuit and the grant lookup. The
--     grant lookup below is unchanged, so an existing time-boxed grant still
--     works and still reports its expiry.
-- ---------------------------------------------------------------------------
drop function if exists public.employee_tracking_access(uuid);

create function public.employee_tracking_access(p_user_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- The CALLER. Never p_user_id: reading auth.uid() here is what makes the
  -- decision impossible to spoof by passing another id.
  v_uid uuid := auth.uid();
  v_role text;
  v_grant record;
  v_is_super boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('can_view', false, 'allowed', false,
      'can_manage', false, 'via', 'none', 'expires_at', null,
      'reason', 'Not signed in.');
  end if;

  select p.role into v_role from public.profiles p where p.id = v_uid;
  v_is_super := coalesce(v_role, '') = 'super_admin';

  -- Super Admin: full access, no grant required. Checked FIRST and it
  -- short-circuits, so this branch is reached with a trustworthy id.
  if v_is_super then
    return jsonb_build_object('can_view', true, 'allowed', true,
      'can_manage', true, 'via', 'super_admin', 'expires_at', null,
      'reason', null);
  end if;

  -- BASELINE VIEWERS (added by 20261102000001). Head of HR, MD/CEO, Director
  -- and Chairman are tracking VIEWS in the product's role matrix; they should
  -- not need the Super Admin to issue a grant before their menu appears.
  -- can_manage stays false: sharing is never delegable.
  if v_role in ('head_of_human_resources', 'hr_manager', 'md_ceo', 'chairman', 'director') then
    return jsonb_build_object('can_view', true, 'allowed', true,
      'can_manage', false, 'via', 'baseline_role', 'expires_at', null,
      'reason', null);
  end if;

  -- Delegated access. The grant must name THIS caller, either directly or by the
  -- caller's role. The EARLIEST live expiry is reported, and a grant whose
  -- expiry has already passed is ignored here — auto-revocation, no cron needed.
  select g.* into v_grant
    from public.tracking_access_grants g
   where g.revoked_at is null
     and (g.expires_at is null or g.expires_at > now())
     and ( (g.target_type = 'user'   and g.target_user_id = v_uid)
        or (g.target_type = 'role'  and g.target_role    = v_role) )
   order by g.expires_at asc nulls last
   limit 1;

  if found then
    return jsonb_build_object(
      'can_view', true, 'allowed', true,
      'can_manage', false,
      'via', 'delegated:' || v_grant.target_type,
      'expires_at', v_grant.expires_at,
      'reason', null);
  end if;

  return jsonb_build_object('can_view', false, 'allowed', false,
    'can_manage', false, 'via', 'none', 'expires_at', null,
    'reason', 'Employee tracking requires an explicit grant from the Super Admin.');
end;
$$;

comment on function public.employee_tracking_access(uuid) is
  'THE single tracking authorization decision. p_user_id is a USER id (profiles.id), NOT an employees.id, and is never consulted. Returns { can_view, allowed (alias of can_view), can_manage, via, expires_at, reason }. Super Admin => view + manage. Head of HR / MD-CEO / Director / Chairman => view only (baseline_role, added by 20261102000001). A live user/role grant => view only. Everything else => denied.';

revoke all on function public.employee_tracking_access(uuid) from public;
grant execute on function public.employee_tracking_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. GRANTS — management RPCs to authenticated (the gate inside decides),
--     every function's direct table access revoked from anon/authenticated.
-- ---------------------------------------------------------------------------
revoke all on function public.is_geofence_admin() from public;
revoke all on function public.is_geofence_admin() from anon;
grant execute on function public.is_geofence_admin() to authenticated;

revoke all on function public.require_geofence_admin() from public;
revoke all on function public.require_geofence_admin() from anon;
grant execute on function public.require_geofence_admin() to authenticated;

revoke all on function public.list_branch_geofences() from public;
revoke all on function public.list_branch_geofences() from anon;
grant execute on function public.list_branch_geofences() to authenticated;

revoke all on function public.save_branch_geofence(uuid, numeric, numeric, numeric, boolean) from public;
revoke all on function public.save_branch_geofence(uuid, numeric, numeric, numeric, boolean) from anon;
grant execute on function public.save_branch_geofence(uuid, numeric, numeric, numeric, boolean) to authenticated;

revoke all on function public.set_branch_geofence_active(uuid, boolean) from public;
revoke all on function public.set_branch_geofence_active(uuid, boolean) from anon;
grant execute on function public.set_branch_geofence_active(uuid, boolean) to authenticated;

revoke all on function public.delete_branch_geofence(uuid) from public;
revoke all on function public.delete_branch_geofence(uuid) from anon;
grant execute on function public.delete_branch_geofence(uuid) to authenticated;

revoke all on function public.check_is_within_geofence(numeric, numeric, uuid) from public;
revoke all on function public.check_is_within_geofence(numeric, numeric, uuid) from anon;
grant execute on function public.check_is_within_geofence(numeric, numeric, uuid) to authenticated;

commit;
