-- ============================================================================
-- 20261101000007a — STAGING SCHEMA for the authoritative employee replace
-- ============================================================================
--
--   ##  RUN THIS FIRST.  ##
--
--   ##  It is safe to re-run.  ##
--
-- The three generated value files (employee_source_values.sql,
-- employee_branch_values.sql, employee_supervisor_values.sql) are plain
-- INSERTs into the stg_* tables, so those tables MUST already exist before
-- they are loaded. The replace script also creates them (idempotently) but it
-- can only run AFTER the data is loaded, so this file exists to break that
-- chicken-and-egg problem: run this, then the three value files, then the
-- replace script.
--
-- Purely additive: creates three staging tables and one index. No existing
-- table is read or modified, and nothing here depends on any employee data.
-- ============================================================================

create table if not exists public.stg_hr_employee_source (
  staff_id text primary key,
  full_name text not null,
  first_name text,
  last_name text,
  email text,
  position text,
  department text,
  gender text,
  confirmation_status text,
  source_row jsonb
);

create table if not exists public.stg_hr_employee_branch_source (
  staff_id text not null,
  branch_label text not null
);

create unique index if not exists uq_stg_branch
  on public.stg_hr_employee_branch_source (staff_id, branch_label);

create table if not exists public.stg_hr_employee_supervisor_source (
  staff_id text primary key,
  supervisor_1 text,
  supervisor_2 text,
  supervisor_3 text
);