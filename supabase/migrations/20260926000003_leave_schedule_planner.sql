-- ============================================================================
-- PHASE 70 - LEAVE SCHEDULE PLANNER & LEAVE POLICY ENGINE (part 1 of 2)
-- ============================================================================
-- Run in Supabase SQL Editor AFTER 20260926000002. Idempotent, additive,
-- transaction-wrapped. No production table is dropped and no leave record is
-- rewritten.
--
-- WHAT THIS PART DOES
--   1. leave_requests.employee_id  (nullable, additive, backfilled)
--      The planner plans by PERSON. leave_requests historically carried only
--      employee_name (text) and created_by (the requester, who is not always
--      the subject when HR files on someone's behalf). The existing Director
--      RPC joins via employees.user_id = leave_requests.created_by, which is
--      unreliable for that case. We add a real FK, backfill it from the SAME
--      relationship already in use, and keep the old join working for any row
--      that cannot be backfilled.
--   2. leave_holidays  -- public holidays / company non-working days.
--      Deliberately seeded EMPTY: the platform had no holiday calendar, and
--      inventing Nigerian public-holiday dates would fabricate policy. HR
--      enters the real dates; until then the day engine uses weekends plus the
--      EXISTING hr_platform_settings.default_working_days.
--   3. leave_capacity_rules -- scoped capacity rules (global / area / branch /
--      department / team / role / designation) with an explicit priority order
--      that HR can read, rather than being hard-coded.
--   4. leave_schedules + leave_schedule_entries -- versioned published
--      schedules (proposed / approved / published) layered on top of existing
--      approved leave_requests rather than replacing them.
--   5. The capacity engine + a DETERMINISTIC availability checker that returns
--      AVAILABLE / CONFLICT / WARNING plus explained alternative periods.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. leave_requests.employee_id
-- ---------------------------------------------------------------------------
alter table public.leave_requests
  add column if not exists employee_id uuid references public.employees(id) on delete set null;

comment on column public.leave_requests.employee_id is
  'The employee the leave is FOR. Nullable: legacy rows may predate this column. When null, fall back to employees.user_id = leave_requests.created_by (the relationship the Director RPC already uses).';

-- Backfill using ONLY the existing, already-trusted relationship. Rows that do
-- not resolve are left null on purpose rather than guessed at.
update public.leave_requests lr
   set employee_id = e.id
  from public.employees e
 where lr.employee_id is null
   and e.user_id = lr.created_by;

create index if not exists idx_leave_requests_employee
  on public.leave_requests (employee_id, start_date desc);
-- Approved/pending leave drives planner capacity, so index that slice.
create index if not exists idx_leave_requests_active_window
  on public.leave_requests (start_date, end_date)
  where status in ('approved', 'pending');

-- ---------------------------------------------------------------------------
-- 2. HOLIDAYS / NON-WORKING DAYS
-- ---------------------------------------------------------------------------
create table if not exists public.leave_holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null,
  name text not null,
  scope text not null default 'company' check (scope in ('company','branch','area')),
  branch_id uuid references public.branches(id) on delete cascade,
  area text,
  is_working_day boolean not null default false,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- A table-level UNIQUE constraint cannot contain an expression, so the
-- company-wide / branch-specific dedupe key is an expression index instead.
create unique index if not exists uq_leave_holidays_scope
  on public.leave_holidays (
    holiday_date, name, scope,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists idx_leave_holidays_date on public.leave_holidays (holiday_date);
create index if not exists idx_leave_holidays_branch on public.leave_holidays (branch_id);

-- INTENTIONALLY EMPTY. No holiday dates are invented. The engine degrades to
-- weekends + hr_platform_settings.default_working_days until HR populates it.
comment on table public.leave_holidays is
  'Public holidays and company non-working days. Intentionally seeded empty - holiday dates are HR policy and are never fabricated by the platform. Leave day counts exclude weekends, configured working days, and these dates.';

-- ---------------------------------------------------------------------------
-- 3. LEAVE YEAR
-- ---------------------------------------------------------------------------
-- The platform's leave balance engine keys on calendar year (leave_balances
-- year column), so the default is Jan 1 - Dec 31 and is NOT assumed silently:
-- it is stored, readable and editable.
alter table public.hr_platform_settings
  add column if not exists leave_year_start_month integer default 1,
  add column if not exists leave_year_start_day integer default 1;

comment on column public.hr_platform_settings.leave_year_start_month is
  'Start month of the organisational leave year. Default 1 (January) matches the existing calendar-year leave_balances.year column.';

-- ---------------------------------------------------------------------------
-- 4. CAPACITY RULES  (sections 3, 4, 5)
-- ---------------------------------------------------------------------------
-- scope_type priority is data, not code: higher priority_number wins, so HR can
-- re-order precedence without a migration. The default ordering below is
-- global < area < branch < department < team < role < designation, i.e. the
-- more specific a scope, the tighter the rule.
create table if not exists public.leave_capacity_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scope_type text not null check (scope_type in
    ('global','area','branch','department','team','role','designation')),
  -- exactly one of these is set, matching scope_type
  scope_value text,
  branch_id uuid references public.branches(id) on delete cascade,
  area text,
  department text,
  role text,
  team text,

  max_people_on_leave integer,
  min_people_on_duty integer,
  max_percent_on_leave numeric(5,2),
  min_staffing_percent numeric(5,2),
  -- a rule that forbids overlapping leave for critical roles entirely
  critical_role_restriction boolean not null default false,
  -- optional: restrict which leave types this rule governs ('*' = all)
  leave_types text[] not null default array['*']::text[],

  priority_number integer not null default 100,
  is_active boolean not null default true,
  effective_from date,
  effective_to date,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A rule must actually constrain something, OR be explicitly marked as an
  -- unconfigured placeholder (is_template). This lets the platform ship the
  -- precedence ladder - so HR can SEE the levels and their order - without the
  -- system inventing capacity numbers that are organisational policy.
  is_template boolean not null default false,
  constraint capacity_has_a_limit check (
    is_template
    or max_people_on_leave is not null
    or min_people_on_duty is not null
    or max_percent_on_leave is not null
    or min_staffing_percent is not null
    or critical_role_restriction
  )
);

