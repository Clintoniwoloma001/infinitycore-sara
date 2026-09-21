-- ============================================================
-- Phase 7a — Platform role expansion (Infinity MFB org chart)
-- Run in Supabase SQL Editor AFTER 20260921000006. Idempotent/additive.
--
-- Renames the legacy internal role `operations_manager` → `head_of_operations`
-- ("Head of Operations") and adds five new department-head roles taken from
-- the designations master (schema_phase26):
--   head_of_e_business        (HEAD, E-BANKING / HEAD OF DIGITAL BANKING)
--   financial_controller      (FINANCIAL CONTROLLER)
--   head_of_risk_compliance   (HEAD, RISK MANAGEMENT / HEAD OF COMPLIANCE)
--   head_of_legal             (HEAD OF LEGAL)
--   head_of_audit             (HEAD OF AUDIT / HEAD OF INTERNAL CONTROL)
--
-- Every RLS policy / RPC that previously enumerated `operations_manager` is
-- rewritten to `head_of_operations`, and the new head roles are granted the
-- org-wide "management" capabilities (training oversight, man-hour visibility,
-- announcements, management auto-channels, management leave class) while
-- HR/payroll-specific gates additionally include financial_controller.
--
-- profiles.role is validated by the CHECK `profiles_role_check`, so the
-- constraint is dropped, live rows migrated, then re-added with 18 roles:
--   super_admin, admin, head_of_business, area_manager, branch_manager,
--   head_of_operations, head_of_e_business, financial_controller,
--   head_of_risk_compliance, head_of_legal, head_of_audit, loan_officer,
--   relationship_manager, customer_service, hr_manager, hr_officer,
--   staff, customer
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. ROLES TABLE
-- ------------------------------------------------------------
-- Rename the system role row (id preserved so role_permissions stay attached).
update public.roles
set role_name = 'head_of_operations',
    display_name = 'Head of Operations',
    description = 'Manage operational workflows'
where role_name = 'operations_manager';

-- Backfill role rows that are referenced but were never seeded, plus the
-- five new department-head roles.
insert into public.roles (role_name, display_name, description, is_system_role, color)
values
  ('area_manager', 'Area Manager', 'Manage a group of branches', true, '#2563eb'),
  ('head_of_business', 'Head of Business', 'Manage business strategy and outcomes', true, '#7c3aed'),
  ('head_of_e_business', 'Head of E-Business', 'Digital & electronic banking channels', true, '#0d9488'),
  ('financial_controller', 'Financial Controller', 'Financial control & BankOne reconciliation', true, '#059669'),
  ('head_of_risk_compliance', 'Head of Risk & Compliance', 'Risk management, compliance & controls', true, '#b45309'),
  ('head_of_legal', 'Head of Legal', 'Legal affairs & document governance', true, '#4f46e5'),
  ('head_of_audit', 'Head of Audit', 'Internal audit & investigations', true, '#be123c')
on conflict (role_name) do nothing;

-- ------------------------------------------------------------
-- 2. DESIGNATION ROLE MAPPINGS
-- ------------------------------------------------------------
insert into public.designation_role_mappings (designation_title, system_role, notes) values
  ('HEAD OF OPERATIONS', 'head_of_operations', 'Renamed from operations_manager'),
  ('HEAD, E-BANKING', 'head_of_e_business', null),
  ('HEAD OF DIGITAL BANKING', 'head_of_e_business', null),
  ('FINANCIAL CONTROLLER', 'financial_controller', null),
  ('HEAD, RISK MANAGEMENT', 'head_of_risk_compliance', null),
  ('HEAD OF COMPLIANCE', 'head_of_risk_compliance', null),
  ('HEAD OF LEGAL', 'head_of_legal', null),
  ('HEAD OF AUDIT', 'head_of_audit', null),
  ('HEAD OF INTERNAL CONTROL', 'head_of_audit', null)
on conflict (designation_title) do update set system_role = excluded.system_role;

-- ------------------------------------------------------------
-- 3. PROFILES ROLE CHECK + LIVE ROW MIGRATION
-- ------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;

update public.profiles
set role = 'head_of_operations'
where role = 'operations_manager';

alter table public.profiles add constraint profiles_role_check
  check (role in (
    'super_admin','admin','head_of_business','area_manager','branch_manager',
    'head_of_operations','head_of_e_business','financial_controller',
    'head_of_risk_compliance','head_of_legal','head_of_audit',
    'loan_officer','relationship_manager','customer_service',
    'hr_manager','hr_officer','staff','customer'
  ));

-- ------------------------------------------------------------
-- 4. ROLE-PERMISSION INHERITANCE (mirror phase6 + phase51 seeds)
-- ------------------------------------------------------------
do $$
declare
  v_head text;
begin
  -- Every head role records their own attendance like staff (phase6 seed),
  -- and inherits the training/man-hour read grants (phase51 seed).
  foreach v_head in array array[
    'head_of_operations','head_of_e_business','financial_controller',
    'head_of_risk_compliance','head_of_legal','head_of_audit'
  ]
  loop
    perform public.assign_permission_to_role(v_head, 'hr.attendance.self');
    perform public.assign_permission_to_role(v_head, 'hr.training.read');
    perform public.assign_permission_to_role(v_head, 'workforce.manhour.read');
  end loop;
end $$;

-- ------------------------------------------------------------
-- 5. FUNCTION REWRITES (create or replace)
-- ------------------------------------------------------------

