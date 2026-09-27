-- ============================================================================
-- PHASE 70 - ATTENDANCE + EMPLOYEE LOCATION INTELLIGENCE (part 2 of 3)
-- ============================================================================
-- Run in Supabase SQL Editor AFTER 20260926000001. Idempotent, additive,
-- transaction-wrapped.
--
-- WHAT THIS PART DOES
--   1. public.employee_tracking_access(p_user_id)  -- THE single authorization
--      decision. Super Admin => full. A delegated user/role => allowed only
--      while the grant is live. Everyone else => DENIED. Every tracking RPC
--      calls this, so authorization cannot be bypassed by calling Supabase
--      directly (A9, §19).
--   2. tracking_access_grants: share with a user OR a role, for ever / until
--      a date-time / for X hours / for X days. Expired grants are revoked
--      automatically on read (no cron required), and can be revoked
--      immediately by the Super Admin.
--   3. record_employee_location(): heartbeat ingest. Resolves through
--      resolve_employee_location() (the ONE engine) and records the ACTUAL
--      observed timestamp, so gaps stay visible and are never filled in.
--   4. Location retention (A11): precise history is pruned on a configurable
--      age; a non-positive / null setting means "keep" and never deletes.
--   5. Audit rows into the EXISTING audit_logs table (A10).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. TRACKING ACCESS GRANTS
-- ---------------------------------------------------------------------------
create table if not exists public.tracking_access_grants (
  id uuid primary key default gen_random_uuid(),
  -- grant_target_type: 'user' | 'role'
  target_type text not null check (target_type in ('user','role')),
  target_user_id uuid references auth.users(id) on delete cascade,
  target_role text,
  granted_by uuid not null references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  reason text,
  constraint tracking_grant_target_check check (
    (target_type = 'user' and target_user_id is not null and target_role is null)
    or
    (target_type = 'role' and target_role is not null and target_user_id is null)
  )
);

comment on column public.tracking_access_grants.expires_at is
  'NULL means "forever". A grant whose expires_at has passed is treated as revoked automatically on every read - no cron and no manual step is required.';

create index if not exists idx_tracking_grants_user on public.tracking_access_grants (target_user_id) where revoked_at is null;
create index if not exists idx_tracking_grants_role on public.tracking_access_grants (target_role) where revoked_at is null;
create index if not exists idx_tracking_grants_expiry on public.tracking_access_grants (expires_at) where revoked_at is null;

alter table public.tracking_access_grants enable row level security;
-- Nobody reads or writes this table directly; the RPCs below are the only path.
revoke all on public.tracking_access_grants from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. THE SINGLE TRACKING AUTHORIZATION DECISION
-- ---------------------------------------------------------------------------
-- Returns { can_view, can_manage, via, expires_at, reason }.
-- Deliberately a function rather than an RLS predicate so the SAME rule is
-- reused by the web module, the mobile app, the reporting views and the audit
-- log writer - there is exactly one place where "may this person see
-- employee tracking data?" is answered.
create or replace function public.employee_tracking_access(p_user_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_role text;
  v_grant record;
  v_is_super boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('can_view', false, 'can_manage', false,
      'via', 'none', 'expires_at', null,
      'reason', 'Not signed in.');
  end if;

  select p.role into v_role from public.profiles p where p.id = v_uid;
  v_is_super := coalesce(v_role, '') = 'super_admin';

  -- Super Admin: full access, no grant required.
  if v_is_super then
    return jsonb_build_object('can_view', true, 'can_manage', true,
      'via', 'super_admin', 'expires_at', null, 'reason', null);
  end if;

  -- Delegated access: the EARLIEST live expiry is reported, and any grant whose
  -- expiry has already passed is simply ignored here (auto-revocation).
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
      'can_view', true,
      'can_manage', false,
      'via', 'delegated:' || v_grant.target_type,
      'expires_at', v_grant.expires_at,
      'reason', null);
  end if;

  return jsonb_build_object('can_view', false, 'can_manage', false,
    'via', 'none', 'expires_at', null,
    'reason', 'Employee tracking requires an explicit grant from the Super Admin.');
end;
$$;

revoke all on function public.employee_tracking_access(uuid) from public;
grant execute on function public.employee_tracking_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. LOCATION RETENTION  (A11 / section 21)
-- ---------------------------------------------------------------------------
-- Precise location history is sensitive. HR/Super Admin configure how long it
-- is kept; NULL or <= 0 means "keep indefinitely" and the pruner then does
-- nothing. Nothing is deleted automatically until this is configured.
alter table public.hr_platform_settings
  add column if not exists location_retention_days integer;