create index if not exists idx_capacity_rules_scope on public.leave_capacity_rules (scope_type, is_active);
create index if not exists idx_capacity_rules_priority on public.leave_capacity_rules (priority_number desc);

comment on column public.leave_capacity_rules.priority_number is
  'Higher wins when several rules match the same employee. Data, not code, so HR can re-order precedence. Defaults: global=10, area=20, branch=30, department=40, team=50, role=60, designation=70.';

-- Seed the precedence ladder only (no capacity numbers - those are HR policy
-- and are never invented here). These rows are marked is_template so the
-- availability engine skips them until HR fills in real numbers.
insert into public.leave_capacity_rules (name, scope_type, priority_number, is_template, notes)
values
 ('Global leave capacity',            'global',      10, true, 'Applies to everyone. Set the numbers your organisation can live with.'),
 ('Area leave capacity',              'area',        20, true, 'Applies within an area. Set the area and its numbers.'),
 ('Branch leave capacity',            'branch',      30, true, 'Applies within a branch. Choose the branch and its numbers.'),
 ('Department leave capacity',        'department',  40, true, 'Applies within a department. Set the department and its numbers.'),
 ('Team leave capacity',              'team',        50, true, 'Applies within a team. Set the team and its numbers.'),
 ('Role leave capacity',              'role',        60, true, 'Applies to a role. Set the role and its numbers.'),
 ('Designation leave capacity',       'designation', 70, true, 'Applies to a designation. Set the designation and its numbers.')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. VERSIONED SCHEDULES
-- ---------------------------------------------------------------------------
create table if not exists public.leave_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  leave_year integer not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'proposed'
    check (status in ('proposed','approved','published','superseded')),
  version integer not null default 1,
  supersedes uuid references public.leave_schedules(id) on delete set null,
  scope_summary jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  unique (name, leave_year, version)
);

create index if not exists idx_leave_schedules_year on public.leave_schedules (leave_year, status);

