-- ============================================================================
-- schema_phase46_employee_guarantors_columns.sql
-- ============================================================================
-- Purpose:
--   Complete the phase38 table-healing of public.employee_guarantors.
--
-- Background:
--   schema_phase38_guarantor_relationship_healing.sql brought a stale live
--   employee_guarantors table up to canonical phase6 parity, but it did NOT
--   heal three columns that the canonical DDL (schema_phase6_hr_platform.sql
--   :340) declares: phone, profession, email. On environments whose table
--   predates phase6 these columns are still absent, so:
--     * submit_onboarding()  -> "column "phone" of relation
--                               "employee_guarantors" does not exist"
--       when a candidate submits the onboarding form from a generated link, and
--     * approve_guarantor_verification() -> same error when HR approves.
--
-- Remedy (idempotent, additive, non-destructive; mirrors phase38 style):
--   add column if not exists for every canonical phase6 column (the phase38
--   ones no-op on healed bases) with the exact defaults/checks from phase6.
--
-- Idempotent / safe to re-run.
-- ============================================================================

alter table public.employee_guarantors
  add column if not exists source text default 'manual'
    check (source in ('manual', 'onboarding'));

alter table public.employee_guarantors
  add column if not exists phone text;

alter table public.employee_guarantors
  add column if not exists profession text;

alter table public.employee_guarantors
  add column if not exists designation text;

alter table public.employee_guarantors
  add column if not exists business_address text;

alter table public.employee_guarantors
  add column if not exists residential_address text;

alter table public.employee_guarantors
  add column if not exists email text;

alter table public.employee_guarantors
  add column if not exists relationship text;

alter table public.employee_guarantors
  add column if not exists bvn text;

alter table public.employee_guarantors
  add column if not exists nin text;

alter table public.employee_guarantors
  add column if not exists verification_status text default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected'));

alter table public.employee_guarantors
  add column if not exists verification_comments text;

alter table public.employee_guarantors
  add column if not exists signature text;

alter table public.employee_guarantors
  add column if not exists signature_date date;

alter table public.employee_guarantors
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_emp_guard
  on public.employee_guarantors (employee_id);

alter table public.employee_guarantors enable row level security;

-- Idempotent backfill to canonical defaults (non-destructive).
update public.employee_guarantors
   set source             = coalesce(source, 'manual'),
       verification_status = coalesce(verification_status, 'pending'),
       updated_at          = coalesce(updated_at, now())
 where source is null
    or verification_status is null
    or updated_at is null;