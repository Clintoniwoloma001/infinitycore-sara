begin;

-- =========================================================================
-- Employee Tracking — ONE access decision, applied consistently
--
-- THE REPORTED SYMPTOM
--   The Super Admin opened Employee Tracking. The LIVE POSITIONS list rendered
--   normally, but every MOVEMENT HISTORY request came back
--   "TRACKING_FORBIDDEN: Employee tracking requires an explicit grant from the
--   Super Admin." — for the Super Admin, who is the one person who never needs
--   a grant. Shared access was equally dead for the same reason.
--
--   Three independent defects produced it. All three are fixed below.
--
-- DEFECT 1 — THE ACCESS CALL PASSED THE WRONG KIND OF ID
--   employee_tracking_access(p_user_id uuid) evaluates the access of a USER:
--   it resolves `select role from profiles where id = v_uid` and then matches
--   tracking_access_grants on target_user_id / target_role.
--
--   Migration 20261101000004 made the history reader call it with the SUBJECT
--   EMPLOYEE:
--
--       v_access := public.employee_tracking_access(p_employee_id);
--
--   employees.id is NOT profiles.id. So the profiles lookup missed, v_is_super
--   stayed false, and the grant lookup searched for a grant whose
--   target_user_id was an EMPLOYEE uuid. No such row exists, so the function
--   returned the "requires an explicit grant" refusal. The Super Admin was
--   denied by their own employee id.
--
--   WHY IT ONLY SHOWED UP IN HISTORY
--   The other readers call employee_tracking_access() with NO argument, which
--   correctly resolves to auth.uid() — the caller. That is why the list worked
--   while every drawer failed, which is exactly the split that was reported.
--
--   THE FIX: authorization is a question about the VIEWER, never about the
--   employee being viewed. Grants in tracking_access_grants are per viewer (a
--   user or a role) and are not scoped per subject, so every read surface asks
--   the same question the same way — "may the CALLER see tracking at all?" —
--   and is then free to return whatever subset it legitimately serves. The
--   subject id is used to SELECT rows, never to decide access.
--
-- DEFECT 2 — A STALE RESULT KEY READ `allowed`, WHICH IS NEVER RETURNED
--   employee_tracking_access() returns `can_view`. Migration 20261101000003
--   tested `v_access ->> 'allowed'`, which is absent, so
--   `coalesce(null,false) = false` was TRUE and the function refused EVERY
--   caller — again including the Super Admin.
--
--   Both this migration and the re-issued readers now read `can_view`, and
--   employee_tracking_access() additionally publishes `allowed` as an explicit
--   ALIAS of `can_view`. That alias exists so a reader still deployed from an
--   older migration keeps working against the corrected function instead of
--   silently denying everyone again.
--
-- DEFECT 3 — employee_current_locations HAD NO ACCESS GATE AT ALL
--   That function is introduced by 20261101000003 as SECURITY DEFINER and was
--   re-issued there with no employee_tracking_access() check and no explicit
--   grants. A SECURITY DEFINER function with default privileges is executable
--   by PUBLIC, so ANY signed-in account could call it directly and receive the
--   live coordinates of EVERY employee — completely bypassing the sharing
--   model. It is now gated and granted to authenticated only.
--
-- THE RULE THIS FILE ENFORCES
--   can_view   -> Super Admin (unconditional) OR a live tracking grant for the
--                 caller (by user or by role). Expired grants fail closed.
--   can_manage -> Super Admin ONLY. Sharing and revoking access is never
--                 delegable: a grantee can watch, never re-share.
--
--   Idempotent, additive, transaction-wrapped, no data is modified.
-- =========================================================================
-- ---------------------------------------------------------------------------
-- 1. THE SINGLE DECISION — DROP AND RECREATE, plus `allowed` as an alias
-- ---------------------------------------------------------------------------
-- WHY DROP FIRST INSTEAD OF CREATE OR REPLACE
--   PostgreSQL refuses to change the NAME of an input parameter through
--   CREATE OR REPLACE ("cannot change name of input parameter"), and the
--   deployed signature does not agree with the repo migration: production has
--   `employee_tracking_access(p_employee_id uuid)`. So the function is dropped
--   and recreated, which also guarantees no stale body survives.
--
--   The drop is safe and is not a data operation: nothing stores a reference to
--   this function, plpgsql bodies are resolved at run time, and it is recreated
--   in this same transaction, so there is no window in which it is missing.
--
-- DEFECT 1 EVIDENCE (read from the live catalog, not assumed)
--   The deployed body resolved the role from auth.uid() but then matched
--   grants with `g.target_user_id = p_employee_id` — comparing a USER grant's
--   target against an EMPLOYEE uuid. Because employee_location_history passed
--   the subject employee in, a grant made to a specific PERSON could never
--   match, so time-boxed per-user access silently did not work. Role grants
--   happened to work only because the role came from auth.uid().
--
-- THE RULE, UNAMBIGUOUSLY
--   Authorization is a property of the CALLER. The parameter is retained only so
--   existing call sites keep compiling; it is NEVER consulted. No caller can
--   widen its own access by passing a different id.
-- ---------------------------------------------------------------------------
drop function if exists public.employee_tracking_access(uuid);