-- 5a. can_manage_bankone — rename + financial controller (finance owns BankOne).
create or replace function public.can_manage_bankone()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'head_of_operations',
    'financial_controller'
  );
$$;

-- 5b. can_manage_reconciliation — rename + financial controller.
create or replace function public.can_manage_reconciliation()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() in (
    'super_admin',
    'admin',
    'hr_manager',
    'hr_officer',
    'head_of_operations',
    'financial_controller',
    'branch_manager'
  );
$$;

-- 5c. can_author_announcement — management class now includes all head roles.
create or replace function public.can_author_announcement()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('super_admin', 'admin', 'hr_manager', 'hr_officer',
                   'branch_manager', 'area_manager', 'head_of_operations',
                   'head_of_business', 'head_of_e_business', 'financial_controller',
                   'head_of_risk_compliance', 'head_of_legal', 'head_of_audit')
  );
$$;
grant execute on function public.can_author_announcement() to authenticated;

-- 5d. training_is_manager — rename + all head roles (frontend grants them hr.training.read).
create or replace function public.training_is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in (
    'super_admin', 'admin', 'hr_manager', 'hr_officer',
    'head_of_business', 'area_manager', 'branch_manager',
    'head_of_operations', 'head_of_e_business', 'financial_controller',
    'head_of_risk_compliance', 'head_of_legal', 'head_of_audit'
  );
$$;
revoke all on function public.training_is_manager() from public;
grant execute on function public.training_is_manager() to authenticated;

-- 5e. enforce_role_change_policy — head roles are management: only
--     super_admin/admin may assign them (extends the area_manager guard).
create or replace function public.enforce_role_change_policy()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  promoter_roles text[] := array['super_admin','admin','hr_manager','area_manager','branch_manager'];
  management_roles text[] := array[
    'area_manager','head_of_business','head_of_operations',
    'head_of_e_business','financial_controller',
    'head_of_risk_compliance','head_of_legal','head_of_audit'
  ];
begin
  if new.role is distinct from old.role then
    if not (actor_role = any(promoter_roles)) then
      raise exception 'Not authorized to change roles (actor role: %)', actor_role;
    end if;

    if new.role = 'super_admin' and actor_role <> 'super_admin' then
      raise exception 'Only super_admin can assign the super_admin role';
    end if;

    if new.role = 'admin' and actor_role not in ('super_admin','admin') then
      raise exception 'Only super_admin or admin can assign the admin role';
    end if;

    if new.role = any(management_roles) and actor_role not in ('super_admin','admin') then
      raise exception 'Only super_admin or admin can assign this role';
    end if;

    -- Branch Manager may only promote a customer into front-line staff
    -- roles, never into management or above.
    if actor_role = 'branch_manager' and new.role not in ('staff','loan_officer','relationship_manager','customer_service') then
      raise exception 'Branch Manager is not authorized to assign this role';
    end if;

    -- Log every role change server-side, regardless of which client made it.
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'user_role_changed',
      'User',
      new.id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      format('%s: %s -> %s', coalesce(new.email, new.id::text), old.role, new.role),
      'critical'
    );
  end if;
  return new;
end; $$;

drop trigger if exists trg_enforce_role_change on public.profiles;
create trigger trg_enforce_role_change
  before update on public.profiles
  for each row execute function public.enforce_role_change_policy();

-- ------------------------------------------------------------
-- 6. RLS POLICY REWRITES
-- ------------------------------------------------------------

-- 6a. branches_read_authorized (phase2) — management read of branch master.
drop policy if exists "branches_read_authorized" on public.branches;
create policy "branches_read_authorized" on public.branches
  for select using (public.current_role() in (
    'super_admin', 'admin', 'branch_manager', 'hr_manager',
    'head_of_operations', 'head_of_business', 'head_of_e_business',
    'financial_controller', 'head_of_risk_compliance', 'head_of_legal', 'head_of_audit'
  ));

-- 6b. leave_balances read own or hr (phase3) — management class renamed+extended.
drop policy if exists "leave_balances read own or hr" on public.leave_balances;
create policy "leave_balances read own or hr"
on public.leave_balances
for select
using (
  employee_id = auth.uid()
  or public.current_role() in (
    'admin',
    'super_admin',
    'manager',
    'hr_manager',
    'hr_officer',
    'branch_manager',
    'head_of_operations',
    'head_of_business',
    'head_of_e_business',
    'financial_controller',
    'head_of_risk_compliance',
    'head_of_legal',
    'head_of_audit'
  )
);

-- 6c. Phase 10 workforce policies — rename ops, keep HR/branch/area scope.
drop policy if exists "tasks_insert_admin" on public.tasks;
create policy "tasks_insert_admin"
on public.tasks
for insert
with check (
    public.current_role() in (
        'admin',
        'super_admin',
        'branch_manager',
        'head_of_operations',
        'hr_manager',
        'hr_officer',
        'area_manager'
    )
);

drop policy if exists "tasks_update_assigned_or_admin" on public.tasks;
create policy "tasks_update_assigned_or_admin"
on public.tasks
for update
using (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'head_of_operations',
        'hr_manager',
        'area_manager'
    )
)
with check (
    assigned_to = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'head_of_operations',
        'hr_manager',
        'area_manager'
    )
);

