-- ============================================================================
-- schema_phase38_guarantor_relationship_healing.sql
-- ----------------------------------------------------------------------------
-- ROOT CAUSE (verified against on-disk migrations + canonical phase6 DDL)
--
--   schema_phase6_hr_platform.sql:340 creates `employee_guarantors` WITH
--   `source text default 'manual' check (source in ('manual','onboarding'))`
--   plus the full verification column family (verification_status,
--   verification_comments, signature, signature_date, updated_at, bvn, nin,
--   relationship, designation, business_address, residential_address).
--
--   Every employee_guarantors CREATE across the repo is `create table if not
--   exists`, and NO migration 7-37 performs an `alter table ... add column`
--   heal on that table. Therefore any environment whose
--   public.employee_guarantors table was created by an EARLIER base migration
--   (pre-phase6), or which ran phase6 before `source` was appended, silently
--   keeps the STALE table — `create table if not exists` no-ops — and the
--   canonical columns never materialize.
--
--   The app then writes the phase6-shaped row (source 'manual'/'onboarding')
--   and Postgres throws the exact observed error:
--       column "source" of relation "employee_guarantors" does not exist
--
-- REMEDY (idempotent, additive, non-destructive; NO drop, NO rename, NO
-- parallel table, NO data loss):
--   Bring a stale live table to exact canonical phase6 parity using
--   `add column if not exists` + `column default` backfill + index + RLS
--   re-assertion. Safe to re-run on any environment, including phase6-clean.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Canonical phase6 columns, healed on the EXISTING table. Every one is
--    guarded `IF NOT EXISTS` so phase6-clean bases no-op and identical live
--    columns are untouched. Defaults/checks mirror schema_phase6_hr_platform.sql
--    340-368 exactly.
-- ---------------------------------------------------------------------------
alter table public.employee_guarantors
  add column if not exists source text default 'manual'
    check (source in ('manual', 'onboarding'));

alter table public.employee_guarantors
  add column if not exists relationship text;

alter table public.employee_guarantors
  add column if not exists designation text;

alter table public.employee_guarantors
  add column if not exists business_address text;

alter table public.employee_guarantors
  add column if not exists residential_address text;

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

-- Index already created in canonical phase6; healed here for stale bases.
create index if not exists idx_emp_guard
  on public.employee_guarantors (employee_id);

-- RLS re-asserted (phase6 enables it; stale bases may not have).
alter table public.employee_guarantors enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Idempotent backfill of ANY pre-existing rows to canonical phase6 values.
--    Non-destructive: only NULL/obviously-stale values are normalized to the
--    defaults, and only when the canonical DDL would have produced them.
-- ---------------------------------------------------------------------------
update public.employee_guarantors
   set source             = coalesce(source, 'manual'),
       verification_status = coalesce(verification_status, 'pending'),
       updated_at          = coalesce(updated_at, now())
 where source is null
    or verification_status is null
    or updated_at is null;

-- ============================================================================
-- 3. RELATIONSHIP GUARANTEES (no orphaned records — the app's canonical write)
--    The employee -> guarantor relationship is enforced by the existing
--    canonical FK: employee_guarantors.employee_id references employees(id)
--    (phase6:341, on delete cascade), NOT by name/email matching. The healing
--    above never touches employee_id, so the ONBOARDING -> GUARANTOR
--    REQUEST -> EMPLOYEE chain (the canonical onboarding submit writes
--    tenant-guarantor rows with the SAME employee_id) is preserved for every
--    pre-existing and new row. Nothing here re-keys, renames, or duplicates
--    relationship records.
-- ============================================================================
