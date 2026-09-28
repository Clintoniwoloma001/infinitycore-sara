-- ============================================================================
-- Work Management & KPI Engine Overhaul - step 1: schema
-- ============================================================================
-- Builds on public.work_tasks (NOT the legacy public.tasks) because "My Work"
-- already reads work_tasks; ACC items therefore land in the same system and
-- move the same completion score.
--
-- Replaces the instruction_items JSONB anti-pattern (manual 0-100 per item,
-- equal weight, no FK, no per-step review) with a real work_task_steps table.
-- Existing items are BACKFILLED so no task loses its current score.
--
-- Idempotent + additive. Safe to re-run.
begin;

create table if not exists public.work_task_steps (
  id                 uuid primary key default gen_random_uuid(),
  task_id            uuid not null references public.work_tasks(id) on delete cascade,
  title              text not null,
  description        text,
  -- BOOLEAN = checkbox deliverable; NUMERICAL = hit a target figure.
  target_type        text not null default 'boolean'
                       check (target_type in ('boolean','numerical')),
  target_value       numeric,          -- null when BOOLEAN
  -- The APPROVED current figure. Pending submissions never write here.
  current_value      numeric,          -- null when BOOLEAN
  is_completed       boolean not null default false,
  step_weight        numeric not null default 0 check (step_weight >= 0),
  calculated_step_rate numeric not null default 0
                       check (calculated_step_rate >= 0 and calculated_step_rate <= 100),
  status             text not null default 'pending'
                       check (status in ('pending','submitted','approved','rejected','revision_requested')),
  order_index        integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- A numerical step must have a real target; a boolean step must not.
  constraint work_task_steps_target_shape check (
    (target_type = 'boolean'  and target_value is null)
    or (target_type = 'numerical' and target_value is not null and target_value > 0)
  )
);

create index if not exists idx_work_task_steps_task
  on public.work_task_steps(task_id, order_index);
create index if not exists idx_work_task_steps_status
  on public.work_task_steps(status) where status <> 'approved';

-- Task-level additions: portfolio weight, review SLA, and the CACHED rate.
-- calculated_completion_rate is always engine-owned, never user-set.
alter table public.work_tasks
  add column if not exists task_weight numeric not null default 1
    check (task_weight >= 0),
  add column if not exists calculated_completion_rate numeric not null default 0
    check (calculated_completion_rate >= 0 and calculated_completion_rate <= 100),
  add column if not exists sla_review_hours integer not null default 48
    check (sla_review_hours > 0),
  add column if not exists sla_review_deadline timestamptz,
  add column if not exists source text not null default 'work_management'
    check (source in ('work_management','automation_centre')),
  add column if not exists source_ref uuid;

create index if not exists idx_work_tasks_source
  on public.work_tasks(source, source_ref);
create index if not exists idx_work_tasks_assignee_status
  on public.work_tasks(assigned_to_user_id, status);
-- The ACC "due soon" listing and the SLA badge both scan by deadline.
create index if not exists idx_work_tasks_sla
  on public.work_tasks(sla_review_deadline)
  where sla_review_deadline is not null;

commit;

-- Work Management & KPI Engine Overhaul - step 2: the calculation engine
-- ============================================================================
-- Every percentage in this module is DERIVED by these functions. There is no
-- code path that lets a client write completion_percentage or a step rate
-- directly; the RPCs below are the only writers.
begin;

-- Step rate, exactly per spec:
--   NUMERICAL -> min(100, current/target * 100);  BOOLEAN -> 100 or 0.
create or replace function public.work_task_step_rate(
  p_target_type   text,
  p_target_value  numeric,
  p_current_value numeric,
  p_is_completed  boolean
) returns numeric
language sql
immutable
as $$
  select case
    when p_target_type = 'boolean'
      then case when coalesce(p_is_completed, false) then 100.0 else 0.0 end
    -- Guard both divide-by-zero and a missing current figure: an unstarted
    -- numerical step scores 0, it does not error or score 100.
    when coalesce(p_target_value, 0) <= 0 or p_current_value is null then 0.0
    else round(least(100.0, (p_current_value / p_target_value) * 100.0), 2)
  end;
$$;

comment on function public.work_task_step_rate(text,numeric,numeric,boolean) is
  'Pure step-rate engine. BOOLEAN => 100/0. NUMERICAL => min(100, current/target*100). Always 0-100.';

