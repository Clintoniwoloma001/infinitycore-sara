-- ============================================================
-- PHASE 50 — AWARE DASHBOARD + SELF-SCOPED ONBOARDING STATUS
--
-- Dashboard reads are intentionally server-side. Filter values supplied by
-- the browser are validated against the authenticated user's role and actual
-- branch/area relationship before any rows are returned.
--
-- Additive and idempotent. Run after the HR, branch, attendance, leave,
-- workforce, and onboarding migrations.
-- ============================================================

-- Employees must be able to see the workflow status of their own submission.
drop policy if exists "onboarding_subs_read" on public.employee_onboarding_submissions;
create policy "onboarding_subs_read" on public.employee_onboarding_submissions
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    or employee_id in (select e.id from public.employees e where e.user_id = auth.uid())
  );

-- ------------------------------------------------------------
-- Self onboarding status. The workflow column remains the source of truth;
-- state is only a read-model for the employee-facing UI.
-- ------------------------------------------------------------
create or replace function public.get_my_onboarding_status()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_employee public.employees%rowtype;
  v_submission record;
  v_completion jsonb;
  v_progress integer := 0;
  v_workflow_status text;
  v_state text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_employee
  from public.employees
  where user_id = auth.uid()
  order by created_at desc
  limit 1;

  if v_employee.id is null then
    return jsonb_build_object(
      'state', 'not_started', 'progress_pct', 0, 'completion_pct', 0,
      'missing_fields', '[]'::jsonb, 'employee_id', null,
      'workflow_status', null
    );
  end if;

  v_completion := public.get_employee_completion(v_employee.id);
  v_progress := greatest(0, least(100, coalesce((v_completion ->> 'completion_pct')::integer, 0)));

  select s.onboarding_status, s.status, s.submitted_at, s.reviewed_at, s.created_at
    into v_submission
  from public.employee_onboarding_submissions s
  where s.employee_id = v_employee.id
  order by s.created_at desc
  limit 1;

  v_workflow_status := coalesce(v_submission.onboarding_status, v_submission.status);
  if v_workflow_status in ('approved', 'completed') or coalesce((v_completion ->> 'is_complete')::boolean, false) then
    v_state := 'completed';
    v_progress := 100;
  elsif v_workflow_status in ('submitted', 'under_review', 'pending_guarantor', 'guarantor_submitted') then
    v_state := 'pending_review';
  elsif v_progress > 0 or v_workflow_status in ('correction_requested', 'rejected') then
    v_state := 'in_progress';
  else
    v_state := 'not_started';
  end if;

  return jsonb_build_object(
    'state', v_state,
    'progress_pct', v_progress,
    'completion_pct', v_progress,
    'missing_fields', coalesce(v_completion -> 'missing_fields', '[]'::jsonb),
    'employee_id', v_employee.id,
    'workflow_status', v_workflow_status,
    'employee', jsonb_build_object(
      'id', v_employee.id,
      'full_name', v_employee.full_name,
      'department', v_employee.department,
      'position', v_employee."position",
      'branch', v_employee.branch,
      'branch_id', v_employee.branch_id,
      'area', v_employee.area,
      'employment_status', v_employee.employment_status,
      'employee_number', v_employee.employee_number,
      'staff_id', v_employee.staff_id
    ),
    'submission', case when v_submission.created_at is null then null else jsonb_build_object(
      'status', v_submission.status,
      'onboarding_status', v_submission.onboarding_status,
      'submitted_at', v_submission.submitted_at,
      'reviewed_at', v_submission.reviewed_at
    ) end
  );
end;
$$;

revoke all on function public.get_my_onboarding_status() from public;
grant execute on function public.get_my_onboarding_status() to authenticated;

