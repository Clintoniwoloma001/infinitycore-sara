-- ============================================================================
-- employee_live_positions_v4 — ONE source of truth for the Live positions tab
-- ============================================================================
-- WHY A NEW VERSION (additive; v2/v3 are left untouched on purpose)
--
-- v3 is correct about the inside/outside VERDICT — it calls classify_geofence()
-- per row — but it is wrong about the SET it returns and about its ordering:
--
--   1. v3 joined the full employees table OUTWARD to its latest fix, so it
--      returned ALL 232 employees. 224 of them have never produced a fix, so
--      the table opened with a wall of "No location yet" and the employees who
--      DO report were buried at the bottom in scan order.
--   2. There is NO ORDER BY at all, so the order is effectively the employees
--      table's physical/scan order — it only looked alphabetic by accident.
--   3. Nothing exposed a single display category, so every client had to
--      recompute one. That is where the reported mismatch was born: the chips
--      counted FRESHNESS while the badges rendered the geofence verdict, so
--      "1 Inside" (one live fix) sat beside a correctly-outside badge.
--
-- v4 therefore:
--   * accepts p_recent_hours (default 48) and returns ONLY employees with at
--     least one fix inside that window — no "No location yet" rows ever;
--   * picks one row per employee strictly by MAX(recorded_at) (never
--     uploaded_at, so a backfilled old fix can never displace a newer live one);
--   * excludes ONLY the exact emulator coordinate, byte for byte as v3 did;
--   * derives EVERY geofence column here, from the newest fix and the SAME
--     active-fence set classify_geofence reads — never from a stored
--     inside_geofence flag written at capture time;
--   * returns ONE display_category per row ('stale' | 'inside' | 'outside' |
--     'unconfigured') so the page can count chips, filter and sort from that
--     single field and never recompute a verdict of its own;
--   * sorts HERE: freshness rank (live, delayed, stale), then recorded_at DESC,
--     then the employee's name. The client must not re-sort.
--
-- SECURITY: identical to v3. Authorization is decided by the same
-- SECURITY DEFINER gate and the same caller-scope enforcement; the identity
-- comes from auth.uid() and never from a parameter, so one user can never read
-- another user's positions by renaming an argument.
--
-- THRESHOLDS ARE DECLARED ONCE, as v3 declared them (6 min / 30 min). They are
-- duplicated into display_category by design so the client has a single field
-- to render; the numbers must stay in step with src/config/trackingFreshness.js.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.employee_live_positions_v4(
  p_recent_hours integer DEFAULT 48,
  p_department text DEFAULT NULL::text,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_role text DEFAULT NULL::text,
  p_search text DEFAULT NULL::text
)
RETURNS TABLE (
  employee_id uuid,
  full_name text,
  employee_number text,
  "position" text,
  department text,
  branch_id uuid,
  branch_name text,
  latitude numeric,
  longitude numeric,
  accuracy_m numeric,
  recorded_at timestamp with time zone,
  uploaded_at timestamp with time zone,
  age_seconds integer,
  server_now timestamp with time zone,
  freshness text,
  geofence_status text,
  geofence_name text,
  nearest_location_name text,
  distance_to_center_m double precision,
  radius_m numeric,
  nearest_distance double precision,
  nearest_radius numeric,
  meters_outside numeric,
  boundary_ambiguous boolean,
  confidence text,
  location_label text,
  sync_status text,
  display_category text,
  has_fix boolean,
  clocked_in_at timestamp with time zone,
  clocked_out_at timestamp with time zone,
  is_clocked_in boolean,
  tracking_unavailable_reason text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_access jsonb;
  v_emulator_lat numeric := 37.4219983;
  v_emulator_lng numeric := -122.0840000;
begin
  -- Caller-scope enforcement, exactly as v3 does it. Raises the same refusal
  -- string so the UI keeps showing the server's own reason.
  v_access := public.employee_tracking_access();
  if not coalesce((v_access ->> 'can_view')::boolean, false) then
    raise exception 'TRACKING_FORBIDDEN:%', coalesce(v_access ->> 'reason', 'Not authorized.');
  end if;

  return query
  with latest_fix as (
    -- ONE row per employee by MAX(recorded_at). Never uploaded_at: a late
    -- backfill of an older capture must not displace a newer live fix.
    select distinct on (l.employee_id)
           l.employee_id, l.id, l.latitude, l.longitude, l.accuracy,
           l.recorded_at, l.uploaded_at, l.sync_status
      from public.employee_location_events l
     where not (l.latitude = v_emulator_lat and l.longitude = v_emulator_lng)
       -- The recency window. Only employees with a fix inside it are returned;
       -- this is what removes every "No location yet" row.
       and l.recorded_at >= now() - make_interval(hours => greatest(1, p_recent_hours))
     order by l.employee_id, l.recorded_at desc nulls last, l.id desc
  ),
  today_ta as (
    select a.employee_id,
           max(a.event_time) filter (where a.event_type = 'CLOCK_IN')  as clocked_in_at,
           max(a.event_time) filter (where a.event_type = 'CLOCK_OUT') as clocked_out_at
      from public.attendance_events a
     where a.event_type in ('CLOCK_IN','CLOCK_OUT')
       and (a.event_time at time zone 'Africa/Lagos')::date
         = (now() at time zone 'Africa/Lagos')::date
     group by a.employee_id
  ),
  classified as (
    select
      e.id,
      e.full_name,
      e.email,
      e.employee_number, e.position, e.department,
      e.branch_id, b.branch_name,
      le.latitude, le.longitude, le.accuracy,
      le.recorded_at, le.uploaded_at, le.sync_status,
      cls.inside, cls.registered_name, cls.geofence_id,
      cls.nearest_registered_name, cls.nearest_distance, cls.nearest_radius,
      cls.distance_to_center_m, cls.radius_m, cls.confidence,
      ta.clocked_in_at, ta.clocked_out_at
    from public.employees e
    -- INNER JOIN: without a recent fix the employee simply is not in the list.
    join latest_fix le on le.employee_id = e.id
    left join public.branches b on b.id = e.branch_id
    left join lateral (
      select * from public.classify_geofence(
        le.latitude::float, le.longitude::float, le.accuracy::float) cls
      limit 1
    ) cls on true
    left join today_ta ta on ta.employee_id = e.id
    where (p_department is null or lower(e.department) = lower(p_department))
      and (p_branch_id is null or e.branch_id = p_branch_id)
      -- Role lives on the profile, not the employee row, so the filter reads
      -- the linked profile. A missing profile simply does not match.
      and (p_role is null
           or exists (select 1 from public.profiles p
                       where p.id = e.user_id and p.role::text = p_role))
      and (p_search is null
           or btrim(coalesce(e.full_name, '')) ilike '%' || p_search || '%'
           or btrim(coalesce(e.employee_number, '')) ilike '%' || p_search || '%')
  )
  select
    c.id,
    coalesce(
      nullif(btrim(c.full_name), ''),
      (select nullif(btrim(pf.full_name), '')
         from public.profiles pf
        where pf.employee_id = c.id
          and nullif(btrim(pf.full_name), '') is not null
        limit 1),
      nullif(btrim(c.email), ''),
      nullif(btrim(c.employee_number), ''),
      'Staff ' || left(c.id::text, 8)
    ) as full_name,
    c.employee_number, c.position, c.department,
    c.branch_id, c.branch_name,
    c.latitude, c.longitude, c.accuracy as accuracy_m,
    c.recorded_at, c.uploaded_at,
    case when c.recorded_at is null then null
         else extract(epoch from (now() - c.recorded_at))::int end as age_seconds,
    now() as server_now,
    -- Freshness, exactly the thresholds v3 used.
    case
      when c.recorded_at is null then 'stale'
      when c.recorded_at > now() - interval '6 minutes' then 'live'
      when c.recorded_at > now() - interval '30 minutes' then 'delayed'
      else 'stale'
    end as freshness,
    -- THE geofence verdict, derived here from the newest fix and the same
    -- active-fence set classify_geofence reads. A stored inside_geofence
    -- written at capture time is never consulted.
    --
    --   'unconfigured' — no active fence exists anywhere to be inside or
    --                    outside of, so the branch has none configured;
    --   'inside'       — the fix is within one active fence's radius;
    --   'outside'      — an active fence exists, but not around this fix.
    case
      when c.nearest_registered_name is null then 'unconfigured'
      when coalesce(c.inside, false) then 'inside'
      else 'outside'
    end as geofence_status,
    coalesce(c.registered_name, c.nearest_registered_name) as geofence_name,
    c.nearest_registered_name as nearest_location_name,
    c.distance_to_center_m,
    c.radius_m,
    c.nearest_distance, c.nearest_radius,
    case when coalesce(c.inside, false) then null
         else round(c.nearest_distance)::numeric end as meters_outside,
    -- TRUE only when the GPS error circle reaches across the fence boundary,
    -- i.e. the reading cannot on its own prove inside or outside. It NEVER
    -- changes the verdict — it only licenses the honest "(low GPS accuracy)"
    -- note. A fix 11.6 km out can never be ambiguous, however imprecise it is.
    case when c.nearest_radius is null or c.accuracy is null then false
         else abs(coalesce(c.distance_to_center_m, c.nearest_distance) - c.nearest_radius)
              <= c.accuracy
    end as boundary_ambiguous,
    c.confidence,
    case
      when coalesce(c.inside, false) then
        coalesce(c.registered_name, 'Registered location')
        || case when c.distance_to_center_m is not null
                then ' (' || round(c.distance_to_center_m)::text || ' m from centre)'
                else '' end
      when c.nearest_registered_name is null then 'No geofence configured'
      else 'Outside ' || c.nearest_registered_name || ' ('
           || round(c.nearest_distance)::text || ' m away)'
    end as location_label,
    c.sync_status,
    -- SINGLE display category. Exactly one value per row:
    --   stale always wins (never present an old fix as a current position);
    --   otherwise the geofence verdict, including 'unconfigured'.
    case
      when c.recorded_at is null
           or c.recorded_at <= now() - interval '30 minutes' then 'stale'
      when c.nearest_registered_name is null then 'unconfigured'
      when coalesce(c.inside, false) then 'inside'
      else 'outside'
    end as display_category,
    true as has_fix,
    c.clocked_in_at, c.clocked_out_at,
    (c.clocked_in_at is not null
       and (c.clocked_out_at is null or c.clocked_out_at < c.clocked_in_at)) as is_clocked_in,
    (select tu.reason from public.employee_tracking_unavailable tu
      where tu.employee_id = c.id
        and tu.occurred_at > c.recorded_at
      order by tu.occurred_at desc limit 1) as tracking_unavailable_reason
  from classified c
  -- TODAY's attendance for the clock-in indicator, kept as its own CTE so the
  -- employees join cannot multiply rows.
  order by
    -- Freshness rank first: live, then delayed, then stale.
    case
      when c.recorded_at > now() - interval '6 minutes' then 0
      when c.recorded_at > now() - interval '30 minutes' then 1
      else 2
    end,
    -- Newest fix first inside the same rank.
    c.recorded_at desc,
    -- Then a stable, human order.
    c.full_name;
end;
$function$;

COMMENT ON FUNCTION public.employee_live_positions_v4(integer, text, uuid, text, text) IS
  'Live positions: only employees with a fix inside p_recent_hours (default 48), '
  'one row per employee by MAX(recorded_at), every geofence column derived from '
  'the newest fix via classify_geofence, and a single display_category per row. '
  'Sorted server-side: freshness rank, recorded_at DESC, name.';
