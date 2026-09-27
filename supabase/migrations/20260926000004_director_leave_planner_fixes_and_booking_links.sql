-- ============================================================================
-- PHASE 70b - DIRECTOR SQL FIX, LEAVE PLANNER FIXES & BOOKING-LINK WORKFLOW
-- ============================================================================
-- Run in Supabase SQL Editor AFTER 20260926000003. Idempotent, additive,
-- transaction-wrapped. No production table is dropped and no existing leave
-- record is rewritten.
--
-- 1. DIRECTOR INTELLIGENCE - "column reference employee_id is ambiguous"
--    20260926000003 added leave_requests.employee_id. The Director snapshot
--    resolved the employee with `select lr.*, e.id employee_id`, so once
--    `lr.*` also carried employee_id the CTE had TWO columns of that name and
--    every later `l.employee_id` reference became ambiguous. The employee is
--    now resolved ONCE, as `resolved_employee_id`, and the join becomes a LEFT
--    join so a request linked only by the new FK is no longer dropped.
--    Reissued from 20260924000005 (the current body) and it PRESERVES both the
--    widened executive role gate and the 20260925160359 fixed-20-day
--    expectation, so this repair cannot regress either.
--
-- 2. LEAVE PLANNER - "column working_days does not exist"
--    leave_is_working_day() read `working_days` from hr_platform_settings,
--    which has no such column - the column 20260926000003 added belongs to
--    leave_schedule_entries, a different table. The platform column is
--    `default_working_days` (already used by the attendance engine). Every
--    "Check availability" call failed because this function is the root of the
--    working-day count.
--
-- 3. BOOKING-LINK WORKFLOW
--    A booking reserves a spot on the SHARED team calendar. It is NOT a leave
--    request and never becomes one on its own: the employee converts it later,
--    and that conversion writes the SAME leave_requests row and enters the
--    SAME approval chain as a request typed by hand. There is exactly one
--    approval pathway in this system and this feature does not add another.
--    The "Request this leave" button is gated by an HR-configurable window
--    before the booked start date, enforced SERVER-side - the disabled button
--    is a convenience, not the control.
-- ============================================================================

begin;

