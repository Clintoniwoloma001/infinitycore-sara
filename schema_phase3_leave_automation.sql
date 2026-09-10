-- ============================================================
-- PHASE 3: LEAVE BALANCE AUTOMATION + DIGITAL SIGNATURE
--
-- CORRECTED HR LEAVE POLICY
--
-- APPROVED LEAVE TYPES:
--   1. Annual Leave       → Staff 10 days / Management 15 / MD 20
--   2. Maternity Leave    → 90 days
--   3. Examination Leave  → 5 days
--   4. Paternity Leave    → 2 days
--
-- ANNUAL LEAVE RULE:
--   normal_staff      = 10 days
--   management_staff  = 15 days
--   md                = 20 days
--
-- Safe to re-run.
-- Existing used leave is preserved.
-- Existing entitlement values are synchronized to HR policy.
-- ============================================================


-- ============================================================
-- 1. LEAVE BALANCES
--    One row per employee per leave type per year
-- ============================================================

create table if not exists public.leave_balances (
  id uuid primary key default gen_random_uuid(),

  employee_id uuid not null
    references auth.users(id)
    on delete cascade,

  employee_name text,

  year int not null,

  leave_type text not null,

  entitled_days numeric not null default 0,

  used_days numeric not null default 0,

  created_at timestamptz default now(),

  updated_at timestamptz default now(),

  unique (employee_id, year, leave_type)
);


-- ============================================================
-- 2. CORRECT THE LEAVE TYPE CONSTRAINT
--
-- ONLY THESE FOUR LEAVE TYPES ARE VALID:
-- annual
-- maternity
-- examination
-- paternity
-- ============================================================

alter table public.leave_balances
  drop constraint if exists leave_balances_leave_type_check;

alter table public.leave_balances
  add constraint leave_balances_leave_type_check
  check (
    leave_type in (
      'annual',
      'maternity',
      'examination',
      'paternity'
    )
  );


-- ============================================================
-- 3. INDEX
-- ============================================================

create index if not exists
idx_leave_balances_employee_year
on public.leave_balances(employee_id, year);


-- ============================================================
-- 4. DIGITAL SIGNATURE ON LEAVE REQUESTS
-- ============================================================

alter table public.leave_requests
  add column if not exists approver_signature text;


-- ============================================================
-- 5. KEEP updated_at FRESH
-- ============================================================

create or replace function public.touch_leave_balance()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


drop trigger if exists trg_touch_leave_balance
on public.leave_balances;

create trigger trg_touch_leave_balance
before update on public.leave_balances
for each row
execute function public.touch_leave_balance();


-- ============================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================

alter table public.leave_balances
enable row level security;


drop policy if exists "leave_balances read own or hr"
on public.leave_balances;

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
    'operations_manager'
  )
);


drop policy if exists "leave_balances write hr"
on public.leave_balances;

create policy "leave_balances write hr"
on public.leave_balances
for all
using (
  public.current_role() in (
    'admin',
    'super_admin',
    'hr_manager'
  )
)
with check (
  public.current_role() in (
    'admin',
    'super_admin',
    'hr_manager'
  )
);


-- ============================================================
-- 7. ALLOW A USER TO INITIALIZE THEIR OWN BALANCE
-- ============================================================

drop policy if exists "leave_balances self insert"
on public.leave_balances;

create policy "leave_balances self insert"
on public.leave_balances
for insert
with check (
  employee_id = auth.uid()
);


-- ============================================================
-- 8. FUNCTION: GET ANNUAL LEAVE ENTITLEMENT
--
-- HR POLICY:
--
-- normal_staff      = 10 days
-- management_staff  = 15 days
-- md                = 20 days
--
-- employee_category is stored on public.employees.
--
-- If an employee record cannot be found, default to
-- normal_staff = 10 days.
-- ============================================================