comment on column public.hr_platform_settings.location_retention_days is
  'Days of precise location history to keep. NULL or <= 0 keeps everything. Pruning is explicit (prune_employee_location_history), never silent.';

create or replace function public.prune_employee_location_history(
  p_older_than_days integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer;
  v_cutoff timestamptz;
  v_deleted integer;
  v_access jsonb;
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_manage')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  select coalesce(p_older_than_days, location_retention_days)
    into v_days from public.hr_platform_settings where id = 1;

  if v_days is null or v_days <= 0 then
    return jsonb_build_object('ok', true, 'pruned', 0, 'retention_days', v_days,
      'note', 'Retention is not configured; no location history was deleted.');
  end if;

  v_cutoff := now() - make_interval(days => v_days);
  delete from public.employee_location_events where recorded_at < v_cutoff;
  v_deleted := found;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LOCATION_HISTORY_PRUNED', 'EmployeeLocationEvent', null,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('retention_days', v_days, 'cutoff', v_cutoff,
                              'rows_deleted', v_deleted)::text, 'warning');

  return jsonb_build_object('ok', true, 'pruned', v_deleted,
                            'retention_days', v_days, 'cutoff', v_cutoff);
end;
$$;

revoke all on function public.prune_employee_location_history(integer) from public;
grant execute on function public.prune_employee_location_history(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. HEARTBEAT INGEST  (A10 / section 24)
-- ---------------------------------------------------------------------------
-- Records the ACTUAL observed position and time. p_recorded_at is when the
-- device saw it; uploaded_at is when it reached the server, so an offline
-- point is visibly "recorded earlier, synced later". A ~30 minute cadence is
-- REQUESTED by the client but never enforced or invented here: a mobile OS may
-- delay collection, and the real gaps are preserved rather than back-filled.
--
-- An employee may only record their OWN position. There is no parameter by
-- which one user could submit a location for another employee.
create or replace function public.record_employee_location(
  p_lat float,
  p_lng float,
  p_accuracy float default null,
  p_recorded_at timestamptz default null,
  p_source text default 'mobile',
  p_source_detail text default null,
  p_device_id text default null,
  p_device_fingerprint text default null,
  p_attendance_record_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_resolved jsonb;
  v_id uuid;
  v_recorded timestamptz := coalesce(p_recorded_at, now());
  v_inserted boolean := false;
begin
  select e.* into v_employee
    from public.employees e
    join public.profiles p on p.id = e.user_id
   where p.id = auth.uid()
   limit 1;

  if not found then
    raise exception 'NO_EMPLOYEE_PROFILE:No employee record is linked to this account.';
  end if;

  -- Reject obviously impossible client timestamps rather than storing them.
  if v_recorded > now() + interval '5 minutes' then
    v_recorded := now();
  end if;

  -- THE single geofence engine. Tracking never invents its own calculation.
  v_resolved := public.resolve_employee_location(p_lat, p_lng, 'track', null);

  insert into public.employee_location_events (
    employee_id, latitude, longitude, accuracy, recorded_at, uploaded_at,
    source, source_detail, device_id, device_fingerprint,
    attendance_record_id, detected_geofence_id, detected_branch_id,
    location_label, inside_geofence, distance_meters
  ) values (
    v_employee.id, p_lat, p_lng, p_accuracy, v_recorded, now(),
    lower(coalesce(nullif(p_source, ''), 'mobile')),
    p_source_detail, p_device_id, p_device_fingerprint,
    p_attendance_record_id,
    nullif(v_resolved ->> 'geofence_id', '')::uuid,
    nullif(v_resolved ->> 'branch_id', '')::uuid,
    v_resolved ->> 'human_label',
    coalesce((v_resolved ->> 'inside')::boolean, false),
    nullif(v_resolved ->> 'distance_meters', '')::numeric
  )
  -- Dedupe on the observation identity (employee, recorded_at, lat, lng) so a
  -- retried offline upload can never create a duplicate point. Referencing the
  -- unique INDEX by name in ON CONFLICT is not valid SQL, hence the column list.
  on conflict (employee_id, recorded_at, latitude, longitude) do nothing;

  v_inserted := found;
  if v_inserted then
    select id into v_id
      from public.employee_location_events
     where employee_id = v_employee.id
       and recorded_at = v_recorded
       and latitude = p_lat
       and longitude = p_lng
     limit 1;
  end if;

  return jsonb_build_object(
    'ok', true,
    'stored', v_inserted,
    'id', v_id,
    'recorded_at', v_recorded,
    'uploaded_at', now(),
    'offline_sync', p_recorded_at is not null
                    and p_recorded_at < now() - interval '2 minutes',
    'location', v_resolved);
end;
$$;

revoke all on function public.record_employee_location(float, float, float, timestamptz, text, text, text, text, uuid) from public;
grant execute on function public.record_employee_location(float, float, float, timestamptz, text, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. READ: LIVE POSITIONS  (A9, B1)
-- ---------------------------------------------------------------------------
-- Every read re-checks authorization. A user calling this directly with a
-- valid session token still gets nothing unless employee_tracking_access()
-- allows it.
create or replace function public.list_tracked_employees(
  p_within_minutes integer default 60,
  p_department text default null,
  p_branch_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_rows jsonb;
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  -- One row per employee: their most recent observation, with an explicit
  -- staleness measure so the UI can never present an old point as live.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen desc), '[]') into v_rows
    from (
      select e.id as employee_id,
             e.full_name,
             e.employee_number,
             e.position,
             e.department,
             e.branch_id,
             b.branch_name,
             le.latitude,
             le.longitude,
             le.accuracy,
             le.recorded_at as last_seen,
             le.uploaded_at,
             le.location_label,
             le.inside_geofence,
             le.distance_meters,
             round(extract(epoch from (now() - le.recorded_at)) / 60.0)::int as minutes_ago,
             (le.recorded_at < now() - interval '45 minutes') as is_stale,
             (select count(*) from public.employee_location_events c
               where c.employee_id = e.id
                 and c.recorded_at > now() - make_interval(mins => p_within_minutes)) as points_in_window
        from public.employee_location_events le
        join public.employees e on e.id = le.employee_id
        left join public.branches b on b.id = e.branch_id
       where le.id = (select l2.id from public.employee_location_events l2
                        where l2.employee_id = e.id
                        order by l2.recorded_at desc limit 1)
         and (p_department is null or lower(e.department) = lower(p_department))
         and (p_branch_id is null or e.branch_id = p_branch_id)
    ) x;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRACKING_HISTORY_VIEWED', 'EmployeeLocationEvent', null,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('view', 'live_positions', 'rows',
                             coalesce(jsonb_array_length(v_rows), 0), 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'access', v_access, 'employees', v_rows,
                            'generated_at', now());
end;
$$;

revoke all on function public.list_tracked_employees(integer, text, uuid) from public;
grant execute on function public.list_tracked_employees(integer, text, uuid) to authenticated;

-- Movement history for one employee on one date. The returned points are the
-- ACTUAL recorded observations in time order - the map polyline and the
-- timeline are both drawn from exactly this array, so no route between two
-- points is ever invented.
create or replace function public.employee_location_history(
  p_employee_id uuid,
  p_date date,
  p_from_time time default null,
  p_to_time time default null,
  p_inside_only text default 'all'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_tz text := public.att_app_timezone();
  v_points jsonb;
  v_emp record;
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if not found then
    raise exception 'Employee not found.';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') into v_points
    from (
      select le.id, le.latitude, le.longitude, le.accuracy, le.recorded_at,
             le.uploaded_at, le.source, le.device_id, le.location_label,
             le.inside_geofence, le.distance_meters, le.detected_branch_id,
             b.branch_name
        from public.employee_location_events le
        left join public.branches b on b.id = le.detected_branch_id
       where le.employee_id = p_employee_id
         and (le.recorded_at at time zone v_tz)::date = p_date
         and (p_from_time is null or (le.recorded_at at time zone v_tz)::time >= p_from_time)
         and (p_to_time   is null or (le.recorded_at at time zone v_tz)::time <= p_to_time)
         and (p_inside_only = 'all'
              or (p_inside_only = 'inside' and le.inside_geofence)
              or (p_inside_only = 'outside' and not le.inside_geofence))
    ) x;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_LOCATION_HISTORY_QUERIED', 'Employee', p_employee_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('date', p_date, 'points',
                             coalesce(jsonb_array_length(v_points), 0), 'success', true)::text,
          'info');

  return jsonb_build_object(
    'ok', true,
    'employee', jsonb_build_object(
      'id', v_emp.id, 'full_name', v_emp.full_name,
      'employee_number', v_emp.employee_number, 'position', v_emp.position,
      'department', v_emp.department, 'branch_id', v_emp.branch_id),
    'date', p_date,
    'points', v_points,
    'point_count', coalesce(jsonb_array_length(v_points), 0),
    'timezone', v_tz);
