-- Director executive intelligence — additive extension of the existing SPA + hosted Supabase.
-- Run after 20260923000003. Idempotent and transaction-wrapped.
-- The browser receives aggregates/details only through the guarded RPCs below.
begin;

-- The hosted legacy schema can contain a repayments table created before the
-- canonical payment_date field was introduced. Existing Repayments UI already
-- writes this field, so restore the intended additive column. Historical rows
-- remain NULL rather than receiving a fabricated payment date.
alter table public.repayments
  add column if not exists payment_date date;


alter table public.permissions drop constraint if exists permissions_category_check;
alter table public.permissions add constraint permissions_category_check check (
  category in (
    'customers','loans','documents','hr','admin','support','reports','branches','bankone',
    'reconciliation','performance','appraisal','hr_config','hr_org','workforce','attendance',
    'payroll','messaging','communications','sara','training','medical','work','settings',
    'users','data','administration','leave','onboarding','director'
  )
);

insert into public.roles (role_name, display_name, description, is_system_role, color, icon)
values ('director', 'Director', 'Read-only executive intelligence across the entire bank', true, '#0f172a', 'crown')
on conflict (role_name) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  is_system_role = true,
  color = excluded.color,
  icon = excluded.icon;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in (
  'super_admin','admin','director','head_of_business','area_manager','branch_manager',
  'head_of_operations','head_of_e_business','financial_controller',
  'head_of_risk_compliance','head_of_legal','head_of_audit',
  'loan_officer','relationship_manager','customer_service',
  'head_of_human_resources','hr_officer','staff','customer'
));

select public.seed_permission(
  'director.executive.read',
  'Read the server-aggregated Director executive intelligence workspace',
  'director', 'executive', 'read', true, 'director'
);
select public.seed_role_permission('director', 'director.executive.read');
select public.seed_role_permission('super_admin', 'director.executive.read');

create or replace function public.enforce_role_change_policy()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  promoter_roles text[] := array['super_admin','admin','head_of_human_resources','area_manager','branch_manager'];
  management_roles text[] := array[
    'director','area_manager','head_of_business','head_of_operations',
    'head_of_e_business','financial_controller','head_of_risk_compliance','head_of_legal','head_of_audit'
  ];
begin
  if new.role is distinct from old.role then
    if not (actor_role = any(promoter_roles)) then
      raise exception 'Not authorized to change roles (actor role: %)', actor_role;
    end if;
    if new.role = 'super_admin' and actor_role <> 'super_admin' then
      raise exception 'Only super_admin can assign the super_admin role';
    end if;
    if new.role in ('super_admin','admin','director') and actor_role not in ('super_admin','admin') then
      raise exception 'Only super_admin or admin can assign the % role', new.role;
    end if;
    if new.role = any(management_roles) and actor_role not in ('super_admin','admin') then
      raise exception 'Only super_admin or admin can assign this role';
    end if;
    if actor_role = 'branch_manager' and new.role not in ('staff','loan_officer','relationship_manager','customer_service') then
      raise exception 'Branch Manager is not authorized to assign this role';
    end if;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('user_role_changed','User',new.id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()),auth.uid()::text),
      format('%s: %s -> %s',coalesce(new.email,new.id::text),old.role,new.role),'critical');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_role_change on public.profiles;
create trigger trg_enforce_role_change before update on public.profiles
for each row execute function public.enforce_role_change_policy();

