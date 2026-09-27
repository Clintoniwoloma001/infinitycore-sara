-- ============================================================================
-- PHASE 70 - ATTENDANCE + EMPLOYEE LOCATION INTELLIGENCE (part 1 of 3)
-- ============================================================================
-- Run in Supabase SQL Editor after 20260925160359. Idempotent, additive,
-- transaction-wrapped. Nothing is deleted or rewritten.
--
-- WHAT THIS PART DOES
--   1. public.resolve_employee_location() - THE single geofence authority.
--      Every attendance/location surface (clock-in, clock-out, terminal,
--      tracking ingest, Location Audit, Director dashboards, web AND mobile)
--      resolves coordinates through this one function. This is the fix for
--      the existing inconsistency where Clock-In Verification reported
--      "Inside / 6m" while Location Audit reported "Unknown / Not available".
--   2. attendance_validate_location() is re-issued as a thin caller of the
--      resolver, so behaviour is preserved for every existing caller.
--   3. CLOCK-OUT LOCATION RULE CORRECTION. The assigned branch and the
--      clock-in branch must NEVER gate whether they may clock out. An
--      employee may clock in at Head Office and clock out at Ketu Branch.
--      Clock-out is rejected ONLY when GPS is outside EVERY registered
--      active geofence.
--
-- THE THREE CONCEPTS, KEPT SEPARATE
--   * Attendance location  -> resolve_employee_location() is authoritative.
--   * Background heartbeat -> employee_location_events (part 2).
--   * Movement history     -> derived from those timestamped events (part 2).
--   They never gate each other.
--
-- NOTHING IS HARD-CODED: registered locations are read live from the existing
-- public.branches / public.attendance_geofences registries.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. THE SINGLE GEOFENCE AUTHORITY
-- ---------------------------------------------------------------------------
-- Pure resolution: it NEVER raises, so each caller decides its own policy
-- (clock-in vs clock-out vs tracking vs audit).
create or replace function public.resolve_employee_location(
  p_lat float,
  p_lng float,
  p_action text default 'clock_in',
  p_geofence_override uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings record;
  v_candidate record;
  v_action text := lower(coalesce(p_action, 'clock_in'));
  v_best_branch_id uuid;
  v_best_geofence_id uuid;
  v_best_name text;
  v_best_type text;
  v_best_distance float;
  v_best_radius numeric;
  v_nearest_name text;
  v_nearest_distance float;
  v_nearest_radius numeric;
  v_has_location boolean := false;
begin
  -- Coordinate sanity. A null/invalid point resolves to "outside" rather than
  -- raising, so tracking ingest can still record a poor fix.
  if p_lat is null or p_lng is null
     or p_lat <> p_lat or p_lng <> p_lng
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    return jsonb_build_object(
      'ok', false, 'inside', false, 'has_location', false,
      'location_id', null, 'branch_id', null, 'geofence_id', null,
      'location_name', null, 'location_type', null,
      'distance_meters', null, 'radius_meters', null,
      'nearest_location_name', null, 'nearest_distance', null,
      'nearest_radius', null, 'human_label', 'Unknown location');
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;

  -- Registered locations: every ACTIVE branch with coordinates, plus every
  -- ACTIVE attendance_geofence. Both are real registered InfinityCore
  -- locations; neither is tied to any employee.
  for v_candidate in
    select b.id as branch_id,
           null::uuid as geofence_id,
           b.branch_name as location_name,
           'branch'::text as location_type,
           b.latitude::float as latitude,
           b.longitude::float as longitude,
           greatest(1, coalesce(b.geofence_radius, v_settings.default_geofence_radius, 150))::numeric as radius
      from public.branches b
     where coalesce(b.geofence_active, false)
       and b.latitude is not null
       and b.longitude is not null
       and p_geofence_override is null
    union all
    select gb.id as branch_id,
           g.id as geofence_id,
           coalesce(gb.branch_name, nullif(g.location_name, ''), g.name) as location_name,
           case
             when lower(coalesce(g.location_name, '') || ' ' || coalesce(g.name, '')) like '%head office%'
               then 'head_office'
             else 'geofence'
           end as location_type,
           g.latitude::float as latitude,
           g.longitude::float as longitude,
           greatest(1, coalesce(g.radius_meters, v_settings.default_geofence_radius, 150))::numeric as radius
      from public.attendance_geofences g
      left join public.branches gb on gb.id::text = g.branch_id
     where (coalesce(g.active, false) or p_geofence_override is not null)
       and (p_geofence_override is null or g.id = p_geofence_override)
       and g.latitude is not null
       and g.longitude is not null
       and case when v_action = 'clock_out'
                then coalesce(g.clock_out_allowed, true)
                else coalesce(g.clock_in_allowed, true)
            end
  loop
    v_has_location := true;
    declare
      v_distance float := public.geo_distance(p_lat, p_lng, v_candidate.latitude, v_candidate.longitude);
    begin
      if v_nearest_distance is null or v_distance < v_nearest_distance then
        v_nearest_distance := v_distance;
        v_nearest_name := v_candidate.location_name;
        v_nearest_radius := v_candidate.radius;
      end if;

      if v_distance <= v_candidate.radius
         and (v_best_distance is null or v_distance < v_best_distance) then
        v_best_distance := v_distance;
        v_best_branch_id := v_candidate.branch_id;
        v_best_geofence_id := v_candidate.geofence_id;
        v_best_name := v_candidate.location_name;
        v_best_type := v_candidate.location_type;
        v_best_radius := v_candidate.radius;
      end if;
    end;
  end loop;

  -- Human-readable label is DERIVED from the registered location name.
  -- Coordinates stay authoritative; a street address is never invented.
  return jsonb_build_object(
    'ok', true,
    'inside', v_best_distance is not null,
    'has_location', v_has_location,
    'location_id', coalesce(v_best_geofence_id, v_best_branch_id),
    'branch_id', v_best_branch_id,
    'geofence_id', v_best_geofence_id,
    'location_name', v_best_name,
    'location_type', v_best_type,
    'distance_meters', v_best_distance,
    'radius_meters', v_best_radius,
    'nearest_location_name', v_nearest_name,
    'nearest_distance', v_nearest_distance,
    'nearest_radius', v_nearest_radius,
    'human_label', case
      when v_best_name is not null then v_best_name
      when v_nearest_name is not null then v_nearest_name
      else 'Outside registered locations'
    end);
end;
$$;

comment on function public.resolve_employee_location(float, float, text, uuid) is
  'THE single geofence authority. Never raises. Every attendance/location surface on web and mobile must resolve coordinates through this function so Clock-In Verification and Location Audit can never disagree.';

revoke all on function public.resolve_employee_location(float, float, text, uuid) from public;
grant execute on function public.resolve_employee_location(float, float, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. attendance_validate_location  (re-issued)
-- ---------------------------------------------------------------------------
-- Now a THIN policy layer over resolve_employee_location(). The assigned
-- branch is still resolved, but for two report-time purposes ONLY:
--   * work-start / work-end / grace defaults, and
--   * the descriptive `location_difference` label.
-- It can no longer REJECT a clock-out. The only rejections that remain are
-- the two genuine platform-level conditions below.
drop function if exists public.attendance_validate_location(uuid, float, float, text, uuid, uuid, boolean);

create or replace function public.attendance_validate_location(
  p_employee_id uuid,
  p_lat float,
  p_lng float,
  p_action text default 'clock_in',
  p_branch_id uuid default null,
  p_geofence_override uuid default null,
  p_allow_outside boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_settings record;
  v_primary_branch record;
  v_resolved jsonb;
  v_action text := lower(coalesce(p_action, 'clock_in'));
  v_assigned_id uuid;
  v_assigned_name text;
  v_is_area_manager boolean := false;
  v_area_branch_ids uuid[];
  v_actual_branch_id uuid;
  v_actual_name text;
begin
  select * into v_employee from public.employees where id = p_employee_id limit 1;
  if not found then
    raise exception 'Employee record not found.';
  end if;

  select * into v_settings from public.hr_platform_settings where id = 1 limit 1;

  if p_lat is null or p_lng is null then
    raise exception 'LOCATION_REQUIRED:Location is required to clock in or out. Please enable location access.';
  end if;
  if p_lat <> p_lat or p_lng <> p_lng
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'LOCATION_INVALID:Your device returned an invalid location. Please try again.';
  end if;

  -- Assigned branch: report-time context only (work times + the descriptive
  -- difference flag). It NEVER gates the clock-out decision.
  select array_agg(b.branch_id), count(*) > 0
    into v_area_branch_ids, v_is_area_manager
    from public.get_area_manager_area_branches(p_employee_id) b;

  if p_branch_id is not null then
    select * into v_primary_branch from public.branches where id = p_branch_id limit 1;
  elsif v_employee.branch_id is not null then
    select * into v_primary_branch from public.branches where id = v_employee.branch_id limit 1;
  elsif nullif(trim(v_employee.branch), '') is not null then
    select * into v_primary_branch
      from public.branches
     where lower(branch_name) = lower(trim(v_employee.branch))
        or lower(coalesce(branch_code, '')) = lower(trim(v_employee.branch))
     order by case when lower(branch_name) = lower(trim(v_employee.branch)) then 0 else 1 end
     limit 1;
  end if;

  v_assigned_id := v_primary_branch.id;
  v_assigned_name := coalesce(v_primary_branch.branch_name, nullif(trim(v_employee.branch), ''));

  -- THE single geofence authority.
  v_resolved := public.resolve_employee_location(p_lat, p_lng, v_action, p_geofence_override);

  v_actual_branch_id := nullif(v_resolved ->> 'branch_id', '')::uuid;
  v_actual_name := v_resolved ->> 'location_name';

  -- Rejection 1: the platform has no registered location at all.
  if not coalesce((v_resolved ->> 'has_location')::boolean, false)
     and not p_allow_outside then
    raise exception 'GEOFENCE_NOT_CONFIGURED:No approved attendance location is configured. Contact HR before clocking in or out.';
  end if;

  -- Rejection 2 (the ONLY genuine clock-out rejection): the GPS position is
  -- outside every registered attendance geofence. Note what is deliberately
  -- ABSENT here: any comparison of the employee's assigned branch or their
  -- clock-in branch against the detected branch. An employee clocked in at
  -- Head Office may clock out at Ketu Branch without restriction.
  if not coalesce((v_resolved ->> 'inside')::boolean, false)
     and not p_allow_outside then
    raise exception 'OUTSIDE_GEOFENCE:Location is outside all registered attendance geofences.';
  end if;

  return jsonb_build_object(
    'assigned_branch_id', v_assigned_id,
    'assigned_branch_name', v_assigned_name,
    'actual_branch_id', v_actual_branch_id,
    'actual_geofence_id', nullif(v_resolved ->> 'geofence_id', '')::uuid,
    'actual_location_name', v_actual_name,
    'actual_location_type', v_resolved ->> 'location_type',
    'location_difference',
      case
        when v_actual_branch_id is null then null
        when v_is_area_manager then not (v_actual_branch_id = any(v_area_branch_ids))
        else not (
          (v_assigned_id is not null and v_actual_branch_id = v_assigned_id)
          or (v_assigned_name is not null and lower(v_actual_name) = lower(v_assigned_name))
        )
      end,
    'distance', nullif(v_resolved ->> 'distance_meters', '')::float,
    'radius', nullif(v_resolved ->> 'radius_meters', '')::numeric,
    'nearest_location_name', v_resolved ->> 'nearest_location_name',
    'nearest_distance', nullif(v_resolved ->> 'nearest_distance', '')::float,
    'nearest_radius', nullif(v_resolved ->> 'nearest_radius', '')::numeric,
    'geofence_status', case when v_resolved ->> 'inside' = 'true' then 'inside' else 'outside' end,
    'location_status', case when v_resolved ->> 'inside' = 'true' then 'inside' else 'outside' end,
    'human_location', v_resolved ->> 'human_label',
    'is_area_manager', v_is_area_manager,
    'area_branch_count', coalesce(array_length(v_area_branch_ids, 1), 0),
    'work_start_time', coalesce(v_primary_branch.work_start_time, v_settings.default_work_start_time, '08:00')::text,
    'work_end_time', coalesce(v_primary_branch.work_end_time, v_settings.default_work_end_time, '17:00')::text,
    'grace_period_minutes', coalesce(v_primary_branch.grace_period_minutes, v_settings.default_grace_period_minutes, 15)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. LOCATION COLUMNS  (additive; existing rows left untouched)
-- ---------------------------------------------------------------------------
-- The old shape stored ONE geofence_id, which clock-out OVERWROTE with its own
-- value - destroying the clock-in location record. These paired columns keep
-- both sides so an attendance row can always answer "clocked in where, clocked
-- out where, how far, inside or outside, verified how".
alter table public.attendance_records
  add column if not exists clock_in_branch_id uuid references public.branches(id) on delete set null,
  add column if not exists clock_in_location_name text,
  add column if not exists clock_in_location_label text,
  add column if not exists clock_in_inside_geofence boolean,
  add column if not exists clock_out_branch_id uuid references public.branches(id) on delete set null,
  add column if not exists clock_out_location_name text,
  add column if not exists clock_out_location_label text,
  add column if not exists clock_out_inside_geofence boolean;

comment on column public.attendance_records.branch_id is
  'The employee''s ASSIGNED branch. Report-time context only. It must never gate clock-in or clock-out validity - see resolve_employee_location().';
comment on column public.attendance_records.clock_in_branch_id is
  'Registered branch detected at clock-in (null when outside every geofence).';
comment on column public.attendance_records.clock_out_branch_id is
  'Registered branch detected at clock-out (null when outside every geofence). May legitimately differ from clock_in_branch_id.';

-- ---------------------------------------------------------------------------
-- 4. RECORD LOCATION VIA THE SINGLE ENGINE (covers EVERY clock path)
-- ---------------------------------------------------------------------------
-- A trigger is used deliberately: the canonical web clock-out, the mobile
-- clock-out, the QR terminal clock-out and any admin correction all UPDATE
-- attendance_records, so all of them get identical location capture without
-- being re-issued one by one (and therefore cannot drift apart again).
create or replace function public.attendance_capture_locations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_in jsonb;
  v_out jsonb;
begin
  -- ---- clock-in side --------------------------------------------------
  if new.clock_in is not null
     and (tg_op = 'INSERT' or old.clock_in is distinct from new.clock_in
                        or old.clock_in_branch_id is distinct from new.clock_in_branch_id) then
    if new.clock_in_lat is not null and new.clock_in_lng is not null then
      -- The override argument is deliberately NULL: the trigger must always
      -- resolve against the FULL registered registry. Passing new.geofence_id
      -- here would restrict the candidate set to a single location and would
      -- make the trigger disagree with attendance_validate_location().
      v_in := public.resolve_employee_location(
        new.clock_in_lat::float, new.clock_in_lng::float, 'clock_in', null);

      new.clock_in_branch_id := nullif(v_in ->> 'branch_id', '')::uuid;
      new.clock_in_location_name := v_in ->> 'location_name';
      new.clock_in_location_label := v_in ->> 'human_label';
      new.clock_in_inside_geofence := coalesce((v_in ->> 'inside')::boolean, false);

      -- On INSERT, clock_in_branch_id is the authoritative recorded location.
      -- `branch_id` (assigned) is deliberately left as-is.
      if tg_op = 'INSERT' then
        new.geofence_id := coalesce(nullif(v_in ->> 'geofence_id', '')::uuid, new.geofence_id);
        new.geofence_distance := coalesce(nullif(v_in ->> 'distance_meters', '')::float, new.geofence_distance);
      end if;
    end if;
  end if;

  -- ---- clock-out side -------------------------------------------------
  -- NOTE: the clock-out location is written to the DEDICATED columns and
  -- deliberately does NOT overwrite geofence_id / geofence_distance, so the
  -- clock-in location remains readable on the same row.
  if new.clock_out is not null
     and (tg_op = 'INSERT' or old.clock_out is distinct from new.clock_out
                        or old.clock_out_branch_id is distinct from new.clock_out_branch_id) then
    if new.clock_out_lat is not null and new.clock_out_lng is not null then
      v_out := public.resolve_employee_location(
        new.clock_out_lat::float, new.clock_out_lng::float, 'clock_out', null);

      new.clock_out_branch_id := nullif(v_out ->> 'branch_id', '')::uuid;
      new.clock_out_location_name := v_out ->> 'location_name';
      new.clock_out_location_label := v_out ->> 'human_label';
      new.clock_out_inside_geofence := coalesce((v_out ->> 'inside')::boolean, false);
      new.clock_out_distance := coalesce(nullif(v_out ->> 'distance_meters', '')::float, new.clock_out_distance);
      new.location_status := case when new.clock_out_inside_geofence then 'inside' else 'outside' end;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists attendance_capture_locations on public.attendance_records;
create trigger attendance_capture_locations
  before insert or update on public.attendance_records
  for each row execute function public.attendance_capture_locations();

-- ---------------------------------------------------------------------------
-- 5. MISSING CLOCK-OUT  (calendar day, never a rolling 24h window)
-- ---------------------------------------------------------------------------
-- The status CHECK did not admit a "missing clock-out" value, so the previous
-- auto-close had to FABRICATE a clock_out timestamp. Now the record is simply
-- marked and left open - it is never corrupted and never deleted.
do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.attendance_records'::regclass
     and conname = 'attendance_records_status_check';

  if v_def is not null and v_def not like '%missing_clock_out%' then
    execute 'alter table public.attendance_records drop constraint attendance_records_status_check';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.attendance_records'::regclass
       and conname = 'attendance_records_status_check'
  ) then
    alter table public.attendance_records
      add constraint attendance_records_status_check
      check (status in ('present','absent','late','early_exit','on_leave',
                        'incomplete','corrected','missing_clock_out'));
  end if;
end $$;

create index if not exists idx_attendance_records_open_sessions
  on public.attendance_records (attendance_date)
  where clock_out is null;

-- ---------------------------------------------------------------------------
-- 5b. LOCATION EVENT MODEL
-- ---------------------------------------------------------------------------
-- The 30-minute heartbeat. Deliberately a SEPARATE table from
-- attendance_records: the heartbeat is background telemetry and must never
-- gate, block or influence attendance validity.
--
-- recorded_at vs uploaded_at (A10/§24): a point captured offline keeps its
-- original recorded_at and gains a later uploaded_at, so an administrator can
-- see a point was observed earlier and synchronised later. Gaps are real and
-- are preserved - missing observations are never back-filled or interpolated.
create table if not exists public.employee_location_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  accuracy numeric(10, 2),
  recorded_at timestamptz not null default now(),
  uploaded_at timestamptz not null default now(),
  source text not null default 'mobile',
  source_detail text,
  device_id text,
  device_fingerprint text,
  attendance_record_id uuid references public.attendance_records(id) on delete set null,
  -- resolved through the ONE engine, never by a second calculation
  detected_geofence_id uuid,
  detected_branch_id uuid references public.branches(id) on delete set null,
  location_label text,
  inside_geofence boolean not null default false,
  distance_meters numeric(12, 2),
  created_at timestamptz not null default now()
);

comment on column public.employee_location_events.recorded_at is
  'When the device actually observed this position. Authoritative. Never fabricated.';
comment on column public.employee_location_events.uploaded_at is
  'When the observation reached the server. Differs from recorded_at after an offline period.';

create index if not exists idx_location_events_employee on public.employee_location_events (employee_id);
create index if not exists idx_location_events_recorded on public.employee_location_events (recorded_at);
create index if not exists idx_location_events_employee_recorded
  on public.employee_location_events (employee_id, recorded_at desc);
create index if not exists idx_location_events_geofence on public.employee_location_events (detected_geofence_id);
create index if not exists idx_location_events_branch on public.employee_location_events (detected_branch_id);
-- Idempotent ingest: a retried offline upload can never duplicate a point.
create unique index if not exists uq_location_events_dedupe
  on public.employee_location_events (employee_id, recorded_at, latitude, longitude);

alter table public.employee_location_events enable row level security;

-- RLS on, but NO select policy for authenticated. Location history is reachable
-- only through the SECURITY DEFINER tracking RPCs in part 2, which re-check
-- authorization on every call. A user cannot read this table directly even with
-- a valid session token.
revoke all on public.employee_location_events from anon, authenticated;

-- End-of-calendar-day sweep. Only sessions from a STRICTLY PAST day are
-- touched; today's open session is left alone until the day actually turns.
create or replace function public.attendance_mark_missing_clockouts(
  p_as_of timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text := public.att_app_timezone();
  v_as_of timestamptz := least(coalesce(p_as_of, clock_timestamp()), clock_timestamp());
  v_today date := (v_as_of at time zone v_tz)::date;
  v_role text := public.current_role();
  v_row record;
  v_marked integer := 0;
  v_people integer := 0;
  v_trail jsonb;
  v_transition timestamptz;
  v_last jsonb;
  v_hr record;
  v_msg text;
begin
  -- Role guard uses the platform's own current_role() (already used across this
  -- schema) rather than auth.uid(), so the function is safe to invoke from
  -- pg_cron, from a service-role call, or from the Supabase SQL editor. A role
  -- is only ever set when there IS an interactive session, so a null role
  -- means "system/cron" and is allowed through.
  if v_role is not null
     and v_role not in ('super_admin','admin','head_of_human_resources',
                        'hr_manager','hr_officer') then
    raise exception 'Not authorized to reconcile attendance sessions.';
  end if;

  for v_row in
    select r.id, r.employee_id, r.attendance_date, r.clock_in,
           r.clock_in_branch_id, r.clock_in_location_label,
           e.full_name, e.employee_number
      from public.attendance_records r
      left join public.employees e on e.id = r.employee_id
     where r.clock_out is null
       and r.status is distinct from 'missing_clock_out'
       and r.attendance_date < v_today
     order by r.attendance_date
     for update of r skip locked
  loop
    -- The record is MARKED, never closed. clock_out stays NULL.
    update public.attendance_records
       set status = 'missing_clock_out',
           early_departure_minutes = coalesce(early_departure_minutes, 0)
     where id = v_row.id;

    insert into public.attendance_events (
      employee_id, attendance_record_id, event_type, event_time, source,
      verification_method, verification_status, metadata
    ) values (
      v_row.employee_id, v_row.id, 'MISSING_CLOCK_OUT', v_as_of, 'SYSTEM',
      'NONE', 'flagged',
      jsonb_build_object(
        'auto', true, 'missing_clock_out', true,
        'reason', 'No clock-out recorded before the end of the calendar working day',
        'attendance_date', v_row.attendance_date)
    );

    -- A6: the last-3 trail is the RELEVANT trail, not the newest 3 rows.
    -- The trail is anchored at the most recent INSIDE -> OUTSIDE transition
    -- (an "inside" observation whose immediately following observation is
    -- "outside"). Everything recorded from that transition onwards is the
    -- trail; the newest three of those are reported. If fewer than three
    -- observations exist after the transition, the real count is returned -
    -- the result is never padded and coordinates are never invented.
    -- If the employee never left a geofence, the trail falls back to their
    -- whole open session (clock-in onwards).
    select coalesce(max(z.recorded_at), v_row.clock_in) into v_transition
      from (
        select e0.recorded_at,
               e0.inside_geofence,
               lead(e0.inside_geofence) over (order by e0.recorded_at) as next_inside
          from public.employee_location_events e0
         where e0.employee_id = v_row.employee_id
           and e0.recorded_at < v_today
      ) z
     where z.inside_geofence
       and z.next_inside = false;

    select coalesce(jsonb_agg(jsonb_build_object(
             'latitude', t.latitude,
             'longitude', t.longitude,
             'recorded_at', t.recorded_at,
             'accuracy', t.accuracy,
             'source', t.source,
             'inside_geofence', t.inside_geofence,
             'location_label', t.location_label
           ) order by t.recorded_at desc), '[]')
      into v_trail
      from (
        select e2.latitude, e2.longitude, e2.recorded_at, e2.accuracy,
               e2.source, e2.inside_geofence, e2.location_label
          from public.employee_location_events e2
         where e2.employee_id = v_row.employee_id
           and e2.recorded_at >= v_transition
           and e2.recorded_at < v_today
         order by e2.recorded_at desc
         limit 3
      ) t;

    select to_jsonb(x) into v_last
      from (
        select e3.latitude, e3.longitude, e3.recorded_at, e3.accuracy,
               e3.source, e3.inside_geofence, e3.location_label
          from public.employee_location_events e3
         where e3.employee_id = v_row.employee_id
           and e3.recorded_at < v_today
         order by e3.recorded_at desc
         limit 1
      ) x;

    v_msg := format(
      '%s did not clock out on %s. Last recorded location: %s. Last location update: %s.',
      coalesce(v_row.full_name, 'An employee'),
      to_char(v_row.attendance_date, 'DD FMMonth YYYY'),
      coalesce(v_last ->> 'location_label', v_row.clock_in_location_label, 'nearby location'),
      coalesce(to_char((v_last ->> 'recorded_at')::timestamptz at time zone v_tz, 'HH24:MI'), 'unknown')
    );

    -- A5: notify Head of HR through the EXISTING notifications table.
    -- A7: the label is the registered location name; coordinates stay
    -- authoritative and no street address is fabricated.
    for v_hr in
      select p.id from public.profiles p
       where p.role in ('head_of_human_resources','hr_manager')
    loop
      insert into public.notifications (user_id, title, message, type, link)
      values (
        v_hr.id, 'Attendance Alert', v_msg, 'urgent',
        '/attendance-management?employee=' || v_row.employee_id::text);
    end loop;

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_MISSING_CLOCK_OUT', 'AttendanceRecord', v_row.id::text,
      'System (attendance sweep)',
      jsonb_build_object(
        'employee_id', v_row.employee_id,
        'employee_name', v_row.full_name,
        'attendance_date', v_row.attendance_date,
        'clock_in', v_row.clock_in,
        'clock_in_location', v_row.clock_in_location_label,
        'last_known_location', v_last ->> 'location_label',
        'last_known_at', v_last ->> 'recorded_at',
        'last_three_relevant_locations', v_trail,
        'success', true)::text,
      'warning'
    );

    v_marked := v_marked + 1;
    v_people := v_people + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'marked_missing_clock_out', v_marked,
    'employees_affected', v_people,
    'as_of', v_as_of,
    'note', 'Records are marked only. No clock_out timestamp was written and no attendance record was deleted.');