create or replace function public.get_annual_leave_entitlement(
  p_user_id uuid
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category text;
begin

  select employee_category
  into v_category
  from public.employees
  where user_id = p_user_id
  limit 1;

  return case
    when lower(coalesce(v_category, 'normal_staff')) = 'md'
      then 20

    when lower(coalesce(v_category, 'normal_staff')) = 'management_staff'
      then 15

    else 10
  end;

end;
$$;


grant execute on function public.get_annual_leave_entitlement(uuid)
to authenticated;


-- ============================================================
-- 9. FUNCTION: GET ENTITLEMENT FOR ANY APPROVED LEAVE TYPE
-- ============================================================

create or replace function public.get_leave_entitlement(
  p_user_id uuid,
  p_leave_type text
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
begin

  return case

    when p_leave_type = 'annual'
      then public.get_annual_leave_entitlement(p_user_id)

    when p_leave_type = 'maternity'
      then 90

    when p_leave_type = 'examination'
      then 5

    when p_leave_type = 'paternity'
      then 2

    else 0

  end;

end;
$$;


grant execute on function public.get_leave_entitlement(uuid, text)
to authenticated;


-- ============================================================
-- 10. SYNCHRONIZE ONE EMPLOYEE'S LEAVE BALANCES
--
-- This is the key correction.
--
-- It does NOT simply "insert if missing".
--
-- It also UPDATES EXISTING ENTITLEMENTS so an old value such
-- as Annual = 15/15 is corrected to:
--
--   Staff       → 10/10
--   Management  → 15/15
--   MD          → 20/20
--
-- Used days are NEVER overwritten.
-- ============================================================

create or replace function public.sync_employee_leave_balances(
  p_user_id uuid,
  p_year int default extract(year from current_date)::int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_name text;
  v_annual_days numeric;
begin

  -- Get employee/profile name
  select coalesce(
    p.full_name,
    p.email
  )
  into v_employee_name
  from public.profiles p
  where p.id = p_user_id;

  -- Determine annual entitlement from employee category
  v_annual_days :=
    public.get_annual_leave_entitlement(p_user_id);


  -- ==========================================================
  -- ANNUAL LEAVE
  -- ==========================================================

  insert into public.leave_balances (
    employee_id,
    employee_name,
    year,
    leave_type,
    entitled_days,
    used_days
  )
  values (
    p_user_id,
    v_employee_name,
    p_year,
    'annual',
    v_annual_days,
    0
  )
  on conflict (
    employee_id,
    year,
    leave_type
  )
  do update
  set
    employee_name = excluded.employee_name,
    entitled_days = v_annual_days,
    updated_at = now();


  -- ==========================================================
  -- MATERNITY LEAVE = 90 DAYS
  -- ==========================================================

  insert into public.leave_balances (
    employee_id,
    employee_name,
    year,
    leave_type,
    entitled_days,
    used_days
  )
  values (
    p_user_id,
    v_employee_name,
    p_year,
    'maternity',
    90,
    0
  )
  on conflict (
    employee_id,
    year,
    leave_type
  )
  do update
  set
    employee_name = excluded.employee_name,
    entitled_days = 90,
    updated_at = now();


  -- ==========================================================
  -- EXAMINATION LEAVE = 5 DAYS
  -- ==========================================================

  insert into public.leave_balances (
    employee_id,
    employee_name,
    year,
    leave_type,
    entitled_days,
    used_days
  )
  values (
    p_user_id,
    v_employee_name,
    p_year,
    'examination',
    5,
    0
  )
  on conflict (
    employee_id,
    year,
    leave_type
  )
  do update
  set
    employee_name = excluded.employee_name,
    entitled_days = 5,
    updated_at = now();


  -- ==========================================================
  -- PATERNITY LEAVE = 2 DAYS
  -- ==========================================================

  insert into public.leave_balances (
    employee_id,
    employee_name,
    year,
    leave_type,
    entitled_days,
    used_days
  )
  values (
    p_user_id,
    v_employee_name,
    p_year,
    'paternity',
    2,
    0
  )
  on conflict (
    employee_id,
    year,
    leave_type
  )
  do update
  set
    employee_name = excluded.employee_name,
    entitled_days = 2,
    updated_at = now();

end;
$$;


grant execute on function public.sync_employee_leave_balances(uuid, int)
to authenticated;


-- ============================================================
-- 11. YEARLY RESET / SYNCHRONIZATION
--
-- Synchronizes EVERY existing profile.
--
-- IMPORTANT:
-- Existing used_days are preserved.
--
-- Example:
--   Old Annual = 15 entitlement, 3 used
--
-- Staff becomes:
--   Annual = 10 entitlement, 3 used
--
-- Therefore:
--   Available = 7
--
-- No leave history is deleted.
-- ============================================================

create or replace function public.reset_annual_leave_balances(
  target_year int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
begin

  for p in
    select
      id,
      coalesce(full_name, email) as full_name
    from public.profiles
  loop

    perform public.sync_employee_leave_balances(
      p.id,
      target_year
    );

  end loop;

end;
$$;


grant execute on function public.reset_annual_leave_balances(int)
to authenticated;


-- ============================================================
-- 12. REMOVE OLD / UNSUPPORTED BALANCE TYPES
--
-- HR has confirmed that the system should contain ONLY:
--
-- annual
-- maternity
-- examination
-- paternity
--
-- This removes obsolete balance rows such as:
-- sick / personal / unpaid
--
-- No valid leave balance is affected.
-- ============================================================

delete from public.leave_balances
where leave_type not in (
  'annual',
  'maternity',
  'examination',
  'paternity'
);


-- ============================================================
-- 13. SYNCHRONIZE CURRENT YEAR
--
-- This is what fixes the current mismatch immediately.
--
-- For 2026:
--
-- STAFF:
--   Annual       10
--   Maternity    90
--   Examination   5
--   Paternity     2
--
-- MANAGEMENT:
--   Annual       15
--   Maternity    90
--   Examination   5
--   Paternity     2
--
-- MD:
--   Annual       20
--   Maternity    90
--   Examination   5
--   Paternity     2
-- ============================================================

select public.reset_annual_leave_balances(2026);


-- ============================================================
-- 14. OPTIONAL AUTOMATIC CURRENT-YEAR SYNC FUNCTION
--
-- The application can call this whenever the Leave Balances
-- page loads to ensure entitlement values remain aligned with
-- employee category.
-- ============================================================

create or replace function public.ensure_current_user_leave_balances()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin

  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform public.sync_employee_leave_balances(
    auth.uid(),
    extract(year from current_date)::int
  );

end;
$$;


grant execute on function public.ensure_current_user_leave_balances()
to authenticated;


-- ============================================================
-- DONE
--
-- FINAL HR POLICY:
--
--                  ANNUAL   MATERNITY   EXAMINATION   PATERNITY
-- STAFF               10        90           5             2
-- MANAGEMENT          15        90           5             2
-- MD                  20        90           5             2
--
-- Existing used_days are preserved.
-- Entitlements are corrected automatically.
-- ============================================================
