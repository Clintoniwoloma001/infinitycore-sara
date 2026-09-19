-- ============================================================
-- PHASE 57: EMPLOYEE PROVISIONING — APPROVAL + AUTHENTICATION FIXES
-- ------------------------------------------------------------
-- PURPOSE
--   Hardens the employee -> user provisioning/approval path so the
--   employee record stays the source of truth:
--
--   1. profiles.employee_number / profiles.designation snapshot the
--      linked employee's identity for display on the approval screen
--      (department, branch, designation and employee number).
--   2. provision_employee_account never null-wipes an existing profile
--      value with an empty employee field; when the employee HAS a value
--      it still wins.
--   3. approve_user (BOTH public overloads — the 5-arg Phase 9 version
--      used by Users.jsx and the 4-arg Phase 10 version used by
--      WorkManagement) now:
--      * keeps the linked employee (never creates a duplicate employee),
--      * preserves the employee's department/branch when the approver
--        leaves the fields blank,
--      * copies employee number + designation onto the profile, and
--      * flags the account `approved = true` consistently.
--
--   Run in the Supabase SQL Editor after the Phase 53 migration.
--   Idempotent + additive — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Helper: effective designation label for an employee row.
--    Prefers the denormalized `position` (job title text), then the
--    master `designations.title`, then any legacy `designation` text.
-- ------------------------------------------------------------
create or replace function public.employee_designation_label(
  p_position text,
  p_designation_id uuid,
  p_legacy_designation text default null
) returns text
language sql stable security invoker set search_path = public as $$
  select coalesce(
    nullif(trim(p_position), ''),
    (select nullif(trim(d.title), '') from public.designations d where d.id = p_designation_id),
    nullif(trim(p_legacy_designation), '')
  );
