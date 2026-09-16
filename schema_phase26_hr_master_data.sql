-- ============================================================
-- PHASE 26 — HR MASTER DATA & ORGANISATION HIERARCHY
--   • employees: confirmation_status, designation_id (FK), import provenance
--   • master data: departments, designations + RBAC mapping, branches (32 verbatim),
--     areas (AREA 1/2/3/5), designation → safest system-role resolution
--   • organisation: employee_supervisors (1st/2nd/3rd line), branch↔area assignments,
--     org assignment history (auditable, no hard deletes)
--   • import: 215-staff bank-master seed (merge-on-staff_id, gap-fill, never duplicates),
--     hierarchy + data-quality exception queues, import batches
--   • performance: config sections + bank defaults (MPR/PAR/loan ageing/grades/
--     mobility/bonus/qualification/sanctions/regulatory), HR-editable with
--     one-click reset-to-bank-default, versioned + audited
--   • invites: employee account invitation tracking (server-side edge fn)
--
-- ALL ADDITIVE. Idempotent (IF NOT EXISTS / OR REPLACE / ON CONFLICT).
-- Source of truth: INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md
-- ============================================================

-- ------------------------------------------------------------
-- 1. DEPARTMENTS MASTER
-- ------------------------------------------------------------
create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  is_active boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- 14 departments from the source workbook (section 2 list).
insert into public.departments (code, name, sort_order) values
  ('ADMINISTRATION', 'ADMINISTRATION', 1),
  ('AUDIT_AND_INVESTIGATION', 'AUDIT & INVESTIGATION', 2),
  ('CREDIT_AND_MARKETING', 'CREDIT & MARKETING', 3),
  ('E_BUSINESS', 'E-BUSINESS', 4),
  ('FINANCIAL_CONTROL', 'FINANCIAL CONTROL', 5),
  ('HUMAN_RESOURCES', 'HUMAN RESOURCES', 6),
  ('INFORMATION_TECHNOLOGY', 'INFORMATION TECHNOLOGY', 7),
  ('LEGAL', 'LEGAL', 8),
  ('LOAN_MONITORING_AND_RECOVERY', 'LOAN MONITORING & RECOVERY', 9),
  ('MD_CEO', 'MD/CEO', 10),
  ('OPERATIONS', 'OPERATIONS', 11),
  ('RECOVERY', 'RECOVERY', 12),
  ('RESEARCH_AND_STRATEGY', 'RESEARCH & STRATEGY', 13),
  ('RISK_AND_COMPLIANCE', 'RISK & COMPLIANCE', 14)
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 2. DESIGNATIONS MASTER
--    Keyed on (title, department): the same title may belong to
--    several departments (e.g. LOAN OFFICER). HR display uses title.
-- ------------------------------------------------------------
create table if not exists public.designations (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  department text,
  category text,
  sort_order int default 0,
  is_active boolean default true,
  created_at timestamptz default now(),
  unique (title, department)
);

create unique index if not exists uq_designations_title_no_dept
  on public.designations (title) where department is null;

insert into public.designations (title, department, category, sort_order) values
  ('AREA MANAGER (AREA 1)', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 1),
  ('AREA MANAGER (AREA 2)', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 2),
  ('AREA MANAGER (AREA 3)', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 3),
  ('AREA MANAGER (AREA 5)', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 4),
  ('BRANCH MANAGER', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 5),
  ('LOAN OFFICER', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 6),
  ('SENIOR LOAN OFFICER', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 7),
  ('SME OFFICER', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 8),
  ('SENIOR SME OFFICER', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 9),
  ('MANAGEMENT TRAINEE', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 10),
  ('HEAD OF OTHER CREDIT UNITS', 'CREDIT & MARKETING', 'CREDIT & MARKETING', 11),
  ('LOAN OFFICER', 'FINANCIAL CONTROL', 'CREDIT & MARKETING', 6),
  ('FINANCIAL CONTROLLER', 'FINANCIAL CONTROL', 'FINANCIAL CONTROL', 12),
  ('CHIEF FINANCIAL OFFICER', 'FINANCIAL CONTROL', 'FINANCIAL CONTROL', 13),
  ('LOAN OFFICER', 'LOAN MONITORING & RECOVERY', 'CREDIT & MARKETING', 6),
  ('HEAD, LOAN MONITORING & RECOVERY', 'LOAN MONITORING & RECOVERY', 'LOAN MONITORING & RECOVERY', 14),
  ('HEAD OF OPERATIONS', 'OPERATIONS', 'OPERATIONS', 15),
  ('HEAD, CONTACT CENTRE', 'OPERATIONS', 'OPERATIONS', 16),
  ('HEAD, E-BANKING', 'E-BUSINESS', 'E-BUSINESS', 17),
  ('HEAD OF DIGITAL BANKING', 'E-BUSINESS', 'E-BUSINESS', 18),
  ('HEAD OF BUSINESS', 'MD/CEO', 'EXECUTIVE', 19),
  ('EXECUTIVE DIRECTOR', 'MD/CEO', 'EXECUTIVE', 20),
  ('MD/CEO', 'MD/CEO', 'EXECUTIVE', 21),
  ('HEAD OF INTERNAL CONTROL', 'AUDIT & INVESTIGATION', 'AUDIT & INVESTIGATION', 22),
  ('HEAD OF AUDIT', 'AUDIT & INVESTIGATION', 'AUDIT & INVESTIGATION', 23),
  ('HEAD, RISK MANAGEMENT', 'RISK & COMPLIANCE', 'RISK & COMPLIANCE', 24),
  ('HEAD OF COMPLIANCE', 'RISK & COMPLIANCE', 'RISK & COMPLIANCE', 25),
  ('HEAD OF RECOVERY', 'RECOVERY', 'RECOVERY', 26),
  ('HEAD OF LEGAL', 'LEGAL', 'LEGAL', 27),
  ('LEGAL OFFICER', 'LEGAL', 'LEGAL', 28),
  ('HEAD OF INFORMATION TECHNOLOGY', 'INFORMATION TECHNOLOGY', 'INFORMATION TECHNOLOGY', 29),
  ('ICT OFFICER', 'INFORMATION TECHNOLOGY', 'INFORMATION TECHNOLOGY', 30),
  ('HEAD, HUMAN RESOURCES', 'HUMAN RESOURCES', 'HUMAN RESOURCES', 31),
  ('HR MANAGER', 'HUMAN RESOURCES', 'HUMAN RESOURCES', 32),
  ('ADMIN MANAGER', 'ADMINISTRATION', 'ADMINISTRATION', 33),
  ('ADMIN OFFICER', 'ADMINISTRATION', 'ADMINISTRATION', 34),
  -- generic designations (no fixed department)
  ('ACCOUNTANT', null, 'FINANCE', 50),
  ('FINANCIAL ACCOUNTANT', null, 'FINANCE', 51),
  ('MANAGEMENT ACCOUNTANT', null, 'FINANCE', 52),
  ('BUDGET OFFICER', null, 'FINANCE', 53),
  ('TREASURY OFFICER', null, 'FINANCE', 54),
  ('INTERNAL AUDITOR', null, 'AUDIT', 55),
  ('COMPLIANCE OFFICER', null, 'RISK & COMPLIANCE', 56),
  ('RISK ANALYST', null, 'RISK & COMPLIANCE', 57),
  ('CREDIT ANALYST', null, 'CREDIT & MARKETING', 58),
  ('DATA ANALYST', null, 'INFORMATION TECHNOLOGY', 59),
  ('BUSINESS ANALYST', null, 'OPERATIONS', 60),
  ('CUSTOMER SERVICE OFFICER', null, 'OPERATIONS', 61),
  ('RELATIONSHIP OFFICER', null, 'CREDIT & MARKETING', 62),
  ('RECOVERY OFFICER', null, 'RECOVERY', 63),
  ('LOAN MONITORING OFFICER', null, 'LOAN MONITORING & RECOVERY', 64),
  ('SECURITY OFFICER', null, 'ADMINISTRATION', 65),
  ('DRIVER', null, 'ADMINISTRATION', 66),
  ('CLEANER', null, 'ADMINISTRATION', 67),
  ('COURT PROCESS SERVER', null, 'LEGAL', 68),
  ('FRONT DESK OFFICER', null, 'OPERATIONS', 69),
  ('UNIT HEAD', null, 'CREDIT & MARKETING', 70),
  ('HUB LEADER', null, 'CREDIT & MARKETING', 71),
  ('TEAM LEAD', null, 'OPERATIONS', 72),
  ('PEOPLE MANAGER', null, 'HUMAN RESOURCES', 73),
  ('REGIONAL MANAGER', null, 'CREDIT & MARKETING', 74),
  ('DEPUTY GENERAL MANAGER', null, 'EXECUTIVE', 75),
  ('GENERAL MANAGER', null, 'EXECUTIVE', 76),
  ('MANAGING DIRECTOR', null, 'EXECUTIVE', 77)
on conflict do nothing;

-- ------------------------------------------------------------
-- 3. DESIGNATION → SYSTEM ROLE MAPPING (RBAC)
--    JOB DESIGNATION is separate from SYSTEM ROLE. Explicit safe map;
--    anything unmapped resolves to the SAFEST role ('staff').
-- ------------------------------------------------------------
create table if not exists public.designation_role_mappings (
  id uuid primary key default gen_random_uuid(),
  designation_title text not null unique,
  system_role text not null,
  is_default_fallback boolean default false,
  notes text,
  created_at timestamptz default now()
);

insert into public.designation_role_mappings (designation_title, system_role, notes) values
  ('MD/CEO', 'super_admin', 'Explicit — assignable by super_admin only'),
  ('MANAGING DIRECTOR', 'super_admin', 'Explicit — assignable by super_admin only'),
  ('EXECUTIVE DIRECTOR', 'admin', null),
  ('DEPUTY GENERAL MANAGER', 'admin', null),
  ('GENERAL MANAGER', 'admin', null),
  ('CHIEF FINANCIAL OFFICER', 'admin', null),
  ('HEAD OF BUSINESS', 'head_of_business', null),
  ('AREA MANAGER (AREA 1)', 'area_manager', null),
  ('AREA MANAGER (AREA 2)', 'area_manager', null),
  ('AREA MANAGER (AREA 3)', 'area_manager', null),
  ('AREA MANAGER (AREA 5)', 'area_manager', null),
  ('BRANCH MANAGER', 'branch_manager', null),
  ('HEAD, HUMAN RESOURCES', 'hr_manager', null),
  ('HR MANAGER', 'hr_manager', null)
on conflict (designation_title) do nothing;

-- ------------------------------------------------------------
-- 4. EMPLOYEE ADDITIVE COLUMNS (Phase 26)
-- ------------------------------------------------------------
alter table public.employees add column if not exists confirmation_status text
  check (confirmation_status in ('CONFIRMED', 'UNCONFIRMED', 'CONTRACT STAFF'));
alter table public.employees add column if not exists designation_id uuid
  references public.designations(id) on delete set null;
alter table public.employees add column if not exists import_source text;
alter table public.employees add column if not exists imported_from_bank_master boolean default false;

-- Extend the legacy source CHECK so bank-master imports can be flagged distinctly.
alter table public.employees drop constraint if exists employees_source_check;
alter table public.employees add constraint employees_source_check
  check (source in ('onboarding', 'manual', 'bank_master_import'));

create index if not exists idx_employees_staff_id on public.employees (staff_id);
create index if not exists idx_employees_confirmation_status on public.employees (confirmation_status);

-- ------------------------------------------------------------
-- 5. BRANCHES — ensure the 32 verbatim source values exist.
--    branch_name is not unique in the legacy schema, so guard by name
--    and generate a collision-free branch_code manually.
-- ------------------------------------------------------------
do $$
declare
  v_name text;
  v_code text;
  v_next int;