drop policy if exists "tasks_read_assigned" on public.tasks;
create policy "tasks_read_assigned"
on public.tasks
for select
using (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'head_of_operations',
        'hr_manager',
        'hr_officer',
        'area_manager'
    )
);

drop policy if exists "task_reports_read" on public.task_progress_reports;
create policy "task_reports_read"
on public.task_progress_reports
for select
using (
    submitted_by = auth.uid()

    OR EXISTS (
        SELECT 1
        FROM public.tasks t
        WHERE t.id = task_id
        AND (
            t.assigned_to = auth.uid()
            OR t.created_by = auth.uid()
        )
    )

    OR public.current_role() IN (
        'super_admin',
        'admin',
        'branch_manager',
        'head_of_operations',
        'hr_manager',
        'hr_officer',
        'area_manager'
    )
);

drop policy if exists "task_reports_update" on public.task_progress_reports;
create policy "task_reports_update"
on public.task_progress_reports
for update
using (
    public.current_role() IN (
        'super_admin',
        'admin',
        'branch_manager',
        'head_of_operations',
        'hr_manager',
        'hr_officer',
        'area_manager'
    )
);

-- 6d. Phase 8/8-9 BankOne + reconciliation writes — rename + financial controller.
drop policy if exists "bankone_batches write" on public.bankone_import_batches;
create policy "bankone_batches write" on public.bankone_import_batches
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'));

drop policy if exists "bankone_txn write" on public.bankone_transactions;
create policy "bankone_txn write" on public.bankone_transactions
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'));

drop policy if exists "bankone_mappings write" on public.bankone_column_mappings;
create policy "bankone_mappings write" on public.bankone_column_mappings
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'));

drop policy if exists "recon_cases write" on public.reconciliation_cases;
create policy "recon_cases write" on public.reconciliation_cases
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'));

drop policy if exists "transport_allow write" on public.transport_allowance_config;
create policy "transport_allow write" on public.transport_allowance_config
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_operations', 'financial_controller'));

-- ------------------------------------------------------------
-- 7. LEAVE ACCRUAL (management class 15 days)
-- ------------------------------------------------------------
create or replace function public.reset_annual_leave_balances(target_year int)
returns void language plpgsql security definer set search_path = public as $$
declare
  lt text;
  p record;
  ent numeric;
begin
  for p in select id, coalesce(full_name, email) AS full_name, role FROM public.profiles loop
    -- Annual: category-dependent
    ent := case
      when p.role in ('md', 'super_admin') then 20
      when p.role in ('admin', 'hr_manager', 'branch_manager', 'area_manager', 'head_of_business',
                      'head_of_operations', 'head_of_e_business', 'financial_controller',
                      'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') then 15
      else 10
    end;
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    values (p.id, p.full_name, target_year, 'annual', ent, 0)
    on conflict (employee_id, year, leave_type) do update set entitled_days = excluded.entitled_days;

    -- Maternity
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    values (p.id, p.full_name, target_year, 'maternity', 90, 0)
    on conflict (employee_id, year, leave_type) do update set entitled_days = 90;

    -- Examination
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    values (p.id, p.full_name, target_year, 'examination', 5, 0)
    on conflict (employee_id, year, leave_type) do update set entitled_days = 5;

    -- Paternity
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    values (p.id, p.full_name, target_year, 'paternity', 2, 0)
    on conflict (employee_id, year, leave_type) do update set entitled_days = 2;
  end loop;
end; $$;

