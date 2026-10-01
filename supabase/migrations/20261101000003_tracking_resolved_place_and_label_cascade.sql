begin;

-- ===========================================================================
-- Employee Tracking — resolved place + historical label cascade
--
-- WHY THIS EXISTS
-- A point outside every registered geofence used to be stored with the label of
-- the NEAREST fence ("HEAD OFFICE") while inside_geofence = false, so the
-- timeline read "08:00 HEAD OFFICE" beside "outside any registered location".
--
-- Migration 20260929000003 already re-resolved rows through
-- resolve_employee_location() and stored the honest "Outside HEAD OFFICE
-- (9 km away)" label. Two gaps remained:
--
--   1. HISTORICAL ROWS THAT STILL MISLABEL. Any row whose location_label names
--      a registered location while inside_geofence is false is the defect, and
--      it is detectable purely from the stored data: a genuine inside row can
--      never disagree with its own flag. Part 3 repairs every such row and
--      re-resolves it through the same authority, so the fix cascades through
--      the whole history instead of only to rows written from now on.
--
--   2. THE REAL PLACE WAS NEVER PERSISTED. The client now reverse-geocodes an
--      outside point and shows "Ogudu GRA Estate", but that answer lived only in
--      the browser session. resolved_place stores it, so the history keeps
--      naming the actual location for that point.
--
-- NOTHING AUTHORITATIVE IS TOUCHED. Coordinates, recorded_at, accuracy,
-- inside_geofence and source are the observed facts; this migration only
-- corrects a DERIVED label. A disputed fix stays disputed and visible.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. PERSIST THE RESOLVED PLACE
-- ---------------------------------------------------------------------------
alter table public.employee_location_events
  add column if not exists resolved_place text;

comment on column public.employee_location_events.resolved_place is
  'The real place a point was recorded, e.g. "Ogudu GRA Estate". Reverse geocoded from the coordinates and written back by the client so the history keeps naming the actual location. NULL when the lookup failed or has not run; the UI then falls back to the honest "X km away" label. NEVER used for inside/outside - that is resolve_employee_location() alone.';

create index if not exists idx_location_events_resolved_place
  on public.employee_location_events (resolved_place)
  where resolved_place is not null;

-- ---------------------------------------------------------------------------
-- 2. WRITE-BACK PATH FOR THE CLIENT
-- ---------------------------------------------------------------------------
-- Narrow on purpose: it may only fill in resolved_place, and only for a row the
-- caller is already authorised to see. It can never move a point inside a
-- fence, rename a location, or touch a coordinate.
-- The caller identity comes from the JWT. Supabase exposes it either as
-- auth.uid() (the wrapper) or current_setting('request.jwt.claim.sub', true).
-- Reading the claim directly is what makes this function testable with
-- set_config('request.jwt.claims', ...) and identical under Supabase.
create or replace function public.set_employee_location_resolved_place(
  p_event_id uuid,
  p_place text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_employee uuid;
begin
  -- Trimmed and length-capped: this is a display label from a third-party
  -- lookup, not data the bank controls.
  p_place := nullif(btrim(p_place), '');
  if p_place is not null and length(p_place) > 160 then
    p_place := left(p_place, 160);
  end if;

  v_uid := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
  );

  if v_uid is null then
    -- No authenticated caller: refuse rather than let an anonymous session
    -- attribute a place to somebody.
    return false;
  end if;

  select e.id into v_employee
    from public.employee_location_events le
    join public.employees e on e.id = le.employee_id
   where le.id = p_event_id
     and e.user_id = v_uid
   limit 1;

  if not found then
    -- Either the row does not exist or this account does not own it. Both are
    -- refusals, and neither is distinguished to the caller.
    return false;
  end if;

  update public.employee_location_events
     set resolved_place = p_place
   where id = p_event_id;

  return true;
end;
$$;

comment on function public.set_employee_location_resolved_place(uuid, text) is
  'Stores the reverse-geocoded place for ONE of the caller own tracking points. Display only: cannot change inside_geofence, location_label or any coordinate.';