$$;
grant execute on function public.employee_designation_label(text, uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 1. Profile display columns mirroring the linked employee.
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists employee_number text,
  add column if not exists designation text;

-- Backfill snapshots for already-linked employees (idempotent).
update public.profiles p
set employee_number = e.employee_number,
    designation = public.employee_designation_label(e."position", e.designation_id)
from public.employees e
where p.employee_id = e.id
  and (p.employee_number is distinct from e.employee_number
       or p.designation is distinct from public.employee_designation_label(e."position", e.designation_id));

-- ------------------------------------------------------------
-- 2. provision_employee_account — never null-wipes employee-backed profile
--    fields. Employee values still take precedence when present.
-- ------------------------------------------------------------
create or replace function public.provision_employee_account(
  p_employee_id uuid,
  p_auth_user_id uuid,
  p_role text default 'staff',
  p_user_type text default 'staff',
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_employee public.employees;
  v_target public.profiles;
  v_branch_name text;
  v_department text;
  v_branch text;
  v_area text;
  v_existing_active boolean;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to provision employee accounts';
  end if;

  if p_employee_id is null or p_auth_user_id is null then
    raise exception 'Employee and auth user are required';
  end if;

  if p_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role in ('admin', 'area_manager', 'head_of_business')
     and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Not authorized to assign this role';
  end if;

  select * into v_employee
  from public.employees
  where id = p_employee_id
  for update;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if nullif(trim(v_employee.email), '') is null then
    raise exception 'This employee does not have a valid email address';
  end if;

  select * into v_target
  from public.profiles
  where id = p_auth_user_id
  for update;
  if v_target.id is null then
    raise exception 'Auth profile was not created';
  end if;
  if lower(trim(coalesce(v_target.email, ''))) <> lower(trim(v_employee.email)) then
    raise exception 'Employee email does not match the invitation email';
  end if;
  if v_target.employee_id is not null and v_target.employee_id <> p_employee_id then
    raise exception 'This auth account is already linked to another employee';
  end if;
  if v_employee.user_id is not null and v_employee.user_id <> p_auth_user_id then
    raise exception 'This employee is already linked to another auth account';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();
  v_existing_active := v_target.status = 'active';
  v_department := nullif(trim(v_employee.department), '');
  v_branch := nullif(trim(v_employee.branch), '');
  v_area := nullif(trim(v_employee.area), '');

  if v_employee.branch_id is not null then
    select branch_name into v_branch_name from public.branches where id = v_employee.branch_id;
    v_branch := coalesce(nullif(trim(v_branch_name), ''), v_branch);
  end if;

  update public.profiles
  set full_name = coalesce(v_employee.full_name, v_target.full_name),
      phone = coalesce(nullif(trim(v_employee.phone), ''), v_target.phone),
      department = coalesce(v_department, v_target.department),
      branch = coalesce(v_branch, v_target.branch),
      employee_number = coalesce(v_employee.employee_number, v_target.employee_number),
      designation = coalesce(public.employee_designation_label(v_employee."position", v_employee.designation_id), v_target.designation),
      employee_id = p_employee_id,
      role = case when v_existing_active then v_target.role else coalesce(nullif(p_role, ''), 'staff') end,
      user_type = coalesce(nullif(p_user_type, ''), 'staff'),
      status = case when v_existing_active then 'active' else 'pending' end,
      approved = case when v_existing_active then coalesce(v_target.approved, true) else false end,
      approved_by = case when v_existing_active then v_target.approved_by else null end,
      approved_at = case when v_existing_active then v_target.approved_at else null end,
      rejection_reason = null,
      rejected_reason = null
  where id = p_auth_user_id;

  update public.employees
  set user_id = p_auth_user_id,
      updated_at = now()
  where id = p_employee_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_ACCOUNT_LINKED', 'Employee', p_employee_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('Employee %s linked to auth user %s (%s)', v_employee.full_name, p_auth_user_id, coalesce(p_reason, 'employee account invitation')),
    'warning'
  );
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_ACCOUNT_ROLE_ASSIGNED', 'User', p_auth_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('Role=%s assigned to employee %s', coalesce(p_role, 'staff'), v_employee.full_name),
    'warning'
  );
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_ACCOUNT_ORG_ASSIGNED', 'Employee', p_employee_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('Department=%s, branch=%s, area=%s for employee %s', coalesce(v_department, 'N/A'), coalesce(v_branch, 'N/A'), coalesce(v_area, 'N/A'), v_employee.full_name),
    'warning'
  );

  return jsonb_build_object(
    'ok', true,
    'employee_id', p_employee_id,
    'auth_user_id', p_auth_user_id,
    'email', lower(trim(v_employee.email)),
    'department', v_department,
    'branch', v_branch,
    'area', v_area
  );
end;
$$;
grant execute on function public.provision_employee_account(uuid, uuid, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 3. approve_user (Phase 9 5-arg overload) — Users.jsx
--    Employee is the source of truth: blank department/branch fall back
--    to the employee record and the existing employee is linked instead
--    of creating a duplicate. Approver-provided values still win.
-- ------------------------------------------------------------
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
  if p_role in ('admin', 'area_manager', 'head_of_business') and v_actor_role not in ('super_admin', 'admin') then
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
                'head_of_business', 'operations_manager', 'loan_officer',
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

-- ------------------------------------------------------------
-- 4. approve_user (Phase 10 4-arg overload) — WorkManagement /
--    userApprovalService (role + department + modules).
--    Same hardened behavior: employee-sourced department/branch are
--    preserved when blanks are sent, the employee is linked (not
--    duplicated), identity fields are snapshotted, and the account is
--    consistently flagged approved.
-- ------------------------------------------------------------
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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'area_manager', 'branch_manager', 'head_of_business') then
    raise exception 'Not authorized to approve users';
  end if;
  if p_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role = 'admin' and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Only super_admin or admin can assign the admin role';
  end if;
  if p_role in ('area_manager', 'head_of_business') and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Only super_admin or admin can assign this role';
  end if;
  if v_actor_role = 'branch_manager' and p_role not in ('staff', 'loan_officer', 'relationship_manager', 'customer_service') then
    raise exception 'Branch Manager is not authorized to assign this role';
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
                          'head_of_business', 'operations_manager', 'loan_officer',
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