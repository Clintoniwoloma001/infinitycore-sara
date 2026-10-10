-- ---------------------------------------------------------------------------
-- List tracked employees: freshness a reader can actually trust
-- ---------------------------------------------------------------------------
-- Re-issues public.list_tracked_employees(integer, text, uuid).
--
-- Why (root cause of "8 recently updated · 0 stale" when the newest fix was
-- two days old):
--   1. The function decided staleness with a 45 MINUTE threshold while the
--      product's stale threshold is 30 minutes, and it did not return the
--      server's own age, so the client had nothing trustworthy to compute from.
--   2. It drove from employee_location_events (inner join), so an employee with
--      no fix at all simply did not appear - the roster cannot show
--      "No location yet" for them, and they cannot be counted as stale.
--
-- What changes (additive, same signature, same access gate, same grants):
--   * Driven from public.employees with a LEFT JOIN LATERAL picking the latest
--     event by recorded_at (nulls last), so every in-scope employee appears.
--     The lateral is a strict superset of the previous "latest row" subquery:
--     for an employee with events it returns exactly the same row.
--   * `is_stale` now uses the 30 minute product threshold.
--   * New columns, appended at the end: recorded_at, age_seconds (now() -
--     recorded_at, in seconds, from the SERVER clock), server_now, has_fix.
--   * Ordered newest-first with nulls last, so no-fix rows are last, not first.
--
-- Everything else (employee_tracking_access() gate, p_* filters, points_in_window,
-- column order of the pre-existing fields, security definer, search_path,
-- grants) is unchanged.
--
-- The UI reads these fields through src/config/trackingFreshness.js, which is
-- the single source of truth for the live / delayed / stale boundaries.
-- ---------------------------------------------------------------------------
begin;

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

  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen desc nulls last), '[]')
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
             -- Product threshold is 30 minutes (src/config/trackingFreshness.js);
             -- this previously shipped at 45 minutes, which hid old fixes.
             (le.recorded_at is not null
              and le.recorded_at < now() - interval '30 minutes') as is_stale,
             (select count(*) from public.employee_location_events c
                where c.employee_id = e.id
                  and c.recorded_at > now() - make_interval(mins => p_within_minutes)) as points_in_window,
             -- ---- appended columns (new) ----
             le.recorded_at,
             case when le.recorded_at is null then null
                  else extract(epoch from (now() - le.recorded_at))::int end as age_seconds,
             now() as server_now,
             le.recorded_at is not null as has_fix
        from public.employees e
        left join lateral (
          select l.id, l.employee_id, l.latitude, l.longitude, l.accuracy,
                 l.recorded_at, l.uploaded_at, l.location_label, l.resolved_place,
                 l.inside_geofence, l.distance_meters, l.nearest_location_name,
                 l.nearest_distance, l.nearest_radius
            from public.employee_location_events l
           where l.employee_id = e.id
           order by l.recorded_at desc nulls last, l.id desc
           limit 1
        ) le on true
        left join public.branches b on b.id = e.branch_id
       where (p_department is null or lower(e.department) = lower(p_department))
         and (p_branch_id is null or e.branch_id = p_branch_id)
    ) x;

  return v_rows;
end;
$$;

revoke all on function public.list_tracked_employees(integer, text, uuid) from public;
grant execute on function public.list_tracked_employees(integer, text, uuid) to authenticated;

comment on function public.list_tracked_employees(integer, text, uuid) is
  'Live position list for Employee Tracking, caller-scoped by employee_tracking_access(). Returns EVERY in-scope employee (LEFT JOIN LATERAL latest event by recorded_at), so an employee with no fix is shown as "No location yet" instead of being omitted. Appends recorded_at / age_seconds / server_now / has_fix (computed against the SERVER clock) for the client freshness classifier; is_stale uses the 30 minute product threshold. inside_geofence comes from resolve_employee_location() only.';

-- ---------------------------------------------------------------------------
-- Defence: prove the definition that actually landed, not the one we hoped for
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_missing text[] := array[]::text[];
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'list_tracked_employees'
     and p.oid = 'public.list_tracked_employees(integer, text, uuid)'::regprocedure;

  if v_def is null then
    raise exception 'list_tracked_freshness_missing: public.list_tracked_employees(integer, text, uuid) was not found after re-issue';
  end if;

  if v_def not like '%employee_tracking_access()%' then
    v_missing := v_missing || 'access gate'::text;
  end if;
  if v_def not like '%age_seconds%' then
    v_missing := v_missing || 'age_seconds'::text;
  end if;
  if v_def not like '%server_now%' then
    v_missing := v_missing || 'server_now'::text;
  end if;
  if v_def not like '%left join lateral%' then
    v_missing := v_missing || 'left join lateral (all employees)'::text;
  end if;
  if v_def not like '%30 minutes%' then
    v_missing := v_missing || '30 minute stale threshold'::text;
  end if;
  if v_def like '%interval ''45 minutes''%' then
    v_missing := v_missing || 'legacy 45 minute threshold still present'::text;
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception 'list_tracked_freshness_incomplete: %', array_to_string(v_missing, ', ');
  end if;
end;
$$;

commit;
