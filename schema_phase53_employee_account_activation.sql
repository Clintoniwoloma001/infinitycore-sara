-- ============================================================
-- PHASE 53: EMPLOYEE ACCOUNT INVITATION + ACTIVATION
--
-- Keeps the employee record as the source of truth while providing a
-- server-authorized link between employees, profiles, and Supabase Auth.
-- Safe to re-run. Existing employee/auth data is preserved.
-- ============================================================

-- 1. Ensure the profile columns used by employee provisioning exist.
alter table public.profiles add column if not exists status text default 'pending';
alter table public.profiles add column if not exists approved boolean default false;
alter table public.profiles add column if not exists approved_by uuid references auth.users(id) on delete set null;
alter table public.profiles add column if not exists approved_at timestamptz;
alter table public.profiles add column if not exists department text;
alter table public.profiles add column if not exists branch text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists employee_id uuid references public.employees(id) on delete set null;
alter table public.profiles add column if not exists user_type text default 'customer';
alter table public.profiles add column if not exists rejection_reason text;
alter table public.profiles add column if not exists rejected_reason text;

-- Phase 9 and Phase 10 used different status/reason constraints. Normalize the
-- accepted set without removing any existing records.
alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('pending', 'active', 'inactive', 'suspended', 'rejected'));

-- 2. Invitation lifecycle metadata. `id` remains the invitation_id.
alter table public.employee_account_invites add column if not exists status text default 'sent';
alter table public.employee_account_invites add column if not exists expires_at timestamptz;
alter table public.employee_account_invites add column if not exists accepted_at timestamptz;
alter table public.employee_account_invites add column if not exists activated_at timestamptz;
alter table public.employee_account_invites add column if not exists resent_count integer not null default 0;
alter table public.employee_account_invites add column if not exists last_sent_at timestamptz;
alter table public.employee_account_invites add column if not exists revoked_at timestamptz;

alter table public.employee_account_invites drop constraint if exists employee_account_invites_result_check;
alter table public.employee_account_invites add constraint employee_account_invites_result_check
  check (result in ('SUCCESS', 'RESENT', 'ALREADY_EXISTS', 'INVALID_EMAIL', 'FAILED'));

alter table public.employee_account_invites drop constraint if exists employee_account_invites_status_check;
alter table public.employee_account_invites add constraint employee_account_invites_status_check
  check (status in ('pending', 'sent', 'accepted', 'activated', 'revoked', 'expired', 'failed'));

update public.employee_account_invites
set status = case
  when result in ('FAILED', 'INVALID_EMAIL') then 'failed'
  else coalesce(nullif(status, ''), 'sent')
end
where status is null or status = '' or result in ('FAILED', 'INVALID_EMAIL');

create index if not exists idx_employee_account_invites_employee_status
  on public.employee_account_invites(employee_id, status, invited_at desc);
create index if not exists idx_employee_account_invites_auth_user
  on public.employee_account_invites(auth_user_id, invited_at desc);

-- 3. Provision/link a profile through the caller's authenticated role. This
-- deliberately runs with the caller JWT so the existing profile role-change
-- trigger sees the real HR/admin actor instead of a service-role null actor.
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
    v_branch := coalesce(v_branch, nullif(trim(v_branch_name), ''));
  end if;

  update public.profiles
  set full_name = coalesce(v_employee.full_name, v_target.full_name),
      phone = v_employee.phone,
      department = v_department,
      branch = v_branch,
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

