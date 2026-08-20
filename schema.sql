-- ============================================================
-- Infinity Bank Operations — Supabase schema, RLS & triggers
-- Run this in your Supabase project: SQL Editor → New query → Run
-- ============================================================

-- 1. PROFILES (joins to auth.users, holds the role)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'staff' check (role in ('admin','manager','staff')),
  created_at timestamptz default now()
);

-- 2. CUSTOMERS
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  address text,
  date_of_birth date,
  national_id text,            -- stored encrypted (AES-256-GCM) via the sensitiveField backend function
  account_number text,         -- stored encrypted (AES-256-GCM) via the sensitiveField backend function
  employment_status text default 'employed',
  employer text,
  monthly_income numeric default 0,
  credit_score numeric default 0,
  status text default 'pending',
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 3. LOAN APPLICATIONS
create table if not exists public.loan_applications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  customer_name text,
  amount numeric not null,
  purpose text,
  term_months int not null,
  interest_rate numeric default 12,
  employment_status text default 'employed',
  monthly_income numeric default 0,
  monthly_expenses numeric default 0,
  existing_debt numeric default 0,
  repayment_history_score numeric default 50,
  risk_score numeric,
  risk_level text,
  approval_route text,
  status text default 'pending',
  reviewed_by_name text,
  reviewed_date timestamptz,
  approval_comments text,
  disbursed_date date,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 4. LOANS (disbursed loans)
create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  application_id uuid,
  customer_id uuid,
  customer_name text,
  principal_amount numeric,
  outstanding_balance numeric,
  interest_rate numeric,
  term_months int,
  monthly_payment numeric,
  status text default 'active',
  disbursed_date date,
  maturity_date date,
  created_at timestamptz default now()
);

-- 5. REPAYMENTS
create table if not exists public.repayments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid,
  customer_id uuid,
  customer_name text,
  amount numeric not null,
  due_date date,
  payment_date date,
  status text default 'pending',
  payment_method text,
  created_at timestamptz default now()
);

-- 6. LEAVE REQUESTS (workflow engine)
create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_name text,
  leave_type text default 'annual',
  start_date date,
  end_date date,
  days int,
  reason text,
  status text default 'pending',
  approval_level int default 1,
  approved_by_name text,
  approved_date timestamptz,
  approval_comments text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- 7. AUDIT LOGS
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  entity_type text,
  entity_id text,
  user_name text,
  details text,
  severity text default 'info',
  created_at timestamptz default now()
);

-- 8. NOTIFICATIONS
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  title text not null,
  message text,
  type text default 'system',
  read boolean default false,
  link text,
  created_at timestamptz default now()
);

-- Auto-create a profile row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Enable Row-Level Security
alter table public.profiles          enable row level security;
alter table public.customers         enable row level security;
alter table public.loan_applications enable row level security;
alter table public.loans             enable row level security;
alter table public.repayments        enable row level security;
alter table public.leave_requests    enable row level security;
alter table public.audit_logs        enable row level security;
alter table public.notifications     enable row level security;

-- Helper: current user's role
-- security definer is REQUIRED here: without it, this function's own
-- lookup against public.profiles gets re-checked by profiles' RLS
-- policy, which calls this function again — infinite recursion
-- ("stack depth limit exceeded"). Do not remove security definer.
create or replace function public.current_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'staff');
$$;

-- PROFILES policies
create policy "profiles read own or admin" on public.profiles
  for select using (auth.uid() = id or public.current_role() = 'admin');
create policy "profiles update own or admin" on public.profiles
  for update using (auth.uid() = id or public.current_role() = 'admin');

-- CUSTOMERS — all authenticated staff read; managers/admins write
create policy "customers read" on public.customers
  for select using (auth.role() = 'authenticated');
create policy "customers insert" on public.customers
  for insert with check (auth.role() = 'authenticated');
create policy "customers update" on public.customers
  for update using (public.current_role() in ('admin','manager'));
create policy "customers delete" on public.customers
  for delete using (public.current_role() = 'admin');

-- LOAN APPLICATIONS — staff submit; managers/admins approve
create policy "loan_apps read" on public.loan_applications
  for select using (auth.role() = 'authenticated');
create policy "loan_apps insert" on public.loan_applications
  for insert with check (auth.role() = 'authenticated');
create policy "loan_apps update" on public.loan_applications
  for update using (created_by = auth.uid() or public.current_role() in ('admin','manager'));
create policy "loan_apps delete" on public.loan_applications
  for delete using (public.current_role() = 'admin');

-- LOANS — managers/admins manage
create policy "loans read" on public.loans
  for select using (auth.role() = 'authenticated');
create policy "loans write" on public.loans
  for all using (public.current_role() in ('admin','manager'))
  with check (public.current_role() in ('admin','manager'));

-- REPAYMENTS — managers/admins manage
create policy "repayments read" on public.repayments
  for select using (auth.role() = 'authenticated');
create policy "repayments write" on public.repayments
  for all using (public.current_role() in ('admin','manager'))
  with check (public.current_role() in ('admin','manager'));

-- LEAVE REQUESTS — own or manager/admin
create policy "leave read" on public.leave_requests
  for select using (created_by = auth.uid() or public.current_role() in ('admin','manager'));
create policy "leave insert" on public.leave_requests
  for insert with check (auth.role() = 'authenticated');
create policy "leave update" on public.leave_requests
  for update using (created_by = auth.uid() or public.current_role() in ('admin','manager'));
create policy "leave delete" on public.leave_requests
  for delete using (public.current_role() = 'admin');

-- AUDIT LOGS — admin only
create policy "audit read" on public.audit_logs
  for select using (public.current_role() = 'admin');
create policy "audit insert" on public.audit_logs
  for insert with check (auth.role() = 'authenticated');

-- NOTIFICATIONS — owner only
create policy "notif read"   on public.notifications for select using (user_id = auth.uid());
create policy "notif insert" on public.notifications for insert with check (auth.role() = 'authenticated');
create policy "notif update" on public.notifications for update using (user_id = auth.uid());
create policy "notif delete" on public.notifications for delete using (user_id = auth.uid());