revoke all on function public.set_employee_location_resolved_place(uuid, text) from public;
grant execute on function public.set_employee_location_resolved_place(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. SERVE resolved_place FROM BOTH READ SURFACES
-- ---------------------------------------------------------------------------
-- The two read functions select into a jsonb row. Adding the column to each
-- select is the only change needed; the grants and signatures are untouched, so
-- this cannot widen who may read tracking.
--
-- CREATE OR REPLACE is valid here because the return type is unchanged and
-- resolved_place is appended to the output columns.
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
  v_rows jsonb;
begin
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
             -- The real place, when it has been resolved. The client prefers it
             -- for an outside point and ignores it for an inside one.
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
  'Live position per employee for the tracking map. inside_geofence is decided solely by resolve_employee_location(). location_label states the honest separation when outside; resolved_place carries the reverse-geocoded real place when known.';

-- ---------------------------------------------------------------------------
-- 5. AND FROM THE HISTORY READ
-- ---------------------------------------------------------------------------
-- Identical to the issued function except for one appended column. The access
-- gate, the audit insert and the date/time filters are reproduced verbatim, so
-- the history surface cannot drift from the audited behaviour.
create or replace function public.employee_location_history(
  p_employee_id uuid,
  p_date date,
  p_from_time time default null,
  p_to_time time default null,
  p_inside_only text default 'all'
) returns jsonb
language plpgsql
-- DELIBERATELY NOT `stable`. This function writes an audit row on every call,
-- and PostgreSQL refuses an INSERT inside a stable function. It is also the
-- honest classification: a call has a side effect, so its result must not be
-- folded into a snapshot by the planner.
security definer
set search_path = public
as $$
declare
  v_access jsonb;
  v_emp employees%rowtype;
  v_tz text;
  v_points jsonb;
begin
  v_access := public.employee_tracking_access(p_employee_id);
  if coalesce((v_access ->> 'allowed')::boolean, false) = false then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if not found then
    raise exception 'Employee not found.';
  end if;

  v_tz := coalesce(
    (select p.timezone from public.profiles p where p.id = v_emp.user_id),
    'Africa/Lagos'
  );

  select coalesce(jsonb_agg(to_jsonb(x) order by x.recorded_at), '[]') into v_points
    from (
      select le.id, le.latitude, le.longitude, le.accuracy, le.recorded_at,
             le.uploaded_at, le.source, le.device_id, le.location_label,
             -- Null until a client has looked the coordinate up. When present it
             -- is the real place, e.g. "Ogudu GRA Estate".
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

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_LOCATION_HISTORY_QUERIED', 'Employee', p_employee_id::text,
          (select full_name from public.profiles where id = coalesce(
             nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
             (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
           )),
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
  'Audited movement history for one employee on one local day. Filtering is done here, never in the client. Each point carries resolved_place (the real place, when resolved) alongside location_label (the honest separation when outside).';

-- ---------------------------------------------------------------------------
-- 3. CASCADE THE LABEL REPAIR THROUGH THE WHOLE HISTORY
-- ---------------------------------------------------------------------------
-- Every row that currently contradicts itself is re-resolved with the SAME
-- function and the SAME maths that produced the ingest label. Nothing is
-- estimated and no inside/outside verdict is changed.
--
-- The predicate is deliberately narrow: it targets exactly the defect -
-- inside_geofence = false while the label names a location with no separation
-- stated. An honest "Outside X (9 km away)" label does NOT match and is left
-- alone, so re-running this is idempotent.
update public.employee_location_events le
   set location_label = case
         when r.outside_label is not null
           then r.outside_label
         else coalesce(
                nullif(le.location_label, ''),
                'Outside registered locations'
              )
       end,
       nearest_location_name = r.nearest_location_name,
       nearest_distance      = r.nearest_distance,
       nearest_radius        = r.nearest_radius,
       -- A resolved place is an observed fact about a point. It survives a
       -- re-resolve: re-deriving the fence context must not erase the real
       -- place a client already looked up for this exact coordinate.
       resolved_place = coalesce(le.resolved_place, r.resolved_place)
  from (
    -- jsonb_to_record, not `x.nearest_location_name`: a lateral function call
    -- returns a bare jsonb record whose keys cannot be referenced as columns.
    -- This is the same expansion the earlier tracking migration uses.
    select le2.id as id,
           n.nearest_location_name,
           n.nearest_distance,
           n.nearest_radius,
           n.outside_label,
           nullif(le2.resolved_place, '') as resolved_place
      from public.employee_location_events le2
      cross join lateral public.resolve_employee_location(
             le2.latitude::float, le2.longitude::float, 'track', null) x
      cross join lateral jsonb_to_record(x) as n(
             nearest_location_name text,
             nearest_distance numeric,
             nearest_radius numeric,
             outside_label text
           )
     where not le2.inside_geofence
  ) r
 where le.id = r.id
   -- A bare registered-location name with no distance beside it.
   and le.location_label is not null
   and le.location_label <> ''
   and le.location_label not like 'Outside %'
   and le.location_label <> 'Outside registered locations';

commit;