end;
$$;

revoke all on function public.attendance_mark_missing_clockouts(timestamptz) from public;
grant execute on function public.attendance_mark_missing_clockouts(timestamptz) to authenticated;

-- Replace the cron so it can no longer fabricate a clock-out.
do $$
declare
  v_jobid bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    select jobid into v_jobid from cron.job where jobname = 'infinitycore-attendance-auto-clockout';
    if v_jobid is not null then
      perform cron.unschedule(v_jobid);
    end if;
    perform cron.schedule(
      'infinitycore-attendance-missing-clockout', '5 0 * * *',
      $cmd$ select public.attendance_mark_missing_clockouts(); $cmd$
    );
  end if;
exception
  when others then
    raise notice 'pg_cron unavailable; schedule attendance_mark_missing_clockouts() externally: %', sqlerrm;
end $$;

-- A3: the Super Admin path keeps the ability to close a stale session, but
-- the response deliberately omits any auto-clock-out marker so the action is
-- not presented to the user as one.
create or replace function public.attendance_auto_clockout_close_sessions(
  p_as_of timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text := public.att_app_timezone();
  v_as_of timestamptz := least(coalesce(p_as_of, clock_timestamp()), clock_timestamp());
  v_local_today date := (v_as_of at time zone v_tz)::date;
  v_work_end time;
  v_row record;
  v_clock_out timestamptz;
  v_total integer;
  v_closed integer := 0;
  v_updated jsonb := '[]'::jsonb;
begin
  -- SUPER ADMIN ONLY. This used to be open to every HR role; it is now the
  -- single manual exception permitted by the auto-clock-out removal.
  if public.current_role() <> 'super_admin' then
    raise exception 'SUPER_ADMIN_ONLY:Only the Super Admin may close a stale attendance session.';
  end if;

  select coalesce(max(default_work_end_time), time '17:00') into v_work_end
    from public.hr_platform_settings where id = 1;

  for v_row in
    select r.id, r.employee_id, r.attendance_date, r.clock_in, r.late_minutes
      from public.attendance_records r
     where r.clock_out is null
       and r.attendance_date < v_local_today
     order by r.attendance_date
     for update skip locked
  loop
    v_clock_out := (v_row.attendance_date + v_work_end) at time zone v_tz;
    v_total := greatest(0, round(extract(epoch from (v_clock_out - v_row.clock_in)) / 60.0))::integer;

    perform set_config('app.correcting_attendance', 'on', true);
    update public.attendance_records
       set clock_out = v_clock_out,
           total_minutes = v_total,
           work_hours = round(v_total::numeric / 60.0, 2),
           early_departure_minutes = 0,
           source = 'admin', source_detail = 'ADMIN', verification_method = 'NONE',
           geofence_status = coalesce(geofence_status, 'no_geofence'),
           status = case when coalesce(v_row.late_minutes, 0) > 0 then 'late' else 'present' end,
           auto_clock_out = true
     where id = v_row.id;
    perform set_config('app.correcting_attendance', 'off', true);

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'ATTENDANCE_SESSION_CLOSED', 'AttendanceRecord', v_row.id::text, 'Super Admin',
      jsonb_build_object('attendance_date', v_row.attendance_date,
                          'scheduled_end', v_work_end, 'success', true)::text,
      'info'
    );

    v_closed := v_closed + 1;
    -- The auto marker is intentionally NOT returned to the caller.
    v_updated := v_updated || jsonb_build_object(
      'id', v_row.id, 'attendance_date', v_row.attendance_date,
      'clock_out', v_clock_out,
      'work_hours', round(v_total::numeric / 60.0, 2));
  end loop;

  return jsonb_build_object('ok', true, 'closed', v_closed, 'as_of', v_as_of, 'updated', v_updated);
exception
  when others then
    perform set_config('app.correcting_attendance', 'off', true);
    raise;
end;
$$;

revoke all on function public.attendance_auto_clockout_close_sessions(timestamptz) from public;
grant execute on function public.attendance_auto_clockout_close_sessions(timestamptz) to authenticated;

commit;