-- Task rate = sum(rate_i * weight_i) / sum(weight_i).
-- If no weights were supplied they are auto-distributed equally (100 / n), so
-- the denominator can never be zero while steps exist.
create or replace function public.work_task_completion_rate(p_task_id uuid)
returns numeric
language sql
stable
as $$
  with s as (
    select
      calculated_step_rate as rate,
      step_weight as w,
      count(*) over ()::numeric as n
    from public.work_task_steps
    where task_id = p_task_id
  ),
  weighted as (
    -- use_weighted: true when any step carries an explicit non-zero weight
    select coalesce(sum(rate * (case when w > 0 then w else (100.0 / n) end)), 0) as num,
           sum(case when w > 0 then w else (100.0 / n) end)                as den
    from s
  )
  select case
    when (select count(*) from s) = 0 then 0.0
    when (select den from weighted) = 0 then 0.0
    else round(least(100.0, (select num from weighted) / (select den from weighted)), 2)
  end;
$$;

comment on function public.work_task_completion_rate(uuid) is
  'Weighted task rate = sum(step_rate * step_weight) / sum(step_weight). Falls back to equal weights when none set. 0 when the task has no steps.';

-- Recalculate one task's steps then its cached rate, and return it.
-- SINGLE writer of calculated_completion_rate.
create or replace function public.work_task_recalculate(p_task_id uuid)
returns numeric
language plpgsql
as $$
declare
  v_rate numeric;
begin
  update public.work_task_steps s
     set calculated_step_rate = public.work_task_step_rate(
           s.target_type, s.target_value, s.current_value, s.is_completed),
         updated_at = now()
   where s.task_id = p_task_id;

  v_rate := public.work_task_completion_rate(p_task_id);

  update public.work_tasks
     set calculated_completion_rate = v_rate,
         updated_at = now()
   where id = p_task_id;

  return v_rate;
end;
$$;

-- User portfolio KPI = sum(task_rate * task_weight) / sum(task_weight).
-- COMPLETED tasks ARE included by default: the spec's acceptance test requires
-- an approved-and-completed task to read 100% in the KPI summary, so excluding
-- it would make finishing your work DECREASE your score. Pass
-- p_include_completed => false for a running "still to do" figure.
create or replace function public.work_user_kpi_score(
  p_user_id            uuid,
  p_include_completed  boolean default true
) returns numeric
language sql
stable
as $$
  with t as (
    select calculated_completion_rate as rate, task_weight as w
    from public.work_tasks
    where assigned_to_user_id = p_user_id
      and status not in ('cancelled','rejected')
      and (p_include_completed or status <> 'completed')
  )
  select case
    when count(*) = 0 then 0.0
    when sum(w) = 0 then round(avg(rate), 2)
    else round(least(100.0, sum(rate * w) / sum(w)), 2)
  end
  from t;
$$;

comment on function public.work_user_kpi_score(uuid,boolean) is
  'Weighted portfolio KPI for a user. INCLUDES completed tasks by default so completing work raises the score; pass false for a running figure.';

commit;

-- ============================================================================

-- Work Management & KPI Engine Overhaul - step 3: backfill
-- ============================================================================
-- Convert existing instruction_items JSONB checkboxes into real steps so no
-- historical task loses its score when My Work switches to the step engine.
-- Idempotent: guarded on "task has no steps yet".
--
-- DEFENSIVE: public.work_tasks.instruction_items is added by migration
-- 20260923000003, which is not present in every environment (an older or
-- partially-migrated database has no such column at all). The backfill is
-- therefore wrapped in a column-existence check instead of assuming the column
-- is there, so this migration applies cleanly either way.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'work_tasks'
      and column_name = 'instruction_items'
  ) then
    raise notice 'work_tasks.instruction_items absent - skipping item backfill (steps remain empty).';
    return;
  end if;

  insert into public.work_task_steps (task_id, title, target_type, is_completed, step_weight, order_index)
  select t.id,
         coalesce(nullif(trim(elt->>'text'), ''), 'Deliverable ' || (ord::text)),
         'boolean',
         coalesce((elt->>'progress')::numeric, 0) >= 100,
         -- Equal distribution: each item gets 100/n so they sum to 100.
         round((100.0 / greatest(1, jsonb_array_length(t.instruction_items))), 2),
         ord - 1
  from public.work_tasks t
  cross join lateral jsonb_array_elements(coalesce(t.instruction_items, '[]'::jsonb)) with ordinality as x(elt, ord)
  where t.instruction_items is not null
    and jsonb_typeof(t.instruction_items) = 'array'
    and jsonb_array_length(t.instruction_items) > 0
    and not exists (select 1 from public.work_task_steps s where s.task_id = t.id);
end;
$$;

-- Refresh every backfilled task's cached rate through the one engine.
do $$
declare
  r record;
begin
  for r in
    select distinct t.id
    from public.work_tasks t
    join public.work_task_steps s on s.task_id = t.id
  loop
    perform public.work_task_recalculate(r.id);
  end loop;
end;
$$;

commit;

-- ============================================================================
