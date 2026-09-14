-- ============================================================
-- PHASE 13 — STAFF IDENTITY
--   • employees.employee_number / staff_id / staff_id_issued_at
--   • idempotent, collision-safe number generation RPC
--   • assigned automatically at onboarding completion (self-service)
--     and available to HR/admin via the same RPC
-- Idempotent + additive — safe to re-run.
-- ============================================================

alter table public.employees add column if not exists employee_number text;
alter table public.employees add column if not exists staff_id text;
alter table public.employees add column if not exists staff_id_issued_at timestamptz;

create unique index if not exists uq_employees_employee_number
  on public.employees(employee_number) where employee_number is not null;
create unique index if not exists uq_employees_staff_id
  on public.employees(staff_id) where staff_id is not null;

-- ============================================================
-- RPC: generate_employee_number(p_employee_id)
--   Assigns a permanent Employee Number / Staff ID (IB-EMP-#####).
--   Idempotent: returns the existing value if already assigned.
--   Collision-safe: retries with the next sequence when taken.
--   Authorized: HR/admin roles, or the employee themself.
-- ============================================================
create or replace function public.generate_employee_number(p_employee_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp public.employees;
  v_actor_role text := public.current_role();
  v_next int;
  v_code text;
  v_actor_name text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    select * into v_emp from public.employees where id = p_employee_id;
    if v_emp.id is null or v_emp.user_id is distinct from auth.uid() then
      raise exception 'Not authorized to assign staff ID';
    end if;
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  -- Idempotent — return existing assignment
  if v_emp.employee_number is not null then
    return jsonb_build_object(
      'ok', true,
      'exists', true,
      'employee_number', v_emp.employee_number,
      'staff_id', coalesce(v_emp.staff_id, v_emp.employee_number)
    );
  end if;

  select count(*) + 1 into v_next from public.employees where employee_number is not null;

  loop
    v_code := 'IB-EMP-' || lpad(v_next::text, 5, '0');
    exit when not exists (
      select 1 from public.employees
      where employee_number = v_code or staff_id = v_code or employee_code = v_code
    );
    v_next := v_next + 1;
  end loop;

  update public.employees set
    employee_number = v_code,
    staff_id = v_code,
    employee_code = coalesce(employee_code, v_code),
    staff_id_issued_at = now(),
    updated_at = now()
  where id = p_employee_id;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'STAFF_ID_ASSIGNED',
    'Employee',
    p_employee_id::text,
    coalesce(v_actor_name, v_actor_role, auth.uid()::text),
    format('Assigned employee number %s', v_code),
    'info'
  );

  return jsonb_build_object(
    'ok', true,
    'exists', false,
    'employee_number', v_code,
    'staff_id', v_code
  );
end; $$;

grant execute on function public.generate_employee_number(uuid) to authenticated;