-- ------------------------------------------------------------
-- 8. MAN-HOUR INTELLIGENCE SCOPE (head roles see the whole org)
-- ------------------------------------------------------------
create or replace function public.get_man_hour_intelligence(
  p_start_date date default null,
  p_end_date date default null,
  p_area text default null,
  p_branch_id uuid default null,
  p_department text default null,
  p_employee_id uuid default null
) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_start date := coalesce(p_start_date, date_trunc('month', current_date)::date);
  v_end date := coalesce(p_end_date, current_date);
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_ids uuid[];
  v_area_scope text;
  v_branch_scope uuid;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;
  select * into v_me from public.employees where user_id = auth.uid() order by created_at desc limit 1;
  if v_role = 'branch_manager' then v_branch_scope := v_me.branch_id;
  elsif v_role = 'area_manager' then v_area_scope := v_me.area;
  elsif v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_business',
                       'head_of_operations', 'head_of_e_business', 'financial_controller',
                       'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') then v_ids := array[v_me.id]; end if;
  if p_branch_id is not null and v_branch_scope is not null and p_branch_id <> v_branch_scope then raise exception 'Not authorized for this branch.'; end if;
  if p_area is not null and v_area_scope is not null and lower(p_area) <> lower(v_area_scope) then raise exception 'Not authorized for this area.'; end if;
  if v_ids is null then
    select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids from public.employees e
    where coalesce(e.is_archived, false) = false
      and (p_employee_id is null or e.id = p_employee_id)
      and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department))
      and (p_branch_id is null or e.branch_id = p_branch_id)
      and (v_branch_scope is null or e.branch_id = v_branch_scope)
      and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area) or exists (select 1 from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id where baa.branch_id = e.branch_id and baa.is_current and lower(a.area_code) = lower(p_area)))
      and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope) or exists (select 1 from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id where baa.branch_id = e.branch_id and baa.is_current and lower(a.area_code) = lower(v_area_scope)));
  end if;
  with settings as (
    select coalesce(default_work_start_time, time '08:00') start_time, coalesce(default_work_end_time, time '17:00') end_time,
           coalesce(default_break_duration_minutes, 60) break_minutes, coalesce(default_working_days, array['mon','tue','wed','thu','fri']) working_days
    from public.hr_platform_settings where id = 1
  ), days as (
    select gs::date as work_day from generate_series(v_start, v_end, interval '1 day') gs
  ), employee_days as (
    select e.id employee_id, e.full_name, e.department,
      coalesce(e.area, (select a.area_code from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id where baa.branch_id = e.branch_id and baa.is_current limit 1)) area,
      e.branch_id, coalesce(b.branch_name, e.branch, 'Unassigned') branch_name,
      d.work_day, coalesce(b.work_start_time, s.start_time) start_time, coalesce(b.work_end_time, s.end_time) end_time,
      coalesce(b.working_days, s.working_days) working_days, coalesce(b.grace_period_minutes, 15) grace_minutes,
      greatest(0, extract(epoch from (coalesce(b.work_end_time, s.end_time) - coalesce(b.work_start_time, s.start_time))) / 3600 - (s.break_minutes / 60.0)) scheduled_day_hours
    from public.employees e cross join days d cross join settings s left join public.branches b on b.id = e.branch_id
    where e.id = any(v_ids) and (e.hire_date is null or e.hire_date <= d.work_day) and e.employment_status <> 'terminated'
  ), workdays as (
    select * from employee_days where case extract(isodow from work_day)::int
      when 1 then 'mon' when 2 then 'tue' when 3 then 'wed' when 4 then 'thu' when 5 then 'fri' when 6 then 'sat' when 7 then 'sun' end = any(working_days)
  ), attendance as (
    select ar.employee_id, ar.attendance_date, sum(coalesce(ar.work_hours, ar.total_minutes::numeric / 60.0, case when ar.clock_in is not null and ar.clock_out is not null then extract(epoch from (ar.clock_out - ar.clock_in)) / 3600 else 0 end)) actual_hours,
      sum(coalesce(ar.late_minutes, 0)) late_minutes, sum(coalesce(ar.early_departure_minutes, 0)) early_minutes, count(*) records
    from public.attendance_records ar where ar.employee_id = any(v_ids) and ar.attendance_date between v_start and v_end group by ar.employee_id, ar.attendance_date
  ), workforce as (
    select w.employee_id, max(w.full_name) full_name, max(w.department) department, max(w.area) area, max(w.branch_name) branch_name,
      round(sum(w.scheduled_day_hours)::numeric, 2) scheduled_hours,
      round(sum(coalesce(a.actual_hours, 0))::numeric, 2) actual_hours,
      round(sum(case when coalesce(a.actual_hours, 0) = 0 then w.scheduled_day_hours else 0 end)::numeric, 2) absence_hours,
      round(sum(coalesce(a.late_minutes, 0))::numeric / 60, 2) late_hours,
      round(sum(coalesce(a.early_minutes, 0))::numeric / 60, 2) early_departure_hours,
      round(sum(greatest(0, coalesce(a.actual_hours, 0) - w.scheduled_day_hours))::numeric, 2) overtime_hours,
      sum(coalesce(a.records, 0)) attendance_records
    from workdays w left join attendance a on a.employee_id = w.employee_id and a.attendance_date = w.work_day group by w.employee_id
  ), training as (
    select r.employee_id, round(sum(r.duration_minutes)::numeric / 60, 2) training_hours,
      round(sum(case when r.training_type = 'kss' then r.duration_minutes else 0 end)::numeric / 60, 2) kss_hours,
      count(*) training_sessions
    from public.employee_training_records r where r.employee_id = any(v_ids) and r.training_date between v_start and v_end group by r.employee_id
  ), all_rows as (
    select w.*, coalesce(t.training_hours, 0) training_hours, coalesce(t.kss_hours, 0) kss_hours, coalesce(t.training_sessions, 0) training_sessions,
      coalesce((select round(sum(s.duration_minutes * p.participant_count)::numeric / 60, 2) from public.training_sessions s join lateral (
        select count(*)::numeric participant_count from public.training_participants tp where tp.session_id = s.id and tp.status not in ('absent', 'withdrawn') and tp.employee_id = w.employee_id
      ) p on true where s.training_date between v_start and v_end), 0) training_man_hours
    from workforce w left join training t on t.employee_id = w.employee_id
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'scheduled_hours', coalesce(round(sum(scheduled_hours)::numeric, 2), 0),
      'actual_attendance_hours', coalesce(round(sum(actual_hours)::numeric, 2), 0),
      'training_hours', coalesce(round(sum(training_hours)::numeric, 2), 0),
      'kss_hours', coalesce(round(sum(kss_hours)::numeric, 2), 0),
      'training_man_hours', coalesce((select round(sum(s.duration_minutes * p.participant_count)::numeric / 60, 2) from public.training_sessions s join lateral (select count(*)::numeric participant_count from public.training_participants tp where tp.session_id = s.id and tp.status not in ('absent', 'withdrawn') and tp.employee_id = any(v_ids)) p on true where s.training_date between v_start and v_end), 0),
      'overtime_hours', coalesce(round(sum(overtime_hours)::numeric, 2), 0),
      'absence_hours', coalesce(round(sum(absence_hours)::numeric, 2), 0),
      'late_hours', coalesce(round(sum(late_hours)::numeric, 2), 0),
      'early_departure_hours', coalesce(round(sum(early_departure_hours)::numeric, 2), 0),
      'attendance_compliance', coalesce(round(100 * sum(actual_hours) / nullif(sum(scheduled_hours), 0), 2), 0)
    ),
    'by_area', coalesce((select jsonb_agg(jsonb_build_object('area', x.area, 'scheduled_hours', x.scheduled_hours, 'actual_hours', x.actual_hours, 'training_hours', x.training_hours, 'training_man_hours', x.training_man_hours, 'employees', x.employees) order by x.area) from (select coalesce(area, 'Unassigned') area, round(sum(scheduled_hours)::numeric, 2) scheduled_hours, round(sum(actual_hours)::numeric, 2) actual_hours, round(sum(training_hours)::numeric, 2) training_hours, round(sum(training_man_hours)::numeric, 2) training_man_hours, count(*) employees from all_rows group by 1) x), '[]'::jsonb),
    'by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch', x.branch_name, 'scheduled_hours', x.scheduled_hours, 'actual_hours', x.actual_hours, 'training_hours', x.training_hours, 'training_man_hours', x.training_man_hours, 'employees', x.employees) order by x.branch_name) from (select branch_name, round(sum(scheduled_hours)::numeric, 2) scheduled_hours, round(sum(actual_hours)::numeric, 2) actual_hours, round(sum(training_hours)::numeric, 2) training_hours, round(sum(training_man_hours)::numeric, 2) training_man_hours, count(*) employees from all_rows group by 1) x), '[]'::jsonb),
    'by_department', coalesce((select jsonb_agg(jsonb_build_object('department', x.department, 'scheduled_hours', x.scheduled_hours, 'actual_hours', x.actual_hours, 'training_hours', x.training_hours, 'training_man_hours', x.training_man_hours, 'employees', x.employees) order by x.department) from (select coalesce(department, 'Unassigned') department, round(sum(scheduled_hours)::numeric, 2) scheduled_hours, round(sum(actual_hours)::numeric, 2) actual_hours, round(sum(training_hours)::numeric, 2) training_hours, round(sum(training_man_hours)::numeric, 2) training_man_hours, count(*) employees from all_rows group by 1) x), '[]'::jsonb),
    'by_employee', coalesce((select jsonb_agg(to_jsonb(x) order by x.full_name) from (select employee_id, full_name, department, area, branch_name, scheduled_hours, actual_hours, absence_hours, late_hours, early_departure_hours, overtime_hours, training_hours, kss_hours, training_man_hours, training_sessions from all_rows) x), '[]'::jsonb),
    'start_date', v_start, 'end_date', v_end, 'scope_employee_ids', to_jsonb(v_ids)
  ) into v_result from all_rows;
  return coalesce(v_result, jsonb_build_object('summary', '{}'::jsonb, 'by_employee', '[]'::jsonb));