begin
  foreach v_name in array array[
    'BARIGA/LAGOS Island 1',
    'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH',
    'TRADE FAIR/BOUNDARY/ALABA',
    'AGEGE & EGBEDA',
    'MUSHIN/YABA',
    'KETU & HEAD OFFICE',
    'KOLA & ILE-EPO',
    'OSHODI & IKEJA',
    'HEAD OFFICE - OSHODI',
    'LAGOS ISLAND2',
    'KETU',
    'IBEJU LEKKI',
    'AJAH',
    'BOUNDARY',
    'ALABA',
    'TRADE FAIR',
    'BARIGA',
    'LAGOS Island 1',
    'YABA',
    'MUSHIN',
    'AGEGE',
    'EGBEDA',
    'KOLA',
    'ILE-EPO',
    'OSHODI',
    'IKEJA',
    'HEAD OFFICE',
    'IKEJA & LEKKI',
    'OSOLO/OKOTA',
    'MILE 2/BADAGRY ROAD',
    'FESTAC',
    'AMUWO ODOFIN'
  ] loop
    if not exists (select 1 from public.branches where branch_name = v_name) then
      select count(*) + 1 into v_next from public.branches;
      v_code := 'BR-' || lpad(v_next::text, 2, '0');
      while exists (select 1 from public.branches where branch_code = v_code) loop
        v_next := v_next + 1;
        v_code := 'BR-' || lpad(v_next::text, 2, '0');
      end loop;
      insert into public.branches (branch_name, branch_code, status)
      values (v_name, v_code, 'active');
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 6. AREAS MASTER (verbatim: AREA 1/2/3/5 — source has NO AREA 4,
--    recorded as a data-quality exception below).
--    manager_employee_id is assigned by HR via assign_area_manager()
--    (never guessed at import).
-- ------------------------------------------------------------
create table if not exists public.areas (
  id uuid primary key default gen_random_uuid(),
  area_code text not null unique,
  area_name text,
  manager_employee_id uuid references public.employees(id) on delete set null,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

insert into public.areas (area_code, area_name) values
  ('AREA 1', 'AREA 1'),
  ('AREA 2', 'AREA 2'),
  ('AREA 3', 'AREA 3'),
  ('AREA 5', 'AREA 5')
on conflict (area_code) do nothing;

-- ------------------------------------------------------------
-- 7. ORG ASSIGNMENT HISTORY (auditable, never hard-deleted)
-- ------------------------------------------------------------
create table if not exists public.org_assignment_history (
  id bigserial primary key,
  entity_type text not null check (entity_type in ('area', 'branch')),
  entity_id uuid not null,
  previous_employee_id uuid,
  new_employee_id uuid,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz default now(),
  reason text
);

-- ------------------------------------------------------------
-- 8. BRANCH ↔ AREA ASSIGNMENTS
-- ------------------------------------------------------------
create table if not exists public.branch_area_assignments (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  area_id uuid not null references public.areas(id) on delete cascade,
  is_current boolean default true,
  assigned_from timestamptz default now(),
  assigned_to timestamptz,
  assigned_by uuid,
  reason text,
  unique (branch_id, area_id)
);

-- ------------------------------------------------------------
-- 9. EMPLOYEE SUPERVISOR RELATIONSHIPS + HIERARCHY EXCEPTIONS
--    Level 1 = primary line manager. Unresolvable/ambiguous links land
--    in hierarchy_exceptions — never silently dropped.
-- ------------------------------------------------------------
create table if not exists public.employee_supervisors (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  supervisor_employee_id uuid not null references public.employees(id) on delete cascade,
  level int not null check (level between 1 and 3),
  supervisor_title text,
  effective_from date,
  source text default 'bank_master',
  created_at timestamptz default now(),
  unique (employee_id, supervisor_employee_id, level)
);

create index if not exists idx_employee_supervisors_employee on public.employee_supervisors (employee_id);
create index if not exists idx_employee_supervisors_supervisor on public.employee_supervisors (supervisor_employee_id);

create table if not exists public.hierarchy_exceptions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete set null,
  source_supervisor_name text not null,
  level int check (level between 1 and 3),
  reason text not null,
  status text default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution jsonb,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz default now(),
  unique (employee_id, source_supervisor_name, level)
);

-- ------------------------------------------------------------
-- 10. DATA QUALITY EXCEPTIONS — source ambiguities surfaced, never hidden.
-- ------------------------------------------------------------
create table if not exists public.data_quality_exceptions (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_ref text,
  category text not null,
  message text not null,
  severity text default 'warn' check (severity in ('info', 'warn', 'error')),
  status text default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz default now(),
  unique (entity_type, entity_ref, category, message)
);

insert into public.data_quality_exceptions (entity_type, entity_ref, category, message, severity) values
  ('branch', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', 'combined_branch', 'Combined physical branches kept verbatim as a single source value.', 'info'),
  ('branch', 'BARIGA/LAGOS Island 1', 'combined_branch', 'Combined physical branches kept verbatim; mixed casing in "Island 1" preserved.', 'info'),
  ('branch', 'TRADE FAIR/BOUNDARY/ALABA', 'combined_branch', 'Combined physical branches kept verbatim as a single source value.', 'info'),
  ('branch', 'AGEGE & EGBEDA', 'combined_branch', 'Combined physical branches kept verbatim as a single source value.', 'info'),
  ('branch', 'MUSHIN/YABA', 'combined_branch', 'Combined physical branches kept verbatim as a single source value.', 'info'),
  ('branch', 'KETU & HEAD OFFICE', 'combined_branch', 'Combined branch + head office kept verbatim as a single source value.', 'info'),
  ('branch', 'KOLA & ILE-EPO', 'combined_branch', 'Combined physical branches kept verbatim as a single source value.', 'info'),
  ('branch', 'OSHODI & IKEJA', 'combined_branch', 'Combined physical branches kept verbatim as a single source value.', 'info'),
  ('branch', 'LAGOS ISLAND2', 'casing_variant', 'Source also uses "LAGOS ISLAND 2" (with space). Treated as distinct source values; not merged silently.', 'warn'),
  ('grade', 'UNSATISFACTORY', 'ambiguous_band', 'Grade band "50 Below" — interpreter assumed ≤ 50 inclusive; editable in Performance Settings.', 'warn'),
  ('area', 'AREA 4', 'missing_value', 'AREA MANAGER designations cover AREA 1/2/3/5; no AREA 4 exists in source.', 'info'),
  ('employee', 'nkechi.eze@infinitycorebank.com', 'duplicate_email', 'Source lists two employees with this email (distinct staff IDs). Verified on import; second match flagged.', 'error'),
  ('employee', 'bisi.ajayi@infinitycorebank.com', 'duplicate_email', 'Source lists two employees with this email (distinct staff IDs). Verified on import; second match flagged.', 'error')
on conflict do nothing;

-- ------------------------------------------------------------
-- 11. STATS IMPORT BATCH TRACKING
-- ------------------------------------------------------------
create table if not exists public.staff_import_batches (
  id uuid primary key default gen_random_uuid(),
  batch_key text not null unique,
  source_file text,
  total_rows int not null default 0,
  imported_rows int not null default 0,
  matched_rows int not null default 0,
  notes text,
  created_by uuid,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 12. PERFORMANCE CONFIGURATION (bank defaults + editable current value)
--     One config table, keyed by config_key, grouped by section.
--     bank_default is the seeded source-of-truth; current_value is the
--     active value; every change is versioned + audited.
-- ------------------------------------------------------------
create table if not exists public.performance_config_sections (
  code text primary key,
  label text not null,
  description text,
  sort_order int default 0,
  is_active boolean default true
);

create table if not exists public.performance_config (
  config_key text primary key,
  section text not null references public.performance_config_sections(code),
  label text not null,
  data_type text not null default 'json',
  bank_default jsonb not null,
  current_value jsonb not null,
  is_active boolean default true,
  notes text,
  effective_from timestamptz default now(),
  version int not null default 1,
  changed_by uuid,
  changed_at timestamptz default now()
);

create table if not exists public.performance_config_audit (
  id bigserial primary key,
  config_key text not null references public.performance_config(config_key),
  section text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  changed_by uuid,
  changed_at timestamptz default now()
);

insert into public.performance_config_sections (code, label, description, sort_order) values
  ('mpr', 'MPR Components', 'Monthly Performance Review weightings (must total 100%).', 1),
  ('par_bands', 'PAR Score Bands', 'PAR (%) mapped to PAR component score.', 2),
  ('loan_ageing', 'Loan Ageing', 'Classification buckets by days past due.', 3),
  ('grades', 'Performance Grades', 'Score ranges to A–E grades.', 4),
  ('mobility', 'Mobility Allowance', 'Portfolio-size bands and monthly allowance.', 5),
  ('bonus', 'Productivity Bonus', 'Eligibility, frequency and bonus scale.', 6),
  ('qualification', 'Productivity Qualification', 'Criteria to qualify for productivity bonus.', 7),
  ('sanctions', 'Performance Sanctions', 'Warning/forfeiture progression (human-approved).', 8),
  ('regulatory', 'Regulatory Reference Values', 'CBN-style regulatory ratios used in performance context.', 9)
on conflict (code) do nothing;

-- Seed bank defaults (current = default on first run).
insert into public.performance_config (config_key, section, label, data_type, bank_default, current_value, notes) values
  (
    'mpr.components',
    'mpr',
    'MPR Component Weights',
    'json',
    '[{"component":"DISBURSEMENT","weight":35},{"component":"PAR","weight":35},{"component":"CASELOAD","weight":30}]'::jsonb,
    '[{"component":"DISBURSEMENT","weight":35},{"component":"PAR","weight":35},{"component":"CASELOAD","weight":30}]'::jsonb,
    'Weights must total 100.'
  ),
  (
    'mpr.par_bands',
    'par_bands',
    'PAR Score Bands',
    'json',
    '[{"min_pct":0,"max_pct":4,"score":35},{"min_pct":4.1,"max_pct":5,"score":30},{"min_pct":5.1,"max_pct":6,"score":20},{"min_pct":6.1,"max_pct":7,"score":15},{"min_pct":7.1,"max_pct":10,"score":7.5},{"min_pct":10.1,"max_pct":null,"score":0}]'::jsonb,
    '[{"min_pct":0,"max_pct":4,"score":35},{"min_pct":4.1,"max_pct":5,"score":30},{"min_pct":5.1,"max_pct":6,"score":20},{"min_pct":6.1,"max_pct":7,"score":15},{"min_pct":7.1,"max_pct":10,"score":7.5},{"min_pct":10.1,"max_pct":null,"score":0}]'::jsonb,
    '>10% maps to score 0.'
  ),
  (
    'mpr.loan_ageing',
    'loan_ageing',
    'Loan Ageing Classification',
    'json',
    '[{"classification":"PERFORMING","min_days":0,"max_days":0},{"classification":"PASS AND WATCH","min_days":1,"max_days":30},{"classification":"SUBSTANDARD","min_days":31,"max_days":60},{"classification":"DOUBTFUL","min_days":61,"max_days":90},{"classification":"LOST","min_days":91,"max_days":null}]'::jsonb,
    '[{"classification":"PERFORMING","min_days":0,"max_days":0},{"classification":"PASS AND WATCH","min_days":1,"max_days":30},{"classification":"SUBSTANDARD","min_days":31,"max_days":60},{"classification":"DOUBTFUL","min_days":61,"max_days":90},{"classification":"LOST","min_days":91,"max_days":null}]'::jsonb,
    null
  ),
  (
    'grades.performance',
    'grades',
    'Performance Grades',
    'json',
    '[{"grade":"EXCELLENT","min_score":90,"max_score":100,"letter":"A"},{"grade":"VERY GOOD","min_score":76,"max_score":89,"letter":"B"},{"grade":"GOOD","min_score":65,"max_score":75,"letter":"C"},{"grade":"AVERAGE","min_score":60,"max_score":64,"letter":"D"},{"grade":"UNSATISFACTORY","min_score":0,"max_score":50,"letter":"E"}]'::jsonb,
    '[{"grade":"EXCELLENT","min_score":90,"max_score":100,"letter":"A"},{"grade":"VERY GOOD","min_score":76,"max_score":89,"letter":"B"},{"grade":"GOOD","min_score":65,"max_score":75,"letter":"C"},{"grade":"AVERAGE","min_score":60,"max_score":64,"letter":"D"},{"grade":"UNSATISFACTORY","min_score":0,"max_score":50,"letter":"E"}]'::jsonb,
    'UNSATISFACTORY "50 Below" interpreted as ≤ 50 (editable).'
  ),
  (
    'mobility.allowance_bands',
    'mobility',
    'Mobility Allowance Bands',
    'json',
    '[{"category":"LOAN OFFICER (1)","min_portfolio":0,"max_portfolio":5099999,"allowance":10000},{"category":"LOAN OFFICER (2)","min_portfolio":5100000,"max_portfolio":10099999,"allowance":26000},{"category":"LOAN OFFICER (3)","min_portfolio":10100000,"max_portfolio":15099999,"allowance":30000},{"category":"SENIOR LOAN OFFICER (1)","min_portfolio":15100000,"max_portfolio":19999999,"allowance":35000},{"category":"SENIOR LOAN OFFICER (2)","min_portfolio":20000000,"max_portfolio":29999999,"allowance":37000},{"category":"SENIOR SME OFFICER","min_portfolio":30000000,"max_portfolio":null,"allowance":40000}]'::jsonb,
    '[{"category":"LOAN OFFICER (1)","min_portfolio":0,"max_portfolio":5099999,"allowance":10000},{"category":"LOAN OFFICER (2)","min_portfolio":5100000,"max_portfolio":10099999,"allowance":26000},{"category":"LOAN OFFICER (3)","min_portfolio":10100000,"max_portfolio":15099999,"allowance":30000},{"category":"SENIOR LOAN OFFICER (1)","min_portfolio":15100000,"max_portfolio":19999999,"allowance":35000},{"category":"SENIOR LOAN OFFICER (2)","min_portfolio":20000000,"max_portfolio":29999999,"allowance":37000},{"category":"SENIOR SME OFFICER","min_portfolio":30000000,"max_portfolio":null,"allowance":40000}]'::jsonb,
    'Category is designation-based, not salary-derived.'
  ),
  (
    'bonus.productivity',
    'bonus',
    'Productivity Bonus',
    'json',
    '{"eligible_designations":["LOAN OFFICER","SME OFFICER","UNIT HEAD"],"monthly_frequency_designations":["LOAN OFFICER","SME OFFICER","UNIT HEAD"],"quarterly_frequency_designations":["BRANCH MANAGER","AREA MANAGER","HUB LEADER","HEAD OF BUSINESS"],"eligibility_wait_months":4,"bonus_scale":[{"min_mpr_pct":75,"percent_of_gross":60},{"min_mpr_pct":60,"max_mpr_pct":74,"percent_of_gross":30}]}'::jsonb,
    '{"eligible_designations":["LOAN OFFICER","SME OFFICER","UNIT HEAD"],"monthly_frequency_designations":["LOAN OFFICER","SME OFFICER","UNIT HEAD"],"quarterly_frequency_designations":["BRANCH MANAGER","AREA MANAGER","HUB LEADER","HEAD OF BUSINESS"],"eligibility_wait_months":4,"bonus_scale":[{"min_mpr_pct":75,"percent_of_gross":60},{"min_mpr_pct":60,"max_mpr_pct":74,"percent_of_gross":30}]}'::jsonb,
    null
  ),
  (
    'bonus.qualification',
    'qualification',
    'Productivity Qualification Criteria',
    'json',
    '{"par_pct":5,"new_staff_par_pct":3,"mpr_min":60,"mpr_max":75,"portfolio_achievement_pct":100,"sme_par_max_days":30,"criteria":["MPR score between 60 and 75 points","PAR ≤ 5% (new staff PAR ≤ 3%)","100% portfolio achievement","SME PAR no more than 30 days"]}'::jsonb,
    '{"par_pct":5,"new_staff_par_pct":3,"mpr_min":60,"mpr_max":75,"portfolio_achievement_pct":100,"sme_par_max_days":30,"criteria":["MPR score between 60 and 75 points","PAR ≤ 5% (new staff PAR ≤ 3%)","100% portfolio achievement","SME PAR no more than 30 days"]}'::jsonb,
    'All criteria must hold simultaneously.'
  ),
  (
    'sanctions.performance',
    'sanctions',
    'Performance Sanctions',
    'json',
    '[{"month":1,"mpr_threshold_pct":40,"sanction":"Warning Letter issued","bonus_forfeit_pct":0},{"month":2,"mpr_threshold_pct":30,"sanction":"Second Warning Letter + 20% bonus forfeiture","bonus_forfeit_pct":20},{"month":3,"mpr_threshold_pct":30,"sanction":"Final Warning Letter + 30% bonus forfeiture","bonus_forfeit_pct":30},{"month":null,"mpr_threshold_pct":null,"sanction":"Staff asked to resign","bonus_forfeit_pct":null}]'::jsonb,
    '[{"month":1,"mpr_threshold_pct":40,"sanction":"Warning Letter issued","bonus_forfeit_pct":0},{"month":2,"mpr_threshold_pct":30,"sanction":"Second Warning Letter + 20% bonus forfeiture","bonus_forfeit_pct":20},{"month":3,"mpr_threshold_pct":30,"sanction":"Final Warning Letter + 30% bonus forfeiture","bonus_forfeit_pct":30},{"month":null,"mpr_threshold_pct":null,"sanction":"Staff asked to resign","bonus_forfeit_pct":null}]'::jsonb,
    'automatic=false: every sanction requires human approval and is audited.'
  ),
  (
    'regulatory.reference_values',
    'regulatory',
    'Regulatory Reference Values',
    'json',
    '[{"metric":"CAR","value":10,"unit":"%"},{"metric":"LIQUIDITY RATIO","value":20,"unit":"%"},{"metric":"OPERATING EXPENSES / ASSETS","value":15,"unit":"%"},{"metric":"OPERATIONAL SELF-SUFFICIENCY (OSS)","value":100,"unit":"%"},{"metric":"ADJUSTED CAPITAL / NET CREDIT","value":"1:10","unit":"ratio"},{"metric":"FIXED ASSET / SHAREHOLDERS'' FUNDS","value":20,"unit":"%"},{"metric":"PAR","value":5,"unit":"%"},{"metric":"SINGLE OBLIGOR LIMIT — INDIVIDUAL","value":1,"unit":"%"},{"metric":"SINGLE OBLIGOR LIMIT — CORPORATE","value":5,"unit":"%"}]'::jsonb,
    '[{"metric":"CAR","value":10,"unit":"%"},{"metric":"LIQUIDITY RATIO","value":20,"unit":"%"},{"metric":"OPERATING EXPENSES / ASSETS","value":15,"unit":"%"},{"metric":"OPERATIONAL SELF-SUFFICIENCY (OSS)","value":100,"unit":"%"},{"metric":"ADJUSTED CAPITAL / NET CREDIT","value":"1:10","unit":"ratio"},{"metric":"FIXED ASSET / SHAREHOLDERS'' FUNDS","value":20,"unit":"%"},{"metric":"PAR","value":5,"unit":"%"},{"metric":"SINGLE OBLIGOR LIMIT — INDIVIDUAL","value":1,"unit":"%"},{"metric":"SINGLE OBLIGOR LIMIT — CORPORATE","value":5,"unit":"%"}]'::jsonb,
    'Reference values only — informational context, not a calculation engine.'
  ),
  (
    'bankone.performance_engine',
    'mpr',
    'BankOne Performance Engine',
    'json',
    '{"foundation_only":true,"note":"BankOne feeds are not yet wired — foundation config only. No API data is simulated."}'::jsonb,
    '{"foundation_only":true,"note":"BankOne feeds are not yet wired — foundation config only. No API data is simulated."}'::jsonb,
    'Foundation for the BankOne performance engine; no fake data.'
  )
on conflict (config_key) do nothing;

-- ------------------------------------------------------------
-- 13. EMPLOYEE ACCOUNT INVITES (server-side writes via edge fn)
-- ------------------------------------------------------------
create table if not exists public.employee_account_invites (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  invited_email text not null,
  intended_role text not null,
  result text not null check (result in ('SUCCESS', 'ALREADY_EXISTS', 'INVALID_EMAIL', 'FAILED')),
  error text,
  auth_user_id uuid,
  invited_by uuid,
  invited_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 14. RPCs
-- ------------------------------------------------------------
-- current_role() is used for server-side authorization everywhere.

create or replace function public.list_performance_config()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  select jsonb_build_object('sections', coalesce(jsonb_agg(jsonb_build_object(
    'code', s.code,
    'label', s.label,
    'description', s.description,
    'sort_order', s.sort_order,
    'is_active', s.is_active,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'config_key', c.config_key,
        'label', c.label,
        'data_type', c.data_type,
        'current_value', c.current_value,
        'bank_default', c.bank_default,
        'is_active', c.is_active,
        'notes', c.notes,
        'version', c.version,
        'effective_from', c.effective_from,
        'changed_by', c.changed_by,
        'changed_at', c.changed_at
      ) order by c.config_key)
      from public.performance_config c
      where c.section = s.code and c.is_active
    ), '[]'::jsonb)
  ) order by s.sort_order), '[]'::jsonb))
  into v_out
  from public.performance_config_sections s
  where s.is_active;
  return v_out;