-- ------------------------------------------------------------
-- Filter options. This is an authorized option list, not a raw employees
-- table read. Branch/area managers receive only their real scope.
-- ------------------------------------------------------------
create or replace function public.get_dashboard_filter_options(
  p_branch_id uuid default null,
  p_department text default null,
  p_area text default null
)
returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_org_scope boolean := false;
  v_branch_scope uuid;
  v_area_scope text;
  v_employee_scope uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_me from public.employees where user_id = auth.uid() order by created_at desc limit 1;
  v_org_scope := v_role in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_business')
    or upper(trim(coalesce(v_me."position", ''))) in ('MD', 'MD/CEO');

  if v_role = 'branch_manager' then
    v_branch_scope := v_me.branch_id;
    if p_branch_id is not null and p_branch_id is distinct from v_branch_scope then
      raise exception 'Not authorized for this branch';
    end if;
    if v_branch_scope is null then v_employee_scope := v_me.id; end if;
  elsif v_role = 'area_manager' then
    v_area_scope := v_me.area;
    if p_area is not null and lower(p_area) <> lower(coalesce(v_area_scope, '')) then
      raise exception 'Not authorized for this area';
    end if;
    if v_area_scope is null then v_employee_scope := v_me.id; end if;
  elsif not v_org_scope then
    v_employee_scope := v_me.id;
  end if;

  return jsonb_build_object(
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'branch_name', b.branch_name, 'branch_code', b.branch_code) order by b.branch_name)
      from public.branches b
      where b.status = 'active'
        and (v_org_scope or v_me.id is not null)
        and (v_branch_scope is null or b.id = v_branch_scope)
        and (v_area_scope is null or exists (
          select 1 from public.branch_area_assignments baa
          join public.areas a on a.id = baa.area_id
          where baa.branch_id = b.id and baa.is_current and lower(a.area_code) = lower(v_area_scope)
        ))
    ), '[]'::jsonb),
    'areas', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'area_code', a.area_code, 'area_name', a.area_name) order by a.area_code)
      from public.areas a
      where a.is_active
        and (v_org_scope or v_me.id is not null)
        and (v_area_scope is null or lower(a.area_code) = lower(v_area_scope))
        and (v_branch_scope is null or exists (
          select 1 from public.branch_area_assignments baa
          where baa.area_id = a.id and baa.branch_id = v_branch_scope and baa.is_current
        ))
    ), '[]'::jsonb),
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.name, 'name', x.name) order by x.name)
      from (
      select distinct coalesce(nullif(trim(e.department), ''), 'Unassigned') as name
        from public.employees e
        where coalesce(e.is_archived, false) = false
          and (v_org_scope or v_me.id is not null)
          and (v_employee_scope is null or e.id = v_employee_scope)
          and (v_branch_scope is null or e.branch_id = v_branch_scope)
          and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope))
          and (p_branch_id is null or e.branch_id = p_branch_id)
          and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area))
      ) x
    ), '[]'::jsonb),
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'full_name', x.full_name, 'department', x.department,
        'branch_id', x.branch_id, 'branch', x.branch, 'area', x.area
      ) order by x.full_name)
      from (
        select e.id, e.full_name, e.department, e.branch_id, e.branch, e.area
        from public.employees e
        where coalesce(e.is_archived, false) = false
          and (v_org_scope or v_me.id is not null)
          and (v_employee_scope is null or e.id = v_employee_scope)
          and (v_branch_scope is null or e.branch_id = v_branch_scope)
          and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope))
          and (p_branch_id is null or e.branch_id = p_branch_id)
          and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department))
          and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area))
        order by e.full_name
        limit 500
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_dashboard_filter_options(uuid, text, text) from public;
grant execute on function public.get_dashboard_filter_options(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- Dashboard snapshot. All sensitive filtering happens here, never in the
-- browser. The returned values are aggregates or the selected employee's
-- permitted detail, not the underlying organization-wide tables.
-- ------------------------------------------------------------
create or replace function public.get_dashboard_snapshot(
  p_branch_id uuid default null,
  p_department text default null,
  p_employee_id uuid default null,
  p_area text default null,
  p_start_date date default null,
  p_end_date date default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_org_scope boolean := false;
  v_scope text := 'management';
  v_branch_scope uuid;
  v_area_scope text;
  v_employee_id uuid := p_employee_id;
  v_ids uuid[] := '{}'::uuid[];
  v_start date := coalesce(p_start_date, current_date - 30);
  v_end date := coalesce(p_end_date, current_date);
  v_late_count integer := 0;
  v_pending_leave integer := 0;
  v_below_kpi integer := 0;
  v_overdue_tasks integer := 0;
  v_onboarding_pending integer := 0;
  v_onboarding_complete integer := 0;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_me from public.employees where user_id = auth.uid() order by created_at desc limit 1;
  v_org_scope := v_role in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_business')
    or upper(trim(coalesce(v_me."position", ''))) in ('MD', 'MD/CEO');

  if v_role = 'branch_manager' then
    v_branch_scope := v_me.branch_id;
    if p_branch_id is not null and p_branch_id is distinct from v_branch_scope then raise exception 'Not authorized for this branch'; end if;
    if v_branch_scope is null then v_employee_id := v_me.id; end if;
  elsif v_role = 'area_manager' then
    v_area_scope := v_me.area;
    if p_area is not null and lower(p_area) <> lower(coalesce(v_area_scope, '')) then raise exception 'Not authorized for this area'; end if;
    if v_area_scope is null then v_employee_id := v_me.id; end if;
  elsif not v_org_scope then
    v_scope := 'self';
    v_employee_id := v_me.id;
    v_branch_scope := null;
    v_area_scope := null;
  end if;

  if v_scope = 'management' and v_employee_id is null and v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_business')
     and upper(trim(coalesce(v_me."position", ''))) not in ('MD', 'MD/CEO') then
    v_scope := 'self';
    v_employee_id := v_me.id;
  end if;

  select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids
  from public.employees e
  where coalesce(e.is_archived, false) = false
    and (v_org_scope or v_me.id is not null)
    and (v_employee_id is null or e.id = v_employee_id)
    and (v_branch_scope is null or e.branch_id = v_branch_scope)
    and (p_branch_id is null or e.branch_id = p_branch_id)
    and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope)
      or exists (
        select 1 from public.branch_area_assignments baa
        join public.areas a on a.id = baa.area_id
        where baa.branch_id = e.branch_id and baa.is_current and lower(a.area_code) = lower(v_area_scope)
      ))
    and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area))
    and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department));

  select count(*) into v_late_count
  from public.attendance_records ar where ar.employee_id = any(v_ids)
    and ar.attendance_date between v_start and v_end
    and (coalesce(ar.late_minutes, 0) > 0 or ar.status = 'late');
  select count(*) into v_pending_leave
  from public.leave_requests lr
  where lr.created_by in (select e.user_id from public.employees e where e.id = any(v_ids) and e.user_id is not null)
    and lr.status = 'pending';
  select count(*) into v_below_kpi
  from public.employee_kpis k where k.employee_id = any(v_ids)
    and k.target_value <> 0 and coalesce(k.actual_value, 0) < k.target_value;
  select count(*) into v_overdue_tasks
  from public.work_tasks wt where wt.employee_id = any(v_ids)
    and wt.due_date < current_date and wt.status not in ('completed', 'cancelled', 'submitted');
  select count(distinct s.employee_id) into v_onboarding_pending
  from public.employee_onboarding_submissions s
  where s.employee_id = any(v_ids)
    and s.onboarding_status in ('submitted', 'under_review', 'pending_guarantor', 'guarantor_submitted', 'correction_requested');
  select count(distinct s.employee_id) into v_onboarding_complete
  from public.employee_onboarding_submissions s
  where s.employee_id = any(v_ids) and s.onboarding_status in ('approved', 'completed');

  return jsonb_build_object(
    'scope', v_scope,
    'filtering_allowed', v_org_scope,
    'viewer', jsonb_build_object('role', v_role, 'user_id', auth.uid()),
    'employee', case when v_scope = 'self' then jsonb_build_object(
      'id', v_me.id, 'full_name', v_me.full_name, 'email', v_me.email,
      'department', v_me.department, 'position', v_me."position", 'branch', v_me.branch,
      'branch_id', v_me.branch_id, 'area', v_me.area, 'employment_status', v_me.employment_status,
      'employee_number', v_me.employee_number, 'staff_id', v_me.staff_id
    ) else null end,
    'selected_employee', case when v_scope = 'management' and v_employee_id is not null then (
      select jsonb_build_object(
        'id', e.id, 'full_name', e.full_name, 'email', e.email, 'department', e.department,
        'position', e."position", 'branch', e.branch, 'branch_id', e.branch_id, 'area', e.area,
        'employment_status', e.employment_status, 'employee_number', e.employee_number, 'staff_id', e.staff_id
      ) from public.employees e where e.id = v_employee_id and e.id = any(v_ids)
    ) else null end,
    'headcount', jsonb_build_object(
      'total', cardinality(v_ids),
      'active', (select count(*) from public.employees e where e.id = any(v_ids) and e.employment_status = 'active'),
      'on_leave', (select count(*) from public.employees e where e.id = any(v_ids) and e.employment_status = 'on_leave'),
      'terminated', (select count(*) from public.employees e where e.id = any(v_ids) and e.employment_status = 'terminated'),
      'unconfirmed', (select count(*) from public.employees e where e.id = any(v_ids) and e.confirmation_status = 'UNCONFIRMED')
    ),
    'onboarding', case when v_scope = 'self' then public.get_my_onboarding_status() else jsonb_build_object(
      'complete', v_onboarding_complete, 'pending_review', v_onboarding_pending,
      'not_started', greatest(cardinality(v_ids) - v_onboarding_complete - v_onboarding_pending, 0)
    ) end,
    'attendance', jsonb_build_object(
      'records', (select count(*) from public.attendance_records ar where ar.employee_id = any(v_ids) and ar.attendance_date between v_start and v_end),
      'present', (select count(*) from public.attendance_records ar where ar.employee_id = any(v_ids) and ar.attendance_date between v_start and v_end and ar.clock_in is not null),
      'late', v_late_count,
      'open_sessions', (select count(*) from public.attendance_records ar where ar.employee_id = any(v_ids) and ar.clock_in is not null and ar.clock_out is null),
      'issues_pending', (select count(*) from public.attendance_issues ai where ai.employee_id = any(v_ids) and ai.status = 'pending'),
      'exceptions_pending', (select count(*) from public.attendance_exceptions ae where ae.employee_id = any(v_ids) and ae.status = 'pending')
    ),
    'attendance_recent', case when v_scope = 'self' then coalesce((
      select jsonb_agg(to_jsonb(ar) order by ar.attendance_date desc)
      from (
        select id, attendance_date, clock_in, clock_out, work_hours, status, late_minutes
        from public.attendance_records
        where employee_id = v_me.id
        order by attendance_date desc
        limit 5
      ) ar
    ), '[]'::jsonb) else '[]'::jsonb end,
    'leave', jsonb_build_object(
      'pending', v_pending_leave,
      'approved_recent', (select count(*) from public.leave_requests lr where lr.created_by in (select e.user_id from public.employees e where e.id = any(v_ids) and e.user_id is not null) and lr.status = 'approved' and lr.created_at >= v_start)
    ),
    'performance', jsonb_build_object(
      'kpi_count', (select count(*) from public.employee_kpis k where k.employee_id = any(v_ids)),
      'below_target', v_below_kpi,
      'avg_achievement', (select round(avg((coalesce(k.actual_value, 0) / nullif(k.target_value, 0) * 100))::numeric, 1) from public.employee_kpis k where k.employee_id = any(v_ids) and k.target_value <> 0)
    ),
    'work', jsonb_build_object(
      'pending', (select count(*) from public.work_tasks wt where wt.employee_id = any(v_ids) and wt.status in ('assigned', 'accepted', 'in_progress')),
      'submitted', (select count(*) from public.work_tasks wt where wt.employee_id = any(v_ids) and wt.status in ('submitted', 'under_review')),
      'overdue', v_overdue_tasks,
      'completed', (select count(*) from public.work_tasks wt where wt.employee_id = any(v_ids) and wt.status = 'completed')
    ),
    'recruitment', case when v_role in ('super_admin', 'admin', 'hr_manager', 'hr_officer') or upper(trim(coalesce(v_me."position", ''))) in ('MD', 'MD/CEO') then jsonb_build_object(
      'total', (select count(*) from public.hr_candidates),
      'active', (select count(*) from public.hr_candidates where application_status not in ('hired', 'rejected', 'withdrawn'))
    ) else null end,
    'branch_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('branch', x.branch_name, 'employees', x.employee_count, 'active', x.active_count) order by x.branch_name)
      from (
        select coalesce(b.branch_name, e.branch, 'Unassigned') branch_name, count(*) employee_count,
          count(*) filter (where e.employment_status = 'active') active_count
        from public.employees e left join public.branches b on b.id = e.branch_id
        where e.id = any(v_ids) group by coalesce(b.branch_name, e.branch, 'Unassigned')
      ) x
    ), '[]'::jsonb),
    'department_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('department', x.department, 'employees', x.employee_count, 'active', x.active_count) order by x.department)
      from (
        select coalesce(nullif(e.department, ''), 'Unassigned') department, count(*) employee_count,
          count(*) filter (where e.employment_status = 'active') active_count
        from public.employees e where e.id = any(v_ids) group by coalesce(nullif(e.department, ''), 'Unassigned')
      ) x
    ), '[]'::jsonb),
    'kpis', case when v_employee_id is not null then coalesce((
      select jsonb_agg(jsonb_build_object('id', k.id, 'kpi_name', k.kpi_name, 'target_value', k.target_value, 'actual_value', k.actual_value, 'unit', k.unit, 'status', k.status) order by k.updated_at desc)
      from public.employee_kpis k where k.employee_id = v_employee_id limit 8
    ), '[]'::jsonb) else '[]'::jsonb end,
    'leave_balances', case when v_scope = 'self' then coalesce((
      select jsonb_agg(jsonb_build_object('leave_type', lb.leave_type, 'entitled_days', lb.entitled_days, 'used_days', lb.used_days) order by lb.leave_type)
      from public.leave_balances lb where lb.employee_id = auth.uid() and lb.year = extract(year from current_date)::integer
    ), '[]'::jsonb) else '[]'::jsonb end,
    'recent_leave', case when v_scope = 'self' then coalesce((
      select jsonb_agg(to_jsonb(lr) order by lr.created_at desc)
      from (select * from public.leave_requests where created_by = auth.uid() order by created_at desc limit 5) lr
    ), '[]'::jsonb) else '[]'::jsonb end,
    'recent_tasks', case when v_scope = 'self' then coalesce((
      select jsonb_agg(to_jsonb(wt) order by wt.created_at desc)
      from (select * from public.work_tasks where assigned_to_user_id = auth.uid() order by created_at desc limit 5) wt
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

revoke all on function public.get_dashboard_snapshot(uuid, text, uuid, text, date, date) from public;
grant execute on function public.get_dashboard_snapshot(uuid, text, uuid, text, date, date) to authenticated;

-- END PHASE 50