-- ============================================================================
-- PART A - BUG FIXES
-- ============================================================================
-- --- A1. Director snapshot: leave_rows ambiguity + preserved later fixes ---
create or replace function public.get_director_executive_snapshot(
  p_start_date date default null, p_end_date date default null,
  p_department text default null, p_branch_id uuid default null,
  p_area text default null, p_role text default null,
  p_designation_id uuid default null, p_employee_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_end date := coalesce(p_end_date, current_date);
  v_start date := coalesce(p_start_date, date_trunc('month', current_date)::date);
  v_previous_end date := v_start - 1;
  v_previous_start date := v_start - (v_end - v_start + 1);
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if public.current_role() not in ('md_ceo','chairman','director','super_admin')
     or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;
  if v_end < v_start or v_end > current_date or v_start < current_date - interval '2 years' then
    raise exception 'Invalid executive reporting period';
  end if;

  with scoped as (
    select e.*, b.branch_name, d.title as designation_title,
      coalesce(nullif(e.area,''),(select coalesce(a.area_name,a.area_code) from public.branch_area_assignments baa
        join public.areas a on a.id=baa.area_id where baa.branch_id=e.branch_id and baa.is_current limit 1)) area_name,
      coalesce(p.role,'staff') platform_role,
      public.department_label(e.department) department_label,
      (select doc.file_path from public.documents doc where doc.entity_type='employee' and doc.entity_id=e.id
        and lower(coalesce(doc.document_type,''))='profile_picture' order by doc.created_at desc limit 1) profile_picture_path
    from public.employees e
    left join public.profiles p on p.id=e.user_id
    left join public.branches b on b.id=e.branch_id
    left join public.designations d on d.id=e.designation_id
    where (p_department is null or lower(coalesce(e.department,''))=lower(p_department))
      and (p_branch_id is null or e.branch_id=p_branch_id)
      and (p_area is null or lower(coalesce(e.area,''))=lower(p_area)
        or exists (select 1 from public.branch_area_assignments baa join public.areas a on a.id=baa.area_id
          where baa.branch_id=e.branch_id and baa.is_current and lower(coalesce(a.area_name,a.area_code))=lower(p_area)))
      and (p_role is null or coalesce(p.role,'staff')=p_role)
      and (p_designation_id is null or e.designation_id=p_designation_id)
      and (p_employee_id is null or e.id=p_employee_id)
  ), ids as (select id from scoped), range_days as (
    select series_date::date as attendance_date
    from generate_series(v_start::timestamp, v_end::timestamp, interval '1 day') as dates(series_date)
    where extract(isodow from series_date::date) < 6
  ), attendance as (
    select * from public.attendance_records where employee_id in (select id from ids) and attendance_date between v_start and v_end
  ), previous_attendance as (
    select * from public.attendance_records where employee_id in (select id from ids) and attendance_date between v_previous_start and v_previous_end
  ), kpis as (
    select * from public.employee_kpis where employee_id in (select id from ids) and coalesce(updated_at,created_at)::date between v_start and v_end
  ), previous_kpis as (
    select * from public.employee_kpis where employee_id in (select id from ids) and coalesce(updated_at,created_at)::date between v_previous_start and v_previous_end
  ), targets as (
    select * from public.targets where employee_id in (select id from ids) and coalesce(start_date,created_at::date)<=v_end
      and coalesce(end_date,'infinity'::date)>=v_start and status not in ('cancelled','missed')
  ), leave_rows as (
    select lr.*, coalesce(lr.employee_id, e.id) as resolved_employee_id
      from public.leave_requests lr
      left join public.employees e on e.user_id = lr.created_by
     where coalesce(lr.employee_id, e.id) in (select id from ids)
  ), staff as (
    select s.*,
      (select count(*) from attendance a where a.employee_id=s.id and a.clock_in is not null)::int attendance_present,
      (select count(*) from previous_attendance a where a.employee_id=s.id and a.clock_in is not null)::int previous_attendance_present,
      20::int expected_days,
      (select count(*) from kpis k where k.employee_id=s.id)::int kpi_count,
      (select count(*) from kpis k where k.employee_id=s.id and k.status in ('completed','acknowledged'))::int kpi_completed,
      (select count(*) from targets t where t.employee_id=s.id)::int target_count,
      (select count(*) from targets t where t.employee_id=s.id and t.status='achieved')::int target_achieved,
      (select count(*) from leave_rows l where l.resolved_employee_id=s.id and l.status='approved' and l.start_date<=v_end and l.end_date>=v_start)::int leave_count
    from scoped s
  ), overall as (
    select count(*)::int total_staff, count(*) filter(where employment_status='active')::int active_staff,
      count(*) filter(where employment_status='on_leave' or leave_count>0)::int on_leave,
      coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0) attendance_rate,
      coalesce(round(100.0*sum(previous_attendance_present)/nullif(sum(expected_days),0)),0) previous_attendance_rate,
      coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0) kpi_completion,
      coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0) target_completion from staff
  ), perf as (
    select coalesce(round(avg(least(200,100.0*actual_value/nullif(target_value,0))),1),0) achievement_pct from kpis where target_value<>0
  ), previous_perf as (
    select coalesce(round(avg(least(200,100.0*actual_value/nullif(target_value,0))),1),0) achievement_pct from previous_kpis where target_value<>0
  ), target_perf as (
    select coalesce(round(100.0*sum(current_value)/nullif(sum(target_value),0),1),0) achievement_pct from targets where target_value<>0
  )
  select jsonb_build_object(
    'generated_at',now(),'range',jsonb_build_object('start',v_start,'end',v_end,'previous_start',v_previous_start,'previous_end',v_previous_end),
    'summary',(select to_jsonb(o) from overall o) || jsonb_build_object(
      'absent',(select coalesce(sum(expected_days-attendance_present),0)::int from staff where employment_status='active' and leave_count=0),
      'kpi_achievement',(select achievement_pct from perf),'previous_kpi_achievement',(select achievement_pct from previous_perf),
      'target_achievement',(select achievement_pct from target_perf),
      'loans_disbursed',(select coalesce(sum(principal_amount),0) from public.loans where coalesce(disbursed_date,created_at::date) between v_start and v_end),
      'previous_loans_disbursed',(select coalesce(sum(principal_amount),0) from public.loans where coalesce(disbursed_date,created_at::date) between v_previous_start and v_previous_end),
      'loan_portfolio',(select coalesce(sum(outstanding_balance),0) from public.loans where status in ('active','disbursed','performing')),
      'repayments',(select coalesce(sum(amount),0) from public.repayments where payment_date between v_start and v_end),
      'previous_repayments',(select coalesce(sum(amount),0) from public.repayments where payment_date between v_previous_start and v_previous_end),
      'active_recruitment',(select count(*) from public.hr_candidates where application_status not in ('hired','rejected','withdrawn')),
      'open_onboarding',(select count(*) from public.employee_onboarding_submissions where onboarding_status in ('submitted','under_review','pending_guarantor','guarantor_submitted','correction_requested')),
      'pending_leave',(select count(*) from leave_rows where status='pending'),
      'upcoming_resumptions',(select count(*) from leave_rows where status='approved' and end_date between v_end and v_end+14)
    ),
    'filters',jsonb_build_object(
      'departments',(select coalesce(jsonb_agg(jsonb_build_object('id',x.name,'name',x.name) order by x.name),'[]') from (select distinct public.department_label(e.department) name from public.employees e) x where x.name <> 'Unassigned'),
      'branches',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',branch_name) order by branch_name),'[]') from public.branches where coalesce(status,'active')='active'),
      'areas',(select coalesce(jsonb_agg(jsonb_build_object('id',area_code,'name',coalesce(area_name,area_code)) order by area_code),'[]') from public.areas where is_active),
      'roles',(select coalesce(jsonb_agg(jsonb_build_object('id',role,'name',role) order by role),'[]') from (select distinct role from public.profiles) x),
      'designations',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',title,'department',department) order by title,department),'[]') from public.designations where is_active),
      'employees',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.full_name,'department',public.department_label(e.department),'branch',b.branch_name) order by e.full_name),'[]') from public.employees e left join public.branches b on b.id=e.branch_id)
    ),
    'departments',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',department_label,'name',department_label,'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0),'completion_rate',coalesce(round((sum(attendance_present)+sum(kpi_completed)+sum(target_achieved))*100.0/nullif(sum(expected_days)+sum(kpi_count)+sum(target_count),0)),0)) x
      from staff group by department_label) x),
    'branches',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',coalesce(branch_name,'Unassigned'),'name',coalesce(branch_name,'Unassigned'),'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0)) x
      from staff group by coalesce(branch_name,'Unassigned')) x),
    'areas',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',coalesce(area_name,'Unassigned'),'name',coalesce(area_name,'Unassigned'),'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0)) x
      from staff group by coalesce(area_name,'Unassigned')) x),
    'staff',(select coalesce(jsonb_agg(to_jsonb(x) order by full_name),'[]') from (select id,user_id,full_name,profile_picture_path,platform_role,department_label as department,branch_name,area_name,"position",designation_title,hire_date,employment_status,leave_count,attendance_present,expected_days,case when expected_days>0 then round(100.0*attendance_present/expected_days) end attendance_rate,kpi_completed,kpi_count,target_achieved,target_count from staff) x),
    'leave',(select coalesce(jsonb_agg(to_jsonb(x) order by end_date),'[]') from (
      -- Join on resolved_employee_id, NOT the raw employee_id column. A legacy
      -- request whose employee_id could not be backfilled is null there but is
      -- still resolvable via created_by, and joining on the raw column would
      -- silently drop it from the director's leave list.
      select l.id,l.resolved_employee_id as employee_id,e.full_name,public.department_label(e.department) as department,e."position",l.leave_type,l.start_date,l.end_date,l.status,greatest(0,l.end_date-current_date) days_remaining
      from leave_rows l join public.employees e on e.id=l.resolved_employee_id
      where l.status='approved' and l.start_date<=v_end and l.end_date>=v_start
      union all
      select l.id,l.resolved_employee_id as employee_id,e.full_name,public.department_label(e.department) as department,e."position",l.leave_type,l.start_date,l.end_date,l.status,0
      from leave_rows l join public.employees e on e.id=l.resolved_employee_id where l.status in ('pending','rejected') order by 1) x),
    'roles',(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)->>'role'),'[]') from (
      select platform_role role,count(*) staff,coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0) attendance_rate,
        coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0) kpi_completion,
        coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0) target_completion from staff group by platform_role) x),
    'trend',(select coalesce(jsonb_agg(to_jsonb(x) order by attendance_date),'[]') from (
      select d.attendance_date,coalesce(round(100.0*count(a.id) filter(where a.clock_in is not null)/nullif(count(s.id),0)),0) attendance_rate
      from range_days d cross join staff s left join attendance a on a.employee_id=s.id and a.attendance_date=d.attendance_date group by d.attendance_date) x),
    'loans',jsonb_build_object('status',jsonb_build_object(
      'count',(select count(*) from public.loans where coalesce(disbursed_date,created_at::date) between v_start and v_end),
      'principal',(select coalesce(sum(principal_amount),0) from public.loans where coalesce(disbursed_date,created_at::date) between v_start and v_end),
      'outstanding',(select coalesce(sum(outstanding_balance),0) from public.loans)))
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.get_director_employee_detail(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb;
begin
  if public.current_role() not in ('md_ceo','chairman','director','super_admin') or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;
  select jsonb_build_object(
    'profile',(select jsonb_build_object('id',e.id,'full_name',e.full_name,'department',public.department_label(e.department),'position',e."position",'designation',d.title,'branch',coalesce(b.branch_name,e.branch),'area',coalesce(e.area,a.area_name),'hire_date',e.hire_date,'status',e.employment_status,'role',coalesce(p.role,'staff')) from public.employees e left join public.profiles p on p.id=e.user_id left join public.branches b on b.id=e.branch_id left join public.designations d on d.id=e.designation_id left join public.branch_area_assignments baa on baa.branch_id=e.branch_id and baa.is_current left join public.areas a on a.id=baa.area_id where e.id=p_employee_id),
    'kpis',(select coalesce(jsonb_agg(to_jsonb(k) order by updated_at desc),'[]') from public.employee_kpis k where k.employee_id=p_employee_id),
    'targets',(select coalesce(jsonb_agg(to_jsonb(t) order by end_date desc),'[]') from public.targets t where t.employee_id=p_employee_id),
    'attendance',(select coalesce(jsonb_agg(to_jsonb(a) order by attendance_date desc),'[]') from (select * from public.attendance_records where employee_id=p_employee_id order by attendance_date desc limit 90) a),
    'leave',(select coalesce(jsonb_agg(to_jsonb(l) order by start_date desc),'[]') from public.leave_requests l left join public.employees e on e.user_id=l.created_by where coalesce(l.employee_id, e.id)=p_employee_id)
  ) into v_result;
  return coalesce(v_result,'{}'::jsonb);
end;
$$;

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

  select coalesce(default_working_days, array['mon','tue','wed','thu','fri'])
    into v_working_days
    from public.hr_platform_settings where id = 1;

  return lower(to_char(p_date, 'Dy')) = any (
    select lower(left(d, 3)) from unnest(v_working_days) d);
end;
$$;

-- Grants are re-asserted for the three reissued functions. create or replace
-- preserves them, but stating them again makes the intent explicit and keeps
-- the file safe to run against a database where they were never granted.
revoke all on function public.get_director_executive_snapshot(date,date,text,uuid,text,text,uuid,uuid) from public;
grant execute on function public.get_director_executive_snapshot(date,date,text,uuid,text,text,uuid,uuid) to authenticated;
revoke all on function public.get_director_employee_detail(uuid) from public;
grant execute on function public.get_director_employee_detail(uuid) to authenticated;
revoke all on function public.leave_is_working_day(date, uuid) from public;
grant execute on function public.leave_is_working_day(date, uuid) to authenticated;

-- ============================================================================
-- PART B - BOOKING TABLES + HR-CONFIGURABLE ELIGIBILITY WINDOW
-- ============================================================================

-- A link is a shareable URL key. Exactly the pattern the QR attendance terminal
-- already uses: the RAW token is returned to the browser exactly once, at
-- creation, and only its SHA-256 is ever stored - so a database leak cannot
-- hand out working links, and a lost link can simply be revoked and reissued.
create table if not exists public.leave_booking_links (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  token_hash text not null unique,
  token_preview text not null,
  is_active boolean not null default true,
  expires_on date,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null
);

comment on table public.leave_booking_links is
  'Shareable links an employee books PLANNED leave through. A booking is not a leave request. Only the SHA-256 of the key is stored; the raw key is shown once at creation.';

create index if not exists idx_leave_booking_links_active
  on public.leave_booking_links (is_active, created_at desc);

-- One row per employee's reserved period. Distinct from leave_requests on
-- purpose: this row cannot be approved, cannot be declined and does not enter
-- any approval chain until it is explicitly converted.
create table if not exists public.leave_bookings (
  id uuid primary key default gen_random_uuid(),
  link_id uuid references public.leave_booking_links(id) on delete set null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type text not null,
  start_date date not null,
  end_date date not null,
  working_days numeric(5,1) not null default 0,
  note text,
  status text not null default 'booked'
    check (status in ('booked','requested','cancelled')),
  leave_request_id uuid references public.leave_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint leave_bookings_dates_check check (end_date >= start_date)
);

comment on table public.leave_bookings is
  'A planned period reserved on the shared team calendar. NOT a leave request: it carries no approval state. status=''requested'' means the employee converted it into a real request through the normal chain.';

create index if not exists idx_leave_bookings_employee
  on public.leave_bookings (employee_id, start_date);
-- The planner's capacity engine reads active bookings across a date window.
create index if not exists idx_leave_bookings_window
  on public.leave_bookings (start_date, end_date)
  where status = 'booked';

-- The eligibility window: how far ahead of a booked start date the employee may
-- convert it into a real request. Stored as a VALUE + UNIT so HR reads "2 weeks
-- before" rather than a bare number of days they have to convert in their head.
alter table public.hr_platform_settings
  add column if not exists leave_booking_request_lead_value integer not null default 14;
alter table public.hr_platform_settings
  add column if not exists leave_booking_request_lead_unit text not null default 'days'
    check (leave_booking_request_lead_unit in ('days','weeks'));

comment on column public.hr_platform_settings.leave_booking_request_lead_value is
  'How far before a booked leave start date the "Request this leave" button becomes clickable. HR-configurable; enforced server-side on conversion.';

-- The window as a number of days, resolved in ONE place so the button, the
-- explanation and the server gate can never disagree.
create or replace function public.leave_booking_window_days()
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_value integer;
  v_unit text;
begin
  select leave_booking_request_lead_value, leave_booking_request_lead_unit
    into v_value, v_unit
    from public.hr_platform_settings where id = 1;

  if v_value is null then
    return 14;
  end if;
  if v_unit = 'weeks' then
    return greatest(v_value, 0) * 7;
  end if;
  return greatest(v_value, 0);
end;
$$;

comment on function public.leave_booking_window_days() is
  'Single authority for the booking-to-request eligibility window, in days. The UI renders it and the conversion gate enforces it from this one function.';

revoke all on function public.leave_booking_window_days() from public;
grant execute on function public.leave_booking_window_days() to authenticated;


-- ============================================================================
-- PART C - LINK MANAGEMENT (HR ONLY)
-- ============================================================================
-- Gated on the SAME permission the capacity rules use (leave.schedule.configure)
-- plus the HR roles, so this cannot be opened up more widely than the rest of
-- the leave configuration surface.

-- Create a link and return the raw key ONCE.
create or replace function public.create_leave_booking_link(
  p_label text,
  p_note text default null,
  p_expires_on date default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_raw text;
  v_id uuid;
begin
  if not (public.has_permission('leave.schedule.configure')
          or v_role in ('super_admin','admin','head_of_human_resources','hr_officer')) then
    raise exception 'LEAVE_CONFIG_FORBIDDEN:You cannot create leave booking links.';
  end if;

  if p_label is null or btrim(p_label) = '' then
    raise exception 'LINK_LABEL_REQUIRED:Give the link a name so you can recognise it later.';
  end if;

  -- pgcrypto lives in the `extensions` schema on Supabase, and this function
  -- pins search_path to public, so both calls MUST be schema-qualified. The
  -- bare names fail at runtime with "function does not exist".
  v_raw := encode(extensions.gen_random_bytes(24), 'hex');
  v_id := gen_random_uuid();

  insert into public.leave_booking_links
    (id, label, token_hash, token_preview, is_active, expires_on, note, created_by)
  values
    (v_id, btrim(p_label), encode(extensions.digest(v_raw, 'sha256'), 'hex'),
     left(v_raw, 8), true, p_expires_on, p_note, auth.uid());

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_BOOKING_LINK_CREATED', 'LeaveBookingLink', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('label', btrim(p_label), 'expires_on', p_expires_on, 'success', true)::text,
          'info');

  -- The raw key is returned here and never again: only its hash is stored.
  return jsonb_build_object(
    'ok', true, 'id', v_id, 'label', btrim(p_label),
    'token', v_raw, 'expires_on', p_expires_on);
end;
$$;

revoke all on function public.create_leave_booking_link(text, text, date) from public;
grant execute on function public.create_leave_booking_link(text, text, date) to authenticated;


-- List every link with live usage counts, so HR can see which ones staff are
-- actually using before revoking one.
create or replace function public.list_leave_booking_links()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
begin
  if not (public.has_permission('leave.schedule.configure')
          or v_role in ('super_admin','admin','head_of_human_resources','hr_officer')) then
    raise exception 'LEAVE_CONFIG_FORBIDDEN:You cannot view leave booking links.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'window_days', public.leave_booking_window_days(),
    'links', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select l.id, l.label, l.token_preview, l.is_active, l.expires_on,
               l.note, l.created_at, l.revoked_at,
               (l.expires_on is not null and l.expires_on < current_date) as is_expired,
               (select count(*) from public.leave_bookings b where b.link_id = l.id) as booking_count,
               (select count(*) from public.leave_bookings b
                 where b.link_id = l.id and b.status = 'booked') as active_booking_count,
               (select count(distinct b.employee_id) from public.leave_bookings b
                 where b.link_id = l.id) as employee_count,
               coalesce((select p.full_name from public.profiles p where p.id = l.created_by),
                        'Unknown') as created_by_name
          from public.leave_booking_links l
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.list_leave_booking_links() from public;
grant execute on function public.list_leave_booking_links() to authenticated;

-- Revoke. A revoked link stops accepting new bookings IMMEDIATELY; the
-- bookings already made through it are deliberately kept, because someone may
-- already be planning around them.
create or replace function public.revoke_leave_booking_link(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
begin
  if not (public.has_permission('leave.schedule.configure')
          or v_role in ('super_admin','admin','head_of_human_resources','hr_officer')) then
    raise exception 'LEAVE_CONFIG_FORBIDDEN:You cannot revoke leave booking links.';
  end if;

  update public.leave_booking_links
     set is_active = false, revoked_at = now(), revoked_by = auth.uid()
   where id = p_id and is_active;

  if not found then
    raise exception 'LINK_NOT_FOUND:That booking link is already closed or does not exist.';
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_BOOKING_LINK_REVOKED', 'LeaveBookingLink', p_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('link_id', p_id, 'success', true)::text, 'warning');

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.revoke_leave_booking_link(uuid) from public;
grant execute on function public.revoke_leave_booking_link(uuid) to authenticated;


-- HR-configurable eligibility window.
create or replace function public.save_leave_booking_window(
  p_value integer,
  p_unit text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
begin
  if not (public.has_permission('leave.schedule.configure')
          or v_role in ('super_admin','admin','head_of_human_resources','hr_officer')) then
    raise exception 'LEAVE_CONFIG_FORBIDDEN:You cannot change the booking eligibility window.';
  end if;

  if p_value is null or p_value < 0 or p_value > 365 then
    raise exception 'INVALID_WINDOW:Enter a number of days or weeks between 0 and 365.';
  end if;
  if p_unit is null or p_unit not in ('days','weeks') then
    raise exception 'INVALID_WINDOW_UNIT:Choose either days or weeks.';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'REASON_REQUIRED:Record why this window is being changed (at least 5 characters).';
  end if;

  update public.hr_platform_settings
     set leave_booking_request_lead_value = p_value,
         leave_booking_request_lead_unit = p_unit
   where id = 1;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_BOOKING_WINDOW_UPDATED', 'HrPlatformSettings', '1',
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('value', p_value, 'unit', p_unit,
                             'days', public.leave_booking_window_days(),
                             'reason', btrim(p_reason), 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'value', p_value, 'unit', p_unit,
                            'days', public.leave_booking_window_days());
end;
$$;

revoke all on function public.save_leave_booking_window(integer, text, text) from public;
grant execute on function public.save_leave_booking_window(integer, text, text) to authenticated;

-- Read the current window (any signed-in user, so the employee can be told the
-- real number rather than a guess).
create or replace function public.get_leave_booking_window()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_value integer;
  v_unit text;
begin
  select leave_booking_request_lead_value, leave_booking_request_lead_unit
    into v_value, v_unit
    from public.hr_platform_settings where id = 1;

  return jsonb_build_object(
    'ok', true,
    'value', coalesce(v_value, 14),
    'unit', coalesce(v_unit, 'days'),
    'days', public.leave_booking_window_days());
end;
$$;

revoke all on function public.get_leave_booking_window() from public;
grant execute on function public.get_leave_booking_window() to authenticated;


-- ============================================================================
-- PART D - THE EMPLOYEE SIDE
-- ============================================================================
-- The employee must be SIGNED IN: a booking is attached to one person, so an
-- anonymous "submit" would be a shared anonymous calendar entry. Signing in is
-- what makes the row attributable, and it is the same session the eventual
-- leave request is created from.

-- Resolve a link for display. Returns WHY a link is unusable rather than a
-- bare failure, so the page can say "this link was closed" instead of "error".
create or replace function public.get_leave_booking_link(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_link public.leave_booking_links;
begin
  if p_token is null or btrim(p_token) = '' then
    raise exception 'LINK_INVALID:That booking link is not valid.';
  end if;

  select * into v_link
    from public.leave_booking_links
   where token_hash = encode(extensions.digest(btrim(p_token), 'sha256'), 'hex');

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invalid',
      'message', 'This booking link is not valid. Please ask HR for a current link.');
  end if;

  if not v_link.is_active then
    return jsonb_build_object('ok', false, 'reason', 'revoked', 'label', v_link.label,
      'message', 'This booking link has been closed. Please ask HR for a current link.');
  end if;

  if v_link.expires_on is not null and v_link.expires_on < current_date then
    return jsonb_build_object('ok', false, 'reason', 'expired', 'label', v_link.label,
      'message', 'This booking link has expired. Please ask HR for a current link.');
  end if;

  return jsonb_build_object(
    'ok', true, 'id', v_link.id, 'label', v_link.label, 'note', v_link.note,
    'expires_on', v_link.expires_on, 'window_days', public.leave_booking_window_days());
end;
$$;

revoke all on function public.get_leave_booking_link(text) from public;
grant execute on function public.get_leave_booking_link(text) to authenticated;

-- Reserve planned dates. This is the ONLY thing a booking does, and the return
-- value says so in words the UI can show verbatim.
create or replace function public.submit_leave_booking(
  p_token text,
  p_leave_type text,
  p_start date,
  p_end date,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.leave_booking_links;
  v_emp record;
  v_id uuid;
  v_days numeric;
begin
  select * into v_emp
    from public.employees e
    join public.profiles p on p.id = e.user_id
   where p.id = auth.uid()
   limit 1;

  if not found then
    raise exception 'NO_EMPLOYEE_PROFILE:No employee record is linked to this account.';
  end if;

  if p_token is null or btrim(p_token) = '' then
    raise exception 'LINK_INVALID:That booking link is not valid.';
  end if;

  select * into v_link
    from public.leave_booking_links
   where token_hash = encode(extensions.digest(btrim(p_token), 'sha256'), 'hex');

  -- The link is re-checked here, not just in get_leave_booking_link: a link
  -- revoked while the form was open must not accept the submission.
  if not found then
    raise exception 'LINK_INVALID:This booking link is not valid.';
  end if;
  if not v_link.is_active then
    raise exception 'LINK_CLOSED:This booking link has been closed.';
  end if;
  if v_link.expires_on is not null and v_link.expires_on < current_date then
    raise exception 'LINK_EXPIRED:This booking link has expired.';
  end if;

  if p_leave_type is null or btrim(p_leave_type) = '' then
    raise exception 'LEAVE_TYPE_REQUIRED:Choose a leave type.';
  end if;
  if p_start is null or p_end is null then
    raise exception 'DATES_REQUIRED:Enter both a start and an end date.';
  end if;
  if p_end < p_start then
    raise exception 'INVALID_RANGE:The end date must be on or after the start date.';
  end if;

  -- One live booking per employee per period. Re-submitting the same dates is
  -- a no-op rather than a second row, so a refresh cannot double-book someone.
  if exists (
    select 1 from public.leave_bookings b
     where b.employee_id = v_emp.id
       and b.status = 'booked'
       and b.leave_type = btrim(p_leave_type)
       and b.start_date = p_start
       and b.end_date = p_end
  ) then
    raise exception 'ALREADY_BOOKED:You have already booked these exact dates.';
  end if;

  v_days := public.leave_working_days(p_start, p_end, v_emp.branch_id);
  v_id := gen_random_uuid();

  insert into public.leave_bookings
    (id, link_id, employee_id, leave_type, start_date, end_date, working_days, note)
  values
    (v_id, v_link.id, v_emp.id, btrim(p_leave_type), p_start, p_end, v_days,
     nullif(btrim(coalesce(p_note, '')), ''));

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_BOOKED', 'LeaveBooking', v_id::text, v_emp.full_name,
          jsonb_build_object('leave_type', btrim(p_leave_type), 'start', p_start,
                             'end', p_end, 'working_days', v_days,
                             'via_link', v_link.id, 'success', true)::text,
          'info');

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'leave_type', btrim(p_leave_type),
    'start_date', p_start, 'end_date', p_end, 'working_days', v_days,
    'window_days', public.leave_booking_window_days(),
    'notice', 'This reserves your planned dates on the team calendar - it is not a '
           || 'leave request. You will need to formally request this leave closer to the date.');
end;
$$;

revoke all on function public.submit_leave_booking(text, text, date, date, text) from public;
grant execute on function public.submit_leave_booking(text, text, date, date, text) to authenticated;


-- The employee's own bookings, with the window already resolved so the UI can
-- render the exact reason a button is disabled instead of a guess.
create or replace function public.get_my_leave_bookings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp record;
  v_window integer := public.leave_booking_window_days();
begin
  select e.* into v_emp
    from public.employees e
    join public.profiles p on p.id = e.user_id
   where p.id = auth.uid()
   limit 1;

  if not found then
    raise exception 'NO_EMPLOYEE_PROFILE:No employee record is linked to this account.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'window_days', v_window,
    'bookings', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.start_date)
      from (
        select b.id, b.leave_type, b.start_date, b.end_date, b.working_days,
               b.note, b.status, b.created_at, b.leave_request_id,
               (b.start_date - v_window) as opens_on,
               case
                 when b.status <> 'booked' then false
                 when current_date > b.end_date then false
                 else current_date >= (b.start_date - v_window)
               end as can_request,
               case
                 when b.status = 'requested' then 'Already turned into a leave request.'
                 when b.status = 'cancelled' then 'This booking was cancelled.'
                 when current_date > b.end_date then 'This booked period has already passed.'
                 when current_date >= (b.start_date - v_window)
                   then 'You can request this leave now.'
                 else 'You can request this leave from '
                      || to_char(b.start_date - v_window, 'DD Mon YYYY') || '.'
               end as status_message
          from public.leave_bookings b
         where b.employee_id = v_emp.id
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_my_leave_bookings() from public;
grant execute on function public.get_my_leave_bookings() to authenticated;

-- Convert a booking into a REAL leave request.
--
-- This writes the SAME leave_requests row the hand-typed form writes, with the
-- same status and the same approval_level/current_approval_level, so the request
-- lands in the one existing approval chain (get_leave_approval_chain_for_employee
-- -> process_leave_decision). Nothing about approval is re-implemented here.
--
-- The eligibility window is enforced HERE, server-side. A disabled button is only
-- a courtesy; this is the control.
create or replace function public.convert_leave_booking_to_request(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
  v_booking public.leave_bookings;
  v_window integer := public.leave_booking_window_days();
  v_request_id uuid;
  v_days integer;
begin
  select e.* into v_emp
    from public.employees e
    join public.profiles p on p.id = e.user_id
   where p.id = auth.uid()
   limit 1;

  if not found then
    raise exception 'NO_EMPLOYEE_PROFILE:No employee record is linked to this account.';
  end if;

  select * into v_booking
    from public.leave_bookings
   where id = p_booking_id and employee_id = v_emp.id;

  if not found then
    raise exception 'BOOKING_NOT_FOUND:That booking no longer exists.';
  end if;

  if v_booking.status <> 'booked' then
    raise exception 'BOOKING_NOT_PENDING:This booking has already been %',
      case v_booking.status when 'requested' then 'turned into a leave request'
                           else 'cancelled' end;
  end if;

  if current_date > v_booking.end_date then
    raise exception 'BOOKING_EXPIRED:This booked period has already passed.';
  end if;

  if current_date < (v_booking.start_date - v_window) then
    raise exception 'TOO_EARLY:You can request this leave from % (that is % day(s) before the booked start date).',
      to_char(v_booking.start_date - v_window, 'DD Mon YYYY'), v_window;
  end if;

  -- Calendar days, matching exactly what the hand-typed request form writes, so
  -- a converted request and a typed one are indistinguishable downstream.
  v_days := (v_booking.end_date - v_booking.start_date) + 1;
  v_request_id := gen_random_uuid();

  insert into public.leave_requests (
    id, employee_id, employee_name, leave_type, start_date, end_date, days,
    reason, status, approval_level, current_approval_level, stage_entered_at,
    is_cancellation, created_by, created_at
  ) values (
    v_request_id, v_emp.id, v_emp.full_name, v_booking.leave_type,
    v_booking.start_date, v_booking.end_date, v_days,
    coalesce(nullif(btrim(coalesce(v_booking.note, '')), ''),
             'Converted from a planned leave booking on the team calendar.'),
    'pending', 1, 1, now(),
    false, auth.uid(), now()
  );

  update public.leave_bookings
     set status = 'requested', leave_request_id = v_request_id
   where id = p_booking_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('LEAVE_BOOKING_CONVERTED', 'LeaveRequest', v_request_id::text, v_emp.full_name,
          jsonb_build_object('booking_id', p_booking_id, 'leave_type', v_booking.leave_type,
                             'start', v_booking.start_date, 'end', v_booking.end_date,
                             'days', v_days, 'success', true)::text,
          'info');

  return jsonb_build_object(
    'ok', true, 'leave_request_id', v_request_id, 'booking_id', p_booking_id,
    'status', 'pending');
end;
$$;

revoke all on function public.convert_leave_booking_to_request(uuid) from public;
grant execute on function public.convert_leave_booking_to_request(uuid) to authenticated;


-- ============================================================================
-- PART E - PLANNER READS BOOKINGS
-- ============================================================================
-- The timeline and the capacity heatmap now include planned bookings, tagged
-- source='booking' with their own planner_state, so HR sees coming team
-- coverage before anyone has formally requested anything. The capacity VERDICT
-- still counts approved leave only: a booking is a plan, not a decision, and
-- must never manufacture a staffing breach on its own.

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
           coalesce(lr.end_date, lr.start_date) as effective_end,
           'request' as source, null::uuid as booking_id
      from scoped s
      join public.leave_requests lr
        on coalesce(lr.employee_id,
             (select e7.id from public.employees e7 where e7.user_id = lr.created_by)) = s.employee_id
     where lr.status in ('approved','pending')
       and (p_status is null or lr.status = p_status)
       and (p_leave_type is null or lr.leave_type = p_leave_type)
       and daterange(lr.start_date, coalesce(lr.end_date, lr.start_date), '[]')
           && daterange(p_from, p_to, '[]')
    union all
    -- Planned periods reserved on the shared calendar. These are NOT requests:
    -- they carry no approval state and cannot be approved from this screen, so
    -- they are tagged source='booking' and drawn in their own state.
    select s.employee_id, s.full_name, s.employee_number, s.position,
           s.department, s.branch_id, s.branch_name,
           null::uuid as request_id, b.leave_type, 'booked' as status,
           b.start_date, b.end_date, b.end_date as effective_end,
           'booking' as source, b.id as booking_id
      from scoped s
      join public.leave_bookings b on b.employee_id = s.employee_id
     where b.status = 'booked'
       and (p_status is null or p_status = 'booked')
       and (p_leave_type is null or b.leave_type = p_leave_type)
       and daterange(b.start_date, b.end_date, '[]') && daterange(p_from, p_to, '[]')
  )
  select coalesce(jsonb_agg(to_jsonb(en) order by en.full_name, en.start_date), '[]')
    into v_legend
    from (
      select e2.employee_id, e2.full_name, e2.employee_number, e2.position,
             e2.department, e2.branch_id, e2.branch_name,
             e2.request_id, e2.leave_type, e2.status, e2.start_date, e2.end_date,
             e2.source, e2.booking_id,
             public.leave_working_days(e2.start_date, e2.effective_end, e2.branch_id) as working_days,
             case
               when e2.source = 'booking' then 'booked'
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
    'booked', count(*) filter (where l->>'planner_state' = 'booked'),
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
  ),
  booked as (
    select e.branch_id, (b.start_date + o)::date as day
      from public.leave_bookings b
      join public.employees e on e.id = b.employee_id
      cross join lateral generate_series(0, b.end_date - b.start_date) o
     where b.status = 'booked'
  ),
  -- Pre-aggregated before the join: joining two day-grain sets to the same
  -- branch would otherwise multiply the counts against each other.
  on_leave_agg as (
    select branch_id, day, count(*)::int as cnt from on_leave group by branch_id, day
  ),
  booked_agg as (
    select branch_id, day, count(*)::int as cnt from booked group by branch_id, day
  )
  select coalesce(jsonb_agg(to_jsonb(h) order by h.branch_name, h.day), '[]')
    into v_capacity
    from (
      select pb.branch_id, pb.branch_name, d.day,
             coalesce(ola.cnt, 0)::int as on_leave_count,
             coalesce(bka.cnt, 0)::int as booked_count,
             (coalesce(ola.cnt, 0) + coalesce(bka.cnt, 0))::int as total_planned_count,
             pb.headcount,
             r.max_people_on_leave as configured_capacity,
             (r.id is not null
              and r.max_people_on_leave is not null
              and coalesce(ola.cnt, 0) > r.max_people_on_leave) as is_conflict
        from per_branch pb
        cross join days d
        left join on_leave_agg ola on ola.branch_id = pb.branch_id and ola.day = d.day
        left join booked_agg bka on bka.branch_id = pb.branch_id and bka.day = d.day
        left join public.leave_capacity_rules r
          on r.scope_type = 'branch' and r.branch_id = pb.branch_id
         and r.is_active and not r.is_template
         and d.day >= coalesce(r.effective_from, d.day - 1)
         and d.day <= coalesce(r.effective_to, d.day + 1)
       group by pb.branch_id, pb.branch_name, d.day, pb.headcount,
                r.id, r.max_people_on_leave, coalesce(ola.cnt, 0), coalesce(bka.cnt, 0)
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

revoke all on function public.get_leave_planner(date,date,text,uuid,text,text,uuid,text,text) from public;
grant execute on function public.get_leave_planner(date,date,text,uuid,text,text,uuid,text,text) to authenticated;

commit;