end;
$$;
grant execute on function public.get_man_hour_intelligence(date, date, text, uuid, text, uuid) to authenticated;

-- ------------------------------------------------------------
-- 9. AUTO-CHANNEL MEMBERSHIP — management bucket includes head roles
-- ------------------------------------------------------------
create or replace function public.sync_auto_channel_members(p_channel_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_channel record;
  v_qualifying uuid[] := '{}';
  v_added int := 0;
  v_removed int := 0;
  v_total int := 0;
begin
  select * into v_channel from public.message_channels where id = p_channel_id;
  if v_channel.id is null then raise exception 'Channel not found'; end if;
  if not v_channel.is_auto then raise exception 'Channel is not an auto channel'; end if;
  v_me := coalesce(v_me, v_channel.creator_id);

  -- Recompute the set of user ids that currently qualify for this channel.
  if v_channel.auto_source = 'branch' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    where e.branch_id = v_channel.auto_source_id
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'area' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    join public.branch_area_assignments ba
      on ba.branch_id = e.branch_id and ba.is_current
    where ba.area_id = v_channel.auto_source_id
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'department' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    where public.employee_matches_department_channel(e.id, v_channel.auto_source_role)
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'role' then
    if v_channel.auto_source_role = 'all' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.status = 'active' and p.role <> 'customer';
    elsif v_channel.auto_source_role = 'management' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('super_admin', 'admin', 'head_of_business', 'head_of_operations',
                       'head_of_e_business', 'financial_controller',
                       'head_of_risk_compliance', 'head_of_legal', 'head_of_audit',
                       'branch_manager', 'area_manager')
        and p.status = 'active';
    elsif v_channel.auto_source_role = 'executive' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('super_admin', 'admin', 'head_of_business')
        and p.status = 'active';
    elsif v_channel.auto_source_role = 'hr' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('hr_manager', 'hr_officer', 'super_admin', 'admin')
        and p.status = 'active';
    else
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role = v_channel.auto_source_role and p.status = 'active';
    end if;
  end if;

  -- Insert everyone who qualifies (as automatic members).
  insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
  select p_channel_id, q.uid, 'member', coalesce(v_me, v_channel.creator_id), true
  from unnest(v_qualifying) as q(uid)
  where not exists (
    select 1 from public.message_channel_members cm
    where cm.channel_id = p_channel_id and cm.member_id = q.uid
  );
  get diagnostics v_added = row_count;

  -- Remove memberships that no longer qualify — ONLY automatic ones
  -- (auto_added = true). Manual memberships and the owner row survive.
  delete from public.message_channel_members cm
  where cm.channel_id = p_channel_id
    and cm.auto_added = true
    and cm.member_id <> all(v_qualifying);
  get diagnostics v_removed = row_count;

  select count(*) into v_total
  from public.message_channel_members where channel_id = p_channel_id;

  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_members_synced', null,
    null, jsonb_build_object('member_count', v_total, 'added', v_added, 'removed', v_removed),
    'auto membership sync'
  );

  return jsonb_build_object(
    'ok', true, 'channel_id', p_channel_id,
    'member_count', v_total, 'added', v_added, 'removed', v_removed
  );