create table if not exists public.leave_schedule_entries (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.leave_schedules(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  leave_type text not null,
  start_date date not null,
  end_date date not null,
  working_days numeric(5,1) not null default 0,
  -- links back to the live request when this entry reflects approved leave
  leave_request_id uuid references public.leave_requests(id) on delete set null,
  origin text not null default 'generated' check (origin in ('generated','request','manual')),
  notes text,
  created_at timestamptz not null default now(),
  constraint schedule_entry_dates_check check (end_date >= start_date)
);

create index if not exists idx_schedule_entries_schedule on public.leave_schedule_entries (schedule_id);
create index if not exists idx_schedule_entries_employee on public.leave_schedule_entries (employee_id, start_date);

-- ---------------------------------------------------------------------------
-- 6. WORKING-DAY ENGINE  (sections 6, 7)
-- ---------------------------------------------------------------------------
-- A day counts toward leave only if it is a working day: not a weekend, listed
-- in the EXISTING hr_platform_settings.default_working_days, and not a holiday
-- in the NEW leave_holidays table (empty until HR fills it). No policy is
-- invented - whatever the platform is configured with is what is counted.
create or replace function public.leave_is_working_day(
  p_date date,
  p_branch_id uuid default null
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_working_days text[];
  v_holiday_count integer;
  v_companion_count integer;
begin
  -- A company holiday, or a holiday scoped to this branch, is never a working
  -- day. An explicitly marked working day on a weekend is respected.
  select count(*) into v_holiday_count
    from public.leave_holidays h
   where h.holiday_date = p_date
     and (h.branch_id is null or h.branch_id = p_branch_id)
     and not h.is_working_day;

  if v_holiday_count > 0 then
    return false;
  end if;

  select count(*) into v_companion_count
    from public.leave_holidays h
   where h.holiday_date = p_date
     and (h.branch_id is null or h.branch_id = p_branch_id)
     and h.is_working_day;

  if v_companion_count > 0 then
    return true;
  end if;

  select coalesce(working_days, array['mon','tue','wed','thu','fri'])
    into v_working_days
    from public.hr_platform_settings where id = 1;

  return lower(to_char(p_date, 'Dy')) = any (
    select lower(left(d, 3)) from unnest(v_working_days) d);
end;
$$;

comment on function public.leave_is_working_day(date, uuid) is
  'Single authority for "is this a working day". Used by the planner, capacity engine and duration calculations so leave duration can never be counted two different ways.';

-- Working days between two dates, inclusive.
create or replace function public.leave_working_days(
  p_start date,
  p_end date,
  p_branch_id uuid default null
) returns numeric
language plpgsql
immutable
security definer
set search_path = public
as $$
declare
  v_days integer;
begin
  if p_start is null or p_end is null or p_end < p_start then
    return 0;
  end if;
  select count(*) into v_days
    from generate_series(p_start, p_end, interval '1 day') d
   where public.leave_is_working_day(d::date, p_branch_id);
  return v_days::numeric;
end;
$$;

revoke all on function public.leave_is_working_day(date, uuid) from public;
grant execute on function public.leave_is_working_day(date, uuid) to authenticated;
revoke all on function public.leave_working_days(date, date, uuid) from public;
grant execute on function public.leave_working_days(date, date, uuid) to authenticated;

-- The organisational leave year window for a given year, read from settings.
create or replace function public.leave_year_window(p_year integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'leave_year', p_year,
    'start', make_date(p_year,
      (select coalesce(leave_year_start_month, 1) from public.hr_platform_settings where id = 1), 1),
    'end', (make_date(p_year,
      (select coalesce(leave_year_start_month, 1) from public.hr_platform_settings where id = 1), 1)
      + interval '1 year - 1 day')::date
  );
$$;

grant execute on function public.leave_year_window(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. AVAILABILITY CHECKER  (sections 9, 10, 33)
-- ---------------------------------------------------------------------------
-- Deterministic: same inputs always produce the same verdict, the same
-- conflicts and the same ordered alternatives. No AI, no randomness, no
-- inference. It NEVER mutates leave - it only reports.
--
-- Race safety (test: "two people requesting the final available slot
-- simultaneously"): a caller that intends to COMMIT the booking passes
-- p_for_update => true, which takes a transaction-scoped advisory lock keyed
-- on the leave type and period. Two concurrent transactions serialise, so the
-- second re-evaluates against the committed first booking and is told
-- CONFLICT instead of silently overbooking the slot.
create or replace function public.check_leave_availability(
  p_employee_ids uuid[],
  p_leave_type text,
  p_start date,
  p_end date,
  p_for_update boolean default false,
  p_depth integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflicts jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_alternatives jsonb := '[]'::jsonb;
  v_employees jsonb;
  v_branch_id uuid;
  v_days numeric;
  v_row record;
  v_rule record;
  v_lock_key bigint;
  v_people integer := coalesce(array_length(p_employee_ids, 1), 0);
begin
  if p_start is null or p_end is null then
    raise exception 'INVALID_RANGE:A start and end date are required.';
  end if;
  if p_end < p_start then
    raise exception 'INVALID_RANGE:The end date cannot be before the start date.';
  end if;

  if p_for_update then
    v_lock_key := hashtextextended(
      coalesce(p_leave_type, 'leave') || '|' || p_start::text || '|' || p_end::text, 0);
    perform pg_advisory_xact_lock(v_lock_key);
  end if;

  -- array_agg for the aggregate; a scalar subquery for the branch, because
  -- PostgreSQL has no min(uuid).
  select coalesce(jsonb_agg(to_jsonb(e) order by e.full_name), '[]')
    into v_employees
    from public.employees e where e.id = any(p_employee_ids);

  select e.branch_id into v_branch_id
    from public.employees e where e.id = any(p_employee_ids) limit 1;

  if v_employees = '[]'::jsonb then
    raise exception 'NO_EMPLOYEES:None of the selected employees exist.';
  end if;

  -- Working days come from the shared engine, so the reported duration is the
  -- same duration the leave balance engine will use.
  v_days := public.leave_working_days(p_start, p_end, v_branch_id);

  if v_days = 0 then
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'NO_WORKING_DAYS', 'severity', 'warning',
      'message', 'The selected range contains no working days (weekends, configured non-working days or holidays).');
  end if;

  -- Overlapping leave, per employee. Approved is treated as committed; pending
  -- is a warning because it is not yet approved.
  for v_row in
    select e.id as employee_id, e.full_name, e.branch_id, e.department, e.position
      from public.employees e where e.id = any(p_employee_ids)
  loop
    if exists (
      select 1 from public.leave_requests lr
       where coalesce(lr.employee_id,
             (select e2.id from public.employees e2 where e2.user_id = lr.created_by)) = v_row.employee_id
         and lr.status in ('approved','pending')
         and daterange(lr.start_date, coalesce(lr.end_date, lr.start_date), '[]')
             && daterange(p_start, p_end, '[]')
    ) then
      v_conflicts := v_conflicts || jsonb_build_object(
        'code', 'OVERLAPPING_LEAVE', 'severity', 'conflict',
        'employee_id', v_row.employee_id, 'employee_name', v_row.full_name,
        'message', format('%s already has leave scheduled in this period.', v_row.full_name));
    end if;
  end loop;

  -- Capacity rules, most specific first (priority_number ascending).
  for v_rule in
    select r.* from public.leave_capacity_rules r
     where r.is_active
       and not r.is_template
       and (r.effective_from is null or r.effective_from <= p_start)
       and (r.effective_to   is null or r.effective_to   >= p_end)
       and (r.leave_types @> array['*'] or r.leave_types @> array[coalesce(p_leave_type,'*')])
       and (
            r.scope_type = 'global'
         or (r.scope_type = 'branch'      and exists (select 1 from public.employees x
              where x.id = any(p_employee_ids) and x.branch_id = r.branch_id))
         or (r.scope_type = 'department'  and exists (select 1 from public.employees x
              where x.id = any(p_employee_ids) and lower(coalesce(x.department,'')) = lower(r.department)))
         or (r.scope_type = 'area'        and exists (select 1 from public.employees x
              where x.id = any(p_employee_ids) and lower(coalesce(x.department,'')) = lower(r.area)))
         or (r.scope_type = 'role'        and exists (select 1 from public.employees x
              where x.id = any(p_employee_ids) and lower(coalesce(x.position,'')) = lower(r.role)))
         or (r.scope_type = 'team'        and exists (select 1 from public.employees x
              where x.id = any(p_employee_ids) and lower(coalesce(x.position,'')) = lower(r.team)))
         or (r.scope_type = 'designation' and lower(coalesce(r.scope_value,'')) = '')
       )
     order by r.priority_number asc
  loop
    declare
      v_population integer;
      v_existing integer;
      v_on_duty integer;
      v_pct_on_leave numeric;
      v_pct_staffing numeric;
    begin
      -- Population the rule is measured against, using the SAME scope predicate
      -- so the count and the comparison can never use different populations.
      select count(*)::integer into v_population
        from public.employees e3
       where (v_rule.scope_type <> 'branch'      or e3.branch_id = v_rule.branch_id)
         and (v_rule.scope_type <> 'department'  or lower(coalesce(e3.department,'')) = lower(coalesce(v_rule.department,'')))
         and (v_rule.scope_type <> 'area'        or lower(coalesce(e3.department,'')) = lower(coalesce(v_rule.area,'')))
         and (v_rule.scope_type <> 'role'        or lower(coalesce(e3.position,''))  = lower(coalesce(v_rule.role,'')))
         and (v_rule.scope_type <> 'team'        or lower(coalesce(e3.position,''))  = lower(coalesce(v_rule.team,'')))
         and (v_rule.scope_type <> 'designation' or true);

      -- People already on approved leave in this period, within that population,
      -- EXCLUDING the employees being booked right now (they are not yet
      -- committed, so they are added back exactly once below).
      select count(distinct e5.id)::integer into v_existing
        from public.leave_requests lr
        join public.employees e5
          on e5.id = coalesce(lr.employee_id,
               (select e6.id from public.employees e6 where e6.user_id = lr.created_by))
       where lr.status = 'approved'
         and daterange(lr.start_date, coalesce(lr.end_date, lr.start_date), '[]')
             && daterange(p_start, p_end, '[]')
         and e5.id <> all(p_employee_ids)
         and (v_rule.scope_type <> 'branch'      or e5.branch_id = v_rule.branch_id)
         and (v_rule.scope_type <> 'department'  or lower(coalesce(e5.department,'')) = lower(coalesce(v_rule.department,'')))
         and (v_rule.scope_type <> 'area'        or lower(coalesce(e5.department,'')) = lower(coalesce(v_rule.area,'')))
         and (v_rule.scope_type <> 'role'        or lower(coalesce(e5.position,''))  = lower(coalesce(v_rule.role,'')))
         and (v_rule.scope_type <> 'team'        or lower(coalesce(e5.position,''))  = lower(coalesce(v_rule.team,'')));

      v_existing := v_existing + v_people;
      v_on_duty := greatest(coalesce(v_population, 0) - v_existing, 0);
      v_pct_on_leave := case when coalesce(v_population,0) > 0
        then round(v_existing::numeric * 100 / v_population, 2) else 0 end;
      v_pct_staffing := case when coalesce(v_population,0) > 0
        then round(v_on_duty::numeric * 100 / v_population, 2) else 100 end;

      if v_rule.max_people_on_leave is not null and v_existing > v_rule.max_people_on_leave then
        v_conflicts := v_conflicts || jsonb_build_object(
          'code', 'MAX_PEOPLE_EXCEEDED', 'severity', 'conflict',
          'rule', v_rule.name, 'rule_id', v_rule.id, 'scope_type', v_rule.scope_type,
          'actual', v_existing, 'limit', v_rule.max_people_on_leave,
          'message', format('%s: %s people would be on leave, exceeding the configured maximum of %s.',
            v_rule.name, v_existing, v_rule.max_people_on_leave));
      end if;

      if v_rule.min_people_on_duty is not null and v_on_duty < v_rule.min_people_on_duty then
        v_conflicts := v_conflicts || jsonb_build_object(
          'code', 'MINIMUM_STAFFING_BREACH', 'severity', 'conflict',
          'rule', v_rule.name, 'rule_id', v_rule.id, 'scope_type', v_rule.scope_type,
          'actual', v_on_duty, 'limit', v_rule.min_people_on_duty,
          'message', format('%s: minimum staffing of %s would be breached - only %s would remain on duty.',
            v_rule.name, v_rule.min_people_on_duty, v_on_duty));
      end if;

      if v_rule.max_percent_on_leave is not null and v_pct_on_leave > v_rule.max_percent_on_leave then
        v_conflicts := v_conflicts || jsonb_build_object(
          'code', 'MAX_PERCENT_EXCEEDED', 'severity', 'conflict',
          'rule', v_rule.name, 'rule_id', v_rule.id, 'scope_type', v_rule.scope_type,
          'actual', v_pct_on_leave, 'limit', v_rule.max_percent_on_leave,
          'message', format('%s: %s%% on leave exceeds the configured maximum of %s%%.',
            v_rule.name, v_pct_on_leave, v_rule.max_percent_on_leave));
      end if;

      if v_rule.min_staffing_percent is not null and v_pct_staffing < v_rule.min_staffing_percent then
        v_conflicts := v_conflicts || jsonb_build_object(
          'code', 'MIN_STAFFING_PERCENT_BREACH', 'severity', 'conflict',
          'rule', v_rule.name, 'rule_id', v_rule.id, 'scope_type', v_rule.scope_type,
          'actual', v_pct_staffing, 'limit', v_rule.min_staffing_percent,
          'message', format('%s: staffing would fall to %s%%, below the configured minimum of %s%%.',
            v_rule.name, v_pct_staffing, v_rule.min_staffing_percent));
      end if;

      if v_rule.critical_role_restriction and v_existing > 1 then
        v_conflicts := v_conflicts || jsonb_build_object(
          'code', 'CRITICAL_ROLE_RESTRICTION', 'severity', 'conflict',
          'rule', v_rule.name, 'rule_id', v_rule.id, 'scope_type', v_rule.scope_type,
          -- flagged so the alternative generator knows shifting the dates will
          -- never clear this conflict, and does not keep proposing shifts that
          -- are guaranteed to fail.
          'shift_may_resolve', false,
          'message', format('%s: overlapping leave is not permitted for this critical role.', v_rule.name));
      end if;
    end;
  end loop;

  -- Alternatives (section 10): the SAME duration, shifted in whole weeks until
  -- it fits, at most three suggestions. Deterministic, and every suggestion
  -- carries the reason it resolves the reported conflict - no unexplained
  -- recommendations.
  --
  -- Two guards:
  --   p_depth  bounds the recursion (each evaluation would otherwise try to
  --            compute alternatives of alternatives, recursing to stack death).
  --   v_unshiftable stops us proposing date shifts when a conflict is flagged
  --            as unfixable by shifting (e.g. a critical-role restriction on
  --            the employee's own leave), because every shift would fail too.
  if jsonb_array_length(v_conflicts) > 0
     and p_depth < 1
     and not exists (select 1 from jsonb_array_elements(v_conflicts) c
                      where (c ->> 'shift_may_resolve') = 'false') then
    for i in 1..6 loop
      declare
        v_alt_start date := p_start + (i * 7);
        v_alt_end   date := p_end   + (i * 7);
        v_alt jsonb;
      begin
        v_alt := public.check_leave_availability(
          p_employee_ids, p_leave_type, v_alt_start, v_alt_end, false, p_depth + 1);
        if jsonb_array_length(v_alt -> 'conflicts') = 0 then
          v_alternatives := v_alternatives || jsonb_build_object(
            'start', v_alt_start,
            'end', v_alt_end,
            'working_days', v_alt -> 'working_days',
            'reason', format(
              'Same duration, shifted %s week%s later. Resolves: %s',
              i, case when i = 1 then '' else 's' end,
              coalesce((select string_agg(c->>'message', '; ')
                          from jsonb_array_elements(v_conflicts) c),
                       'the reported conflict')));
        end if;
      end;
      exit when jsonb_array_length(v_alternatives) >= 3;
    end loop;
  elsif jsonb_array_length(v_conflicts) > 0 then
    -- Conflicts that no date shift can clear are explained rather than hidden.
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'NO_DATE_SHIFT_RESOLVES', 'severity', 'warning',
      'message', 'No alternative period can clear this conflict automatically - it concerns the employee''s own leave or a critical-role restriction. Review manually.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'verdict', case
      when jsonb_array_length(v_conflicts) > 0 then 'CONFLICT'
      when jsonb_array_length(v_warnings) > 0 then 'WARNING'
      else 'AVAILABLE'
    end,
    'start', p_start, 'end', p_end,
    'leave_type', p_leave_type,
    'working_days', v_days,
    'employees', v_employees,
    'conflicts', v_conflicts,
    'warnings', v_warnings,
    'alternatives', v_alternatives,
    'evaluated_at', now());
end;
$$;

-- Drop the previous signature if it exists, so the added depth parameter can
-- never leave an ambiguous overload behind (the same hazard handled for the
-- canonical attendance clock functions in phase 20260922000011).
drop function if exists public.check_leave_availability(uuid[], text, date, date, boolean);

revoke all on function public.check_leave_availability(uuid[], text, date, date, boolean, integer) from public;
grant execute on function public.check_leave_availability(uuid[], text, date, date, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. PLANNER READ  (sections 8, 11, 13, 14, 18, 19)
-- ---------------------------------------------------------------------------
-- One aggregated read for the whole planner: timeline rows, overview counters
-- and the capacity heatmap. Server-side aggregation only - the browser never
-- receives the company database to compute these itself.
create or replace function public.get_leave_planner(
  p_from date,
  p_to date,
  p_department text default null,
  p_branch_id uuid default null,
  p_area text default null,
  p_role text default null,
  p_employee_id uuid default null,
  p_leave_type text default null,
  p_status text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp record;
  v_is_planner boolean;
  v_legend jsonb;
  v_summary jsonb;
  v_capacity jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_RANGE:The planner needs a valid from/to range.';
  end if;

  select e.* into v_emp
    from public.employees e join public.profiles p on p.id = e.user_id
   where p.id = auth.uid() limit 1;

  if not found then
    raise exception 'NO_EMPLOYEE_PROFILE:No employee record is linked to this account.';
  end if;

  v_is_planner := public.has_permission('leave.schedule.view')
                   or public.current_role() in
                      ('super_admin','admin','head_of_human_resources','hr_officer');

  -- Timeline. Approved + pending leave overlapping the window. Rejected and
  -- cancelled requests are excluded, so they never appear as active leave.
  -- A non-planner is hard-scoped to their own row.
  with scoped as (
    select e.id as employee_id, e.full_name, e.employee_number, e.position,
           e.department, e.branch_id, b.branch_name
      from public.employees e
      left join public.branches b on b.id = e.branch_id
     where (p_employee_id is null or e.id = p_employee_id)
       and (p_department is null or lower(coalesce(e.department,'')) = lower(p_department))
       and (p_branch_id  is null or e.branch_id = p_branch_id)
       and (p_area       is null or lower(coalesce(b.branch_name,'')) = lower(p_area)
                            or lower(coalesce(e.department,'')) = lower(p_area))
       and (p_role       is null or lower(coalesce(e.position,'')) = lower(p_role))
       and (v_is_planner or e.id = v_emp.id)
  ),
  entries as (
    select s.employee_id, s.full_name, s.employee_number, s.position,
           s.department, s.branch_id, s.branch_name,
           lr.id as request_id, lr.leave_type, lr.status,
           lr.start_date, lr.end_date,
           coalesce(lr.end_date, lr.start_date) as effective_end
      from scoped s
      join public.leave_requests lr
        on coalesce(lr.employee_id,
             (select e7.id from public.employees e7 where e7.user_id = lr.created_by)) = s.employee_id
     where lr.status in ('approved','pending')
       and (p_status is null or lr.status = p_status)
       and (p_leave_type is null or lr.leave_type = p_leave_type)
       and daterange(lr.start_date, coalesce(lr.end_date, lr.start_date), '[]')
           && daterange(p_from, p_to, '[]')
  )
  select coalesce(jsonb_agg(to_jsonb(en) order by en.full_name, en.start_date), '[]')
    into v_legend
    from (
      select e2.employee_id, e2.full_name, e2.employee_number, e2.position,
             e2.department, e2.branch_id, e2.branch_name,
             e2.request_id, e2.leave_type, e2.status, e2.start_date, e2.end_date,
             public.leave_working_days(e2.start_date, e2.effective_end, e2.branch_id) as working_days,
             case
               when e2.status = 'approved'
                and e2.start_date <= current_date
                and e2.effective_end >= current_date then 'on_leave'
               when e2.status = 'pending' then 'pending'
               when e2.status = 'approved' and e2.start_date > current_date then 'upcoming'
               else 'completed'
             end as planner_state
        from entries e2
    ) en;

  -- Overview counters, derived from the SAME legend, so a card can never
  -- disagree with the timeline rendered beneath it.
  select jsonb_build_object(
    'currently_on_leave', count(*) filter (where l->>'planner_state' = 'on_leave'),
    'upcoming_this_week', count(*) filter (where l->>'planner_state' = 'upcoming'
      and (l->>'start_date')::date between current_date and current_date + 7),
    'upcoming_this_month', count(*) filter (where l->>'planner_state' = 'upcoming'
      and (l->>'start_date')::date < (date_trunc('month', current_date) + interval '1 month')::date),
    'pending_requests', count(*) filter (where l->>'status' = 'pending'),
    'completed', count(*) filter (where l->>'planner_state' = 'completed')
  ) into v_summary
  from jsonb_array_elements(v_legend) l;

  -- Capacity heatmap per branch per day (section 18). The denominator is real
  -- headcount and the capacity is the CONFIGURED rule. Where no rule is
  -- configured the row reports configured_capacity = null and is_conflict =
  -- false, so an unconfigured rule is never displayed as a breach.
  with days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  ),
  per_branch as (
    select b.id as branch_id, b.branch_name, count(e.id)::int as headcount
      from public.branches b
      left join public.employees e on e.branch_id = b.id
     group by b.id, b.branch_name
  ),
  on_leave as (
    select x.branch_id, (lr.start_date + o)::date as day
      from public.leave_requests lr
      join public.employees x
        on x.id = coalesce(lr.employee_id,
             (select e8.id from public.employees e8 where e8.user_id = lr.created_by))
      cross join lateral generate_series(0, coalesce(lr.end_date, lr.start_date) - lr.start_date) o
     where lr.status = 'approved'
  )
  select coalesce(jsonb_agg(to_jsonb(h) order by h.branch_name, h.day), '[]')
    into v_capacity
    from (
      select pb.branch_id, pb.branch_name, d.day,
             count(ol.branch_id)::int as on_leave_count,
             pb.headcount,
             r.max_people_on_leave as configured_capacity,
             (r.id is not null
              and r.max_people_on_leave is not null
              and count(ol.branch_id) > r.max_people_on_leave) as is_conflict
        from per_branch pb
        cross join days d
        left join on_leave ol on ol.branch_id = pb.branch_id and ol.day = d.day
        left join public.leave_capacity_rules r
          on r.scope_type = 'branch' and r.branch_id = pb.branch_id
         and r.is_active and not r.is_template
         and d.day >= coalesce(r.effective_from, d.day - 1)
         and d.day <= coalesce(r.effective_to, d.day + 1)
       group by pb.branch_id, pb.branch_name, d.day, pb.headcount,
                r.id, r.max_people_on_leave
    ) h;

  return jsonb_build_object(
    'ok', true,
    'from', p_from, 'to', p_to,
    'scope', jsonb_build_object(
      'employee_id', v_emp.id, 'branch_id', v_emp.branch_id,
      'department', v_emp.department, 'is_planner', v_is_planner),
    'entries', v_legend,
    'summary', v_summary,
    'capacity', v_capacity,
    'generated_at', now());
end;
$$;

revoke all on function public.get_leave_planner(date, date, text, uuid, text, text, uuid, text, text) from public;
grant execute on function public.get_leave_planner(date, date, text, uuid, text, text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. CAPACITY RULE CRUD  (sections 2, 3, 4, 31)
-- ---------------------------------------------------------------------------
-- Writing a capacity rule is restricted SERVER-side. Hiding the button in the
-- UI is not the control: the RPC refuses regardless of what the client sends.
create or replace function public.upsert_leave_capacity_rule(
  p_id uuid default null,
  p_name text default null,
  p_scope_type text default null,
  p_branch_id uuid default null,
  p_department text default null,
  p_area text default null,
  p_role text default null,
  p_team text default null,
  p_scope_value text default null,
  p_max_people_on_leave integer default null,
  p_min_people_on_duty integer default null,
  p_max_percent_on_leave numeric default null,
  p_min_staffing_percent numeric default null,
  p_critical_role_restriction boolean default false,
  p_leave_types text[] default array['*']::text[],
  p_priority_number integer default null,
  p_effective_from date default null,
  p_effective_to date default null,
  p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_id uuid;
  v_priority integer;
begin
  if not (public.has_permission('leave.schedule.configure')
          or v_role in ('super_admin','admin','head_of_human_resources')) then
    raise exception 'LEAVE_CONFIG_FORBIDDEN:You cannot change leave scheduling rules.';
  end if;

  -- p_name and p_scope_type are the only genuinely required inputs; they carry
  -- a default only because PostgreSQL requires every parameter after the first
  -- defaulted one to also have one.
  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'MISSING_NAME:Give this capacity rule a name.';
  end if;

  if p_scope_type not in ('global','area','branch','department','team','role','designation') then
    raise exception 'INVALID_SCOPE:%', coalesce(p_scope_type, '(none)');
  end if;
  if p_scope_type = 'branch' and p_branch_id is null then
    raise exception 'MISSING_SCOPE_VALUE:Choose the branch this rule applies to.';
  end if;
  if p_effective_to is not null and p_effective_from is not null
     and p_effective_to < p_effective_from then
    raise exception 'INVALID_EFFECTIVE_RANGE:The end date cannot be before the start date.';
  end if;

  -- Default precedence follows the documented ladder when HR does not override.
  v_priority := coalesce(p_priority_number, case p_scope_type
    when 'global' then 10 when 'area' then 20 when 'branch' then 30
    when 'department' then 40 when 'team' then 50 when 'role' then 60
    else 70 end);

  if p_id is null then
    insert into public.leave_capacity_rules (
      name, scope_type, branch_id, department, area, role, team, scope_value,
      max_people_on_leave, min_people_on_duty, max_percent_on_leave,
      min_staffing_percent, critical_role_restriction, leave_types,
      priority_number, is_template, is_active,
      effective_from, effective_to, notes, created_by
    ) values (
      p_name, p_scope_type, p_branch_id,
      nullif(trim(p_department), ''), nullif(trim(p_area), ''),
      nullif(trim(p_role), ''), nullif(trim(p_team), ''),
      nullif(trim(p_scope_value), ''),
      p_max_people_on_leave, p_min_people_on_duty, p_max_percent_on_leave,
      p_min_staffing_percent, coalesce(p_critical_role_restriction, false),
      coalesce(p_leave_types, array['*']::text[]),
      v_priority, false, true,
      p_effective_from, p_effective_to, p_notes, auth.uid()
    ) returning id into v_id;
  else
    update public.leave_capacity_rules
       set name = p_name, scope_type = p_scope_type, branch_id = p_branch_id,
           department = nullif(trim(p_department), ''),
           area = nullif(trim(p_area), ''), role = nullif(trim(p_role), ''),
           team = nullif(trim(p_team), ''), scope_value = nullif(trim(p_scope_value), ''),
           max_people_on_leave = p_max_people_on_leave,
           min_people_on_duty = p_min_people_on_duty,
           max_percent_on_leave = p_max_percent_on_leave,
           min_staffing_percent = p_min_staffing_percent,
           critical_role_restriction = coalesce(p_critical_role_restriction, false),
           leave_types = coalesce(p_leave_types, array['*']::text[]),
           priority_number = v_priority,
           -- editing a template turns it into a real rule
           is_template = false, is_active = true,
           effective_from = p_effective_from, effective_to = p_effective_to,
           notes = p_notes, updated_at = now()
     where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'RULE_NOT_FOUND:That capacity rule no longer exists.';
    end if;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_CAPACITY_RULE_SAVED', 'LeaveCapacityRule', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('scope_type', p_scope_type, 'name', p_name, 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'id', v_id, 'priority_number', v_priority);
end;
$$;

revoke all on function public.upsert_leave_capacity_rule(uuid, text, text, uuid, text, text, text, text, text, integer, integer, numeric, numeric, boolean, text[], integer, date, date, text) from public;
grant execute on function public.upsert_leave_capacity_rule(uuid, text, text, uuid, text, text, text, text, text, integer, integer, numeric, numeric, boolean, text[], integer, date, date, text) to authenticated;

create or replace function public.delete_leave_capacity_rule(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
begin
  if not (public.has_permission('leave.schedule.configure')
          or v_role in ('super_admin','admin','head_of_human_resources')) then
    raise exception 'LEAVE_CONFIG_FORBIDDEN:You cannot change leave scheduling rules.';
  end if;

  delete from public.leave_capacity_rules where id = p_id;
  if not found then
    raise exception 'RULE_NOT_FOUND:That capacity rule no longer exists.';
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_CAPACITY_RULE_DELETED', 'LeaveCapacityRule', p_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('rule_id', p_id, 'success', true)::text, 'info');

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.delete_leave_capacity_rule(uuid) from public;
grant execute on function public.delete_leave_capacity_rule(uuid) to authenticated;

-- Rule list, ordered by the precedence that actually applies, so HR can see
-- which rule wins without reading the source.
create or replace function public.list_leave_capacity_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(x) order by x.priority_number asc, x.name), '[]')
    into v_rows
    from (
      select r.id, r.name, r.scope_type, r.branch_id, b.branch_name,
             r.department, r.area, r.role, r.team, r.scope_value,
             r.max_people_on_leave, r.min_people_on_duty,
             r.max_percent_on_leave, r.min_staffing_percent,
             r.critical_role_restriction, r.leave_types, r.priority_number,
             r.is_template, r.is_active, r.effective_from, r.effective_to, r.notes
        from public.leave_capacity_rules r
        left join public.branches b on b.id = r.branch_id
    ) x;

  return jsonb_build_object('ok', true, 'rules', v_rows);
end;
$$;

grant execute on function public.list_leave_capacity_rules() to authenticated;

commit;