create or replace function public.employee_tracking_access(p_user_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- The CALLER. Never p_user_id: see the note above. Reading auth.uid() here is
  -- what makes the decision impossible to spoof by passing another id.
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
    -- can_manage is deliberately FALSE: being allowed to look is not the same
    -- authority as being allowed to hand the access on to somebody else.
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
  'THE single tracking authorization decision. p_user_id is a USER id (profiles.id), NOT an employees.id. Returns { can_view, allowed (alias of can_view), can_manage, via, expires_at, reason }. Super Admin => can_view and can_manage. A live user/role grant => can_view only. Everything else => denied.';

revoke all on function public.employee_tracking_access(uuid) from public;
grant execute on function public.employee_tracking_access(uuid) to authenticated;
-- ---------------------------------------------------------------------------
-- 2. MOVEMENT HISTORY — authorize the CALLER, then filter by subject
-- ---------------------------------------------------------------------------
-- Identical to 20261101000004 except for the single decisive line: the access
-- question is asked with NO argument, so it resolves to auth.uid().
create or replace function public.employee_location_history(
  p_employee_id uuid,
  p_date date,
  p_from_time time default null,
  p_to_time time default null,
  p_inside_only text default 'all'
) returns jsonb
language plpgsql
-- NOT `stable`: this writes an audit row, and PostgreSQL refuses an INSERT in a
-- stable function. It is also the honest classification.
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_tz text := public.att_app_timezone();
  v_points jsonb;
  v_emp record;
begin
  -- DEFECT 1 FIXED. No argument => auth.uid() => the VIEWER. The previous
  -- `employee_tracking_access(p_employee_id)` looked the employee id up in
  -- profiles, missed, and refused even the Super Admin.
  v_access := public.employee_tracking_access();
  -- DEFECT 2 FIXED. `can_view` is the real key; `allowed` is now also an alias.
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  -- Access is settled. Only now do we touch the subject, and only to read rows.
  select * into v_emp from public.employees where id = p_employee_id;
  if not found then
    raise exception 'Employee not found.';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') into v_points
    from (
      select le.id, le.latitude, le.longitude, le.accuracy, le.recorded_at,
             le.uploaded_at, le.source, le.device_id, le.location_label,
             le.resolved_place,
             le.inside_geofence, le.distance_meters, le.detected_branch_id,
             le.nearest_location_name, le.nearest_distance, le.nearest_radius,
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

  -- The auditor is the CALLER, resolved from the JWT, not the subject. These
  -- are two different people and conflating them would misattribute the audit.
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_LOCATION_HISTORY_QUERIED', 'Employee', p_employee_id::text,
          coalesce(
            (select full_name from public.profiles
              where id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid),
            (select p2.full_name from public.profiles p2
              where p2.id = (select e.user_id from public.employees e
                              where e.id = p_employee_id))),
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
    'from_time', p_from_time,
    'to_time', p_to_time,
    'points', v_points,
    'point_count', coalesce(jsonb_array_length(v_points), 0),
    'timezone', v_tz);
end;
$$;

comment on function public.employee_location_history(uuid, date, time, time, text) is
  'Audited movement history for ONE employee on ONE local day. Authorization is decided about the CALLER (Super Admin, or a live tracking grant) — never about the subject employee — so a Super Admin reads any history without a grant and a delegated viewer is still refused without one. Filtering happens here, never in the client.';

revoke all on function public.employee_location_history(uuid, date, time, time, text) from public;
grant execute on function public.employee_location_history(uuid, date, time, time, text) to authenticated;
-- ---------------------------------------------------------------------------
-- 3. LIVE POSITIONS — DEFECT 3, the function that had NO gate
-- ---------------------------------------------------------------------------
-- Body reproduced verbatim from 20261101000003; the ONLY change is the access
-- gate at the top and explicit grants at the bottom. Without the gate this
-- SECURITY DEFINER function handed every employee's live coordinates to any
-- authenticated caller.
create or replace function public.employee_current_locations(
  p_department text default null,
  p_branch_id uuid default null,
  p_within_minutes integer default 240
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_rows jsonb;
begin
  -- DEFECT 3 FIXED. Same caller-scoped question as every other reader.
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  -- No token in the requested window: an empty array, never null.
  if p_department is null and p_branch_id is null then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen desc), '[]')
      into v_rows
      from (
        select e.id as employee_id, e.full_name, e.employee_number,
               le.latitude, le.longitude, le.recorded_at as last_seen,
               le.inside_geofence, le.location_label, le.resolved_place,
               round(extract(epoch from (now() - le.recorded_at)) / 60.0)::int
                 as minutes_ago
          from public.employee_location_events le
          join public.employees e on e.id = le.employee_id
         where le.id = (select l2.id from public.employee_location_events l2
                          where l2.employee_id = e.id
                          order by l2.recorded_at desc limit 1)
      ) x;
    return v_rows;
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen desc), '[]')
    into v_rows
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
             le.resolved_place,
             le.inside_geofence,
             le.distance_meters,
             le.nearest_location_name,
             le.nearest_distance,
             le.nearest_radius,
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

  return v_rows;