end; $$;
grant execute on function public.sync_auto_channel_members(uuid) to authenticated;

create or replace function public.reconcile_auto_channel_membership_for_employee(p_employee_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_e record;
  v_eligible boolean;
  v_added int := 0;
  v_removed int := 0;
  v_matches boolean;
  v_role_matches boolean;
  v_chan record;
  v_p record;
begin
  if auth.uid() is not null
     and not public.is_communication_admin()
     and not exists (select 1 from public.employees where id = p_employee_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select * into v_e from public.employees where id = p_employee_id;
  if v_e.id is null then return jsonb_build_object('ok', true, 'skipped', 'not_found'); end if;
  if v_e.user_id is null then return jsonb_build_object('ok', true, 'skipped', 'not_linked'); end if;

  v_eligible := v_e.employment_status in ('active', 'on_leave') and coalesce(v_e.is_archived, false) = false;

  select role, status into v_p from public.profiles where id = v_e.user_id;
  if v_p.role is null then v_p.role := 'customer'; v_p.status := coalesce(v_p.status, 'pending'); end if;

  for v_chan in
    select * from public.message_channels
    where is_auto and status = 'active'
  loop
    v_matches := false;
    if v_chan.auto_source = 'branch' then
      v_matches := v_e.branch_id is not null and v_e.branch_id = v_chan.auto_source_id;
    elsif v_chan.auto_source = 'area' then
      v_matches := v_e.branch_id is not null and exists (
        select 1 from public.branch_area_assignments ba
        where ba.branch_id = v_e.branch_id and ba.area_id = v_chan.auto_source_id and ba.is_current
      );
    elsif v_chan.auto_source = 'department' then
      v_matches := public.employee_matches_department_channel(v_e.id, v_chan.auto_source_role);
    elsif v_chan.auto_source = 'role' then
      v_role_matches := false;
      if v_chan.auto_source_role = 'all' then
        v_role_matches := v_p.role <> 'customer' and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'management' then
        v_role_matches := v_p.role in ('super_admin', 'admin', 'head_of_business', 'head_of_operations',
                                       'head_of_e_business', 'financial_controller',
                                       'head_of_risk_compliance', 'head_of_legal', 'head_of_audit',
                                       'branch_manager', 'area_manager') and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'executive' then
        v_role_matches := v_p.role in ('super_admin', 'admin', 'head_of_business') and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'hr' then
        v_role_matches := v_p.role in ('hr_manager', 'hr_officer', 'super_admin', 'admin') and v_p.status = 'active';
      else
        v_role_matches := v_p.role = v_chan.auto_source_role and v_p.status = 'active';
      end if;
      v_matches := v_role_matches;
    end if;

    if v_matches and v_eligible then
      if not exists (
        select 1 from public.message_channel_members
        where channel_id = v_chan.id and member_id = v_e.user_id
      ) then
        insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
        values (v_chan.id, v_e.user_id, 'member', v_chan.creator_id, true)
        on conflict (channel_id, member_id) do nothing;
        v_added := v_added + 1;
      end if;
    else
      delete from public.message_channel_members
      where channel_id = v_chan.id and member_id = v_e.user_id and auto_added = true;
      if found then v_removed := v_removed + 1; end if;
    end if;
  end loop;

  perform public.write_communication_audit(
    'channel', null, 'employee_auto_membership_reconciled', null, null,
    jsonb_build_object('employee_id', p_employee_id, 'user_id', v_e.user_id, 'added', v_added, 'removed', v_removed),
    'employee org provisioning'
  );

  return jsonb_build_object('ok', true, 'employee_id', p_employee_id, 'added', v_added, 'removed', v_removed);
end; $$;
grant execute on function public.reconcile_auto_channel_membership_for_employee(uuid) to authenticated;

-- ------------------------------------------------------------
-- 10. approve_user OVERLOADS — head roles are staff roles for
--     auto-linking and require super_admin/admin to assign.
-- ------------------------------------------------------------

-- 10a. 5-arg approve_user (Users.jsx).
create or replace function public.approve_user(
  p_user_id uuid,
  p_role text default 'staff',
  p_department text default null,
  p_branch text default null,
  p_user_type text default 'staff'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
  v_employee public.employees;
  v_dept text;
  v_branch text;
  v_designation text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to approve users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Cannot modify Super Admin accounts';
  end if;

  -- Validate role assignment (reuse enforce_role_change_policy logic)
  if p_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role in ('admin', 'area_manager', 'head_of_business', 'head_of_operations',
                'head_of_e_business', 'financial_controller',
                'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Not authorized to assign this role';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  -- Resolve the source-of-truth employee before writing the profile.
  -- Preference: real link, then auth-user link, then matching email.
  select e.* into v_employee
  from public.employees e
  where e.user_id = p_user_id
     or e.id = v_target.employee_id
     or (v_target.email is not null and lower(e.email) = lower(v_target.email))
  order by case
             when e.user_id = p_user_id then 0
             when e.id = v_target.employee_id then 1
             else 2
           end
  limit 1;

  v_dept := v_employee.department;
  v_branch := v_employee.branch;
  if v_employee.branch_id is not null then
    select branch_name into v_branch from public.branches where id = v_employee.branch_id;
    v_branch := coalesce(v_branch, v_employee.branch);
  end if;
  v_designation := public.employee_designation_label(v_employee."position", v_employee.designation_id);

  update public.profiles set
    role = p_role,
    status = 'active',
    approved = true,
    approved_by = auth.uid(),
    approved_at = now(),
    department = coalesce(nullif(trim(p_department), ''), v_dept, department),
    branch = coalesce(nullif(trim(p_branch), ''), v_branch, branch),
    employee_number = coalesce(v_employee.employee_number, employee_number),
    designation = coalesce(v_designation, designation),
    user_type = coalesce(nullif(trim(p_user_type), ''), 'staff')
  where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_APPROVED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s approved with role %s, dept %s, branch %s', coalesce(v_target.email, p_user_id::text), p_role, coalesce(nullif(trim(p_department), ''), v_dept, 'N/A'), coalesce(nullif(trim(p_branch), ''), v_branch, 'N/A')),
    'warning'
  );

  -- Notify the approved user
  insert into public.notifications (user_id, title, message, type, link)
  values (
    p_user_id,
    'Account Approved',
    format('Your account has been approved. You now have access as %s.', p_role),
    'system',
    '/'
  );

  -- Auto-create/link employee record for staff roles
  if p_role in ('staff', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager',
                'head_of_business', 'head_of_operations', 'head_of_e_business',
                'financial_controller', 'head_of_risk_compliance', 'head_of_legal',
                'head_of_audit', 'loan_officer',
                'relationship_manager', 'customer_service', 'admin') then
    declare
      v_emp_id uuid;
      v_emp_code text;
    begin
      -- Check if employee already exists (by user_id or email)
      select id into v_emp_id from public.employees
        where user_id = p_user_id
           or (v_target.email is not null and lower(email) = lower(v_target.email))
        limit 1;

      if v_emp_id is null then
        -- Generate employee code
        v_emp_code := public.generate_employee_code();

        insert into public.employees (
          user_id, full_name, email, department, "position", branch,
          employment_status, employee_code, source, created_by, hire_date, updated_at
        ) values (
          p_user_id, coalesce(v_target.full_name, v_target.email, 'Unknown'),
          v_target.email, coalesce(nullif(trim(p_department), ''), v_dept), v_designation, coalesce(nullif(trim(p_branch), ''), v_branch),
          'active', v_emp_code, 'manual', auth.uid(), now()::date, now()
        )
        returning id into v_emp_id;

        insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
        values (
          'EMPLOYEE_AUTO_CREATED',
          'Employee',
          v_emp_id::text,
          coalesce(v_actor_name, auth.uid()::text),
          format('Employee auto-created for approved user %s (role: %s)', coalesce(v_target.email, p_user_id::text), p_role),
          'info'
        );

        -- Assign the standard employee number / staff id so the approval
        -- screen shows an identity for the new employee.
        perform public.generate_employee_number(v_emp_id);
      else
        -- Link existing employee to user_id if not already linked.
        -- The employee record itself is left untouched — HR data stays
        -- authoritative; the profile snapshot below mirrors it.
        update public.employees set user_id = p_user_id, updated_at = now()
          where id = v_emp_id and user_id is null;
      end if;

      -- Link profile to employee
      update public.profiles set employee_id = v_emp_id where id = p_user_id and employee_id is null;

      -- Final snapshot sync: employee record is the source of truth for
      -- the identity fields shown on the approval/review screen.
      update public.profiles p
      set employee_number = e.employee_number,
          designation = public.employee_designation_label(e."position", e.designation_id)
      from public.employees e
      where e.id = v_emp_id and p.id = p_user_id;
    end;
  end if;

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.approve_user(uuid, text, text, text, text) to authenticated;

-- 10b. 4-arg approve_user (userApprovalService / WorkManagement).
create or replace function public.approve_user(
  p_user_id uuid,
  p_role text default 'customer',
  p_department text default null,
  p_modules jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
  v_employee public.employees;
  v_dept text;
  v_branch text;
  v_designation text;
  v_prev_status text;
  v_prev_role text;
  v_prev_employee_id uuid;
  v_emp_id uuid;
  v_emp_code text;
  v_effective_role text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'area_manager', 'branch_manager', 'head_of_business', 'head_of_operations', 'head_of_e_business', 'financial_controller', 'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') then
    raise exception 'Not authorized to approve users';
  end if;
  if p_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role = 'admin' and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Only super_admin or admin can assign the admin role';
  end if;
  if p_role in ('area_manager', 'head_of_business', 'head_of_operations', 'head_of_e_business',
                'financial_controller', 'head_of_risk_compliance', 'head_of_legal', 'head_of_audit')
     and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Only super_admin or admin can assign this role';
  end if;
  if v_actor_role in ('branch_manager', 'area_manager') and p_role not in ('staff', 'loan_officer', 'relationship_manager', 'customer_service') then
    raise exception 'This role cannot be assigned by you';
  end if;

  select * into v_target
  from public.profiles
  where id = p_user_id
  for update;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Cannot modify Super Admin accounts';
  end if;

  v_prev_status := v_target.status;
  v_prev_role := v_target.role;
  v_prev_employee_id := v_target.employee_id;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  -- Resolve the source-of-truth employee (link, auth-user link, email).
  select e.* into v_employee
  from public.employees e
  where e.user_id = p_user_id
     or e.id = v_target.employee_id
     or (v_target.email is not null and lower(e.email) = lower(v_target.email))
  order by case
             when e.user_id = p_user_id then 0
             when e.id = v_target.employee_id then 1
             else 2
           end
  limit 1;

  v_dept := v_employee.department;
  v_branch := v_employee.branch;
  if v_employee.branch_id is not null then
    select branch_name into v_branch from public.branches where id = v_employee.branch_id;
    v_branch := coalesce(v_branch, v_employee.branch);
  end if;
  v_designation := public.employee_designation_label(v_employee."position", v_employee.designation_id);
  v_effective_role := coalesce(nullif(trim(p_role), ''), 'customer');

  update public.profiles
  set status = 'active',
      approved = true,
      role = v_effective_role,
      department = coalesce(nullif(trim(p_department), ''), v_dept, department),
      branch = coalesce(v_branch, branch),
      employee_number = coalesce(v_employee.employee_number, employee_number),
      designation = coalesce(v_designation, designation),
      approved_by = auth.uid(),
      approved_at = now(),
      rejected_reason = null
  where id = p_user_id;

  -- Access profile
  if p_modules is not null then
    insert into public.user_access_profiles (user_id, modules, granted_by, granted_at, updated_at)
    values (p_user_id, p_modules, auth.uid(), now(), now())
    on conflict (user_id)
    do update set modules = excluded.modules,
                  granted_by = auth.uid(),
                  granted_at = now(),
                  updated_at = now();
  end if;

  -- Approval audit
  insert into public.user_approval_audit (user_id, action, previous_status, new_status, previous_role, new_role, department, approver_id, approver_name)
  values (p_user_id, 'USER_APPROVED', v_prev_status, 'active', v_prev_role, v_effective_role, coalesce(nullif(trim(p_department), ''), v_dept), auth.uid(), v_actor_name);

  -- Role change audit
  if v_prev_role is distinct from v_effective_role then
    insert into public.user_approval_audit (user_id, action, previous_role, new_role, approver_id, approver_name)
    values (p_user_id, 'USER_ROLE_CHANGED', v_prev_role, v_effective_role, auth.uid(), v_actor_name);
  end if;

  -- Department audit
  if p_department is not null then
    insert into public.user_approval_audit (user_id, action, department, approver_id, approver_name)
    values (p_user_id, 'USER_DEPARTMENT_CHANGED', p_department, auth.uid(), v_actor_name);
  end if;

  -- Access audit
  if p_modules is not null then
    insert into public.user_approval_audit (user_id, action, approver_id, approver_name)
    values (p_user_id, 'USER_ACCESS_CHANGED', auth.uid(), v_actor_name);
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('USER_APPROVED', 'User', p_user_id::text, v_actor_name,
          format('User approved: role=%s, department=%s', v_effective_role, coalesce(nullif(trim(p_department), ''), v_dept, 'none')),
          'critical');

  -- Link/create the employee record for staff roles (never duplicate).
  if v_effective_role in ('staff', 'hr_manager', 'hr_officer', 'branch_manager', 'area_manager',
                          'head_of_business', 'head_of_operations', 'head_of_e_business',
                          'financial_controller', 'head_of_risk_compliance', 'head_of_legal',
                          'head_of_audit', 'loan_officer',
                          'relationship_manager', 'customer_service', 'admin') then
    if v_prev_employee_id is not null then
      v_emp_id := v_prev_employee_id;
    else
      select id into v_emp_id from public.employees
        where user_id = p_user_id
           or (v_target.email is not null and lower(email) = lower(v_target.email))
        limit 1;
    end if;

    if v_emp_id is null then
      v_emp_code := public.generate_employee_code();
      insert into public.employees (
        user_id, full_name, email, department, "position", branch,
        employment_status, employee_code, source, created_by, hire_date, updated_at
      ) values (
        p_user_id, coalesce(v_target.full_name, v_target.email, 'Unknown'),
        v_target.email, coalesce(nullif(trim(p_department), ''), v_dept), v_designation, v_branch,
        'active', v_emp_code, 'manual', auth.uid(), now()::date, now()
      )
      returning id into v_emp_id;

      insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
      values ('EMPLOYEE_AUTO_CREATED', 'Employee', v_emp_id::text, v_actor_name,
              format('Employee auto-created for approved user %s (role: %s)', coalesce(v_target.email, p_user_id::text), v_effective_role),
              'info');

      -- Assign the standard employee number / staff id so the approval
      -- screen shows an identity for the new employee.
      perform public.generate_employee_number(v_emp_id);
    else
      update public.employees set user_id = p_user_id, updated_at = now()
        where id = v_emp_id and user_id is null;
    end if;

    update public.profiles set employee_id = v_emp_id where id = p_user_id and employee_id is null;

    update public.profiles p
    set employee_number = e.employee_number,
        designation = public.employee_designation_label(e."position", e.designation_id)
    from public.employees e
    where e.id = v_emp_id and p.id = p_user_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.approve_user(uuid, text, text, jsonb) to authenticated;

commit;