end; $$;
grant execute on function public.list_performance_config() to authenticated;

create or replace function public.save_performance_config(
  p_key text,
  p_value jsonb,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor_name text;
  v_old jsonb;
  v_section text;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to modify performance configuration';
  end if;
  select current_value, section into v_old, v_section
  from public.performance_config where config_key = p_key;
  if v_old is null then
    raise exception 'Unknown configuration key %', p_key;
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();
  update public.performance_config set
    current_value = p_value,
    version = version + 1,
    effective_from = now(),
    changed_by = auth.uid(),
    changed_at = now()
  where config_key = p_key;
  insert into public.performance_config_audit (config_key, section, old_value, new_value, reason, changed_by)
  values (p_key, v_section, v_old, p_value, p_reason, auth.uid());
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PERFORMANCE_CONFIG_SAVED', 'PerformanceConfig', p_key,
          coalesce(v_actor_name, v_role, auth.uid()::text),
          format('Performance config %s updated to %s', p_key, p_value::text), 'info');
  return jsonb_build_object('ok', true, 'config_key', p_key, 'version', (select version from public.performance_config where config_key = p_key));
end; $$;
grant execute on function public.save_performance_config(text, jsonb, text) to authenticated;

create or replace function public.reset_performance_config(
  p_key text default null,
  p_section text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor_name text;
  v_reset text[] := '{}';
  r record;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to modify performance configuration';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();
  if p_key is not null then
    for r in
      select config_key from public.performance_config where config_key = p_key
    loop
      v_reset := v_reset || r.config_key;
    end loop;
  elsif p_section is not null then
    for r in
      select config_key from public.performance_config where section = p_section
    loop
      v_reset := v_reset || r.config_key;
    end loop;
  else
    for r in select config_key from public.performance_config loop
      v_reset := v_reset || r.config_key;
    end loop;
  end if;

  for r in select config_key from unnest(v_reset) as t(config_key) loop
    update public.performance_config set
      current_value = bank_default,
      version = version + 1,
      effective_from = now(),
      changed_by = auth.uid(),
      changed_at = now()
    where config_key = r.config_key;
    insert into public.performance_config_audit (config_key, section, old_value, new_value, reason, changed_by)
    select config_key, section, current_value, bank_default, 'Reset to bank default', auth.uid()
    from public.performance_config where config_key = r.config_key;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('PERFORMANCE_CONFIG_RESET', 'PerformanceConfig', r.config_key,
            coalesce(v_actor_name, v_role, auth.uid()::text),
            format('Performance config %s reset to bank default', r.config_key), 'info');
  end loop;

  return jsonb_build_object('ok', true, 'reset_keys', coalesce(v_reset, '{}'));
end; $$;
grant execute on function public.reset_performance_config(text, text) to authenticated;

create or replace function public.resolve_system_role_for_designation(p_designation_title text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text;
begin
  select system_role into v_role
  from public.designation_role_mappings
  where designation_title = p_designation_title;
  return jsonb_build_object(
    'designation_title', p_designation_title,
    'system_role', coalesce(v_role, 'staff'),
    'is_default', v_role is null
  );
end; $$;
grant execute on function public.resolve_system_role_for_designation(text) to authenticated;

create or replace function public.list_org_summary()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  select jsonb_build_object(
    'employees', (select count(*) from public.employees),
    'departments', (select count(*) from public.departments),
    'designations', (select count(*) from public.designations),
    'branches', (select count(*) from public.branches),
    'areas', (select count(*) from public.areas),
    'area_managers', (select count(*) from public.employees where "position" like 'AREA MANAGER (%'),
    'branch_managers', (select count(*) from public.employees where "position" = 'BRANCH MANAGER'),
    'confirmed', (select count(*) from public.employees where confirmation_status = 'CONFIRMED'),
    'unconfirmed', (select count(*) from public.employees where confirmation_status = 'UNCONFIRMED'),
    'contract_staff', (select count(*) from public.employees where confirmation_status = 'CONTRACT STAFF'),
    'imported', (select count(*) from public.employees where imported_from_bank_master),
    'open_hierarchy_issues', (select count(*) from public.hierarchy_exceptions where status = 'open'),
    'open_data_issues', (select count(*) from public.data_quality_exceptions where status = 'open'),
    'uninvited', (select count(*) from public.employees where user_id is null),
    'invited', (select count(*) from public.employee_account_invites)
  ) into v_out;
  return v_out;
end; $$;
grant execute on function public.list_org_summary() to authenticated;

create or replace function public.assign_area_manager(
  p_area_code text,
  p_employee_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor_name text;
  v_area record;
  v_emp record;
  v_old uuid;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to assign area managers';
  end if;
  select * into v_area from public.areas where area_code = p_area_code;
  if v_area.id is null then
    raise exception 'Area % not found', p_area_code;
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  v_old := v_area.manager_employee_id;
  if v_old is distinct from p_employee_id then
    update public.areas set manager_employee_id = p_employee_id, updated_at = now()
    where id = v_area.id;

    insert into public.org_assignment_history (entity_type, entity_id, previous_employee_id, new_employee_id, changed_by, changed_by_name, reason)
    values ('area', v_area.id, v_old, p_employee_id, auth.uid(), v_actor_name, p_reason);

    -- Propagate the area label to staff whose branch belongs to this area.
    update public.employees set area = v_area.area_code, updated_at = now()
    where branch_id in (
      select baa.branch_id from public.branch_area_assignments baa
      where baa.area_id = v_area.id and baa.is_current
    ) and branch_id is not null;

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('AREA_MANAGER_ASSIGNED', 'Area', v_area.id::text,
            coalesce(v_actor_name, v_role, auth.uid()::text),
            format('Area %s manager %s → %s (%s)', v_area.area_code, coalesce(v_old::text, 'none'), v_emp.full_name, coalesce(p_reason, 'no reason')), 'warning');
  end if;

  return jsonb_build_object('ok', true, 'area_code', v_area.area_code, 'manager_employee_id', p_employee_id);
end; $$;
grant execute on function public.assign_area_manager(text, uuid, text) to authenticated;

create or replace function public.assign_branch_manager(
  p_branch_id uuid,
  p_employee_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor_name text;
  v_branch record;
  v_emp record;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to assign branch managers';
  end if;
  select * into v_branch from public.branches where id = p_branch_id;
  if v_branch.id is null then
    raise exception 'Branch not found';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.branches set manager_name = v_emp.full_name, updated_at = now()
  where id = p_branch_id;

  insert into public.org_assignment_history (entity_type, entity_id, previous_employee_id, new_employee_id, changed_by, changed_by_name, reason)
  values ('branch', p_branch_id, null, p_employee_id, auth.uid(), v_actor_name, p_reason);

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('BRANCH_MANAGER_ASSIGNED', 'Branch', p_branch_id::text,
          coalesce(v_actor_name, v_role, auth.uid()::text),
          format('Branch %s manager → %s (%s)', v_branch.branch_name, v_emp.full_name, coalesce(p_reason, 'no reason')), 'warning');

  return jsonb_build_object('ok', true, 'branch_id', p_branch_id, 'manager_name', v_emp.full_name);
end; $$;
grant execute on function public.assign_branch_manager(uuid, uuid, text) to authenticated;

create or replace function public.record_staff_import_batch(
  p_batch_key text,
  p_total_rows int default 0,
  p_imported_rows int default 0,
  p_matched_rows int default 0,
  p_notes text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_id uuid;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to record import batches';
  end if;
  insert into public.staff_import_batches (batch_key, source_file, total_rows, imported_rows, matched_rows, notes, created_by)
  values (p_batch_key, 'INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md',
          p_total_rows, p_imported_rows, p_matched_rows, p_notes, auth.uid())
  on conflict (batch_key) do update set
    total_rows = excluded.total_rows,
    imported_rows = excluded.imported_rows,
    matched_rows = excluded.matched_rows,
    notes = excluded.notes
  returning id into v_id;
  return jsonb_build_object('ok', true, 'batch_id', v_id);
end; $$;
grant execute on function public.record_staff_import_batch(text, int, int, int, text) to authenticated;

-- ------------------------------------------------------------
-- 15. ROW LEVEL SECURITY (read for authenticated; mutations via RPC/edge fn)
-- ------------------------------------------------------------
alter table public.departments enable row level security;
alter table public.designations enable row level security;
alter table public.designation_role_mappings enable row level security;
alter table public.areas enable row level security;
alter table public.org_assignment_history enable row level security;
alter table public.branch_area_assignments enable row level security;
alter table public.employee_supervisors enable row level security;
alter table public.hierarchy_exceptions enable row level security;
alter table public.data_quality_exceptions enable row level security;
alter table public.staff_import_batches enable row level security;
alter table public.performance_config_sections enable row level security;
alter table public.performance_config enable row level security;
alter table public.performance_config_audit enable row level security;
alter table public.employee_account_invites enable row level security;

drop policy if exists phase26_read_all on public.departments;
create policy phase26_read_all on public.departments for select to authenticated using (true);
drop policy if exists phase26_read_all on public.designations;
create policy phase26_read_all on public.designations for select to authenticated using (true);
drop policy if exists phase26_read_all on public.designation_role_mappings;
create policy phase26_read_all on public.designation_role_mappings for select to authenticated using (true);
drop policy if exists phase26_read_all on public.areas;
create policy phase26_read_all on public.areas for select to authenticated using (true);
drop policy if exists phase26_read_all on public.org_assignment_history;
create policy phase26_read_all on public.org_assignment_history for select to authenticated using (true);
drop policy if exists phase26_read_all on public.branch_area_assignments;
create policy phase26_read_all on public.branch_area_assignments for select to authenticated using (true);
drop policy if exists phase26_read_all on public.employee_supervisors;
create policy phase26_read_all on public.employee_supervisors for select to authenticated using (true);
drop policy if exists phase26_read_all on public.hierarchy_exceptions;
create policy phase26_read_all on public.hierarchy_exceptions for select to authenticated using (true);
drop policy if exists phase26_read_all on public.data_quality_exceptions;
create policy phase26_read_all on public.data_quality_exceptions for select to authenticated using (true);
drop policy if exists phase26_read_all on public.staff_import_batches;
create policy phase26_read_all on public.staff_import_batches for select to authenticated using (true);
drop policy if exists phase26_read_all on public.performance_config_sections;
create policy phase26_read_all on public.performance_config_sections for select to authenticated using (true);
drop policy if exists phase26_read_all on public.performance_config;
create policy phase26_read_all on public.performance_config for select to authenticated using (true);
drop policy if exists phase26_read_all on public.performance_config_audit;
create policy phase26_read_all on public.performance_config_audit for select to authenticated using (true);
drop policy if exists phase26_read_all on public.employee_account_invites;
create policy phase26_read_all on public.employee_account_invites for select to authenticated using (true);

-- ------------------------------------------------------------
-- 16. STAFF MASTER SEED — 215 employees (marker expanded by build script)
-- ------------------------------------------------------------
-- GENERATED FILE — do not edit by hand. Regenerate with:
--   node scripts/parse_hr_masterdata.js
-- Source: INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md
-- Rows: 215

insert into public.employees (
  full_name, email, department, "position", designation_id,
  staff_id, employee_number, employee_code,
  branch, branch_id, confirmation_status, hire_date,
  employment_status, source, import_source, imported_from_bank_master,
  updated_at
) values
  ('Amaka Nwosu', 'amaka.nwosu@infinitycorebank.com', 'CREDIT & MARKETING', 'AREA MANAGER (AREA 1)', (select id from public.designations d where d.title = 'AREA MANAGER (AREA 1)' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-001', 'IMFB-KH-001', 'IMFB-KH-001', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'CONFIRMED', '2019-03-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Uche Obi', 'uche.obi@infinitycorebank.com', 'CREDIT & MARKETING', 'BRANCH MANAGER', (select id from public.designations d where d.title = 'BRANCH MANAGER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-002', 'IMFB-KH-002', 'IMFB-KH-002', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'CONFIRMED', '2020-07-21', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Kelechi Eze', 'kelechi.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-003', 'IMFB-KH-003', 'IMFB-KH-003', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'UNCONFIRMED', '2022-02-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adaeze Okonkwo', 'adaeze.okonkwo@infinitycorebank.com', 'CREDIT & MARKETING', 'SENIOR SME OFFICER', (select id from public.designations d where d.title = 'SENIOR SME OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-004', 'IMFB-KH-004', 'IMFB-KH-004', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2018-09-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Nnenna Ibe', 'nnenna.ibe@infinitycorebank.com', 'CREDIT & MARKETING', 'AREA MANAGER (AREA 1)', (select id from public.designations d where d.title = 'AREA MANAGER (AREA 1)' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-005', 'IMFB-KH-005', 'IMFB-KH-005', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2019-01-30', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Emeka Okafor', 'emeka.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-006', 'IMFB-KH-006', 'IMFB-KH-006', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'UNCONFIRMED', '2022-06-17', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chiamaka Nwoye', 'chiamaka.nwoye@infinitycorebank.com', 'CREDIT & MARKETING', 'SME OFFICER', (select id from public.designations d where d.title = 'SME OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-007', 'IMFB-KH-007', 'IMFB-KH-007', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'CONFIRMED', '2016-12-08', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ifeanyi Ohaka', 'ifeanyi.ohaka@infinitycorebank.com', 'CREDIT & MARKETING', 'BRANCH MANAGER', (select id from public.designations d where d.title = 'BRANCH MANAGER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-008', 'IMFB-KH-008', 'IMFB-KH-008', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'UNCONFIRMED', '2021-05-03', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Blessing Akpan', 'blessing.akpan@infinitycorebank.com', 'CREDIT & MARKETING', 'AREA MANAGER (AREA 1)', (select id from public.designations d where d.title = 'AREA MANAGER (AREA 1)' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-009', 'IMFB-KH-009', 'IMFB-KH-009', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'CONFIRMED', '2018-10-26', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Tunde Bakare', 'tunde.bakare@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-010', 'IMFB-KH-010', 'IMFB-KH-010', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'CONFIRMED', '2019-08-19', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Yetunde Lawal', 'yetunde.lawal@infinitycorebank.com', 'CREDIT & MARKETING', 'BRANCH MANAGER', (select id from public.designations d where d.title = 'BRANCH MANAGER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-011', 'IMFB-KH-011', 'IMFB-KH-011', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'CONFIRMED', '2015-03-11', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chinedu Obi', 'chinedu.obi@infinitycorebank.com', 'CREDIT & MARKETING', 'AREA MANAGER (AREA 1)', (select id from public.designations d where d.title = 'AREA MANAGER (AREA 1)' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-012', 'IMFB-KH-012', 'IMFB-KH-012', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'CONFIRMED', '2017-06-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Halima Suleiman', 'halima.suleiman@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-013', 'IMFB-KH-013', 'IMFB-KH-013', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'UNCONFIRMED', '2023-02-23', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Segun Adeyemi', 'segun.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'BRANCH MANAGER', (select id from public.designations d where d.title = 'BRANCH MANAGER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-014', 'IMFB-KH-014', 'IMFB-KH-014', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'CONFIRMED', '2016-11-15', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adebayo Thomas', 'adebayo.thomas@infinitycorebank.com', 'CREDIT & MARKETING', 'AREA MANAGER (AREA 2)', (select id from public.designations d where d.title = 'AREA MANAGER (AREA 2)' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-015', 'IMFB-KH-015', 'IMFB-KH-015', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'CONFIRMED', '2019-05-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ngozi Okoro', 'ngozi.okoro@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-016', 'IMFB-KH-016', 'IMFB-KH-016', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'CONTRACT STAFF', '2023-04-01', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Bolanle Ajayi', 'bolanle.ajayi@infinitycorebank.com', 'CREDIT & MARKETING', 'SME OFFICER', (select id from public.designations d where d.title = 'SME OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-017', 'IMFB-KH-017', 'IMFB-KH-017', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'CONFIRMED', '2018-02-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ireti Adewale', 'ireti.adewale@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-018', 'IMFB-KH-018', 'IMFB-KH-018', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'UNCONFIRMED', '2022-07-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chukwuma Ogbechie', 'chukwuma.ogbechie@infinitycorebank.com', 'CREDIT & MARKETING', 'BRANCH MANAGER', (select id from public.designations d where d.title = 'BRANCH MANAGER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-019', 'IMFB-KH-019', 'IMFB-KH-019', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'CONFIRMED', '2020-01-27', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Oluwaseun Adeleke', 'oluwaseun.adeleke@infinitycorebank.com', 'CREDIT & MARKETING', 'AREA MANAGER (AREA 2)', (select id from public.designations d where d.title = 'AREA MANAGER (AREA 2)' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-020', 'IMFB-KH-020', 'IMFB-KH-020', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'CONFIRMED', '2014-08-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Kafayat Bello', 'kafayat.bello@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-021', 'IMFB-KH-021', 'IMFB-KH-021', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'CONFIRMED', '2019-09-25', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Opeyemi Adesina', 'opeyemi.adesina@infinitycorebank.com', 'CREDIT & MARKETING', 'BRANCH MANAGER', (select id from public.designations d where d.title = 'BRANCH MANAGER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-022', 'IMFB-KH-022', 'IMFB-KH-022', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'CONFIRMED', '2019-06-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Funmilayo Balogun', 'funmilayo.balogun@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-023', 'IMFB-KH-023', 'IMFB-KH-023', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'UNCONFIRMED', '2023-03-28', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adaeze Okafor', 'adaeze.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'BRANCH MANAGER', (select id from public.designations d where d.title = 'BRANCH MANAGER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-024', 'IMFB-KH-024', 'IMFB-KH-024', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'CONFIRMED', '2020-07-13', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Olayemi Adenuga', 'olayemi.adenuga@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-025', 'IMFB-KH-025', 'IMFB-KH-025', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'CONFIRMED', '2021-12-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Sule Ameh', 'sule.ameh@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-026', 'IMFB-KH-026', 'IMFB-KH-026', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'UNCONFIRMED', '2022-06-20', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chinwe Ekwueme', 'chinwe.ekwueme@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-027', 'IMFB-KH-027', 'IMFB-KH-027', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2020-10-11', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Bisi Ajayi', 'bisi.ajayi@infinitycorebank.com', 'CREDIT & MARKETING', 'AREA MANAGER (AREA 2)', (select id from public.designations d where d.title = 'AREA MANAGER (AREA 2)' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-028', 'IMFB-KH-028', 'IMFB-KH-028', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2016-04-22', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Grace Eze', 'grace.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-029', 'IMFB-KH-029', 'IMFB-KH-029', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'CONFIRMED', '2020-01-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Peter Sunday', 'peter.sunday@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-030', 'IMFB-KH-030', 'IMFB-KH-030', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'UNCONFIRMED', '2022-11-16', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Aisha Mohammed', 'aisha.mohammed@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-031', 'IMFB-KH-031', 'IMFB-KH-031', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'CONFIRMED', '2021-05-06', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ibrahim Musa', 'ibrahim.musa@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-032', 'IMFB-KH-032', 'IMFB-KH-032', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'CONFIRMED', '2021-10-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Folake Adeyemi', 'folake.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'SENIOR LOAN OFFICER', (select id from public.designations d where d.title = 'SENIOR LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-033', 'IMFB-KH-033', 'IMFB-KH-033', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'CONFIRMED', '2017-08-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Celestine Okoye', 'celestine.okoye@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-034', 'IMFB-KH-034', 'IMFB-KH-034', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'UNCONFIRMED', '2022-09-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Abiodun Alabi', 'abiodun.alabi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-035', 'IMFB-KH-035', 'IMFB-KH-035', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'CONFIRMED', '2020-03-24', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Nnamdi Okafor', 'nnamdi.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-036', 'IMFB-KH-036', 'IMFB-KH-036', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'CONFIRMED', '2019-07-29', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Aderonke Oladele', 'aderonke.oladele@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-037', 'IMFB-KH-037', 'IMFB-KH-037', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'UNCONFIRMED', '2022-08-15', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ayodeji Olawale', 'ayodeji.olawale@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-038', 'IMFB-KH-038', 'IMFB-KH-038', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2020-04-30', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Mary Olayinka', 'mary.olayinka@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-039', 'IMFB-KH-039', 'IMFB-KH-039', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'CONFIRMED', '2021-06-07', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Tobi Adewumi', 'tobi.adewumi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-040', 'IMFB-KH-040', 'IMFB-KH-040', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'UNCONFIRMED', '2023-03-11', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chidera Obi', 'chidera.obi@infinitycorebank.com', 'CREDIT & MARKETING', 'SME OFFICER', (select id from public.designations d where d.title = 'SME OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-041', 'IMFB-KH-041', 'IMFB-KH-041', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2018-02-19', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Fatima Bello', 'fatima.bello@infinitycorebank.com', 'CREDIT & MARKETING', 'SME OFFICER', (select id from public.designations d where d.title = 'SME OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-042', 'IMFB-KH-042', 'IMFB-KH-042', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'CONFIRMED', '2020-11-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adewale Adeyemi', 'adewale.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-043', 'IMFB-KH-043', 'IMFB-KH-043', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'CONFIRMED', '2021-04-27', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Oluwafemi Omotayo', 'oluwafemi.omotayo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-044', 'IMFB-KH-044', 'IMFB-KH-044', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'UNCONFIRMED', '2022-09-21', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chioma Umeh', 'chioma.umeh@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-045', 'IMFB-KH-045', 'IMFB-KH-045', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'CONFIRMED', '2021-04-08', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Kanayo Nduka', 'kanayo.nduka@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-046', 'IMFB-KH-046', 'IMFB-KH-046', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'UNCONFIRMED', '2022-12-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ngozi Okafor', 'ngozi.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-047', 'IMFB-KH-047', 'IMFB-KH-047', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'CONFIRMED', '2020-02-03', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Samuel Adebayo', 'samuel.adebayo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-048', 'IMFB-KH-048', 'IMFB-KH-048', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2021-07-26', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Omolara Adewole', 'omolara.adewole@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-049', 'IMFB-KH-049', 'IMFB-KH-049', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'CONFIRMED', '2019-05-17', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Abubakar Sani', 'abubakar.sani@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-050', 'IMFB-KH-050', 'IMFB-KH-050', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'CONFIRMED', '2023-02-13', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Abimbola Odu', 'abimbola.odu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-051', 'IMFB-KH-051', 'IMFB-KH-051', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'UNCONFIRMED', '2023-03-06', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Oluwaseun Ogun', 'oluwaseun.ogun@infinitycorebank.com', 'CREDIT & MARKETING', 'SME OFFICER', (select id from public.designations d where d.title = 'SME OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-052', 'IMFB-KH-052', 'IMFB-KH-052', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'CONFIRMED', '2020-04-20', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ezinne Anyanwu', 'ezinne.anyanwu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-053', 'IMFB-KH-053', 'IMFB-KH-053', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'CONFIRMED', '2019-08-22', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Temitope Adeola', 'temitope.adeola@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-054', 'IMFB-KH-054', 'IMFB-KH-054', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'UNCONFIRMED', '2022-10-25', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Yetunde Akinola', 'yetunde.akinola@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-055', 'IMFB-KH-055', 'IMFB-KH-055', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'CONFIRMED', '2021-06-28', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ibrahim Lawal', 'ibrahim.lawal@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-056', 'IMFB-KH-056', 'IMFB-KH-056', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2020-03-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Oluchi Obi', 'oluchi.obi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-057', 'IMFB-KH-057', 'IMFB-KH-057', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'CONFIRMED', '2023-01-16', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Zakari Aliyu', 'zakari.aliyu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-058', 'IMFB-KH-058', 'IMFB-KH-058', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'CONFIRMED', '2019-09-23', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chioma Nwosu', 'chioma.nwosu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-059', 'IMFB-KH-059', 'IMFB-KH-059', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'UNCONFIRMED', '2022-08-04', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Babatunde Ojo', 'babatunde.ojo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-060', 'IMFB-KH-060', 'IMFB-KH-060', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'CONFIRMED', '2018-12-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Nkechi Eze', 'nkechi.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-061', 'IMFB-KH-061', 'IMFB-KH-061', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'CONFIRMED', '2020-07-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Gbenga Adeleke', 'gbenga.adeleke@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-062', 'IMFB-KH-062', 'IMFB-KH-062', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'UNCONFIRMED', '2022-05-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Amina Yusuf', 'amina.yusuf@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-063', 'IMFB-KH-063', 'IMFB-KH-063', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'CONFIRMED', '2019-11-07', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Tobiloba Adeyemi', 'tobiloba.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-064', 'IMFB-KH-064', 'IMFB-KH-064', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2021-05-30', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Umar Farouk', 'umar.farouk@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-065', 'IMFB-KH-065', 'IMFB-KH-065', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'CONFIRMED', '2020-10-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adeola Ogunleye', 'adeola.ogunleye@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-066', 'IMFB-KH-066', 'IMFB-KH-066', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'UNCONFIRMED', '2022-01-19', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ijeoma Uzochukwu', 'ijeoma.uzochukwu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-067', 'IMFB-KH-067', 'IMFB-KH-067', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'CONFIRMED', '2021-04-26', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Femi Adewusi', 'femi.adewusi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-068', 'IMFB-KH-068', 'IMFB-KH-068', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'CONFIRMED', '2020-11-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chukwuemeka Eze', 'chukwuemeka.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-069', 'IMFB-KH-069', 'IMFB-KH-069', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'UNCONFIRMED', '2023-02-22', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Titilayo Adewale', 'titilayo.adewale@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-070', 'IMFB-KH-070', 'IMFB-KH-070', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'CONFIRMED', '2018-08-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Danladi Ibrahim', 'danladi.ibrahim@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-071', 'IMFB-KH-071', 'IMFB-KH-071', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'CONFIRMED', '2020-12-24', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Oluwatoyin Adebayo', 'oluwatoyin.adebayo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-072', 'IMFB-KH-072', 'IMFB-KH-072', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2022-03-17', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Aliyu Abubakar', 'aliyu.abubakar@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-073', 'IMFB-KH-073', 'IMFB-KH-073', 'BARIGA/LAGOS Island 1', (select id from public.branches b where b.branch_name = 'BARIGA/LAGOS Island 1' limit 1), 'UNCONFIRMED', '2022-06-08', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Oluwaseun Adeleke', 'oluwaseun.adeleke2@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-074', 'IMFB-KH-074', 'IMFB-KH-074', 'AGEGE & EGBEDA', (select id from public.branches b where b.branch_name = 'AGEGE & EGBEDA' limit 1), 'CONFIRMED', '2021-01-11', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Kemi Oloruntoba', 'kemi.oloruntoba@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-075', 'IMFB-KH-075', 'IMFB-KH-075', 'TRADE FAIR/BOUNDARY/ALABA', (select id from public.branches b where b.branch_name = 'TRADE FAIR/BOUNDARY/ALABA' limit 1), 'CONFIRMED', '2019-09-29', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adeyosola Oyetola', 'adeyosola.oyetola@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-076', 'IMFB-KH-076', 'IMFB-KH-076', 'MUSHIN/YABA', (select id from public.branches b where b.branch_name = 'MUSHIN/YABA' limit 1), 'UNCONFIRMED', '2023-03-01', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ngozi Nnamdi', 'ngozi.nnamdi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-077', 'IMFB-KH-077', 'IMFB-KH-077', 'KOLA & ILE-EPO', (select id from public.branches b where b.branch_name = 'KOLA & ILE-EPO' limit 1), 'CONFIRMED', '2021-10-21', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Yakubu Garba', 'yakubu.garba@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-078', 'IMFB-KH-078', 'IMFB-KH-078', 'KETU & HEAD OFFICE', (select id from public.branches b where b.branch_name = 'KETU & HEAD OFFICE' limit 1), 'CONFIRMED', '2019-06-13', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Timilehin Adeola', 'timilehin.adeola@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-079', 'IMFB-KH-079', 'IMFB-KH-079', 'OSHODI & IKEJA', (select id from public.branches b where b.branch_name = 'OSHODI & IKEJA' limit 1), 'UNCONFIRMED', '2022-08-04', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chinonso Iheanacho', 'chinonso.iheanacho@infinitycorebank.com', 'CREDIT & MARKETING', 'SME OFFICER', (select id from public.designations d where d.title = 'SME OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-080', 'IMFB-KH-080', 'IMFB-KH-080', 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH', (select id from public.branches b where b.branch_name = 'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH' limit 1), 'CONFIRMED', '2019-05-27', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Aisha Abubakar', 'aisha.abubakar@infinitycorebank.com', 'ADMINISTRATION', 'ADMIN OFFICER', (select id from public.designations d where d.title = 'ADMIN OFFICER' and d.department = 'ADMINISTRATION' limit 1), 'IMFB-KH-081', 'IMFB-KH-081', 'IMFB-KH-081', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-09-20', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Zainab Adeyemi', 'zainab.adeyemi@infinitycorebank.com', 'ADMINISTRATION', 'ADMIN MANAGER', (select id from public.designations d where d.title = 'ADMIN MANAGER' and d.department = 'ADMINISTRATION' limit 1), 'IMFB-KH-082', 'IMFB-KH-082', 'IMFB-KH-082', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2016-04-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ahmed Ogunwale', 'ahmed.ogunwale@infinitycorebank.com', 'OPERATIONS', 'HEAD OF OPERATIONS', (select id from public.designations d where d.title = 'HEAD OF OPERATIONS' and d.department = 'OPERATIONS' limit 1), 'IMFB-KH-083', 'IMFB-KH-083', 'IMFB-KH-083', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2013-11-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Maryam Sanusi', 'maryam.sanusi@infinitycorebank.com', 'OPERATIONS', 'HEAD, CONTACT CENTRE', (select id from public.designations d where d.title = 'HEAD, CONTACT CENTRE' and d.department = 'OPERATIONS' limit 1), 'IMFB-KH-084', 'IMFB-KH-084', 'IMFB-KH-084', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2015-06-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Kelechi Okafor', 'kelechi.okafor@infinitycorebank.com', 'E-BUSINESS', 'HEAD, E-BANKING', (select id from public.designations d where d.title = 'HEAD, E-BANKING' and d.department = 'E-BUSINESS' limit 1), 'IMFB-KH-085', 'IMFB-KH-085', 'IMFB-KH-085', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2014-02-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ademola Olatunji', 'ademola.olatunji@infinitycorebank.com', 'MD/CEO', 'HEAD OF BUSINESS', (select id from public.designations d where d.title = 'HEAD OF BUSINESS' and d.department = 'MD/CEO' limit 1), 'IMFB-KH-086', 'IMFB-KH-086', 'IMFB-KH-086', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2012-10-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chidi Okafor', 'chidi.okafor@infinitycorebank.com', 'E-BUSINESS', 'HEAD OF DIGITAL BANKING', (select id from public.designations d where d.title = 'HEAD OF DIGITAL BANKING' and d.department = 'E-BUSINESS' limit 1), 'IMFB-KH-087', 'IMFB-KH-087', 'IMFB-KH-087', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-07-25', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Uloaku Nnaji', 'uloaku.nnaji@infinitycorebank.com', 'LOAN MONITORING & RECOVERY', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'LOAN MONITORING & RECOVERY' limit 1), 'IMFB-KH-088', 'IMFB-KH-088', 'IMFB-KH-088', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-03-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Bamidele Adebayo', 'bamidele.adebayo@infinitycorebank.com', 'LOAN MONITORING & RECOVERY', 'HEAD, LOAN MONITORING & RECOVERY', (select id from public.designations d where d.title = 'HEAD, LOAN MONITORING & RECOVERY' and d.department = 'LOAN MONITORING & RECOVERY' limit 1), 'IMFB-KH-089', 'IMFB-KH-089', 'IMFB-KH-089', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2017-08-19', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Tunde Adebayo', 'tunde.adebayo@infinitycorebank.com', 'RECOVERY', 'HEAD OF RECOVERY', (select id from public.designations d where d.title = 'HEAD OF RECOVERY' and d.department = 'RECOVERY' limit 1), 'IMFB-KH-090', 'IMFB-KH-090', 'IMFB-KH-090', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2015-05-08', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Gbenga Adewale', 'gbenga.adewale@infinitycorebank.com', 'MD/CEO', 'EXECUTIVE DIRECTOR', (select id from public.designations d where d.title = 'EXECUTIVE DIRECTOR' and d.department = 'MD/CEO' limit 1), 'IMFB-KH-091', 'IMFB-KH-091', 'IMFB-KH-091', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2011-03-03', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Funke Ogunlesi', 'funke.ogunlesi@infinitycorebank.com', 'HUMAN RESOURCES', 'HEAD, HUMAN RESOURCES', (select id from public.designations d where d.title = 'HEAD, HUMAN RESOURCES' and d.department = 'HUMAN RESOURCES' limit 1), 'IMFB-KH-092', 'IMFB-KH-092', 'IMFB-KH-092', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2015-06-22', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Lola Akintola', 'lola.akintola@infinitycorebank.com', 'HUMAN RESOURCES', 'HR MANAGER', (select id from public.designations d where d.title = 'HR MANAGER' and d.department = 'HUMAN RESOURCES' limit 1), 'IMFB-KH-093', 'IMFB-KH-093', 'IMFB-KH-093', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-01-15', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chinedu Okafor', 'chinedu.okafor@infinitycorebank.com', 'AUDIT & INVESTIGATION', 'HEAD OF INTERNAL CONTROL', (select id from public.designations d where d.title = 'HEAD OF INTERNAL CONTROL' and d.department = 'AUDIT & INVESTIGATION' limit 1), 'IMFB-KH-094', 'IMFB-KH-094', 'IMFB-KH-094', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2014-09-28', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Okon Bassey', 'okon.bassey@infinitycorebank.com', 'AUDIT & INVESTIGATION', 'HEAD OF AUDIT', (select id from public.designations d where d.title = 'HEAD OF AUDIT' and d.department = 'AUDIT & INVESTIGATION' limit 1), 'IMFB-KH-095', 'IMFB-KH-095', 'IMFB-KH-095', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2016-04-11', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Anita Okoro', 'anita.okoro@infinitycorebank.com', 'MD/CEO', 'MD/CEO', (select id from public.designations d where d.title = 'MD/CEO' and d.department = 'MD/CEO' limit 1), 'IMFB-KH-096', 'IMFB-KH-096', 'IMFB-KH-096', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2010-08-06', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adaeze Obi', 'adaeze.obi@infinitycorebank.com', 'RISK & COMPLIANCE', 'HEAD, RISK MANAGEMENT', (select id from public.designations d where d.title = 'HEAD, RISK MANAGEMENT' and d.department = 'RISK & COMPLIANCE' limit 1), 'IMFB-KH-097', 'IMFB-KH-097', 'IMFB-KH-097', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2015-07-13', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Nkechi Eze', 'nkechi.eze@infinitycorebank.com', 'RISK & COMPLIANCE', 'HEAD OF COMPLIANCE', (select id from public.designations d where d.title = 'HEAD OF COMPLIANCE' and d.department = 'RISK & COMPLIANCE' limit 1), 'IMFB-KH-098', 'IMFB-KH-098', 'IMFB-KH-098', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-24', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ugochukwu Nwosu', 'ugochukwu.nwosu@infinitycorebank.com', 'FINANCIAL CONTROL', 'FINANCIAL CONTROLLER', (select id from public.designations d where d.title = 'FINANCIAL CONTROLLER' and d.department = 'FINANCIAL CONTROL' limit 1), 'IMFB-KH-099', 'IMFB-KH-099', 'IMFB-KH-099', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2014-12-17', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Bisi Ajayi', 'bisi.ajayi@infinitycorebank.com', 'FINANCIAL CONTROL', 'CHIEF FINANCIAL OFFICER', (select id from public.designations d where d.title = 'CHIEF FINANCIAL OFFICER' and d.department = 'FINANCIAL CONTROL' limit 1), 'IMFB-KH-100', 'IMFB-KH-100', 'IMFB-KH-100', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2012-05-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Omolayo Adeyemi', 'omolayo.adeyemi@infinitycorebank.com', 'FINANCIAL CONTROL', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'FINANCIAL CONTROL' limit 1), 'IMFB-KH-101', 'IMFB-KH-101', 'IMFB-KH-101', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-10-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Kolawole Adeyemi', 'kolawole.adeyemi@infinitycorebank.com', 'FINANCIAL CONTROL', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'FINANCIAL CONTROL' limit 1), 'IMFB-KH-102', 'IMFB-KH-102', 'IMFB-KH-102', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-03-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ikenna Nwachukwu', 'ikenna.nwachukwu@infinitycorebank.com', 'FINANCIAL CONTROL', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'FINANCIAL CONTROL' limit 1), 'IMFB-KH-103', 'IMFB-KH-103', 'IMFB-KH-103', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-08-27', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Soji Aderemi', 'soji.aderemi@infinitycorebank.com', 'INFORMATION TECHNOLOGY', 'ICT OFFICER', (select id from public.designations d where d.title = 'ICT OFFICER' and d.department = 'INFORMATION TECHNOLOGY' limit 1), 'IMFB-KH-104', 'IMFB-KH-104', 'IMFB-KH-104', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-01-23', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Funmilayo Adegbite', 'funmilayo.adegbite@infinitycorebank.com', 'INFORMATION TECHNOLOGY', 'HEAD OF INFORMATION TECHNOLOGY', (select id from public.designations d where d.title = 'HEAD OF INFORMATION TECHNOLOGY' and d.department = 'INFORMATION TECHNOLOGY' limit 1), 'IMFB-KH-105', 'IMFB-KH-105', 'IMFB-KH-105', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2017-09-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chibueze Okafor', 'chibueze.okafor@infinitycorebank.com', 'INFORMATION TECHNOLOGY', 'ICT OFFICER', (select id from public.designations d where d.title = 'ICT OFFICER' and d.department = 'INFORMATION TECHNOLOGY' limit 1), 'IMFB-KH-106', 'IMFB-KH-106', 'IMFB-KH-106', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-07-06', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Oluwakemi Adeyemi', 'oluwakemi.adeyemi@infinitycorebank.com', 'LEGAL', 'HEAD OF LEGAL', (select id from public.designations d where d.title = 'HEAD OF LEGAL' and d.department = 'LEGAL' limit 1), 'IMFB-KH-107', 'IMFB-KH-107', 'IMFB-KH-107', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2016-03-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adesina Ogunleye', 'adesina.ogunleye@infinitycorebank.com', 'LEGAL', 'LEGAL OFFICER', (select id from public.designations d where d.title = 'LEGAL OFFICER' and d.department = 'LEGAL' limit 1), 'IMFB-KH-108', 'IMFB-KH-108', 'IMFB-KH-108', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2021-11-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Yemi Adekoya', 'yemi.adekoya@infinitycorebank.com', 'CREDIT & MARKETING', 'HEAD OF OTHER CREDIT UNITS', (select id from public.designations d where d.title = 'HEAD OF OTHER CREDIT UNITS' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-109', 'IMFB-KH-109', 'IMFB-KH-109', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-05-29', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ahmed Bello', 'ahmed.bello@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-110', 'IMFB-KH-110', 'IMFB-KH-110', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-02-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Bukola Adeyemi', 'bukola.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-111', 'IMFB-KH-111', 'IMFB-KH-111', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-09-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ibrahim Adeyemi', 'ibrahim.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-112', 'IMFB-KH-112', 'IMFB-KH-112', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-06-15', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chinedu Onyeka', 'chinedu.onyeka@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-113', 'IMFB-KH-113', 'IMFB-KH-113', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-08-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Maryam Okafor', 'maryam.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-114', 'IMFB-KH-114', 'IMFB-KH-114', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-02-23', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Osaro Eghosa', 'osaro.eghosa@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-115', 'IMFB-KH-115', 'IMFB-KH-115', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-11-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Habiba Kasim', 'habiba.kasim@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-116', 'IMFB-KH-116', 'IMFB-KH-116', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2022-03-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Nnenna Eze', 'nnenna.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'SME OFFICER', (select id from public.designations d where d.title = 'SME OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-117', 'IMFB-KH-117', 'IMFB-KH-117', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-07-01', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Olisa Eze', 'olisa.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-118', 'IMFB-KH-118', 'IMFB-KH-118', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-04-26', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Zainab Bello', 'zainab.bello@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-119', 'IMFB-KH-119', 'IMFB-KH-119', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-10-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ridwan Olamilekan', 'ridwan.olamilekan@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-120', 'IMFB-KH-120', 'IMFB-KH-120', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-06-28', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Abosede Lawal', 'abosede.lawal@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-121', 'IMFB-KH-121', 'IMFB-KH-121', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-05-11', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Musibau Adeleke', 'musibau.adeleke@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-122', 'IMFB-KH-122', 'IMFB-KH-122', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2017-12-03', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adeola Osho', 'adeola.osho@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-123', 'IMFB-KH-123', 'IMFB-KH-123', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-01-22', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Emeka Nwosu', 'emeka.nwosu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-124', 'IMFB-KH-124', 'IMFB-KH-124', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-08-16', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Aderemi Olajide', 'aderemi.olajide@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-125', 'IMFB-KH-125', 'IMFB-KH-125', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-04-06', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Samira Usman', 'samira.usman@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-126', 'IMFB-KH-126', 'IMFB-KH-126', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-09-19', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ogochukwu Obi', 'ogochukwu.obi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-127', 'IMFB-KH-127', 'IMFB-KH-127', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2022-02-07', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Joseph Adebayo', 'joseph.adebayo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-128', 'IMFB-KH-128', 'IMFB-KH-128', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-03-26', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Khadijat Oyedeji', 'khadijat.oyedeji@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-129', 'IMFB-KH-129', 'IMFB-KH-129', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-11-13', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Segun Ogunleye', 'segun.ogunleye@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-130', 'IMFB-KH-130', 'IMFB-KH-130', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-06-04', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chika Obi', 'chika.obi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-131', 'IMFB-KH-131', 'IMFB-KH-131', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-01-17', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Nobert Adewopo', 'nobert.adewopo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-132', 'IMFB-KH-132', 'IMFB-KH-132', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-07-29', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Eniola Ogunlana', 'eniola.ogunlana@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-133', 'IMFB-KH-133', 'IMFB-KH-133', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2023-03-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adeola Adewale', 'adeola.adewale@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-134', 'IMFB-KH-134', 'IMFB-KH-134', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-08-21', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Tunde Oyerinde', 'tunde.oyerinde@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-135', 'IMFB-KH-135', 'IMFB-KH-135', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-05-15', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Njideka Okoli', 'njideka.okoli@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-136', 'IMFB-KH-136', 'IMFB-KH-136', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-12-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Salawu Adeleke', 'salawu.adeleke@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-137', 'IMFB-KH-137', 'IMFB-KH-137', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-02-24', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ngozi Nwosu', 'ngozi.nwosu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-138', 'IMFB-KH-138', 'IMFB-KH-138', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-08-08', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Waheed Adamu', 'waheed.adamu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-139', 'IMFB-KH-139', 'IMFB-KH-139', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-04-30', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Abimbola Oyeniyi', 'abimbola.oyeniyi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-140', 'IMFB-KH-140', 'IMFB-KH-140', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-05-17', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ifeoluwa Adewale', 'ifeoluwa.adewale@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-141', 'IMFB-KH-141', 'IMFB-KH-141', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-10-06', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Rosemary Eze', 'rosemary.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-142', 'IMFB-KH-142', 'IMFB-KH-142', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-06-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Olamide Adeyemi', 'olamide.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-143', 'IMFB-KH-143', 'IMFB-KH-143', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-11-28', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Folorunso Adebayo', 'folorunso.adebayo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-144', 'IMFB-KH-144', 'IMFB-KH-144', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-09-21', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Hameed Adebayo', 'hameed.adebayo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-145', 'IMFB-KH-145', 'IMFB-KH-145', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2017-03-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Kelechi Nwosu', 'kelechi.nwosu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-146', 'IMFB-KH-146', 'IMFB-KH-146', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-05-19', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Oreoluwa Adeyemi', 'oreoluwa.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-147', 'IMFB-KH-147', 'IMFB-KH-147', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-01-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Yemisi Adeola', 'yemisi.adeola@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-148', 'IMFB-KH-148', 'IMFB-KH-148', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-05-24', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Lawal Adeyemi', 'lawal.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-149', 'IMFB-KH-149', 'IMFB-KH-149', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-10-03', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Simisola Ogunleye', 'simisola.ogunleye@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-150', 'IMFB-KH-150', 'IMFB-KH-150', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-11-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Fatima Lawal', 'fatima.lawal@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-151', 'IMFB-KH-151', 'IMFB-KH-151', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-07-16', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Emeka Obiora', 'emeka.obiora@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-152', 'IMFB-KH-152', 'IMFB-KH-152', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-08-27', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Blessing Obiora', 'blessing.obiora@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-153', 'IMFB-KH-153', 'IMFB-KH-153', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-04-08', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Tope Adeyemi', 'tope.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-154', 'IMFB-KH-154', 'IMFB-KH-154', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-01-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adeyinka Osho', 'adeyinka.osho@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-155', 'IMFB-KH-155', 'IMFB-KH-155', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2017-07-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ngozi Ezeala', 'ngozi.ezeala@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-156', 'IMFB-KH-156', 'IMFB-KH-156', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-02-25', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adeola Adesina', 'adeola.adesina@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-157', 'IMFB-KH-157', 'IMFB-KH-157', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-03-07', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Femi Ogunyemi', 'femi.ogunyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-158', 'IMFB-KH-158', 'IMFB-KH-158', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-11-20', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Olanrewaju Oluwole', 'olanrewaju.oluwole@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-159', 'IMFB-KH-159', 'IMFB-KH-159', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-05-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Amina Hamza', 'amina.hamza@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-160', 'IMFB-KH-160', 'IMFB-KH-160', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-01-29', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chidimma Okafor', 'chidimma.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-161', 'IMFB-KH-161', 'IMFB-KH-161', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2022-06-13', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adaeze Okafor', 'adaeze.okafor2@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-162', 'IMFB-KH-162', 'IMFB-KH-162', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-10-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chukwudumebi Okafor', 'chukwudumebi.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-163', 'IMFB-KH-163', 'IMFB-KH-163', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-09-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Aina Ogunleye', 'aina.ogunleye@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-164', 'IMFB-KH-164', 'IMFB-KH-164', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-04-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adamu Idris', 'adamu.idris@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-165', 'IMFB-KH-165', 'IMFB-KH-165', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-12-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Eucharia Okoro', 'eucharia.okoro@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-166', 'IMFB-KH-166', 'IMFB-KH-166', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-11-26', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Iyabo Akande', 'iyabo.akande@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-167', 'IMFB-KH-167', 'IMFB-KH-167', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-06-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Osezua Omoruyi', 'osezua.omoruyi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-168', 'IMFB-KH-168', 'IMFB-KH-168', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-23', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Paulette Adeyemi', 'paulette.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-169', 'IMFB-KH-169', 'IMFB-KH-169', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-07-15', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Lawrence Ekwueme', 'lawrence.ekwueme@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-170', 'IMFB-KH-170', 'IMFB-KH-170', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-05-29', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chiamaka Amaechi', 'chiamaka.amaechi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-171', 'IMFB-KH-171', 'IMFB-KH-171', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-09-21', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Obiageli Nwosu', 'obiageli.nwosu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-172', 'IMFB-KH-172', 'IMFB-KH-172', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-07-11', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Sunday Ogbonna', 'sunday.ogbonna@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-173', 'IMFB-KH-173', 'IMFB-KH-173', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-12-03', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Laila Adewale', 'laila.adewale@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-174', 'IMFB-KH-174', 'IMFB-KH-174', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2022-02-18', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Kehinde Adeyemi', 'kehinde.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-175', 'IMFB-KH-175', 'IMFB-KH-175', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2017-08-14', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Maimuna Adamu', 'maimuna.adamu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-176', 'IMFB-KH-176', 'IMFB-KH-176', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-01-26', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Olugbenga Adewale', 'olugbenga.adewale@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-177', 'IMFB-KH-177', 'IMFB-KH-177', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-09-08', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Uzor Okechukwu', 'uzor.okechukwu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-178', 'IMFB-KH-178', 'IMFB-KH-178', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2018-04-17', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Abike Adeyemi', 'abike.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-179', 'IMFB-KH-179', 'IMFB-KH-179', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-05-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Osaretin Okafor', 'osaretin.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-180', 'IMFB-KH-180', 'IMFB-KH-180', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-02-19', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Muritala Adeyemi', 'muritala.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-181', 'IMFB-KH-181', 'IMFB-KH-181', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2022-06-01', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Janet Okafor', 'janet.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-182', 'IMFB-KH-182', 'IMFB-KH-182', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-09-25', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Sikiru Adeyemi', 'sikiru.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-183', 'IMFB-KH-183', 'IMFB-KH-183', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-05-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ngozi Okafor2', 'ngozi.okafor2@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-184', 'IMFB-KH-184', 'IMFB-KH-184', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-01-28', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ifeoma Eze', 'ifeoma.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-185', 'IMFB-KH-185', 'IMFB-KH-185', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-07-20', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Bosede Adeyemi', 'bosede.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-186', 'IMFB-KH-186', 'IMFB-KH-186', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-11-06', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Yinka Adebayo', 'yinka.adebayo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-187', 'IMFB-KH-187', 'IMFB-KH-187', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-06-16', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adaeze Umeh', 'adaeze.umeh@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-188', 'IMFB-KH-188', 'IMFB-KH-188', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chisom Eze', 'chisom.eze@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-189', 'IMFB-KH-189', 'IMFB-KH-189', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-10-22', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Rahmat Adeyemi', 'rahmat.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-190', 'IMFB-KH-190', 'IMFB-KH-190', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-08-05', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Okikiola Adeyemi', 'okikiola.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-191', 'IMFB-KH-191', 'IMFB-KH-191', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-03-15', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Osahon Oshodin', 'osahon.oshodin@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-192', 'IMFB-KH-192', 'IMFB-KH-192', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-02-09', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Damola Adesina', 'damola.adesina@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-193', 'IMFB-KH-193', 'IMFB-KH-193', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-30', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Funmilola Ojo', 'funmilola.ojo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-194', 'IMFB-KH-194', 'IMFB-KH-194', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-06-13', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adefunke Adeyemi', 'adefunke.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-195', 'IMFB-KH-195', 'IMFB-KH-195', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2022-08-27', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ikechukwu Okafor', 'ikechukwu.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-196', 'IMFB-KH-196', 'IMFB-KH-196', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-11-07', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Bukola Ogunleye', 'bukola.ogunleye@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-197', 'IMFB-KH-197', 'IMFB-KH-197', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-03-19', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chidinma Nwosu', 'chidinma.nwosu@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-198', 'IMFB-KH-198', 'IMFB-KH-198', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2021-04-02', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Olawale Adebayo', 'olawale.adebayo@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-199', 'IMFB-KH-199', 'IMFB-KH-199', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2019-10-12', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Yetunde Adeyemi', 'yetunde.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'LOAN OFFICER', (select id from public.designations d where d.title = 'LOAN OFFICER' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-200', 'IMFB-KH-200', 'IMFB-KH-200', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'CONFIRMED', '2020-06-25', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ogar Odey', 'ogar.odey@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-201', 'IMFB-KH-201', 'IMFB-KH-201', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Rotimi Adeleke', 'rotimi.adeleke@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-202', 'IMFB-KH-202', 'IMFB-KH-202', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Tomiwa Adeyemi', 'tomiwa.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-203', 'IMFB-KH-203', 'IMFB-KH-203', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Zainab Adewale', 'zainab.adewale@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-204', 'IMFB-KH-204', 'IMFB-KH-204', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Nnenna Ugwu', 'nnenna.ugwu@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-205', 'IMFB-KH-205', 'IMFB-KH-205', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chukwuemeka Nwafor', 'chukwuemeka.nwafor@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-206', 'IMFB-KH-206', 'IMFB-KH-206', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Adaeze Ogbu', 'adaeze.ogbu@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-207', 'IMFB-KH-207', 'IMFB-KH-207', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Balikis Alade', 'balikis.alade@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-208', 'IMFB-KH-208', 'IMFB-KH-208', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Emeka Nwankwo', 'emeka.nwankwo@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-209', 'IMFB-KH-209', 'IMFB-KH-209', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ifeoma Okafor', 'ifeoma.okafor@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-210', 'IMFB-KH-210', 'IMFB-KH-210', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Rukayat Adeyemi', 'rukayat.adeyemi@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-211', 'IMFB-KH-211', 'IMFB-KH-211', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Abiodun Adewale', 'abiodun.adewale@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-212', 'IMFB-KH-212', 'IMFB-KH-212', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Ndubuisi Eke', 'ndubuisi.eke@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-213', 'IMFB-KH-213', 'IMFB-KH-213', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Onyeka Onyeka', 'onyeka.onyeka@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-214', 'IMFB-KH-214', 'IMFB-KH-214', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now()),
  ('Chiamaka Nwosu2', 'chiamaka.nwosu2@infinitycorebank.com', 'CREDIT & MARKETING', 'MANAGEMENT TRAINEE', (select id from public.designations d where d.title = 'MANAGEMENT TRAINEE' and d.department = 'CREDIT & MARKETING' limit 1), 'IMFB-KH-215', 'IMFB-KH-215', 'IMFB-KH-215', 'HEAD OFFICE - OSHODI', (select id from public.branches b where b.branch_name = 'HEAD OFFICE - OSHODI' limit 1), 'UNCONFIRMED', '2023-04-10', 'active', 'bank_master_import', 'bank_master', true, now())

on conflict (staff_id) where staff_id is not null do update set
  full_name = coalesce(nullif(employees.full_name, ''), excluded.full_name),
  email = coalesce(nullif(employees.email, ''), excluded.email),
  department = coalesce(nullif(employees.department, ''), excluded.department),
  "position" = coalesce(nullif(employees."position", ''), excluded."position"),
  designation_id = coalesce(employees.designation_id, excluded.designation_id),
  branch = coalesce(nullif(employees.branch, ''), excluded.branch),
  branch_id = coalesce(employees.branch_id, excluded.branch_id),
  confirmation_status = coalesce(nullif(employees.confirmation_status, ''), excluded.confirmation_status),
  hire_date = coalesce(employees.hire_date, excluded.hire_date),
  employment_status = coalesce(nullif(employees.employment_status, ''), 'active'),
  source = case when employees.source is null then 'bank_master_import' else employees.source end,
  imported_from_bank_master = true,
  updated_at = now();

-- Supervisor relationships (level 1 = primary line manager)
drop table if exists _phase26_tmp_supervisors;
create temp table _phase26_tmp_supervisors (
  staff_id text primary key,
  sup1 text, sup2 text, sup3 text
);

insert into _phase26_tmp_supervisors (staff_id, sup1, sup2, sup3) values
  ('IMFB-KH-001', 'Anita Okoro', null, null),
  ('IMFB-KH-002', 'Amaka Nwosu', 'Anita Okoro', null),
  ('IMFB-KH-003', 'Uche Obi', 'Amaka Nwosu', 'Anita Okoro'),
  ('IMFB-KH-004', 'Nnenna Ibe', null, null),
  ('IMFB-KH-005', 'Anita Okoro', null, null),
  ('IMFB-KH-006', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-007', 'Ifeanyi Ohaka', null, null),
  ('IMFB-KH-008', 'Blessing Akpan', null, null),
  ('IMFB-KH-009', 'Anita Okoro', null, null),
  ('IMFB-KH-010', 'Yetunde Lawal', null, null),
  ('IMFB-KH-011', 'Chinedu Obi', null, null),
  ('IMFB-KH-012', 'Anita Okoro', null, null),
  ('IMFB-KH-013', 'Segun Adeyemi', null, null),
  ('IMFB-KH-014', 'Adebayo Thomas', null, null),
  ('IMFB-KH-015', 'Oluwaseun Adeleke', null, null),
  ('IMFB-KH-016', 'Segun Adeyemi', 'Adebayo Thomas', 'Oluwaseun Adeleke'),
  ('IMFB-KH-017', 'Adebayo Thomas', null, null),
  ('IMFB-KH-018', 'Chukwuma Ogbechie', null, null),
  ('IMFB-KH-019', 'Oluwaseun Adeleke', null, null),
  ('IMFB-KH-020', 'Bisi Ajayi', null, null),
  ('IMFB-KH-021', 'Opeyemi Adesina', null, null),
  ('IMFB-KH-022', 'Amaka Nwosu', null, null),
  ('IMFB-KH-023', 'Adaeze Okonkwo', null, null),
  ('IMFB-KH-024', 'Nnenna Ibe', null, null),
  ('IMFB-KH-025', 'Adaeze Okafor', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-026', 'Adaeze Okafor', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-027', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-028', 'Anita Okoro', null, null),
  ('IMFB-KH-029', 'Uche Obi', 'Amaka Nwosu', 'Anita Okoro'),
  ('IMFB-KH-030', 'Yetunde Lawal', 'Chinedu Obi', 'Anita Okoro'),
  ('IMFB-KH-031', 'Ifeanyi Ohaka', 'Blessing Akpan', 'Anita Okoro'),
  ('IMFB-KH-032', 'Yetunde Lawal', 'Chinedu Obi', 'Anita Okoro'),
  ('IMFB-KH-033', 'Uche Obi', 'Amaka Nwosu', 'Anita Okoro'),
  ('IMFB-KH-034', 'Opeyemi Adesina', 'Amaka Nwosu', null),
  ('IMFB-KH-035', 'Segun Adeyemi', 'Adebayo Thomas', 'Oluwaseun Adeleke'),
  ('IMFB-KH-036', 'Chukwuma Ogbechie', 'Oluwaseun Adeleke', 'Bisi Ajayi'),
  ('IMFB-KH-037', 'Opeyemi Adesina', 'Amaka Nwosu', null),
  ('IMFB-KH-038', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-039', 'Adaeze Okafor', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-040', 'Uche Obi', 'Amaka Nwosu', 'Anita Okoro'),
  ('IMFB-KH-041', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-042', 'Ifeanyi Ohaka', 'Blessing Akpan', 'Anita Okoro'),
  ('IMFB-KH-043', 'Segun Adeyemi', 'Adebayo Thomas', 'Oluwaseun Adeleke'),
  ('IMFB-KH-044', 'Yetunde Lawal', 'Chinedu Obi', 'Anita Okoro'),
  ('IMFB-KH-045', 'Opeyemi Adesina', 'Amaka Nwosu', null),
  ('IMFB-KH-046', 'Chukwuma Ogbechie', 'Oluwaseun Adeleke', 'Bisi Ajayi'),
  ('IMFB-KH-047', 'Adaeze Okafor', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-048', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-049', 'Uche Obi', 'Amaka Nwosu', 'Anita Okoro'),
  ('IMFB-KH-050', 'Yetunde Lawal', 'Chinedu Obi', 'Anita Okoro'),
  ('IMFB-KH-051', 'Ifeanyi Ohaka', 'Blessing Akpan', 'Anita Okoro'),
  ('IMFB-KH-052', 'Segun Adeyemi', 'Adebayo Thomas', 'Oluwaseun Adeleke'),
  ('IMFB-KH-053', 'Opeyemi Adesina', 'Amaka Nwosu', null),
  ('IMFB-KH-054', 'Chukwuma Ogbechie', 'Oluwaseun Adeleke', 'Bisi Ajayi'),
  ('IMFB-KH-055', 'Adaeze Okafor', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-056', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-057', 'Uche Obi', 'Amaka Nwosu', 'Anita Okoro'),
  ('IMFB-KH-058', 'Yetunde Lawal', 'Chinedu Obi', 'Anita Okoro'),
  ('IMFB-KH-059', 'Ifeanyi Ohaka', 'Blessing Akpan', 'Anita Okoro'),
  ('IMFB-KH-060', 'Segun Adeyemi', 'Adebayo Thomas', 'Oluwaseun Adeleke'),
  ('IMFB-KH-061', 'Opeyemi Adesina', 'Amaka Nwosu', null),
  ('IMFB-KH-062', 'Chukwuma Ogbechie', 'Oluwaseun Adeleke', 'Bisi Ajayi'),
  ('IMFB-KH-063', 'Adaeze Okafor', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-064', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-065', 'Uche Obi', 'Amaka Nwosu', 'Anita Okoro'),
  ('IMFB-KH-066', 'Yetunde Lawal', 'Chinedu Obi', 'Anita Okoro'),
  ('IMFB-KH-067', 'Ifeanyi Ohaka', 'Blessing Akpan', 'Anita Okoro'),
  ('IMFB-KH-068', 'Segun Adeyemi', 'Adebayo Thomas', 'Oluwaseun Adeleke'),
  ('IMFB-KH-069', 'Opeyemi Adesina', 'Amaka Nwosu', null),
  ('IMFB-KH-070', 'Chukwuma Ogbechie', 'Oluwaseun Adeleke', 'Bisi Ajayi'),
  ('IMFB-KH-071', 'Adaeze Okafor', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-072', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-073', 'Uche Obi', 'Amaka Nwosu', 'Anita Okoro'),
  ('IMFB-KH-074', 'Yetunde Lawal', 'Chinedu Obi', 'Anita Okoro'),
  ('IMFB-KH-075', 'Ifeanyi Ohaka', 'Blessing Akpan', 'Anita Okoro'),
  ('IMFB-KH-076', 'Segun Adeyemi', 'Adebayo Thomas', 'Oluwaseun Adeleke'),
  ('IMFB-KH-077', 'Opeyemi Adesina', 'Amaka Nwosu', null),
  ('IMFB-KH-078', 'Chukwuma Ogbechie', 'Oluwaseun Adeleke', 'Bisi Ajayi'),
  ('IMFB-KH-079', 'Adaeze Okafor', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-080', 'Adaeze Okonkwo', 'Nnenna Ibe', 'Anita Okoro'),
  ('IMFB-KH-081', 'Zainab Adeyemi', null, null),
  ('IMFB-KH-082', 'Ahmed Ogunwale', null, null),
  ('IMFB-KH-083', 'Maryam Sanusi', null, null),
  ('IMFB-KH-084', 'Maryam Sanusi', null, null),
  ('IMFB-KH-085', 'Ademola Olatunji', null, null),
  ('IMFB-KH-086', 'Chidi Okafor', null, null),
  ('IMFB-KH-087', 'Ademola Olatunji', null, null),
  ('IMFB-KH-088', 'Bamidele Adebayo', null, null),
  ('IMFB-KH-089', 'Tunde Adebayo', null, null),
  ('IMFB-KH-090', 'Gbenga Adewale', null, null),
  ('IMFB-KH-091', null, null, null),
  ('IMFB-KH-092', 'Lola Akintola', null, null),
  ('IMFB-KH-093', 'Funke Ogunlesi', null, null),
  ('IMFB-KH-094', 'Okon Bassey', null, null),
  ('IMFB-KH-095', 'Anita Okoro', null, null),
  ('IMFB-KH-096', null, null, null),
  ('IMFB-KH-097', 'Nkechi Eze', null, null),
  ('IMFB-KH-098', 'Nkechi Eze', null, null),
  ('IMFB-KH-099', 'Bisi Ajayi', null, null),
  ('IMFB-KH-100', 'Gbenga Adewale', null, null),
  ('IMFB-KH-101', 'Ugochukwu Nwosu', 'Bisi Ajayi', null),
  ('IMFB-KH-102', 'Ugochukwu Nwosu', 'Bisi Ajayi', null),
  ('IMFB-KH-103', 'Ugochukwu Nwosu', 'Bisi Ajayi', null),
  ('IMFB-KH-104', 'Funmilayo Adegbite', null, null),
  ('IMFB-KH-105', 'Ademola Olatunji', null, null),
  ('IMFB-KH-106', 'Funmilayo Adegbite', null, null),
  ('IMFB-KH-107', 'Adesina Ogunleye', null, null),
  ('IMFB-KH-108', 'Oluwakemi Adeyemi', null, null),
  ('IMFB-KH-109', 'Ademola Olatunji', null, null),
  ('IMFB-KH-110', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-111', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-112', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-113', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-114', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-115', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-116', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-117', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-118', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-119', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-120', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-121', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-122', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-123', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-124', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-125', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-126', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-127', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-128', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-129', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-130', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-131', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-132', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-133', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-134', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-135', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-136', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-137', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-138', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-139', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-140', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-141', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-142', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-143', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-144', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-145', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-146', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-147', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-148', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-149', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-150', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-151', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-152', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-153', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-154', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-155', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-156', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-157', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-158', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-159', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-160', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-161', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-162', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-163', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-164', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-165', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-166', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-167', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-168', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-169', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-170', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-171', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-172', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-173', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-174', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-175', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-176', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-177', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-178', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-179', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-180', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-181', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-182', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-183', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-184', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-185', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-186', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-187', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-188', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-189', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-190', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-191', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-192', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-193', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-194', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-195', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-196', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-197', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-198', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-199', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-200', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-201', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-202', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-203', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-204', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-205', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-206', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-207', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-208', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-209', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-210', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-211', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-212', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-213', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-214', 'Yemi Adekoya', 'Ademola Olatunji', null),
  ('IMFB-KH-215', 'Yemi Adekoya', 'Ademola Olatunji', null);


-- 17. BACKFILL designation_id FOR PRE-EXISTING EMPLOYEES
-- ------------------------------------------------------------
update public.employees e
   set designation_id = d.id, updated_at = now()
  from public.designations d
 where e.designation_id is null
   and e."position" is not null
   and d.title = e."position"
   and (d.department = e.department or d.department is null);

select coalesce((select count(*) from public.employees where imported_from_bank_master), 0) as bank_master_imported;

-- ------------------------------------------------------------
-- 18. HIERARCHY RESOLUTION
--     For each (staff_id, level, supervisor name): resolve by unique exact
--     full-name match. None/ambiguous/self → hierarchy_exceptions.
-- ------------------------------------------------------------
do $$
declare
  r record;
  v_emp uuid;
  v_tgt uuid;
  v_count int;
  v_src_title text;
  v_hire date;
begin
  for r in select * from _phase26_tmp_supervisors loop
    select id, hire_date, "position" into v_emp, v_hire, v_src_title
    from public.employees where staff_id = r.staff_id;
    if v_emp is null then continue; end if;

    -- level 1
    if r.sup1 is not null then
      select count(*), (array_agg(id))[1] into v_count, v_tgt
      from public.employees where lower(trim(full_name)) = lower(trim(r.sup1));
      if v_count = 1 and v_tgt is distinct from v_emp then
        insert into public.employee_supervisors (employee_id, supervisor_employee_id, level, supervisor_title, effective_from, source)
        values (v_emp, v_tgt, 1, (select "position" from public.employees where id = v_tgt), v_hire, 'bank_master')
        on conflict (employee_id, supervisor_employee_id, level) do nothing;
      elsif v_count = 1 and v_tgt = v_emp then
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup1, 1, 'self_reference') on conflict do nothing;
      elsif v_count > 1 then
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup1, 1, 'ambiguous_name') on conflict do nothing;
      else
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup1, 1, 'not_found') on conflict do nothing;
      end if;
    end if;

    -- level 2
    if r.sup2 is not null then
      select count(*), (array_agg(id))[1] into v_count, v_tgt
      from public.employees where lower(trim(full_name)) = lower(trim(r.sup2));
      if v_count = 1 and v_tgt is distinct from v_emp then
        insert into public.employee_supervisors (employee_id, supervisor_employee_id, level, supervisor_title, effective_from, source)
        values (v_emp, v_tgt, 2, (select "position" from public.employees where id = v_tgt), v_hire, 'bank_master')
        on conflict (employee_id, supervisor_employee_id, level) do nothing;
      elsif v_count = 1 and v_tgt = v_emp then
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup2, 2, 'self_reference') on conflict do nothing;
      elsif v_count > 1 then
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup2, 2, 'ambiguous_name') on conflict do nothing;
      else
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup2, 2, 'not_found') on conflict do nothing;
      end if;
    end if;

    -- level 3
    if r.sup3 is not null then
      select count(*), (array_agg(id))[1] into v_count, v_tgt
      from public.employees where lower(trim(full_name)) = lower(trim(r.sup3));
      if v_count = 1 and v_tgt is distinct from v_emp then
        insert into public.employee_supervisors (employee_id, supervisor_employee_id, level, supervisor_title, effective_from, source)
        values (v_emp, v_tgt, 3, (select "position" from public.employees where id = v_tgt), v_hire, 'bank_master')
        on conflict (employee_id, supervisor_employee_id, level) do nothing;
      elsif v_count = 1 and v_tgt = v_emp then
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup3, 3, 'self_reference') on conflict do nothing;
      elsif v_count > 1 then
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup3, 3, 'ambiguous_name') on conflict do nothing;
      else
        insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
        values (v_emp, r.sup3, 3, 'not_found') on conflict do nothing;
      end if;
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 19. BRANCH ↔ AREA DERIVATION
--     A branch belongs to an area when its BRANCH MANAGER's level-1
--     supervisor is an AREA MANAGER (AREA N) — and only when the two are
--     different people. No area manager is auto-named on the area row.
-- ------------------------------------------------------------
do $$
declare
  v_bm record;
  v_area record;
  v_am_id uuid;
begin
  for v_bm in
    select e.id as bm_id, e.branch_id, e.hire_date
    from public.employees e
    where e."position" = 'BRANCH MANAGER' and e.branch_id is not null
  loop
    select s.supervisor_employee_id into v_am_id
    from public.employee_supervisors s
    where s.employee_id = v_bm.bm_id and s.level = 1;

    if v_am_id is null or v_am_id = v_bm.bm_id then
      insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
      values (v_bm.bm_id, '(branch manager area link)', 1, 'no_area_manager_link')
      on conflict do nothing;
      continue;
    end if;

    select a.* into v_area
    from public.employees am
    join public.areas a on a.area_code = replace(replace(am."position", 'AREA MANAGER (', ''), ')', '')
    where am.id = v_am_id and am."position" like 'AREA MANAGER (%';

    if v_area.id is not null then
      insert into public.branch_area_assignments (branch_id, area_id, is_current, assigned_from, assigned_by, reason)
      values (v_bm.branch_id, v_area.id, true, now(), auth.uid(), 'bank_master_derivation')
      on conflict (branch_id, area_id) do nothing;
    else
      insert into public.hierarchy_exceptions (employee_id, source_supervisor_name, level, reason)
      values (v_bm.bm_id, v_am_id::text, 1, 'area_manager_not_area_role')
      on conflict do nothing;
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 20. VERIFICATION QUERIES (handy after running in SQL Editor)
-- ------------------------------------------------------------
select 'phase26_hr_master_data applied' as status;