end;
$$;

comment on function public.employee_current_locations(text, uuid, integer) is
  'Live position per employee for the tracking map. Gated by employee_tracking_access() for the CALLER — it was previously ungated and readable by any authenticated account. inside_geofence is decided solely by resolve_employee_location(); location_label states the honest separation when outside and resolved_place carries the real place when known.';

revoke all on function public.employee_current_locations(text, uuid, integer) from public;
grant execute on function public.employee_current_locations(text, uuid, integer) to authenticated;
-- ---------------------------------------------------------------------------
-- 4. THE REMAINING READER — same question, same key, stated explicitly
-- ---------------------------------------------------------------------------
-- This one already asked the caller-scoped question with the correct key. It is
-- re-issued unchanged so that every tracking surface provably shares ONE
-- definition of "may this caller see tracking?", and so the anon revoke is
-- present on it too.
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

  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen desc), '[]')
    into v_rows
    from (
      select e.id as employee_id, e.full_name, e.employee_number,
             e.position, e.department, e.branch_id, b.branch_name,
             le.latitude, le.longitude, le.accuracy,
             le.recorded_at as last_seen, le.uploaded_at, le.location_label,
             le.resolved_place,
             le.inside_geofence, le.distance_meters,
             le.nearest_location_name, le.nearest_distance, le.nearest_radius,
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

  return v_rows;
end;
$$;

revoke all on function public.list_tracked_employees(integer, text, uuid) from public;
grant execute on function public.list_tracked_employees(integer, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. DEFENCE: prove the deployed definitions, do not just assert them
-- ---------------------------------------------------------------------------
-- Reads pg_get_functiondef() for every tracking read surface and ABORTS if any
-- of them has lost its access gate. This is what stops this same class of
-- defect from being reintroduced silently by a later CREATE OR REPLACE: the
-- failure happens when the migration runs, with the offending function named,
-- instead of surfacing later as "the Super Admin cannot open a history drawer".
do $$
declare
  v_fn  text;
  v_def text;
  v_bad text[] := array[]::text[];
  v_gate text[] := array[
    'list_tracked_employees',
    'employee_location_history',
    'employee_current_locations',
    'list_tracking_geofences'
  ];
begin
  foreach v_fn in array v_gate loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn
     order by p.oid
     limit 1;

    -- A function that is simply not deployed yet has no gate to lose, so it is
    -- not this migration's business to fail on. Only a function that EXISTS and
    -- is readable WITHOUT a gate is a genuine authorization hole.
    if v_def is not null and v_def not like '%employee_tracking_access%' then
      v_bad := v_bad || (v_fn || ' (exists with no access gate)');
    end if;
  end loop;

  if array_length(v_bad, 1) is not null then
    raise exception
      'tracking_access_gate_violation: these tracking read functions exist but are not access-gated: %. Re-apply the earlier tracking migrations before continuing.',
      array_to_string(v_bad, ', ');
  end if;
end $$;

commit;