-- 4. Configure a non-employee user created from the existing Create User
-- modal without weakening the same role checks.
create or replace function public.configure_invited_user(
  p_user_id uuid,
  p_role text default 'staff',
  p_full_name text default null,
  p_phone text default null,
  p_department text default null,
  p_branch text default null,
  p_user_type text default 'staff'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target public.profiles;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to configure invited users';
  end if;
  if p_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role in ('admin', 'area_manager', 'head_of_business')
     and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Not authorized to assign this role';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if v_target.id is null then raise exception 'User profile not found'; end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.profiles
  set full_name = coalesce(p_full_name, full_name),
      phone = p_phone,
      department = p_department,
      branch = p_branch,
      role = coalesce(nullif(p_role, ''), 'staff'),
      user_type = coalesce(nullif(p_user_type, ''), 'staff'),
      status = 'pending',
      approved = false,
      approved_by = null,
      approved_at = null
  where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('USER_ACCOUNT_INVITED', 'User', p_user_id::text,
          coalesce(v_actor_name, auth.uid()::text),
          format('User %s invited with role %s', coalesce(v_target.email, p_user_id::text), coalesce(p_role, 'staff')),
          'warning');
  return jsonb_build_object('ok', true, 'user_id', p_user_id);
end;
$$;
grant execute on function public.configure_invited_user(uuid, text, text, text, text, text, text) to authenticated;

-- 5. Return only the current authenticated user's invitation context. The
-- activation page never accepts an email address from the browser.
create or replace function public.get_employee_invitation_context()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_inv public.employee_account_invites;
  v_profile public.profiles;
  v_employee public.employees;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_invitation');
  end if;

  select email into v_email from auth.users where id = v_user_id;
  select * into v_profile from public.profiles where id = v_user_id;
  select i.* into v_inv
  from public.employee_account_invites i
  where i.auth_user_id = v_user_id
  order by i.invited_at desc
  limit 1;

  if v_inv.id is null and v_profile.employee_id is not null then
    select * into v_employee from public.employees where id = v_profile.employee_id;
    select i.* into v_inv
    from public.employee_account_invites i
    where i.employee_id = v_profile.employee_id
      and lower(i.invited_email) = lower(coalesce(v_email, ''))
    order by i.invited_at desc
    limit 1;
  end if;

  if v_inv.id is null then
    if v_profile.status = 'active' and v_profile.employee_id is not null then
      return jsonb_build_object('ok', false, 'code', 'already_activated', 'email', v_email);
    end if;
    return jsonb_build_object('ok', false, 'code', 'invalid_invitation');
  end if;

  if lower(trim(coalesce(v_inv.invited_email, ''))) <> lower(trim(coalesce(v_email, ''))) then
    return jsonb_build_object('ok', false, 'code', 'email_mismatch');
  end if;
  if v_inv.status = 'revoked' then
    return jsonb_build_object('ok', false, 'code', 'revoked', 'email', v_email);
  end if;
  if v_inv.status in ('accepted', 'activated') then
    return jsonb_build_object('ok', false, 'code', 'already_activated', 'email', v_email);
  end if;
  if v_inv.expires_at is not null and v_inv.expires_at <= now() then
    update public.employee_account_invites set status = 'expired' where id = v_inv.id;
    return jsonb_build_object('ok', false, 'code', 'expired', 'email', v_email);
  end if;

  if v_employee.id is null then
    select * into v_employee from public.employees where id = v_inv.employee_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_inv.status,
    'email', v_email,
    'expires_at', v_inv.expires_at,
    'employee_id', v_employee.id,
    'employee_name', v_employee.full_name,
    'department', v_employee.department,
    'branch', coalesce(v_employee.branch, (select b.branch_name from public.branches b where b.id = v_employee.branch_id)),
    'area', v_employee.area
  );
end;
$$;
grant execute on function public.get_employee_invitation_context() to authenticated;

-- 6. Activate only the authenticated invitee's own account. This is
-- idempotent so a retry after a transient client error cannot create a second
-- identity or lose the audit trail.
create or replace function public.activate_employee_invitation()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_actor_name text;
  v_inv public.employee_account_invites;
  v_profile public.profiles;
  v_employee public.employees;
begin
  if v_user_id is null then return jsonb_build_object('ok', false, 'code', 'invalid_invitation'); end if;
  select email into v_email from auth.users where id = v_user_id;
  select * into v_profile from public.profiles where id = v_user_id for update;
  select full_name into v_actor_name from public.profiles where id = v_user_id;

  select i.* into v_inv
  from public.employee_account_invites i
  where i.auth_user_id = v_user_id
  order by i.invited_at desc
  limit 1;

  if v_inv.id is null and v_profile.employee_id is not null then
    select i.* into v_inv
    from public.employee_account_invites i
    where i.employee_id = v_profile.employee_id
      and lower(i.invited_email) = lower(coalesce(v_email, ''))
    order by i.invited_at desc
    limit 1;
  end if;
  if v_inv.id is null then return jsonb_build_object('ok', false, 'code', 'invalid_invitation'); end if;
  if lower(trim(coalesce(v_inv.invited_email, ''))) <> lower(trim(coalesce(v_email, ''))) then
    return jsonb_build_object('ok', false, 'code', 'email_mismatch');
  end if;
  if v_inv.status = 'revoked' then return jsonb_build_object('ok', false, 'code', 'revoked'); end if;
  if v_inv.expires_at is not null and v_inv.expires_at <= now() then
    update public.employee_account_invites set status = 'expired' where id = v_inv.id;
    return jsonb_build_object('ok', false, 'code', 'expired');
  end if;

  if v_profile.status = 'active' and v_inv.status in ('accepted', 'activated') then
    return jsonb_build_object('ok', true, 'code', 'already_activated', 'employee_id', v_profile.employee_id);
  end if;

  update public.profiles
  set status = 'active', approved = true, approved_at = coalesce(approved_at, now()),
      rejection_reason = null, rejected_reason = null
  where id = v_user_id;

  update public.employee_account_invites
  set status = 'activated', accepted_at = coalesce(accepted_at, now()), activated_at = now(), last_sent_at = coalesce(last_sent_at, invited_at)
  where id = v_inv.id;

  select * into v_employee from public.employees where id = coalesce(v_profile.employee_id, v_inv.employee_id);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_INVITATION_ACCEPTED', 'Employee', coalesce(v_employee.id, v_inv.employee_id)::text,
          coalesce(v_actor_name, v_email), format('Invitation accepted for %s', v_email), 'info');
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PASSWORD_ACTIVATED', 'User', v_user_id::text,
          coalesce(v_actor_name, v_email), format('Password activated for employee account %s', v_email), 'info');

  return jsonb_build_object('ok', true, 'code', 'activated', 'employee_id', coalesce(v_profile.employee_id, v_inv.employee_id), 'email', v_email);
end;
$$;
grant execute on function public.activate_employee_invitation() to authenticated;