end;
$$;

revoke all on function public.employee_location_history(uuid, date, time, time, text) from public;
grant execute on function public.employee_location_history(uuid, date, time, time, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. SHARE  (A9, A10, section 16)
-- ---------------------------------------------------------------------------
-- Duration is expressed as an ISO-8601 duration so HR never has to think in
-- timestamps: 'forever', 'PT8H' (X hours), 'P2D' (X days), or an explicit
-- 'until' timestamp.
create or replace function public.grant_tracking_access(
  p_target_type text,
  p_target_user_id uuid default null,
  p_target_role text default null,
  p_duration text default 'forever',
  p_expires_at timestamptz default null,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_expires timestamptz;
  v_id uuid;
  v_kind text := lower(coalesce(nullif(p_duration, ''), 'forever'));
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_manage')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Only the Super Admin can share tracking access.');
  end if;

  if p_target_type not in ('user','role') then
    raise exception 'INVALID_TARGET_TYPE:Target must be a user or a role.';
  end if;
  if p_target_type = 'user' and p_target_user_id is null then
    raise exception 'INVALID_TARGET:A user grant requires p_target_user_id.';
  end if;
  if p_target_type = 'role' and nullif(trim(coalesce(p_target_role,'')),'') is null then
    raise exception 'INVALID_TARGET:A role grant requires p_target_role.';
  end if;

  if p_expires_at is not null then
    v_expires := p_expires_at;
  elsif v_kind in ('forever','never') then
    v_expires := null;
  else
    -- PT<n>H for hours, P<n>D for days. Case-insensitive: normalize to the
    -- upper-case form PostgreSQL's interval parser expects.
    v_expires := now() + coalesce(upper(v_kind)::interval, interval '0');
    if v_expires <= now() then
      raise exception 'INVALID_DURATION:Duration must be positive, or use ''forever''.';
    end if;
  end if;

  insert into public.tracking_access_grants (
    target_type, target_user_id, target_role, granted_by, expires_at, reason
  ) values (
    p_target_type,
    case when p_target_type = 'user' then p_target_user_id else null end,
    case when p_target_type = 'role' then nullif(trim(p_target_role), '') else null end,
    auth.uid(), v_expires, nullif(trim(coalesce(p_reason,'')), '')
  ) returning id into v_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRACKING_ACCESS_GRANTED', 'TrackingAccessGrant', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('target_type', p_target_type,
                              'target_user_id', p_target_user_id,
                              'target_role', p_target_role,
                              'expires_at', v_expires, 'reason', p_reason,
                              'success', true)::text, 'info');

  return jsonb_build_object('ok', true, 'id', v_id, 'expires_at', v_expires);