-- Server-side read model. Metrics and filters are calculated from canonical tables.
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
  if public.current_role() not in ('director','super_admin')
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
      'departments',(select coalesce(jsonb_agg(jsonb_build_object('id',department,'name',department) order by department),'[]') from (select distinct department from public.employees where nullif(department,'') is not null) x),
      'branches',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',branch_name) order by branch_name),'[]') from public.branches where coalesce(status,'active')='active'),
      'areas',(select coalesce(jsonb_agg(jsonb_build_object('id',area_code,'name',coalesce(area_name,area_code)) order by area_code),'[]') from public.areas where is_active),
      'roles',(select coalesce(jsonb_agg(jsonb_build_object('id',role,'name',role) order by role),'[]') from (select distinct role from public.profiles) x),
      'designations',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',title,'department',department) order by title,department),'[]') from public.designations where is_active),
      'employees',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.full_name,'department',e.department,'branch',b.branch_name) order by e.full_name),'[]') from public.employees e left join public.branches b on b.id=e.branch_id)
    ),
    'departments',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',coalesce(nullif(department,''),'Unassigned'),'name',coalesce(nullif(department,''),'Unassigned'),'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0),'completion_rate',coalesce(round((sum(attendance_present)+sum(kpi_completed)+sum(target_achieved))*100.0/nullif(sum(expected_days)+sum(kpi_count)+sum(target_count),0)),0)) x
      from staff group by coalesce(nullif(department,''),'Unassigned')) x),
    'branches',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',coalesce(branch_name,'Unassigned'),'name',coalesce(branch_name,'Unassigned'),'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0)) x
      from staff group by coalesce(branch_name,'Unassigned')) x),
    'areas',(select coalesce(jsonb_agg(x order by (x->>'total_staff')::int desc),'[]') from (
      select jsonb_build_object('id',coalesce(area_name,'Unassigned'),'name',coalesce(area_name,'Unassigned'),'total_staff',count(*),'active_staff',count(*) filter(where employment_status='active'),'attendance_rate',coalesce(round(100.0*sum(attendance_present)/nullif(sum(expected_days),0)),0),'kpi_completion',coalesce(round(100.0*sum(kpi_completed)/nullif(sum(kpi_count),0)),0),'target_completion',coalesce(round(100.0*sum(target_achieved)/nullif(sum(target_count),0)),0),'on_leave',count(*) filter(where leave_count>0)) x
      from staff group by coalesce(area_name,'Unassigned')) x),
    'staff',(select coalesce(jsonb_agg(to_jsonb(x) order by full_name),'[]') from (select id,user_id,full_name,profile_picture_path,platform_role,department,branch_name,area_name,"position",designation_title,hire_date,employment_status,leave_count,attendance_present,expected_days,case when expected_days>0 then round(100.0*attendance_present/expected_days) end attendance_rate,kpi_completed,kpi_count,target_achieved,target_count from staff) x),
    'leave',(select coalesce(jsonb_agg(to_jsonb(x) order by end_date),'[]') from (
      select l.id,l.employee_id,e.full_name,e.department,e."position",l.leave_type,l.start_date,l.end_date,l.status,greatest(0,l.end_date-current_date) days_remaining
      from leave_rows l join public.employees e on e.id=l.employee_id
      where l.status='approved' and l.start_date<=v_end and l.end_date>=v_start
      union all
      select l.id,l.employee_id,e.full_name,e.department,e."position",l.leave_type,l.start_date,l.end_date,l.status,0
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

-- Employee drill-down loads history only for the selected person.
create or replace function public.get_director_employee_detail(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_result jsonb;
begin
  if public.current_role() not in ('director','super_admin') or not public.has_permission('director.executive.read') then
    raise exception 'insufficient_permissions: director.executive.read';
  end if;
  select jsonb_build_object(
    'profile',(select jsonb_build_object('id',e.id,'full_name',e.full_name,'department',e.department,'position',e."position",'designation',d.title,'branch',coalesce(b.branch_name,e.branch),'area',coalesce(e.area,a.area_name),'hire_date',e.hire_date,'status',e.employment_status,'role',coalesce(p.role,'staff')) from public.employees e left join public.profiles p on p.id=e.user_id left join public.branches b on b.id=e.branch_id left join public.designations d on d.id=e.designation_id left join public.branch_area_assignments baa on baa.branch_id=e.branch_id and baa.is_current left join public.areas a on a.id=baa.area_id where e.id=p_employee_id),
    'kpis',(select coalesce(jsonb_agg(to_jsonb(k) order by updated_at desc),'[]') from public.employee_kpis k where k.employee_id=p_employee_id),
    'targets',(select coalesce(jsonb_agg(to_jsonb(t) order by end_date desc),'[]') from public.targets t where t.employee_id=p_employee_id),
    'attendance',(select coalesce(jsonb_agg(to_jsonb(a) order by attendance_date desc),'[]') from (select * from public.attendance_records where employee_id=p_employee_id order by attendance_date desc limit 90) a),
    'leave',(select coalesce(jsonb_agg(to_jsonb(l) order by start_date desc),'[]') from public.leave_requests l join public.employees e on e.user_id=l.created_by where e.id=p_employee_id)
  ) into v_result;
  return coalesce(v_result,'{}'::jsonb);
end;
$$;
revoke all on function public.get_director_employee_detail(uuid) from public;
grant execute on function public.get_director_employee_detail(uuid) to authenticated;

create index if not exists idx_director_kpis_employee_period on public.employee_kpis(employee_id, coalesce(updated_at,created_at));
create index if not exists idx_director_targets_employee_dates on public.targets(employee_id, start_date, end_date);
create index if not exists idx_director_leave_employee_dates on public.leave_requests(created_by, start_date, end_date);

commit;

