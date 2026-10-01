-- Authoritative HR employee master: multi-branch assignments, three-level
-- supervisor hierarchy, and a reconciliation/review layer for the reviewed
-- workbook.
--
-- SAFETY CONTRACT
--   * Existing auth users, profiles, employee ids and every historical business
--     record (payroll, attendance, leave, appraisal, audit) are NEVER deleted or
--     recreated. This migration only adds structure and reconciles in place.
--   * An import is a SESSION. Nothing reaches employees / employee_supervisors
--     until a session is applied, and then only its SAFE rows.
--   * Anything ambiguous is queued for a human decision, never guessed.
--   * Idempotent: re-running never duplicates an employee, branch assignment,
--     supervisor link or mapping.
--
-- Run after the latest 20260931* migration.

begin;

-- ---------------------------------------------------------------------------
-- 1. Multi-branch responsibility (Phase 5)
-- ---------------------------------------------------------------------------
create table if not exists public.employee_branch_assignments (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id) on delete cascade,
  branch_id      uuid references public.branches(id) on delete set null,
  -- Verbatim workbook label, kept even when no canonical branch matched, so a
  -- later reconciliation can finish the mapping without re-importing.
  branch_label   text not null,
  branch_label_norm text,
  assignment_type text not null default 'responsibility',
  is_primary     boolean not null default false,
  is_active      boolean not null default true,
  source_sheet   text,
  effective_from date,
  effective_to   date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint employee_branch_assignments_type_check
    check (assignment_type in ('primary','responsibility','temporary')),
  constraint employee_branch_assignments_dates_check
    check (effective_to is null or effective_from is null or effective_to >= effective_from)
);
create unique index if not exists uq_employee_branch_assignment_active
  on public.employee_branch_assignments (employee_id, branch_label_norm)
  where is_active;
create index if not exists idx_employee_branch_assignments_branch on public.employee_branch_assignments (branch_id);
create index if not exists idx_employee_branch_assignments_employee on public.employee_branch_assignments (employee_id, is_active);
-- An employee has at most ONE active primary assignment.
create unique index if not exists uq_employee_branch_assignment_one_primary
  on public.employee_branch_assignments (employee_id)
  where is_primary and is_active;

comment on table public.employee_branch_assignments is
  'One employee may hold several branch responsibilities. An employee is NEVER duplicated to represent a second location.';

-- ---------------------------------------------------------------------------
-- 2. Import session (Phase 16) — durable, resumable, never auto-deleted
-- ---------------------------------------------------------------------------
create table if not exists public.hr_master_import_sessions (
  id             uuid primary key default gen_random_uuid(),
  session_uid    uuid not null default gen_random_uuid(),
  source_filename text not null,
  source_file_hash text,
  as_at_date     date not null default current_date,
  status         text not null default 'previewed',
  totals         jsonb not null default '{}'::jsonb,
  mapping_version text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  applied_at     timestamptz,
  error_message  text,
  constraint hr_master_import_sessions_status_check
    check (status in ('previewed','applied','rejected','superseded','failed'))
);
create unique index if not exists uq_hr_master_session_uid on public.hr_master_import_sessions (session_uid);
-- ---------------------------------------------------------------------------
-- 3. Reconciled person (one row per PERSON, not per workbook row)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_master_people (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.hr_master_import_sessions(id) on delete cascade,
  staff_id       text,
  staff_id_norm  text,
  full_name_raw  text not null,
  full_name_norm text,
  confirmed_status text,
  designation    text,
  department     text,
  email          text,
  source_sheets  text[] not null default '{}',
  identity_kind  text not null,
  match_key      text,
  employee_id    uuid references public.employees(id) on delete set null,
  conflict_reason text,
  needs_review   boolean not null default true,
  created_at     timestamptz not null default now(),
  constraint hr_master_people_identity_kind_check
    check (identity_kind in ('match_existing','new_employee','staff_id_conflict','duplicate_name','unidentifiable'))
);
create index if not exists idx_hr_master_people_session on public.hr_master_people (session_id);
create index if not exists idx_hr_master_people_staff on public.hr_master_people (staff_id_norm);
create index if not exists idx_hr_master_people_employee on public.hr_master_people (employee_id);
create index if not exists idx_hr_master_people_review on public.hr_master_people (session_id) where needs_review;

-- ---------------------------------------------------------------------------
-- 4. Supervisor + branch links proposed by a session (Phase 7/8)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_master_supervisor_links (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.hr_master_import_sessions(id) on delete cascade,
  person_id      uuid not null references public.hr_master_people(id) on delete cascade,
  level          integer not null check (level between 1 and 3),
  source_label   text,
  source_label_norm text,
  match_tier     text not null,
  supervisor_employee_id uuid references public.employees(id) on delete set null,
  candidates     jsonb not null default '[]'::jsonb,
  status         text not null default 'pending',
  resolved_by    uuid,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  constraint hr_master_supervisor_links_status_check
    check (status in ('pending','applied','unresolved','organisation_body'))
);
create unique index if not exists uq_hr_master_supervisor_link on public.hr_master_supervisor_links (person_id, level);
create index if not exists idx_hr_master_supervisor_links_review on public.hr_master_supervisor_links (session_id) where status = 'pending';

create table if not exists public.hr_master_branch_links (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.hr_master_import_sessions(id) on delete cascade,
  branch_label   text not null,
  branch_label_norm text not null,
  is_combined    boolean not null default false,
  combined_parts text[] not null default '{}',
  canonical_branch_id uuid references public.branches(id) on delete set null,
  mapping_method text,
  status         text not null default 'pending',
  resolved_by    uuid,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  constraint hr_master_branch_links_status_check
    check (status in ('pending','mapped','split','unresolved'))
);
create unique index if not exists uq_hr_master_branch_link on public.hr_master_branch_links (session_id, branch_label_norm);

-- ---------------------------------------------------------------------------
-- 5. Permanent, reusable mappings (Phase 8/12) — learned once, reused forever
-- ---------------------------------------------------------------------------
create table if not exists public.hr_supervisor_label_mappings (
  id             uuid primary key default gen_random_uuid(),
  normalized_label text not null,
  raw_label      text,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  mapping_type   text not null,
  confidence     numeric(5,4),
  status         text not null default 'active',
  source         text not null default 'hr_review',
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint hr_supervisor_label_mappings_status_check check (status in ('active','revoked'))
);
create unique index if not exists uq_hr_supervisor_label_mapping_active
  on public.hr_supervisor_label_mappings (normalized_label) where status = 'active';

create table if not exists public.hr_branch_label_mappings (
  id             uuid primary key default gen_random_uuid(),
  normalized_label text not null,
  raw_label      text,
  canonical_branch_id uuid not null references public.branches(id) on delete cascade,
  mapping_method text not null default 'manual',
  status         text not null default 'active',
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint hr_branch_label_mappings_status_check check (status in ('active','revoked'))
);
create unique index if not exists uq_hr_branch_label_mapping_active
  on public.hr_branch_label_mappings (normalized_label) where status = 'active';

commit;

-- Refresh PostgREST's schema cache so the new objects are callable at once.
notify pgrst, 'reload schema';
-- Re-importing the same file reuses the session instead of duplicating people.
create unique index if not exists uq_hr_master_session_hash on public.hr_master_import_sessions (source_file_hash)
  where source_file_hash is not null and status <> 'rejected';
comment on table public.hr_master_import_sessions is
  'One row per workbook import; the unit of idempotency for the whole migration.';