end;
$$;

revoke all on function public.grant_tracking_access(text, uuid, text, text, timestamptz, text) from public;
grant execute on function public.grant_tracking_access(text, uuid, text, text, timestamptz, text) to authenticated;

-- Active + historical shares, with an explicit status so the Super Admin can
-- see at a glance what is live, what has expired and what was revoked.
create or replace function public.list_tracking_access_grants()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_rows jsonb;
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_manage')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Only the Super Admin can list tracking access.');
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.granted_at desc), '[]') into v_rows
    from (
      select g.id, g.target_type, g.target_user_id, g.target_role, g.granted_at,
             g.expires_at, g.revoked_at, g.reason,
             gb.full_name as granted_by_name,
             ru.full_name as target_user_name,
             case
               when g.revoked_at is not null then 'revoked'
               when g.expires_at is not null and g.expires_at <= now() then 'expired'
               else 'active'
             end as status
        from public.tracking_access_grants g
        left join public.profiles gb on gb.id = g.granted_by
        left join public.profiles ru on ru.id = g.target_user_id
    ) x;

  return jsonb_build_object('ok', true, 'grants', v_rows);
end;
$$;

revoke all on function public.list_tracking_access_grants() from public;
grant execute on function public.list_tracking_access_grants() to authenticated;

-- Immediate revocation. Access is removed at once - the recipient does not
-- have to wait for the original expiry date.
create or replace function public.revoke_tracking_access(p_grant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access jsonb;
begin
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_manage')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Only the Super Admin can revoke tracking access.');
  end if;

  update public.tracking_access_grants
     set revoked_at = now(), revoked_by = auth.uid()
   where id = p_grant_id and revoked_at is null;

  if not found then
    raise exception 'GRANT_NOT_FOUND:That tracking grant does not exist or was already revoked.';
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRACKING_ACCESS_REVOKED', 'TrackingAccessGrant', p_grant_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('grant_id', p_grant_id, 'success', true)::text, 'info');

  return jsonb_build_object('ok', true, 'revoked_at', now());
