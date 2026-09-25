-- ============================================================================
-- INFINITYCORE — Itemized, persistent tasks with weighted auto-calculated
-- completion (Phase: PIP / KPI / Performance foundation)
-- ============================================================================
--
-- 1. `work_tasks.instruction_items`   — ordered list of distinct instruction
--    sub-items: `[{"id":"...","text":"Ensure that all leave requests..."}, …]`.
--    The old single `instructions` text column stays (legacy/display fallback).
-- 2. `work_tasks.instruction_progress` — per-sub-item progress 0..100 aligned by
--    `item_id`: `[{"item_id":"...","progress":70}, …]`. Untouched items simply
--    have no row, which the engine counts as 0 — NOT as "not in the average".
-- 3. Auto-calculated completion (NEVER manually entered): the task's overall
--    completion is the integer average of ALL sub-item percentages divided by
--    the TOTAL sub-item count. A task with 5 sub-items at [100,70,0,0,0]
--    yields (100+70+0+0+0)/5 = 34% (NOT 85%). When a task has no sub-items
--    the legacy single `completion_percentage` is the fallback.
-- 4. `task_submissions.*` now snapshot instruction_items / instruction_progress
--    / comment_items so HR can see the PROGRESSION of each submission (20% on
--    Monday, 60% on Wednesday), never silently overwritten.
-- 5. `comment_items` on a submission is an ordered list of distinct comment
--    entries `[{"id":"..","text":"..."}, …]` (Enter-to-add / "Add more").
-- 6. Two new server functions:
--      calculate_task_completion(jsonb, jsonb) -> int   (THE one engine)
--      get_employee_task_completion_rate(uuid, date, date) -> jsonb
--    (single source of truth consumed by My Work, Performance, PIP).
--
-- Backup / restore note: this migration is idempotent + additive.

-- ----------------------------------------------------------------------------
-- 1. work_tasks: itemized instructions + per-item progress
-- ----------------------------------------------------------------------------
alter table public.work_tasks
  add column if not exists instruction_items jsonb not null default '[]'::jsonb;

alter table public.work_tasks
  add column if not exists instruction_progress jsonb not null default '[]'::jsonb;

-- ----------------------------------------------------------------------------
-- 2. task_submissions: snapshot columns so history is never lost
-- ----------------------------------------------------------------------------
alter table public.task_submissions
  add column if not exists instruction_items jsonb not null default '[]'::jsonb;

alter table public.task_submissions
  add column if not exists instruction_progress jsonb not null default '[]'::jsonb;

alter table public.task_submissions
  add column if not exists comment_items jsonb not null default '[]'::jsonb;

-- ----------------------------------------------------------------------------
-- 3. THE completion engine (pure, shared by everything)
-- ----------------------------------------------------------------------------
create or replace function public.calculate_task_completion(
  p_items jsonb,
  p_progress jsonb
) returns integer
language sql
immutable
as $$
  -- items: [{"id":..., "text":...}, ...]  ·  progress: [{"item_id":..., "progress":0..100}, ...]
  -- Overall = round( sum(each item's progress, missing => 0) / total item count )
  -- NULL when there are no sub-items (caller falls back to completion_percentage).
  with items as (
    select row_number() over () as ord, elt ->> 'id' as item_id
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) elt
  ),
  progress as (
    select elt ->> 'item_id' as item_id,
           (coalesce((elt ->> 'progress')::integer, 0)) as pct
      from jsonb_array_elements(coalesce(p_progress, '[]'::jsonb)) elt
  ),
  total as (
    select count(*)::integer as n from items
  )
  select case
    when (select n from total) = 0 then null
    else round(
      sum(coalesce(pr.pct, 0))::numeric / (select n from total)
    )::integer
  end
  from items i
  left join progress pr on pr.item_id = i.item_id;
$$;

comment on function public.calculate_task_completion(jsonb, jsonb) is
  'Weighted task completion = average of ALL sub-item percentages (untouched = 0%) divided by total sub-item count. NULL when no sub-items.';

-- ----------------------------------------------------------------------------
-- 4. Aggregate KPI/task completion rate for an employee over a date range
-- ----------------------------------------------------------------------------
create or replace function public.get_employee_task_completion_rate(
  p_employee_id uuid,
  p_from date,
  p_to date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate numeric;
  v_task_count integer;
  v_own_user uuid;
begin
  if p_from is null or p_to is null then
    raise exception 'A date range is required.';
  end if;
  if p_from > p_to then
    raise exception 'The date range is invalid.';
  end if;

  -- Only the subject employee or HR roles may read completion rates.
  select e.user_id into v_own_user from public.employees e where e.id = p_employee_id;
  if v_own_user is not distinct from auth.uid() then
    -- owner may read their own rate
  elsif coalesce((select role from public.profiles where id = auth.uid()), '')
        in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    then
    -- HR may read any employee's rate
  else
    raise exception 'Not authorized to view this employee''s task completion rate.';
  end if;

  select
    coalesce(avg(effective), 0),
    count(*)::integer
    into v_rate, v_task_count
  from (
    select coalesce(
      public.calculate_task_completion(wt.instruction_items, wt.instruction_progress),
      wt.completion_percentage::numeric
    ) as effective
    from public.work_tasks wt
    where wt.employee_id = p_employee_id
      and (wt.start_date is null or wt.start_date <= p_to)
      and (wt.due_date is null or wt.due_date >= p_from)
  ) eff;

  return jsonb_build_object(
    'employee_id', p_employee_id,
    'from', p_from,
    'to', p_to,
    'task_count', v_task_count,
    'completion_rate', round(v_rate)::integer
  );
end;
$$;

comment on function public.get_employee_task_completion_rate(uuid, date, date) is
  'Average task/KPI completion rate for an employee over a date range, using calculate_task_completion().';

revoke all on function public.get_employee_task_completion_rate(uuid, date, date) from public;
grant execute on function public.get_employee_task_completion_rate(uuid, date, date) to authenticated;

-- Note: task_submissions already snapshots task_id / completion_percentage and
-- its RLS policies allow the submitter + the task's assigner to read.