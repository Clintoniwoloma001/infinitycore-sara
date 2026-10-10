-- ============================================================================
-- 20261110000008_director_metric_values_upsert_rpc.sql  (PHASE 1)
-- ============================================================================
-- WHY: the importer needs ONE server-side entry point that commits a multi-metric
-- file in one transaction, updates ONLY the metric keys the file contains (never
-- nulling/zeroing the others), writes a history row for every overwrite,
-- surfaces conflicts for confirmation, and returns per-metric counts so the UI
-- can show "N new, M updates, K unchanged, C conflicts".
--
-- GATE: can_manage_bankone() only (the same importers who may publish). Writing
-- is narrower than the Director read gate on purpose.
--
-- CONTRACT
--   p_rows jsonb  -- array of {employee_id, as_of_date, metric_key, value}
--                   -- as_of_date is a plain YYYY-MM-DD string, parsed with an
--                   -- explicit format so it never depends on the session TZ.
--   p_batch_id uuid
--   p_confirm_conflicts boolean -- false = report conflicts, change nothing;
--                               -- true  = newer wins, history=conflict_confirmed
--   returns jsonb {inserted, updated, unchanged, conflicts[], conflict_count, per_metric}
--
-- Additive. Run AFTER 20261110000007.
-- ============================================================================

begin;

create or replace function public.director_upsert_metric_values(
  p_rows jsonb,
  p_batch_id uuid default null,
  p_confirm_conflicts boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_inserted int := 0;
  v_updated  int := 0;
  v_unchanged int := 0;
  r record;
  v_existing record;
  v_conflicts jsonb := '[]'::jsonb;
  v_per_metric jsonb := '{}'::jsonb;
  v_metric text;
  v_delta numeric;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if not public.can_manage_bankone() then
    raise exception 'insufficient_permissions: bankone.import';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  -- Iterate in a deterministic order so counts and the conflict list are stable.
  for r in
    select
      (elem->>'employee_id')::uuid        as employee_id,
      to_date(elem->>'as_of_date', 'YYYY-MM-DD') as as_of_date,
      elem->>'metric_key'                 as metric_key,
      (elem->>'value')::numeric           as value
    from jsonb_array_elements(p_rows) elem
    where elem->>'employee_id' is not null
      and elem->>'as_of_date' is not null
      and elem->>'metric_key' is not null
      and elem->>'value' is not null
    order by (elem->>'employee_id'), (elem->>'as_of_date'), (elem->>'metric_key')
  loop
    if not exists (select 1 from public.director_metric_definitions d where d.metric_key = r.metric_key) then
      raise exception 'Unknown metric_key: %', r.metric_key;
    end if;
    if not exists (select 1 from public.employees e where e.id = r.employee_id) then
      raise exception 'Unknown employee_id: %', r.employee_id;
    end if;

    select * into v_existing
      from public.director_metric_values v
     where v.employee_id = r.employee_id
       and v.as_of_date = r.as_of_date
       and v.metric_key = r.metric_key;

    if v_existing.id is null then
      insert into public.director_metric_values
        (employee_id, as_of_date, metric_key, value, source_batch_id, imported_by)
      values (r.employee_id, r.as_of_date, r.metric_key, r.value, p_batch_id, v_uid);
      insert into public.director_metric_values_history
        (employee_id, as_of_date, metric_key, old_value, new_value, unit, old_batch_id, new_batch_id, action, changed_by)
      values (r.employee_id, r.as_of_date, r.metric_key, null, r.value,
         (select unit from public.director_metric_definitions where metric_key = r.metric_key),
         null, p_batch_id, 'insert', v_uid);
      v_inserted := v_inserted + 1;

    elsif v_existing.value = r.value then
      update public.director_metric_values
         set source_batch_id = coalesce(p_batch_id, source_batch_id),
             imported_by = v_uid, updated_at = now()
       where id = v_existing.id;
      v_unchanged := v_unchanged + 1;

    else
      if not p_confirm_conflicts then
        v_conflicts := v_conflicts || jsonb_build_object(
          'employee_id', r.employee_id, 'as_of_date', r.as_of_date,
          'metric_key', r.metric_key, 'old_value', v_existing.value,
          'new_value', r.value, 'old_batch_id', v_existing.source_batch_id,
          'new_batch_id', p_batch_id);
      else
        insert into public.director_metric_values_history
          (employee_id, as_of_date, metric_key, old_value, new_value, unit, old_batch_id, new_batch_id, action, changed_by)
        values (r.employee_id, r.as_of_date, r.metric_key, v_existing.value, r.value,
           v_existing.unit, v_existing.source_batch_id, p_batch_id, 'conflict_confirmed', v_uid);
        update public.director_metric_values
           set value = r.value, source_batch_id = coalesce(p_batch_id, source_batch_id),
               imported_by = v_uid, updated_at = now()
         where id = v_existing.id;
        v_updated := v_updated + 1;
      end if;
    end if;

    v_metric := r.metric_key;
    v_delta := coalesce((v_per_metric->>v_metric)::numeric, 0) + r.value;
    v_per_metric := jsonb_set(v_per_metric, array[v_metric], to_jsonb(v_delta), true);
  end loop;

  return jsonb_build_object(
    'ok', true, 'inserted', v_inserted, 'updated', v_updated,
    'unchanged', v_unchanged, 'conflicts', v_conflicts,
    'conflict_count', jsonb_array_length(v_conflicts), 'per_metric', v_per_metric);
end;
$$;

revoke all on function public.director_upsert_metric_values(jsonb, uuid, boolean) from public;
revoke all on function public.director_upsert_metric_values(jsonb, uuid, boolean) from anon;
grant execute on function public.director_upsert_metric_values(jsonb, uuid, boolean) to authenticated;

comment on function public.director_upsert_metric_values(jsonb, uuid, boolean) is
  'Commits a multi-metric file in one transaction. Updates ONLY the metric keys present; never nulls/zeroes others; writes a history row for every overwrite; surfaces conflicts (old vs new) unless p_confirm_conflicts is true, in which case the newer value wins and history records action=conflict_confirmed. Gate: can_manage_bankone() only.';

commit;