end;
$$;

revoke all on function public.revoke_tracking_access(uuid) from public;
grant execute on function public.revoke_tracking_access(uuid) to authenticated;

-- Expiry reporting for the audit trail. Expired grants are already denied by
-- employee_tracking_access(); this only makes the transition visible.
create or replace function public.expire_tracking_access_grants()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expired integer;
begin
  update public.tracking_access_grants
     set revoked_at = expires_at, revoked_by = null
   where revoked_at is null and expires_at is not null and expires_at <= now();
  v_expired := found;

  if v_expired > 0 then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('TRACKING_PERMISSION_EXPIRED', 'TrackingAccessGrant', null, 'System (expiry sweep)',
            jsonb_build_object('grants_expired', v_expired, 'success', true)::text, 'info');
  end if;

  return jsonb_build_object('ok', true, 'expired', v_expired,
    'note', 'Expiry is already enforced on read; this only records the transition.');
end;
$$;

revoke all on function public.expire_tracking_access_grants() from public;
grant execute on function public.expire_tracking_access_grants() to authenticated;

-- ---------------------------------------------------------------------------
-- PERMISSION CATALOG ENTRIES for the Phase 70 modules
-- ---------------------------------------------------------------------------
-- Deliberately NOT inserted into the generated block above (that block is
-- regenerated from src/constants/roles.js by scripts/gen-privilege-seed.mjs).
-- These three modules are not role-granular: tracking access is granted
-- dynamically per-person/role through tracking_access_grants, and the leave
-- planner keys off the existing HR leave permissions. They are registered here
-- so the catalog stays complete and the UI can reference stable keys.
select public.seed_permission('tracking.view', 'View employee tracking (tracking.view)', 'tracking', 'view', 'view', false, 'tracking');
select public.seed_permission('tracking.manage', 'Manage employee tracking (tracking.manage)', 'tracking', 'manage', 'manage', false, 'tracking');
select public.seed_permission('tracking.share', 'Share employee tracking access (tracking.share)', 'tracking', 'share', 'share', false, 'tracking');
select public.seed_permission('leave.schedule.view', 'View the leave schedule planner (leave.schedule.view)', 'leave_config', 'schedule', 'view', false, 'hr');
select public.seed_permission('leave.schedule.manage', 'Manage leave schedules (leave.schedule.manage)', 'leave_config', 'schedule', 'manage', false, 'hr');
select public.seed_permission('leave.schedule.configure', 'Configure leave capacity rules (leave.schedule.configure)', 'leave_config', 'schedule', 'configure', false, 'hr_config');

-- Baseline grants. Super Admin is the default holder of tracking (the RPC also
-- treats super_admin as unconditional). HR roles get the planner surface but
-- NOT tracking: tracking stays opt-in per the sharing requirement.
select public.seed_role_permission('super_admin', 'tracking.view');
select public.seed_role_permission('super_admin', 'tracking.manage');
select public.seed_role_permission('super_admin', 'tracking.share');
select public.seed_role_permission('head_of_human_resources', 'leave.schedule.view');
select public.seed_role_permission('head_of_human_resources', 'leave.schedule.manage');
select public.seed_role_permission('head_of_human_resources', 'leave.schedule.configure');
select public.seed_role_permission('admin', 'leave.schedule.view');
select public.seed_role_permission('admin', 'leave.schedule.manage');
select public.seed_role_permission('admin', 'leave.schedule.configure');
select public.seed_role_permission('hr_officer', 'leave.schedule.view');
select public.seed_role_permission('hr_officer', 'leave.schedule.manage');

-- Delegation authority: who may share tracking access.
insert into public.permission_delegation (grantee_type, grantee_key, module, max_scope)
values ('role', 'super_admin', 'tracking', 'global')
on conflict (grantee_type, grantee_key, module) do nothing;

commit;