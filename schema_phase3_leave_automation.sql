-- ============================================================
-- Phase 3: Leave Balance Automation + Digital Signature
-- Run this manually in Supabase SQL Editor.
-- Safe to re-run: every statement uses IF NOT EXISTS / OR REPLACE.
-- ============================================================

-- 1. LEAVE BALANCES — one row per employee per leave type per year
create table if not exists public.leave_balances (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references auth.users(id) on delete cascade,
  employee_name text,
  year int not null,
  leave_type text not null check (leave_type in ('annual','sick','maternity','paternity','personal','unpaid')),
  entitled_days numeric not null default 0,
  used_days numeric not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (employee_id, year, leave_type)
);

create index if not exists idx_leave_balances_employee_year on public.leave_balances(employee_id, year);

-- 2. SIGNATURE ON LEAVE REQUESTS — approver signs off digitally
alter table public.leave_requests add column if not exists approver_signature text;

-- 3. Keep updated_at fresh on balance changes
create or replace function public.touch_leave_balance()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_touch_leave_balance on public.leave_balances;
create trigger trg_touch_leave_balance
  before update on public.leave_balances
  for each row execute function public.touch_leave_balance();

-- 4. Row Level Security
alter table public.leave_balances enable row level security;

drop policy if exists "leave_balances read own or hr" on public.leave_balances;
create policy "leave_balances read own or hr" on public.leave_balances
  for select using (
    employee_id = auth.uid()
    or public.current_role() in ('admin','super_admin','manager','hr_manager','hr_officer','branch_manager','operations_manager')
  );

drop policy if exists "leave_balances write hr" on public.leave_balances;
create policy "leave_balances write hr" on public.leave_balances
  for all using (
    public.current_role() in ('admin','super_admin','hr_manager')
  )
  with check (
    public.current_role() in ('admin','super_admin','hr_manager')
  );

-- Allow the approval workflow (any authenticated user acting through the app)
-- to insert a first-time balance row for themselves so the app can
-- "auto-initialize" a balance on first use without needing an HR admin
-- to have done it in advance.
drop policy if exists "leave_balances self insert" on public.leave_balances;
create policy "leave_balances self insert" on public.leave_balances
  for insert with check (employee_id = auth.uid());

-- 5. Yearly reset function — creates fresh balance rows for a given year
--    at the default entitlements, for every profile that doesn't already
--    have a row for that year/type. Safe to run multiple times.
--    Call from Supabase SQL editor: select public.reset_annual_leave_balances(2027);
create or replace function public.reset_annual_leave_balances(target_year int)
returns void language plpgsql security definer set search_path = public as $$
declare
  defaults jsonb := '{"annual":21,"sick":10,"maternity":90,"paternity":10,"personal":5}'::jsonb;
  lt text;
  p record;
begin
  for p in select id, coalesce(full_name, email) as full_name from public.profiles loop
    for lt in select jsonb_object_keys(defaults) loop
      insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
      values (p.id, p.full_name, target_year, lt, (defaults->>lt)::numeric, 0)
      on conflict (employee_id, year, leave_type) do nothing;
    end loop;
  end loop;
end; $$;

-- ============================================================
-- DONE. Next: run "select public.reset_annual_leave_balances(2026);"
-- once to seed balances for the current year for all existing users.
-- ============================================================
