-- ===========================================================================
-- Director Intelligence: repair "record ->> unknown" in the roles aggregate.
--
-- Run in Supabase SQL Editor AFTER 20260924000004. Transaction-wrapped and
-- idempotent. No data is inserted, updated, or deleted.
--
-- Root cause: the 'roles' entry of get_director_executive_snapshot aggregated a
-- FOUR-column subquery aliased "x" (platform_role, staff, attendance_rate,
-- kpi_completion, target_completion) and then applied the jsonb "->>" operator to
-- the bare identifier "x". A bare identifier that names a multi-column subquery
-- alias resolves to the whole row, whose type is "record" -- and PostgreSQL has
-- no "record ->> text" operator. Every authenticated call to the RPC therefore
-- failed with:
--
--   ERROR: operator does not exist: record ->> unknown
--   LINE: ... 'roles',(select coalesce(jsonb_agg(x order by x->>'role')...
--
-- Note this is NOT the same defect as 20260924000004 (json || jsonb). Both
-- statements lived in the same function, so fixing one exposed the other.
--
-- The sibling 'departments' / 'branches' / 'areas' aggregates are NOT affected:
-- their subqueries project a single jsonb column, so a bare "x" there resolves to
-- that column rather than to a record. Only the multi-column 'roles'
-- subquery triggers the whole-row expansion.
--
-- Fix: wrap the row in to_jsonb(x) so the operator receives jsonb, matching the
-- pattern already used by the 'staff', 'leave' and 'trend' aggregates in the
-- same function. Output shape is unchanged -- each element is still an object
-- with role/staff/attendance_rate/kpi_completion/target_completion keys, now
-- sorted by the role name.
--
-- The function is reissued verbatim from 20260924000003 apart from this one
-- expression. CREATE OR REPLACE preserves the function owner, grants,
-- volatility, security definer flag and search_path, and re-emitting the grants
-- is a no-op, so this repair is independent of whether 20260924000004 was
-- applied.
-- ===========================================================================
begin;

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
    select lr.*, e.id employee_id from public.leave_requests lr join public.employees e on e.user_id=lr.created_by where e.id in (select id from ids)
  ), staff as (
    select s.*,
      (select count(*) from attendance a where a.employee_id=s.id and a.clock_in is not null)::int attendance_present,
      (select count(*) from previous_attendance a where a.employee_id=s.id and a.clock_in is not null)::int previous_attendance_present,
      (select count(*) from range_days)::int expected_days,
      (select count(*) from kpis k where k.employee_id=s.id)::int kpi_count,
      (select count(*) from kpis k where k.employee_id=s.id and k.status in ('completed','acknowledged'))::int kpi_completed,
      (select count(*) from targets t where t.employee_id=s.id)::int target_count,
      (select count(*) from targets t where t.employee_id=s.id and t.status='achieved')::int target_achieved,
      (select count(*) from leave_rows l where l.employee_id=s.id and l.status='approved' and l.start_date<=v_end and l.end_date>=v_start)::int leave_count
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
      select l.id,l.employee_id,e.full_name,public.department_label(e.department) as department,e."position",l.leave_type,l.start_date,l.end_date,l.status,greatest(0,l.end_date-current_date) days_remaining
      from leave_rows l join public.employees e on e.id=l.employee_id
      where l.status='approved' and l.start_date<=v_end and l.end_date>=v_start
      union all
      select l.id,l.employee_id,e.full_name,public.department_label(e.department) as department,e."position",l.leave_type,l.start_date,l.end_date,l.status,0
      from leave_rows l join public.employees e on e.id=l.employee_id where l.status in ('pending','rejected') order by 1) x),
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

revoke all on function public.get_director_executive_snapshot(date,date,text,uuid,text,text,uuid,uuid) from public;
grant execute on function public.get_director_executive_snapshot(date,date,text,uuid,text,text,uuid,uuid) to authenticated;


commit;
