-- ============================================================
-- Phase — Role rename: hr_manager → head_of_human_resources
-- Run in Supabase SQL Editor AFTER 20260921000009. Idempotent/
-- additive within one transaction (begin / commit).
--
-- Renames the internal role "hr_manager" to
-- "head_of_human_resources" ("Head of Human Resources"). The roles
-- row is UPDATEd in place (id preserved, so role_permissions stay
-- attached); live profiles.role rows are migrated; profiles_role_check
-- is rebuilt; and EVERY existing RLS policy / SECURITY DEFINER RPC
-- / function that checks `hr_manager` is re-issued with the new name
-- so the whole platform (payroll, attendance, onboarding, medical,
-- recruitment, BankOne, messaging, workforce) grants the Head of HR
-- exactly the same access the HR Manager role has today.
--
-- Backwards-compat: NO sql-level `hr_manager` remains. Any stale
-- row left as hr_manager is folded in by the profile UPDATE below.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. ROLES TABLE (id preserved → role_permissions stay attached)
-- ------------------------------------------------------------
update public.roles
set role_name = 'head_of_human_resources',
    display_name = 'Head of Human Resources',
    description = 'Lead, manage and own the human-resources function across the bank'
where role_name = 'hr_manager';

-- ------------------------------------------------------------
-- 2. LIVE PROFILES + ROLE CHECK
-- ------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;

update public.profiles
set role = 'head_of_human_resources'
where role = 'hr_manager';

alter table public.profiles add constraint profiles_role_check
  check (role in (
    'super_admin','admin','head_of_business','area_manager','branch_manager',
    'head_of_operations','head_of_e_business','financial_controller',
    'head_of_risk_compliance','head_of_legal','head_of_audit',
    'loan_officer','relationship_manager','customer_service',
    'head_of_human_resources','hr_officer','staff','customer'
  ));

-- ------------------------------------------------------------
-- 3. Dynamic attendance-child policies (schema_phase6 execute-format
--     loop → re-run verbatim with the role string replaced)
-- ------------------------------------------------------------

do $$
declare
  t text;
  tbl text;
begin
  foreach t in array array['employee_education', 'employee_work_history', 'employee_guarantors', 'employee_fidelity_bonds']
  loop
    execute format('drop policy if exists "%s_read" on public.%s', t, t);
    execute format('create policy "%s_read" on public.%s for select using (employee_id in (select id from public.employees where user_id = auth.uid()) or public.current_role() in (%L))', t, t, 'super_admin,admin,head_of_human_resources,hr_officer');
    execute format('drop policy if exists "%s_write" on public.%s', t, t);
    execute format('create policy "%s_write" on public.%s for all using (public.current_role() in (%L)) with check (public.current_role() in (%L))', t, t, 'super_admin,admin,head_of_human_resources', 'super_admin,admin,head_of_human_resources');
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3b. RLS POLICIES re-issue (drop + create, hr_manager → head_of_human_resources)
-- ------------------------------------------------------------

drop policy if exists "documents_read_authorized" on public.documents;


create policy "documents_read_authorized" on public.documents
  for select
  using (
    -- Uploader or verifier of this row (current-row columns, no self-join).
    uploaded_by = auth.uid()
    or verified_by = auth.uid()
    -- Existing HR / credit role model.
    or public.current_role() in (
      'super_admin',
      'admin',
      'loan_officer',
      'head_of_human_resources',
      'hr_officer'
    )
    -- An employee may read documents attached to their own employee record.
    or (
      entity_type = 'employee'
      and exists (
        select 1
        from public.employees e
        where e.id = documents.entity_id
          and e.user_id = auth.uid()
      )
    )
    -- A loan applicant may read documents attached to their own application.
    or (
      entity_type = 'loan_application'
      and exists (
        select 1
        from public.loan_applications la
        where la.id = documents.entity_id
          and la.created_by = auth.uid()
      )
    )
  );


drop policy if exists "documents_insert_user" on public.documents;

create policy "documents_insert_user" on public.documents
  for insert with check (
    auth.role() = 'authenticated'
    and (entity_type <> 'offer_letter' or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'))
  );


drop policy if exists "tasks_read_assigned" on public.tasks;

create policy "tasks_read_assigned"
on public.tasks
for select
using (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'head_of_operations',
        'head_of_human_resources',
        'hr_officer',
        'area_manager'
    )
);


drop policy if exists "tasks_insert_admin" on public.tasks;

create policy "tasks_insert_admin"
on public.tasks
for insert
with check (
    public.current_role() in (
        'admin',
        'super_admin',
        'branch_manager',
        'head_of_operations',
        'head_of_human_resources',
        'hr_officer',
        'area_manager'
    )
);


drop policy if exists "tasks_update_assigned_or_admin" on public.tasks;

create policy "tasks_update_assigned_or_admin"
on public.tasks
for update
using (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'head_of_operations',
        'head_of_human_resources',
        'area_manager'
    )
)
with check (
    assigned_to = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'head_of_operations',
        'head_of_human_resources',
        'area_manager'
    )
);


drop policy if exists "hr_jobs_read" on public.hr_jobs;

create policy hr_jobs_read on public.hr_jobs
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "hr_jobs_insert" on public.hr_jobs;

create policy hr_jobs_insert on public.hr_jobs
  for insert with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "hr_jobs_update" on public.hr_jobs;

create policy hr_jobs_update on public.hr_jobs
  for update using (created_by = auth.uid() or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "hr_candidates_read" on public.hr_candidates;

create policy hr_candidates_read on public.hr_candidates
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "hr_candidates_insert" on public.hr_candidates;

create policy hr_candidates_insert on public.hr_candidates
  for insert with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "hr_candidates_update" on public.hr_candidates;

create policy hr_candidates_update on public.hr_candidates
  for update using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "hr_assessments_read" on public.hr_assessments;


-- HR ASSESSMENTS: HR staff and assigned assessors
create policy "hr_assessments_read" on public.hr_assessments
  for select using (
    public.current_role() in ('admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "hr_assessments_insert" on public.hr_assessments;


create policy "hr_assessments_insert" on public.hr_assessments
  for insert with check (
    public.current_role() in ('admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "hr_interviews_read" on public.hr_interviews;


-- HR INTERVIEWS: HR staff and assigned interviewers
create policy "hr_interviews_read" on public.hr_interviews
  for select using (
    interviewer_id = auth.uid()
    or public.current_role() in ('admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "hr_interviews_insert" on public.hr_interviews;


create policy "hr_interviews_insert" on public.hr_interviews
  for insert with check (
    public.current_role() in ('admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "employees_read" on public.employees;

create policy "employees_read" on public.employees
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager')
  );


drop policy if exists "employees_insert" on public.employees;

create policy "employees_insert" on public.employees
  for insert with check (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  );


drop policy if exists "branches_read_authorized" on public.branches;

create policy "branches_read_authorized" on public.branches
  for select using (public.current_role() in (
    'super_admin', 'admin', 'branch_manager', 'head_of_human_resources',
    'head_of_operations', 'head_of_business', 'head_of_e_business',
    'financial_controller', 'head_of_risk_compliance', 'head_of_legal', 'head_of_audit'
  ));


drop policy if exists "payroll_read_hr_admin" on public.payroll;

create policy "payroll_read_hr_admin" on public.payroll
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "payroll_manage_admin_hr_manager" on public.payroll;

create policy "payroll_manage_admin_hr_manager" on public.payroll
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "offer_letters_read_hr_admin" on public.offer_letters;

create policy "offer_letters_read_hr_admin" on public.offer_letters
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "offer_letters_manage_hr_admin" on public.offer_letters;

create policy "offer_letters_manage_hr_admin" on public.offer_letters
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "leave_balances read own or hr" on public.leave_balances;

create policy "leave_balances read own or hr"
on public.leave_balances
for select
using (
  employee_id = auth.uid()
  or public.current_role() in (
    'admin',
    'super_admin',
    'manager',
    'head_of_human_resources',
    'hr_officer',
    'branch_manager',
    'head_of_operations',
    'head_of_business',
    'head_of_e_business',
    'financial_controller',
    'head_of_risk_compliance',
    'head_of_legal',
    'head_of_audit'
  )
);


drop policy if exists "leave_balances write hr" on public.leave_balances;


create policy "leave_balances write hr"
on public.leave_balances
for all
using (
  public.current_role() in (
    'admin',
    'super_admin',
    'head_of_human_resources'
  )
)
with check (
  public.current_role() in (
    'admin',
    'super_admin',
    'head_of_human_resources'
  )
);


drop policy if exists "leave_approvals read" on public.leave_approvals;

create policy "leave_approvals read" on public.leave_approvals
  for select using (
    approver_id = auth.uid()
    or exists (
      select 1 from public.leave_requests lr
      where lr.id = leave_request_id
        and (lr.created_by = auth.uid()
             or public.current_role() in ('super_admin','admin','head_of_human_resources','hr_officer')
             or public.current_role() in ('area_manager','head_of_business')
             or (public.current_role() = 'branch_manager'
                 and exists (
                   select 1 from public.employees e
                   join public.branches b on b.id = e.branch_id
                   where e.user_id = lr.created_by and b.manager_id = auth.uid()
                 )))
    )
  );


drop policy if exists "employees_update" on public.employees;

create policy "employees_update" on public.employees
  for update using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  )
  with check (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  );


drop policy if exists "attendance_read" on public.attendance_records;

create policy "attendance_read" on public.attendance_records
  for select using (
    employee_id in (select id from public.employees where user_id = auth.uid())
    or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager')
  );


drop policy if exists "onboarding_links_read" on public.employee_onboarding_links;

create policy "onboarding_links_read" on public.employee_onboarding_links
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "onboarding_links_write" on public.employee_onboarding_links;

create policy "onboarding_links_write" on public.employee_onboarding_links
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "onboarding_subs_read" on public.employee_onboarding_submissions;

create policy "onboarding_subs_read" on public.employee_onboarding_submissions
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    or employee_id in (select e.id from public.employees e where e.user_id = auth.uid())
  );


drop policy if exists "payroll_periods_read" on public.payroll_periods;

create policy "payroll_periods_read" on public.payroll_periods
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "payroll_periods_write" on public.payroll_periods;

create policy "payroll_periods_write" on public.payroll_periods
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "payroll_config_read" on public.payroll_config;

create policy "payroll_config_read" on public.payroll_config
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "import_jobs_read" on public.data_import_jobs;

create policy "import_jobs_read" on public.data_import_jobs
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "import_records_read" on public.data_import_records;

create policy "import_records_read" on public.data_import_records
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "guarantor_verif_read" on public.guarantor_verifications;

create policy "guarantor_verif_read" on public.guarantor_verifications
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "guarantor_verif_write" on public.guarantor_verifications;

create policy "guarantor_verif_write" on public.guarantor_verifications
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "guarantor_docs_read" on public.guarantor_documents;

create policy "guarantor_docs_read" on public.guarantor_documents
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "guarantor_corr_read" on public.guarantor_corrections;

create policy "guarantor_corr_read" on public.guarantor_corrections
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "guarantor_corr_write" on public.guarantor_corrections;

create policy "guarantor_corr_write" on public.guarantor_corrections
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "onboard_events_read" on public.onboarding_events;

create policy "onboard_events_read" on public.onboarding_events
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "guarantor_docs_hr_read" on storage.objects;

create policy "guarantor_docs_hr_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and name like 'guarantor/%'
    and public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    and exists (
      select 1 from public.guarantor_documents d
      where d.file_path = name
    )
  );


drop policy if exists "bankone_batches read" on public.bankone_import_batches;



-- ============================================================
-- 20. BANKONE IMPORT BATCH POLICIES
-- ============================================================

create policy "bankone_batches read"
on public.bankone_import_batches
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);


drop policy if exists "bankone_rows read" on public.bankone_import_rows;



-- ============================================================
-- 21. BANKONE IMPORT ROW POLICIES
-- ============================================================

create policy "bankone_rows read"
on public.bankone_import_rows
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);


drop policy if exists "bankone_txn read" on public.bankone_transactions;



-- ============================================================
-- 22. BANKONE TRANSACTION POLICIES
-- ============================================================

create policy "bankone_txn read"
on public.bankone_transactions
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager',
    'loan_officer',
    'relationship_manager'
  )
);


drop policy if exists "txn_history read" on public.transaction_status_history;



-- ============================================================
-- 23. TRANSACTION STATUS HISTORY POLICIES
-- ============================================================

create policy "txn_history read"
on public.transaction_status_history
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager'
  )
);


drop policy if exists "txn_rel read" on public.transaction_relationships;



-- ============================================================
-- 24. TRANSACTION RELATIONSHIP POLICIES
-- ============================================================

create policy "txn_rel read"
on public.transaction_relationships
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager'
  )
);


drop policy if exists "emp_bankone read" on public.employee_bankone_identifiers;



-- ============================================================
-- 26. EMPLOYEE BANKONE IDENTIFIER POLICIES
-- ============================================================

create policy "emp_bankone read"
on public.employee_bankone_identifiers
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer'
  )
);


drop policy if exists "emp_bankone insert" on public.employee_bankone_identifiers;


create policy "emp_bankone insert"
on public.employee_bankone_identifiers
for insert
with check (
  public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer'
  )
);


drop policy if exists "emp_bankone update" on public.employee_bankone_identifiers;


create policy "emp_bankone update"
on public.employee_bankone_identifiers
for update
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources'
  )
);


drop policy if exists "emp_bankone delete" on public.employee_bankone_identifiers;


create policy "emp_bankone delete"
on public.employee_bankone_identifiers
for delete
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources'
  )
);


drop policy if exists "perf_metrics read" on public.performance_metrics;



-- ============================================================
-- 27. PERFORMANCE METRICS POLICIES
-- ============================================================

create policy "perf_metrics read"
on public.performance_metrics
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);


drop policy if exists "perf_results read" on public.performance_results;



-- ============================================================
-- 28. PERFORMANCE RESULTS POLICIES
-- ============================================================

create policy "perf_results read"
on public.performance_results
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);


drop policy if exists "appraisal_periods read" on public.appraisal_periods;



-- ============================================================
-- 29. APPRAISAL PERIOD POLICIES
-- ============================================================

create policy "appraisal_periods read"
on public.appraisal_periods
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business'
  )
);


drop policy if exists "appraisal_results read" on public.appraisal_results;



-- ============================================================
-- 30. APPRAISAL RESULT POLICIES
-- ============================================================

create policy "appraisal_results read"
on public.appraisal_results
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business'
  )
);


drop policy if exists "appraisal_results insert" on public.appraisal_results;


create policy "appraisal_results insert"
on public.appraisal_results
for insert
with check (
  public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer'
  )
);


drop policy if exists "appraisal_results update" on public.appraisal_results;


create policy "appraisal_results update"
on public.appraisal_results
for update
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources'
  )
);


drop policy if exists "appraisal_results delete" on public.appraisal_results;


create policy "appraisal_results delete"
on public.appraisal_results
for delete
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources'
  )
);


drop policy if exists "recon_cases read" on public.reconciliation_cases;



-- ============================================================
-- 31. RECONCILIATION CASE POLICIES
-- ============================================================

create policy "recon_cases read"
on public.reconciliation_cases
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager',
    'head_of_business',
    'area_manager'
  )
);


drop policy if exists "recon_events read" on public.reconciliation_case_events;



-- ============================================================
-- 32. RECONCILIATION EVENTS POLICIES
-- ============================================================

create policy "recon_events read"
on public.reconciliation_case_events
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'operations_manager',
    'branch_manager'
  )
);


drop policy if exists "transport_allowance read" on public.transport_allowance_config;



-- ============================================================
-- 34. TRANSPORT ALLOWANCE POLICIES
-- ============================================================

create policy "transport_allowance read"
on public.transport_allowance_config
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer'
  )
);


drop policy if exists "perf_adj read" on public.performance_adjustments;



-- ============================================================
-- 35. PERFORMANCE ADJUSTMENT POLICIES
-- ============================================================

create policy "perf_adj read"
on public.performance_adjustments
for select
using (
  auth.role() = 'authenticated'
  and public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer'
  )
);


drop policy if exists "perf_adj insert" on public.performance_adjustments;


create policy "perf_adj insert"
on public.performance_adjustments
for insert
with check (
  public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer'
  )
);


drop policy if exists "perf_adj update" on public.performance_adjustments;


create policy "perf_adj update"
on public.performance_adjustments
for update
using (
  public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources'
  )
);


drop policy if exists "onb_corr_read" on public.onboarding_corrections;

create policy "onb_corr_read" on public.onboarding_corrections
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "onb_corr_write" on public.onboarding_corrections;

create policy "onb_corr_write" on public.onboarding_corrections
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "targets_select" on public.targets;

create policy "targets_select"
  on public.targets for select
  to authenticated
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = targets.employee_id
      and e.user_id = auth.uid()
    )
    or public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );


drop policy if exists "targets_insert" on public.targets;

create policy "targets_insert"
  on public.targets for insert
  to authenticated
  with check (
    public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );


drop policy if exists "targets_update" on public.targets;

create policy "targets_update"
  on public.targets for update
  to authenticated
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = targets.employee_id
      and e.user_id = auth.uid()
    )
    or public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  )
  with check (
    public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );


drop policy if exists "kpis_select" on public.employee_kpis;

create policy "kpis_select"
  on public.employee_kpis for select
  to authenticated
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = employee_kpis.employee_id
      and e.user_id = auth.uid()
    )
    or public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );


drop policy if exists "kpis_insert" on public.employee_kpis;

create policy "kpis_insert"
  on public.employee_kpis for insert
  to authenticated
  with check (
    public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );


drop policy if exists "kpis_update" on public.employee_kpis;

create policy "kpis_update"
  on public.employee_kpis for update
  to authenticated
  using (
    manager_id = auth.uid()
    or exists (
      select 1 from public.employees e
      where e.id = employee_kpis.employee_id
      and e.user_id = auth.uid()
    )
    or public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  )
  with check (
    public.current_role() in (
      'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
      'branch_manager', 'area_manager', 'head_of_business'
    )
  );


drop policy if exists "hr_settings_read" on public.hr_platform_settings;

create policy "hr_settings_read" on public.hr_platform_settings
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "hr_settings_write" on public.hr_platform_settings;

create policy "hr_settings_write" on public.hr_platform_settings
  for all using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  ) with check (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  );


drop policy if exists "hr_settings_audit_read" on public.hr_settings_audit;

create policy "hr_settings_audit_read" on public.hr_settings_audit
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  );


drop policy if exists "attendance_corr_audit_read" on public.attendance_corrections_audit;

create policy "attendance_corr_audit_read" on public.attendance_corrections_audit
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager')
  );


drop policy if exists "branches_write_hr" on public.branches;

create policy "branches_write_hr" on public.branches
  for all using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  ) with check (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  );


drop policy if exists "profiles_read_all" on public.profiles;

create policy "profiles_read_all" on public.profiles
  for select
  using (
    auth.uid() = id
    or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "profiles_update_hr" on public.profiles;

create policy "profiles_update_hr" on public.profiles
  for update using (
    auth.uid() = id
    or (
      public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
      and (role <> 'super_admin' or public.current_role() = 'super_admin')
    )
  )
  with check (
    auth.uid() = id
    or (
      public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
      and (role <> 'super_admin' or public.current_role() = 'super_admin')
    )
  );


drop policy if exists "sara_audit_select" on public.sara_audit_logs;

create policy "sara_audit_select" on public.sara_audit_logs
  for select using (
    auth.uid() = user_id
    or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  );


drop policy if exists "device_manage" on public.attendance_devices;

create policy "device_manage" on public.attendance_devices
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "fidelity_verif_read" on public.fidelity_bond_verifications;

create policy "fidelity_verif_read" on public.fidelity_bond_verifications
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager'));


drop policy if exists "fidelity_verif_write" on public.fidelity_bond_verifications;

create policy "fidelity_verif_write" on public.fidelity_bond_verifications
  for insert with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "fidelity_verif_update" on public.fidelity_bond_verifications;

create policy "fidelity_verif_update" on public.fidelity_bond_verifications
  for update using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "fidelity_docs_read" on public.fidelity_bond_documents;

create policy "fidelity_docs_read" on public.fidelity_bond_documents
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager'));


drop policy if exists "fidelity_docs_write" on public.fidelity_bond_documents;

create policy "fidelity_docs_write" on public.fidelity_bond_documents
  for insert with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "leave read scoped" on public.leave_requests;

create policy "leave read scoped" on public.leave_requests
  for select using (
    created_by = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    or public.current_role() in ('area_manager', 'head_of_business')
    or (public.current_role() = 'branch_manager'
        and exists (
          select 1
          from public.employees e
          join public.branches b on b.id = e.branch_id
          where e.user_id = leave_requests.created_by
            and b.manager_id = auth.uid()
        ))
  );


drop policy if exists "leave update scoped" on public.leave_requests;

create policy "leave update scoped" on public.leave_requests
  for update using (
    created_by = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    or public.current_role() in ('area_manager', 'head_of_business')
    or (public.current_role() = 'branch_manager'
        and exists (
          select 1
          from public.employees e
          join public.branches b on b.id = e.branch_id
          where e.user_id = leave_requests.created_by
            and b.manager_id = auth.uid()
        ))
  );


drop policy if exists "profile_photo_self_upload" on storage.objects;

create policy "profile_photo_self_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'profile-photo/%'
    and (
      public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
      or exists (
        select 1 from public.employees e
        where e.id::text = split_part(name, '/', 2)
          and e.user_id = auth.uid()
      )
    )
  );


drop policy if exists "employee_docs_self_upload" on storage.objects;

create policy "employee_docs_self_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'employee/%'
    and (
      public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
      or exists (
        select 1 from public.employees e
        where e.id::text = split_part(name, '/', 2)
          and e.user_id = auth.uid()
      )
    )
  );


drop policy if exists "profile_photo_self_delete" on storage.objects;

create policy "profile_photo_self_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and name like 'profile-photo/%'
    and (
      public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
      or exists (
        select 1 from public.employees e
        where e.id::text = split_part(name, '/', 2)
          and e.user_id = auth.uid()
      )
    )
  );


drop policy if exists "employee_docs_self_delete" on storage.objects;

create policy "employee_docs_self_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and name like 'employee/%'
    and (
      public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
      or exists (
        select 1 from public.employees e
        where e.id::text = split_part(name, '/', 2)
          and e.user_id = auth.uid()
      )
    )
  );


drop policy if exists "documents_delete_self_or_hr" on public.documents;

create policy "documents_delete_self_or_hr" on public.documents
  for delete using (
    uploaded_by = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "ea_cred_read" on public.employee_auth_credentials;

create policy "ea_cred_read" on public.employee_auth_credentials
  for select using (
    auth.role() = 'authenticated' AND (
      public.current_role() IN ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager')
      OR employee_id IN (
        select e.id from public.employees e where e.user_id = auth.uid()
      )
    )
  );


drop policy if exists "phase26_read_all" on public.employee_supervisors;

create policy "phase26_read_all"
  on public.employee_supervisors for select
  to authenticated
  using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "phase26_read_all" on public.employee_account_invites;

create policy "phase26_read_all"
  on public.employee_account_invites for select
  to authenticated
  using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "employment_letters_read" on public.employment_letters;

create policy employment_letters_read on public.employment_letters
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    or exists (
      select 1 from public.employees e
      where e.id = employment_letters.employee_id and e.user_id = auth.uid()
    )
  );


drop policy if exists "employment_letters_write" on public.employment_letters;

create policy employment_letters_write on public.employment_letters
  for all using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  ) with check (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "payroll_push_requests_read" on public.payroll_push_requests;

create policy payroll_push_requests_read on public.payroll_push_requests
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'auditor')
  );


drop policy if exists "payroll_push_approvals_read" on public.payroll_push_approvals;

create policy payroll_push_approvals_read on public.payroll_push_approvals
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'auditor')
  );


drop policy if exists "payroll_push_events_read" on public.payroll_push_events;

create policy payroll_push_events_read on public.payroll_push_events
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'auditor')
  );


drop policy if exists "employee_history_read" on public.employee_employment_history;

create policy "employee_history_read"
  on public.employee_employment_history
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    or employee_id in (select id from public.employees where user_id = auth.uid())
  );


drop policy if exists "termination_records_read" on public.employee_termination_records;

create policy "termination_records_read"
  on public.employee_termination_records
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    or employee_id in (select id from public.employees where user_id = auth.uid())
  );


drop policy if exists "cand_status_history_hr" on public.hr_candidate_status_history;

create policy "cand_status_history_hr" on public.hr_candidate_status_history
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "hr_candidate_notes_hr_select" on public.hr_candidate_notes;

create policy "hr_candidate_notes_hr_select" on public.hr_candidate_notes
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "hr_candidate_notes_hr_insert" on public.hr_candidate_notes;

create policy "hr_candidate_notes_hr_insert" on public.hr_candidate_notes
  for insert with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "screening_configs_hr_select" on public.hr_screening_configs;

create policy "screening_configs_hr_select" on public.hr_screening_configs
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "screening_results_hr_select" on public.candidate_screening_results;

create policy "screening_results_hr_select" on public.candidate_screening_results
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "assessment_templates_hr_select" on public.assessment_templates;

create policy "assessment_templates_hr_select" on public.assessment_templates
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "assessment_templates_hr_write" on public.assessment_templates;

create policy "assessment_templates_hr_write" on public.assessment_templates
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "assessment_tq_hr_select" on public.assessment_template_questions;

create policy "assessment_tq_hr_select" on public.assessment_template_questions
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "assessment_tq_hr_write" on public.assessment_template_questions;

create policy "assessment_tq_hr_write" on public.assessment_template_questions
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "hr_assessments_hr_update" on public.hr_assessments;

create policy "hr_assessments_hr_update" on public.hr_assessments
  for update using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "attempts_hr_select" on public.assessment_attempts;

create policy "attempts_hr_select" on public.assessment_attempts
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "attempt_answers_hr_select" on public.assessment_attempt_answers;

create policy "attempt_answers_hr_select" on public.assessment_attempt_answers
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "retake_requests_hr_select" on public.assessment_retake_requests;

create policy "retake_requests_hr_select" on public.assessment_retake_requests
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "offer_templates_hr_select" on public.offer_letter_templates;

create policy "offer_templates_hr_select" on public.offer_letter_templates
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "offer_templates_hr_write" on public.offer_letter_templates;

create policy "offer_templates_hr_write" on public.offer_letter_templates
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "payroll_components_hr_select" on public.payroll_salary_components;

create policy "payroll_components_hr_select" on public.payroll_salary_components
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "payroll_components_hr_write" on public.payroll_salary_components;

create policy "payroll_components_hr_write" on public.payroll_salary_components
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "salary_packages_hr_select" on public.employee_salary_packages;

create policy "salary_packages_hr_select" on public.employee_salary_packages
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "salary_snapshots_hr_select" on public.employee_salary_snapshots;

create policy "salary_snapshots_hr_select" on public.employee_salary_snapshots
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "interview_questions_select" on public.interview_questions;

create policy "interview_questions_select" on public.interview_questions
  for select using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "interview_questions_insert" on public.interview_questions;

create policy "interview_questions_insert" on public.interview_questions
  for insert with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "offer_letter_hr_upload" on storage.objects;

create policy "offer_letter_hr_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'offer_letter/%'
    and public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "offer_letter_hr_delete" on storage.objects;

create policy "offer_letter_hr_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and name like 'offer_letter/%'
    and public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "employee_guarantors_read" on public.employee_guarantors;

create policy "employee_guarantors_read" on public.employee_guarantors
  for select using (
    employee_id in (select id from public.employees where user_id = auth.uid())
    or public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );


drop policy if exists "employee_guarantors_write" on public.employee_guarantors;

create policy "employee_guarantors_write" on public.employee_guarantors
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources'));


drop policy if exists "recruitment_events_hr_read" on public.recruitment_application_events;

create policy recruitment_events_hr_read on public.recruitment_application_events
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "talent_pool_hr_read" on public.recruitment_talent_pool;

create policy talent_pool_hr_read on public.recruitment_talent_pool
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "talent_pool_matches_hr_read" on public.recruitment_talent_pool_matches;

create policy talent_pool_matches_hr_read on public.recruitment_talent_pool_matches
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "signature_upload" on storage.objects;

create policy "signature_upload" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'documents'
  and (
    (
      (name like 'signatures/management/%' or name like 'signatures/hr-manager/%')
      and public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
    )
    or (
      name like 'signatures/employees/%'
      and (
        public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
        or exists (
          select 1 from public.employees e
          where e.id::text = split_part(name, '/', 3)
            and e.user_id = auth.uid()
        )
      )
    )
  )
);


drop policy if exists "signature_read" on storage.objects;

create policy "signature_read" on storage.objects
for select to authenticated
using (
  bucket_id = 'documents'
  and (
    name like 'signatures/management/%'
    or name like 'signatures/hr-manager/%'
    or (
      name like 'signatures/employees/%'
      and (
        public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
        or exists (
          select 1 from public.employees e
          where e.id::text = split_part(name, '/', 3)
            and e.user_id = auth.uid()
        )
      )
    )
  )
);


drop policy if exists "signature_delete" on storage.objects;

create policy "signature_delete" on storage.objects
for delete to authenticated
using (
  bucket_id = 'documents'
  and public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  and (
    name like 'signatures/management/%'
    or name like 'signatures/hr-manager/%'
    or name like 'signatures/employees/%'
  )
);


drop policy if exists "payroll_imports_select" on public.payroll_imports;

create policy payroll_imports_select on public.payroll_imports
  for select to authenticated
  using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "payroll_audit_logs_select" on public.payroll_audit_logs;

create policy payroll_audit_logs_select on public.payroll_audit_logs
  for select to authenticated
  using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "assessment_suggestions_hr_select" on public.assessment_suggestions;

create policy "assessment_suggestions_hr_select" on public.assessment_suggestions
  for select using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));


drop policy if exists "task_reports_read" on public.task_progress_reports;

create policy "task_reports_read"
on public.task_progress_reports
for select
using (
    submitted_by = auth.uid()

    OR EXISTS (
        SELECT 1
        FROM public.tasks t
        WHERE t.id = task_id
        AND (
            t.assigned_to = auth.uid()
            OR t.created_by = auth.uid()
        )
    )

    OR public.current_role() IN (
        'super_admin',
        'admin',
        'branch_manager',
        'head_of_operations',
        'head_of_human_resources',
        'hr_officer',
        'area_manager'
    )
);


drop policy if exists "task_reports_update" on public.task_progress_reports;

create policy "task_reports_update"
on public.task_progress_reports
for update
using (
    public.current_role() IN (
        'super_admin',
        'admin',
        'branch_manager',
        'head_of_operations',
        'head_of_human_resources',
        'hr_officer',
        'area_manager'
    )
);


drop policy if exists "bankone_batches write" on public.bankone_import_batches;

create policy "bankone_batches write" on public.bankone_import_batches
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'));


drop policy if exists "bankone_txn write" on public.bankone_transactions;

create policy "bankone_txn write" on public.bankone_transactions
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'));


drop policy if exists "bankone_mappings write" on public.bankone_column_mappings;

create policy "bankone_mappings write" on public.bankone_column_mappings
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'));


drop policy if exists "recon_cases write" on public.reconciliation_cases;

create policy "recon_cases write" on public.reconciliation_cases
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'));


drop policy if exists "transport_allow write" on public.transport_allowance_config;

create policy "transport_allow write" on public.transport_allowance_config
  for all using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'))
  with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_operations', 'financial_controller'));


drop policy if exists "hr_jobs_delete" on public.hr_jobs;

create policy hr_jobs_delete on public.hr_jobs
  for delete using (
    public.current_role() in ('super_admin', 'admin', 'head_of_human_resources')
  );


-- ------------------------------------------------------------
-- 4. FUNCTIONS / RPCs re-issue (create or replace, hr_manager → head_of_human_resources)
-- ------------------------------------------------------------



-- ------------------------------------------------------------
-- 7. LEAVE ACCRUAL (management class 15 days)
-- ------------------------------------------------------------
create or replace function public.reset_annual_leave_balances(target_year int)
returns void language plpgsql security definer set search_path = public as $$
declare
  lt text;
  p record;
  ent numeric;
begin
  for p in select id, coalesce(full_name, email) AS full_name, role FROM public.profiles loop
    -- Annual: category-dependent
    ent := case
      when p.role in ('md', 'super_admin') then 20
      when p.role in ('admin', 'head_of_human_resources', 'branch_manager', 'area_manager', 'head_of_business',
                      'head_of_operations', 'head_of_e_business', 'financial_controller',
                      'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') then 15
      else 10
    end;
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    values (p.id, p.full_name, target_year, 'annual', ent, 0)
    on conflict (employee_id, year, leave_type) do update set entitled_days = excluded.entitled_days;

    -- Maternity
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    values (p.id, p.full_name, target_year, 'maternity', 90, 0)
    on conflict (employee_id, year, leave_type) do update set entitled_days = 90;

    -- Examination
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    values (p.id, p.full_name, target_year, 'examination', 5, 0)
    on conflict (employee_id, year, leave_type) do update set entitled_days = 5;

    -- Paternity
    insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days)
    values (p.id, p.full_name, target_year, 'paternity', 2, 0)
    on conflict (employee_id, year, leave_type) do update set entitled_days = 2;
  end loop;
end; $$;




-- 5e. enforce_role_change_policy — head roles are management: only
--     super_admin/admin may assign them (extends the area_manager guard).
create or replace function public.enforce_role_change_policy()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  promoter_roles text[] := array['super_admin','admin','head_of_human_resources','area_manager','branch_manager'];
  management_roles text[] := array[
    'area_manager','head_of_business','head_of_operations',
    'head_of_e_business','financial_controller',
    'head_of_risk_compliance','head_of_legal','head_of_audit'
  ];
begin
  if new.role is distinct from old.role then
    if not (actor_role = any(promoter_roles)) then
      raise exception 'Not authorized to change roles (actor role: %)', actor_role;
    end if;

    if new.role = 'super_admin' and actor_role <> 'super_admin' then
      raise exception 'Only super_admin can assign the super_admin role';
    end if;

    if new.role = 'admin' and actor_role not in ('super_admin','admin') then
      raise exception 'Only super_admin or admin can assign the admin role';
    end if;

    if new.role = any(management_roles) and actor_role not in ('super_admin','admin') then
      raise exception 'Only super_admin or admin can assign this role';
    end if;

    -- Branch Manager may only promote a customer into front-line staff
    -- roles, never into management or above.
    if actor_role = 'branch_manager' and new.role not in ('staff','loan_officer','relationship_manager','customer_service') then
      raise exception 'Branch Manager is not authorized to assign this role';
    end if;

    -- Log every role change server-side, regardless of which client made it.
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'user_role_changed',
      'User',
      new.id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      format('%s: %s -> %s', coalesce(new.email, new.id::text), old.role, new.role),
      'critical'
    );
  end if;
  return new;
end; $$;




-- ============================================================
-- 11. CORRECT ATTENDANCE WITH AUDIT TRAIL
--    Extends the existing correct_attendance() to also write
--    to attendance_corrections_audit.
-- ============================================================
create or replace function public.correct_attendance(
  p_attendance_id uuid,
  p_clock_in timestamptz,
  p_clock_out timestamptz,
  p_reason text default 'Corrected by HR'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  v_old record;
begin
  if actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to correct attendance';
  end if;
  if p_clock_in is null then
    raise exception 'Clock-in time is required.';
  end if;
  if p_clock_out is not null and p_clock_out <= p_clock_in then
    raise exception 'Clock-out must be after clock-in.';
  end if;

  select * into v_old from public.attendance_records where id = p_attendance_id;
  if not found then
    raise exception 'Attendance record not found.';
  end if;

  -- Write audit trail
  insert into public.attendance_corrections_audit (attendance_id, field_name, previous_value, corrected_value, reason, corrected_by)
  values
    (p_attendance_id, 'clock_in', v_old.clock_in::text, p_clock_in::text, p_reason, auth.uid()),
    (p_attendance_id, 'clock_out', v_old.clock_out::text, p_clock_out::text, p_reason, auth.uid());

  perform set_config('app.correcting_attendance', 'on', true);
  update public.attendance_records
  set clock_in = p_clock_in,
      clock_out = p_clock_out,
      work_hours = round(extract(epoch from (coalesce(p_clock_out, now()) - p_clock_in)) / 3600.0, 2),
      total_minutes = round(extract(epoch from (coalesce(p_clock_out, now()) - p_clock_in)) / 60.0)::int,
      status = 'corrected',
      is_corrected = true,
      corrected_by = auth.uid(),
      corrected_at = now(),
      correction_reason = coalesce(p_reason, 'Corrected by HR')
  where id = p_attendance_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ATTENDANCE_CORRECTED', 'AttendanceRecord', p_attendance_id::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
          format('Attendance corrected to %s / %s. Reason: %s', p_clock_in, p_clock_out, p_reason),
          'warning');
  return jsonb_build_object('ok', true, 'attendance_id', p_attendance_id);
end; $$;




-- Candidate submission replacement. The old Phase 6 function inserted the
-- expected guarantor into employee_guarantors and extracted guarantor_phone
-- from the candidate payload. That payload intentionally has no guarantor
-- phone, which failed on deployments where phone_number is NOT NULL. The
-- expected relationship remains in payload and the pending_guarantor status;
-- the completed row is created by approve_guarantor_verification().
create or replace function public.submit_onboarding(p_token text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(coalesce(p_token, ''));
  v_link record;
  v_employee uuid;
  v_created boolean := false;
  v_submission uuid;
  v_full_name text;
  v_surname text := lower(trim(coalesce(p_payload ->> 'surname', '')));
  v_first_name text := lower(trim(coalesce(p_payload ->> 'first_name', '')));
  v_email text := lower(trim(coalesce(p_payload ->> 'email', '')));
  v_phone text := trim(coalesce(p_payload ->> 'phone', ''));
  v_dob date;
  v_candidate_id uuid;
  v_candidate text := coalesce(p_payload ->> 'candidate_id', '');
  v_warnings text[] := '{}'::text[];
  v_doc record;
  v_notes text[];
  v_hr_id uuid;
  v_req text;
  v_row record;
  v_has_expected_guarantor boolean := false;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or (v_surname = '' and v_first_name = '') then
    raise exception 'Submission payload is required and must include a name.';
  end if;

  if nullif(trim(coalesce(p_payload ->> 'guarantor_full_name', '')), '') is not null
     or nullif(trim(coalesce(p_payload ->> 'guarantor_email', '')), '') is not null then
    if nullif(trim(coalesce(p_payload ->> 'guarantor_full_name', '')), '') is null
       or nullif(trim(coalesce(p_payload ->> 'guarantor_email', '')), '') is null then
      raise exception 'Expected guarantor name and email must be supplied together.';
    end if;
    v_has_expected_guarantor := true;
  end if;

  begin
    v_dob := nullif(p_payload ->> 'date_of_birth', '')::date;
  exception when others then
    v_dob := null;
  end;

  select id, candidate_name, candidate_email, candidate_phone,
         coalesce(expires_at, expiry) as expiry, status,
         "position", department, branch, employment_type
  into v_link
  from public.employee_onboarding_links
  where token_hash = v_hash
  for update;

  if v_link.id is null then raise exception 'Invalid onboarding link.'; end if;
  if v_link.status = 'SUBMITTED' then raise exception 'This onboarding link has already been used.'; end if;
  if v_link.status = 'REVOKED' then raise exception 'This onboarding link has been revoked.'; end if;
  if v_link.expiry <= now() then raise exception 'This onboarding link has expired.'; end if;

  v_full_name := trim(initcap(v_surname));
  if v_first_name <> '' then v_full_name := v_full_name || ' ' || initcap(v_first_name); end if;
  if v_full_name = '' then v_full_name := coalesce(v_link.candidate_name, 'Candidate'); end if;

  if v_candidate <> '' then
    begin
      v_candidate_id := v_candidate::uuid;
    exception when others then
      v_candidate_id := null;
    end;
  end if;

  select id into v_employee
  from public.employees
  where (v_candidate_id is not null and candidate_id = v_candidate_id)
     or (v_email <> '' and lower(email) = v_email)
     or (v_phone <> '' and phone = v_phone)
  limit 1;

  if v_employee is null then
    insert into public.employees (
      full_name, candidate_id, email, phone, sex, date_of_birth, state_of_origin, lga,
      town, residential_address, religion, denomination, nationality, marital_status,
      employee_code, department, "position", employment_type, employment_status,
      next_of_kin_name, next_of_kin_address, next_of_kin_phone, next_of_kin_relationship,
      beneficiary_name, beneficiary_address, beneficiary_phone, beneficiary_relationship,
      pension_id, tax_id, bvn, nin, branch,
      emergency_contact_name, emergency_contact_phone,
      number_of_children, children_age_range
    ) values (
      v_full_name, v_candidate_id, nullif(v_email, ''), nullif(v_phone, ''), nullif(coalesce(p_payload ->> 'sex', ''), ''),
      v_dob, nullif(p_payload ->> 'state_of_origin', ''), nullif(p_payload ->> 'lga', ''),
      nullif(p_payload ->> 'town', ''), nullif(p_payload ->> 'residential_address', ''),
      nullif(p_payload ->> 'religion', ''), nullif(p_payload ->> 'denomination', ''),
      nullif(p_payload ->> 'nationality', ''), nullif(p_payload ->> 'marital_status', ''),
      nullif(p_payload ->> 'employee_code', ''), nullif(coalesce(p_payload ->> 'department', v_link.department), ''),
      nullif(coalesce(p_payload ->> 'position', v_link."position"), ''),
      nullif(coalesce(p_payload ->> 'employment_type', v_link.employment_type), ''), 'onboarding',
      nullif(p_payload ->> 'next_of_kin_name', ''), nullif(p_payload ->> 'next_of_kin_address', ''),
      nullif(p_payload ->> 'next_of_kin_phone', ''), nullif(p_payload ->> 'next_of_kin_relationship', ''),
      nullif(p_payload ->> 'beneficiary_name', ''), nullif(p_payload ->> 'beneficiary_address', ''),
      nullif(p_payload ->> 'beneficiary_phone', ''), nullif(p_payload ->> 'beneficiary_relationship', ''),
      nullif(p_payload ->> 'pension_id', ''), nullif(p_payload ->> 'tax_id', ''),
      nullif(p_payload ->> 'bvn', ''), nullif(p_payload ->> 'nin', ''),
      nullif(coalesce(p_payload ->> 'branch', v_link.branch), ''),
      nullif(p_payload ->> 'emergency_contact_name', ''), nullif(p_payload ->> 'emergency_contact_phone', ''),
      coalesce(nullif(p_payload ->> 'number_of_children', ''), '0')::int,
      nullif(p_payload ->> 'children_age_range', '')
    ) returning id into v_employee;
    v_created := true;
  else
    update public.employees set
      email = coalesce(nullif(v_email, ''), email),
      phone = coalesce(nullif(v_phone, ''), phone),
      sex = coalesce(nullif(p_payload ->> 'sex', ''), sex),
      date_of_birth = coalesce(v_dob, date_of_birth),
      state_of_origin = coalesce(nullif(p_payload ->> 'state_of_origin', ''), state_of_origin),
      lga = coalesce(nullif(p_payload ->> 'lga', ''), lga),
      town = coalesce(nullif(p_payload ->> 'town', ''), town),
      residential_address = coalesce(nullif(p_payload ->> 'residential_address', ''), residential_address),
      religion = coalesce(nullif(p_payload ->> 'religion', ''), religion),
      denomination = coalesce(nullif(p_payload ->> 'denomination', ''), denomination),
      marital_status = coalesce(nullif(p_payload ->> 'marital_status', ''), marital_status),
      spouse_name = coalesce(nullif(p_payload ->> 'spouse_name', ''), spouse_name),
      spouse_occupation = coalesce(nullif(p_payload ->> 'spouse_occupation', ''), spouse_occupation),
      spouse_phone = coalesce(nullif(p_payload ->> 'spouse_phone', ''), spouse_phone),
      next_of_kin_name = coalesce(nullif(p_payload ->> 'next_of_kin_name', ''), next_of_kin_name),
      next_of_kin_address = coalesce(nullif(p_payload ->> 'next_of_kin_address', ''), next_of_kin_address),
      next_of_kin_phone = coalesce(nullif(p_payload ->> 'next_of_kin_phone', ''), next_of_kin_phone),
      next_of_kin_relationship = coalesce(nullif(p_payload ->> 'next_of_kin_relationship', ''), next_of_kin_relationship),
      beneficiary_name = coalesce(nullif(p_payload ->> 'beneficiary_name', ''), beneficiary_name),
      beneficiary_address = coalesce(nullif(p_payload ->> 'beneficiary_address', ''), beneficiary_address),
      beneficiary_phone = coalesce(nullif(p_payload ->> 'beneficiary_phone', ''), beneficiary_phone),
      beneficiary_relationship = coalesce(nullif(p_payload ->> 'beneficiary_relationship', ''), beneficiary_relationship),
      pension_id = coalesce(nullif(p_payload ->> 'pension_id', ''), pension_id),
      tax_id = coalesce(nullif(p_payload ->> 'tax_id', ''), tax_id),
      bvn = coalesce(nullif(p_payload ->> 'bvn', ''), bvn),
      nin = coalesce(nullif(p_payload ->> 'nin', ''), nin),
      emergency_contact_name = coalesce(nullif(p_payload ->> 'emergency_contact_name', ''), emergency_contact_name),
      emergency_contact_phone = coalesce(nullif(p_payload ->> 'emergency_contact_phone', ''), emergency_contact_phone),
      number_of_children = coalesce(nullif(p_payload ->> 'number_of_children', '')::int, number_of_children),
      children_age_range = coalesce(nullif(p_payload ->> 'children_age_range', ''), children_age_range),
      updated_at = now()
    where id = v_employee;
  end if;

  if p_payload ? 'education' and jsonb_typeof(p_payload -> 'education') = 'array' then
    for v_row in select * from jsonb_array_elements(p_payload -> 'education') loop
      if nullif(trim(v_row.value ->> 'institution'), '') is not null then
        insert into public.employee_education (employee_id, source, institution, education_level, from_year, to_year, field_of_study, class_degree)
        values (v_employee, 'onboarding', v_row.value ->> 'institution', v_row.value ->> 'education_level',
                nullif(v_row.value ->> 'from_year', '')::int, nullif(v_row.value ->> 'to_year', '')::int,
                v_row.value ->> 'field_of_study', v_row.value ->> 'class_degree');
      end if;
    end loop;
  end if;

  if p_payload ? 'work_history' and jsonb_typeof(p_payload -> 'work_history') = 'array' then
    for v_row in select * from jsonb_array_elements(p_payload -> 'work_history') loop
      if nullif(trim(v_row.value ->> 'company_name'), '') is not null then
        insert into public.employee_work_history (
          employee_id, source, company_name, company_address, company_email, "position", duties, salary,
          supervisor_name, supervisor_phone, start_date, end_date, reason_for_leaving
        ) values (
          v_employee, 'onboarding', v_row.value ->> 'company_name', v_row.value ->> 'company_address',
          v_row.value ->> 'company_email', v_row.value ->> 'position', v_row.value ->> 'duties',
          nullif(v_row.value ->> 'salary', '')::numeric, v_row.value ->> 'supervisor_name',
          v_row.value ->> 'supervisor_phone', nullif(v_row.value ->> 'start_date', '')::date,
          nullif(v_row.value ->> 'end_date', '')::date, v_row.value ->> 'reason_for_leaving'
        );
      end if;
    end loop;
  end if;

  -- No employee_guarantors INSERT occurs here. The candidate supplied only an
  -- expected relationship; HR creates the token-scoped verification record
  -- after submission, and approval creates/updates the completed row.

  if p_payload ? 'fidelity_surety_name' and nullif(trim(p_payload ->> 'fidelity_surety_name'), '') is not null then
    insert into public.employee_fidelity_bonds (
      employee_id, source, surety_name, address, occupation, bvn, nin, email, phone,
      relationship, employee_ref, signature, signature_date
    ) values (
      v_employee, 'onboarding', p_payload ->> 'fidelity_surety_name', p_payload ->> 'fidelity_address',
      p_payload ->> 'fidelity_occupation', p_payload ->> 'fidelity_bvn', p_payload ->> 'fidelity_nin',
      p_payload ->> 'fidelity_email', p_payload ->> 'fidelity_phone', p_payload ->> 'fidelity_relationship',
      v_full_name, p_payload ->> 'fidelity_signature', nullif(p_payload ->> 'fidelity_date', '')::date
    );
  end if;

  if p_payload ? 'documents' and jsonb_typeof(p_payload -> 'documents') = 'array' then
    for v_doc in select * from jsonb_array_elements(p_payload -> 'documents') loop
      v_req := 'onboarding/' || v_hash || '/';
      if position(v_req in coalesce(v_doc.value ->> 'file_path', '')) = 1
         and position('..' in coalesce(v_doc.value ->> 'file_path', '')) = 0 then
        insert into public.documents (
          entity_type, entity_id, document_type, file_name, file_path, file_size, mime_type,
          verification_status, is_required, uploaded_at
        ) values (
          'employee', v_employee, coalesce(v_doc.value ->> 'category', 'other'), v_doc.value ->> 'file_name',
          v_doc.value ->> 'file_path', (v_doc.value ->> 'size')::int, v_doc.value ->> 'mime',
          'pending', false, now()
        );
        v_notes := array_append(v_notes, v_doc.value ->> 'category');
      else
        v_warnings := array_append(v_warnings, 'Document path rejected: ' || coalesce(v_doc.value ->> 'file_name', '?'));
      end if;
    end loop;
  end if;

  insert into public.employee_onboarding_submissions (
    link_id, employee_id, candidate_name, email, phone, "position", department,
    employment_type, payload, declaration_accepted, signature_data
  ) values (
    v_link.id, v_employee, v_full_name, nullif(v_email, ''), nullif(v_phone, ''),
    v_link."position", v_link.department, v_link.employment_type, p_payload,
    coalesce((p_payload ->> 'declaration_accepted')::boolean, false), p_payload ->> 'declaration_signature'
  ) returning id into v_submission;

  update public.employee_onboarding_submissions
  set onboarding_status = case when v_has_expected_guarantor then 'pending_guarantor' else 'submitted' end
  where id = v_submission;

  update public.employee_onboarding_links
  set status = 'SUBMITTED', submitted_at = now(), updated_at = now()
  where id = v_link.id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ONBOARDING_SUBMITTED', 'OnboardingSubmission', v_submission::text, coalesce(v_full_name, 'candidate'),
          format('Onboarding submitted by %s (token link %s)', v_full_name, v_link.id), 'info');
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (case when v_created then 'EMPLOYEE_CREATED' else 'EMPLOYEE_UPDATED' end,
          'Employee', v_employee::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), 'candidate'),
          format('%s via onboarding (%s)', v_full_name, case when v_created then 'new record' else 'existing record updated' end), 'info');
  if array_length(v_notes, 1) > 0 then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('DOCUMENT_UPLOADED', 'Employee', v_employee::text, v_full_name,
            format('Onboarding documents: %s', array_to_string(v_notes, ', ')), 'info');
  end if;

  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') loop
    insert into public.notifications (user_id, title, message, type, link)
    values (
      v_hr_id,
      'New employee onboarding submitted',
      format('%s submitted onboarding information as %s.', v_full_name, coalesce(v_link."position", 'N/A')),
      'onboarding', '/onboarding-links'
    );
  end loop;

  return jsonb_build_object(
    'ok', true, 'submission_id', v_submission, 'employee_id', v_employee, 'created', v_created,
    'guarantor_pending', v_has_expected_guarantor,
    'message', case when v_created then 'NEW EMPLOYEE CREATED' else 'EXISTING EMPLOYEE PROFILE UPDATED' end,
    'warnings', to_jsonb(v_warnings)
  );
end; $$;




-- ============================================================
-- 7. compute_payroll — honour component packages instead of
--    hardcoding allowances = 0
-- ============================================================
create or replace function public.compute_payroll(p_period_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  v_period record;
  v_emp record;
  v_salary numeric;
  v_allowances numeric;
  v_allowances_taxable numeric;
  v_component_deductions numeric;
  v_pension numeric;
  v_gross numeric;
  v_tax numeric;
  v_other numeric;
  v_net numeric;
  v_break jsonb;
  v_count int := 0;
begin
  if actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to compute payroll';
  end if;

  select * into v_period from public.payroll_periods where id = p_period_id;
  if v_period.id is null then
    raise exception 'Payroll period not found.';
  end if;
  if v_period.status not in ('draft', 'calculated') then
    raise exception 'Payroll can only be calculated for a draft or calculated period.';
  end if;

  -- Recalculate the whole period: rows for this period are rewritten.
  delete from public.payroll where payroll_period = v_period.period_label;

  for v_emp in
    select * from public.employees
    where employment_status in ('active', 'probation', 'on_leave')
    order by full_name
  loop
    v_salary := coalesce(v_emp.salary, 0);
    select coalesce(sum(amount), 0) into v_allowances
    from public.employee_salary_packages
    where employee_id = v_emp.id and active and snapshot ->> 'component_type' = 'allowance';
    select coalesce(sum(amount), 0) into v_allowances_taxable
    from public.employee_salary_packages
    where employee_id = v_emp.id and active
      and snapshot ->> 'component_type' = 'allowance'
      and coalesce((snapshot ->> 'taxable')::bool, true);
    select coalesce(sum(amount), 0) into v_component_deductions
    from public.employee_salary_packages
    where employee_id = v_emp.id and active and snapshot ->> 'component_type' = 'deduction';

    v_break := public._salary_breakdown(v_salary, v_allowances, v_allowances_taxable, v_component_deductions);
    v_gross := (v_break ->> 'gross_monthly')::numeric;
    v_tax := (v_break ->> 'tax_paye')::numeric;
    v_pension := (v_break ->> 'pension')::numeric;
    v_other := (v_break ->> 'other_deductions')::numeric;
    v_net := (v_break ->> 'net_monthly')::numeric;

    insert into public.payroll (employee_id, employee_name, salary, allowances, gross_pay, tax_paye, pension_deduction,
      other_deductions, deductions, payroll_period, period_start, period_end, status)
    values (v_emp.id, v_emp.full_name, v_salary, v_allowances, v_gross, v_tax,
      v_pension, v_other, (v_break ->> 'deductions_total')::numeric, v_period.period_label, v_period.start_date, v_period.end_date, 'calculated');
    v_count := v_count + 1;
  end loop;

  update public.payroll_periods set status = 'calculated', updated_at = now()
  where id = p_period_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_CALCULATED', 'PayrollPeriod', p_period_id::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
          format('Payroll calculated for %s — %s employee rows', v_period.period_label, v_count), 'info');

  return jsonb_build_object('ok', true, 'period', v_period.period_label, 'rows', v_count);
end; $$;




-- A guarantor can submit only complete data through the token-scoped RPC.
-- Required document paths must belong to this token namespace.
create or replace function public.submit_guarantor_verification(p_token text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(coalesce(p_token, ''));
  v_verif record;
  v_doc record;
  v_req text;
  v_count int := 0;
  v_hr_id uuid;
  v_phone text;
  v_full_name text;
  v_doc_type text;
  v_file_path text;
  v_has_passport boolean := false;
  v_has_id_card boolean := false;
begin
  if coalesce(btrim(p_token), '') = '' or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'A valid verification payload is required.';
  end if;

  select * into v_verif
  from public.guarantor_verifications
  where token_hash = v_hash for update;

  if v_verif.id is null then raise exception 'Invalid verification link.'; end if;
  if v_verif.revoked_at is not null or v_verif.status = 'revoked' then raise exception 'This verification link has been revoked.'; end if;
  if v_verif.expires_at is not null and v_verif.expires_at <= now() then raise exception 'This verification link has expired.'; end if;
  if v_verif.status = 'submitted' then raise exception 'This verification has already been submitted.'; end if;
  if v_verif.status = 'approved' then raise exception 'This verification has already been approved.'; end if;
  if v_verif.status not in ('started', 'link_sent', 'correction_requested') then raise exception 'This verification link is not active.'; end if;

  v_full_name := nullif(btrim(p_payload ->> 'full_name'), '');
  if v_full_name is null then v_full_name := nullif(btrim(v_verif.guarantor_name), ''); end if;
  v_phone := nullif(btrim(p_payload ->> 'phone'), '');
  if v_full_name is null or v_phone is null
     or nullif(btrim(p_payload ->> 'residential_address'), '') is null
     or nullif(btrim(p_payload ->> 'occupation'), '') is null
     or nullif(btrim(p_payload ->> 'employer'), '') is null
     or nullif(btrim(p_payload ->> 'bvn'), '') is null
     or nullif(btrim(p_payload ->> 'nin'), '') is null
     or nullif(btrim(p_payload ->> 'selfie_data'), '') is null
     or nullif(btrim(p_payload ->> 'signature_data'), '') is null then
    raise exception 'Phone, legal name, address, occupation, employer, BVN, NIN, selfie, and signature are required.';
  end if;

  if p_payload ? 'documents' and jsonb_typeof(p_payload -> 'documents') = 'array' then
    for v_doc in select * from jsonb_array_elements(p_payload -> 'documents') loop
      v_doc_type := coalesce(v_doc.value ->> 'document_type', '');
      v_file_path := coalesce(v_doc.value ->> 'file_path', '');
      if v_doc_type not in ('passport', 'id_card', 'nin', 'work_id', 'utility_bill', 'other') then
        raise exception 'Unsupported guarantor document type.';
      end if;
      if position('guarantor/' || v_hash || '/' in v_file_path) <> 1 or position('..' in v_file_path) > 0 then
        raise exception 'Invalid guarantor document path.';
      end if;
      if coalesce(nullif(v_doc.value ->> 'file_size', '')::int, 0) > 10 * 1024 * 1024 then
        raise exception 'Guarantor document exceeds the 10MB limit.';
      end if;
      if v_doc_type = 'passport' then v_has_passport := true; end if;
      if v_doc_type = 'id_card' then v_has_id_card := true; end if;
    end loop;
  end if;
  if not v_has_passport or not v_has_id_card then
    raise exception 'Passport photograph and valid identification are required.';
  end if;

  update public.guarantor_verifications set
    verified_full_name = v_full_name,
    phone = v_phone,
    residential_address = nullif(btrim(p_payload ->> 'residential_address'), ''),
    occupation = nullif(btrim(p_payload ->> 'occupation'), ''),
    employer = nullif(btrim(p_payload ->> 'employer'), ''),
    bvn = nullif(btrim(p_payload ->> 'bvn'), ''),
    nin = nullif(btrim(p_payload ->> 'nin'), ''),
    selfie_data = nullif(p_payload ->> 'selfie_data', ''),
    selfie_captured_at = case when p_payload ? 'selfie_data' then now() else selfie_captured_at end,
    signature_data = nullif(p_payload ->> 'signature_data', ''),
    signature_date = coalesce(nullif(p_payload ->> 'signature_date', '')::date, signature_date, now()::date),
    status = 'submitted', submitted_at = now(), updated_at = now()
  where id = v_verif.id;

  if p_payload ? 'documents' and jsonb_typeof(p_payload -> 'documents') = 'array' then
    for v_doc in select * from jsonb_array_elements(p_payload -> 'documents') loop
      v_file_path := coalesce(v_doc.value ->> 'file_path', '');
      if position('guarantor/' || v_hash || '/' in v_file_path) = 1 then
        insert into public.guarantor_documents (
          guarantor_verification_id, document_type, file_name, file_path,
          file_size, mime_type, status
        ) values (
          v_verif.id, coalesce(v_doc.value ->> 'document_type', 'other'),
          coalesce(v_doc.value ->> 'file_name', 'document'), v_file_path,
          nullif(v_doc.value ->> 'file_size', '')::int,
          v_doc.value ->> 'mime_type', 'pending'
        );
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (v_verif.id, 'GUARANTOR_SUBMITTED', format('Guarantor %s submitted verification with %s documents', v_full_name, v_count), v_full_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('GUARANTOR_VERIFICATION_SUBMITTED', 'GuarantorVerification', v_verif.id::text, v_full_name,
          'Guarantor verification submitted through token-scoped link', 'info');

  if v_verif.submission_id is not null then
    update public.employee_onboarding_submissions
    set onboarding_status = 'guarantor_submitted'
    where id = v_verif.submission_id and onboarding_status in ('pending_guarantor', 'correction_requested');
  end if;

  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') loop
    insert into public.notifications (user_id, title, message, type, link)
    values (v_hr_id, 'Guarantor verification submitted',
            format('%s has completed guarantor verification.', v_full_name), 'onboarding', '/onboarding-links');
  end loop;

  return jsonb_build_object('ok', true, 'verification_id', v_verif.id, 'documents', v_count);
end; $$;




-- ============================================================
-- 9. RPC: request_guarantor_correction (HR only)
--    Creates correction records preserving previous values
-- ============================================================
create or replace function public.request_guarantor_correction(
  p_verification_id uuid,
  p_corrections jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_verif record;
  v_corr record;
  v_field text;
  v_label text;
  v_comment text;
  v_prev text;
  v_count int := 0;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to request corrections';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_verif from public.guarantor_verifications where id = p_verification_id;
  if v_verif.id is null then
    raise exception 'Verification record not found.';
  end if;

  -- Process each correction request
  for v_corr in select * from jsonb_array_elements(p_corrections)
  loop
    v_field := v_corr.value ->> 'field_name';
    v_label := v_corr.value ->> 'field_label';
    v_comment := v_corr.value ->> 'hr_comment';

    -- Get previous value from the verification record
    v_prev := case v_field
      when 'phone' then v_verif.phone
      when 'residential_address' then v_verif.residential_address
      when 'occupation' then v_verif.occupation
      when 'employer' then v_verif.employer
      when 'bvn' then v_verif.bvn
      when 'nin' then v_verif.nin
      when 'selfie_data' then v_verif.selfie_data
      when 'signature_data' then v_verif.signature_data
      else null
    end;

    insert into public.guarantor_corrections (guarantor_verification_id, field_name, field_label, previous_value, hr_comment, status)
    values (p_verification_id, v_field, v_label, v_prev, v_comment, 'pending');
    v_count := v_count + 1;
  end loop;

  -- Update verification status
  update public.guarantor_verifications
  set status = 'correction_requested', hr_comments = p_corrections ->> 'overall_comment', updated_at = now()
  where id = p_verification_id;

  -- Update submission status
  if v_verif.submission_id is not null then
    update public.employee_onboarding_submissions set onboarding_status = 'correction_requested'
    where id = v_verif.submission_id;
  end if;

  -- Event + audit
  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (p_verification_id, 'CORRECTION_REQUESTED', format('%s corrections requested by %s', v_count, v_actor_name), v_actor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('CORRECTION_REQUESTED', 'GuarantorVerification', p_verification_id::text, v_actor_name,
          format('%s field corrections requested', v_count), 'warning');

  return jsonb_build_object('ok', true, 'corrections_created', v_count);
end; $$;




-- ============================================================
-- 11. RPC: approve_guarantor_correction (HR only)
--     Applies corrected value to verification record
-- ============================================================
create or replace function public.approve_guarantor_correction(p_correction_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_corr record;
  v_verif_id uuid;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to approve corrections';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_corr from public.guarantor_corrections where id = p_correction_id;
  if v_corr.id is null then
    raise exception 'Correction record not found.';
  end if;
  if v_corr.status != 'submitted' then
    raise exception 'Correction has not been submitted by the guarantor yet.';
  end if;

  -- Apply the corrected value to the verification record
  v_verif_id := v_corr.guarantor_verification_id;
  execute format('update public.guarantor_verifications set %I = %L, updated_at = now() where id = %L',
    v_corr.field_name, v_corr.corrected_value, v_verif_id);

  -- Mark correction as approved
  update public.guarantor_corrections
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_correction_id;

  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (v_verif_id, 'CORRECTION_APPROVED',
          format('Field %s correction approved by %s', v_corr.field_name, v_actor_name), v_actor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('CORRECTION_APPROVED', 'GuarantorCorrection', p_correction_id::text, v_actor_name,
          format('Field %s corrected from [%s] to [%s]', v_corr.field_name,
                 left(coalesce(v_corr.previous_value, ''), 20), left(coalesce(v_corr.corrected_value, ''), 20)), 'info');

  return jsonb_build_object('ok', true, 'field', v_corr.field_name);
end; $$;




-- ============================================================
-- 12. RPC: reject_guarantor_correction (HR only)
-- ============================================================
create or replace function public.reject_guarantor_correction(p_correction_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_corr record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.guarantor_corrections
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_correction_id and status = 'submitted'
  returning * into v_corr;

  if v_corr.id is null then
    raise exception 'Correction record not found or not in submitted state.';
  end if;

  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (v_corr.guarantor_verification_id, 'CORRECTION_REJECTED',
          format('Field %s correction rejected by %s', v_corr.field_name, v_actor_name), v_actor_name);

  return jsonb_build_object('ok', true);
end; $$;




-- Approval is the first point at which employee_guarantors is materialized.
-- It supports both the canonical `phone` column and the older deployed
-- `phone_number` column without inventing placeholder data.
create or replace function public.approve_guarantor_verification(p_verification_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_verif record;
  v_employee_id uuid;
  v_guarantor_id uuid;
  v_has_phone_number boolean;
  v_completed_name text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then raise exception 'Not authorized to approve verification'; end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_verif from public.guarantor_verifications where id = p_verification_id;
  if v_verif.id is null then raise exception 'Verification record not found.'; end if;
  if v_verif.status = 'approved' then raise exception 'Verification already approved.'; end if;
  if v_verif.status <> 'submitted' then raise exception 'Guarantor verification must be submitted before approval.'; end if;
  if exists (
    select 1 from public.guarantor_corrections
    where guarantor_verification_id = p_verification_id and status in ('pending', 'submitted')
  ) then raise exception 'There are unresolved corrections. Please approve or reject all corrections first.'; end if;
  if v_verif.employee_id is null or nullif(btrim(v_verif.phone), '') is null then
    raise exception 'Verified guarantor identity is incomplete.';
  end if;

  v_employee_id := v_verif.employee_id;
  v_completed_name := coalesce(nullif(btrim(v_verif.verified_full_name), ''), v_verif.guarantor_name);
  select id into v_guarantor_id
  from public.employee_guarantors
  where employee_id = v_employee_id
    and lower(btrim(full_name)) = lower(btrim(v_verif.guarantor_name))
  order by created_at desc nulls last
  limit 1;

  select exists(
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employee_guarantors' and column_name = 'phone_number'
  ) into v_has_phone_number;

  if v_guarantor_id is null then
    if v_has_phone_number then
      execute $sql$
        insert into public.employee_guarantors (
          employee_id, source, full_name, phone, phone_number, profession, designation,
          business_address, residential_address, email, relationship, bvn, nin,
          signature, signature_date, verification_status, updated_at
        ) values ($1, 'onboarding', $2, $3, $3, $4, null, $5, $6, $7, $8, $9, $10, $11, $12, 'verified', now())
      $sql$
      using v_employee_id, v_completed_name, v_verif.phone, v_verif.occupation,
            v_verif.employer, v_verif.residential_address, v_verif.guarantor_email,
            v_verif.guarantor_relationship, v_verif.bvn, v_verif.nin,
            v_verif.signature_data, v_verif.signature_date;
    else
      insert into public.employee_guarantors (
        employee_id, source, full_name, phone, profession, designation,
        business_address, residential_address, email, relationship, bvn, nin,
        signature, signature_date, verification_status, updated_at
      ) values (
        v_employee_id, 'onboarding', v_completed_name, v_verif.phone, v_verif.occupation, null,
        v_verif.employer, v_verif.residential_address, v_verif.guarantor_email,
        v_verif.guarantor_relationship, v_verif.bvn, v_verif.nin,
        v_verif.signature_data, v_verif.signature_date, 'verified', now()
      ) returning id into v_guarantor_id;
    end if;
  else
    update public.employee_guarantors set
      full_name = v_completed_name,
      phone = v_verif.phone,
      profession = coalesce(v_verif.occupation, profession),
      business_address = coalesce(v_verif.employer, business_address),
      residential_address = coalesce(v_verif.residential_address, residential_address),
      email = coalesce(v_verif.guarantor_email, email),
      relationship = coalesce(v_verif.guarantor_relationship, relationship),
      bvn = coalesce(v_verif.bvn, bvn),
      nin = coalesce(v_verif.nin, nin),
      signature = coalesce(v_verif.signature_data, signature),
      signature_date = coalesce(v_verif.signature_date, signature_date),
      verification_status = 'verified', updated_at = now()
    where id = v_guarantor_id;
    if v_has_phone_number then
      execute 'update public.employee_guarantors set phone_number = $1 where id = $2'
      using v_verif.phone, v_guarantor_id;
    end if;
  end if;

  update public.guarantor_verifications
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = p_verification_id;

  if v_verif.submission_id is not null then
    update public.employee_onboarding_submissions
    set onboarding_status = 'under_review'
    where id = v_verif.submission_id;
  end if;

  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (p_verification_id, 'GUARANTOR_APPROVED', format('Guarantor verification approved by %s', v_actor_name), v_actor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('GUARANTOR_VERIFICATION_APPROVED', 'GuarantorVerification', p_verification_id::text, v_actor_name,
          format('Guarantor %s verification approved', v_completed_name), 'info');

  return jsonb_build_object('ok', true, 'employee_guarantor_id', v_guarantor_id);
end; $$;




create or replace function public.approve_onboarding(p_submission_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_sub record;
  v_employee_id uuid;
  v_verif_count int;
  v_approved_count int;
  v_requires_guarantor boolean;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then raise exception 'Not authorized to approve onboarding'; end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();
  select * into v_sub from public.employee_onboarding_submissions where id = p_submission_id;
  if v_sub.id is null then raise exception 'Submission not found.'; end if;
  if v_sub.onboarding_status = 'completed' then raise exception 'Onboarding already completed.'; end if;

  v_requires_guarantor := nullif(btrim(v_sub.payload ->> 'guarantor_full_name'), '') is not null
    or nullif(btrim(v_sub.payload ->> 'guarantor_email'), '') is not null;
  select count(*), count(*) filter (where status = 'approved')
  into v_verif_count, v_approved_count
  from public.guarantor_verifications where submission_id = p_submission_id;
  if v_requires_guarantor and v_verif_count = 0 then
    raise exception 'A guarantor verification link must be completed before onboarding approval.';
  end if;
  if v_verif_count > 0 and v_approved_count < v_verif_count then
    raise exception 'Not all guarantor verifications are approved.';
  end if;

  v_employee_id := v_sub.employee_id;
  if v_employee_id is not null then
    update public.employees
    set employment_status = 'active', hire_date = coalesce(hire_date, now()::date), updated_at = now()
    where id = v_employee_id;
  end if;

  update public.employee_onboarding_submissions
  set onboarding_status = 'completed', status = 'approved', reviewed_by = auth.uid(),
      reviewed_at = now(), review_comments = 'Onboarding approved'
  where id = p_submission_id;

  insert into public.onboarding_events (onboarding_link_id, event_type, details, actor)
  values (v_sub.link_id, 'ONBOARDING_APPROVED',
          format('Onboarding approved by %s for %s', v_actor_name, coalesce(v_sub.candidate_name, 'employee')), v_actor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ONBOARDING_APPROVED', 'OnboardingSubmission', p_submission_id::text, v_actor_name,
          format('Onboarding approved for %s (employee: %s)', coalesce(v_sub.candidate_name, ''), v_employee_id), 'info');
  insert into public.notifications (user_id, title, message, type, link)
  select id, 'Onboarding approved',
         format('%s has been approved and is now an active employee.', coalesce(v_sub.candidate_name, 'Employee')),
         'onboarding', '/employees'
  from public.profiles where role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer');

  return jsonb_build_object('ok', true, 'employee_id', v_employee_id);
end; $$;




-- ============================================================
-- 15. RPC: add_employee_to_payroll (HR only)
-- ============================================================
create or replace function public.add_employee_to_payroll(
  p_employee_id uuid,
  p_period_label text,
  p_salary numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
  v_period record;
  v_existing int;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage payroll';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;
  if v_emp.employment_status not in ('active', 'probation', 'on_leave') then
    raise exception 'Employee must be active to add to payroll.';
  end if;

  select * into v_period from public.payroll_periods where period_label = p_period_label;
  if v_period.id is null then
    raise exception 'Payroll period not found.';
  end if;

  -- Check for duplicate
  select count(*) into v_existing from public.payroll
  where employee_id = p_employee_id and payroll_period = p_period_label;
  if v_existing > 0 then
    raise exception 'Employee already in this payroll period.';
  end if;

  insert into public.payroll (employee_id, employee_name, salary, allowances, deductions,
    payroll_period, period_start, period_end, status, net_pay)
  values (p_employee_id, v_emp.full_name, coalesce(p_salary, v_emp.salary, 0), 0, 0,
    p_period_label, v_period.start_date, v_period.end_date, 'draft',
    coalesce(p_salary, v_emp.salary, 0))
  returning id into v_existing;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_ADDED_TO_PAYROLL', 'Payroll', v_existing::text, v_actor_name,
          format('%s added to payroll period %s', v_emp.full_name, p_period_label), 'info');

  return jsonb_build_object('ok', true, 'payroll_id', v_existing);
end; $$;




-- ============================================================
-- 16. RPC: reject_onboarding (HR only)
-- ============================================================
create or replace function public.reject_onboarding(p_submission_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_sub record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_sub from public.employee_onboarding_submissions where id = p_submission_id;
  if v_sub.id is null then
    raise exception 'Submission not found.';
  end if;

  update public.employee_onboarding_submissions
  set onboarding_status = 'rejected', status = 'rejected',
      reviewed_by = auth.uid(), reviewed_at = now(), review_comments = p_reason
  where id = p_submission_id;

  insert into public.onboarding_events (onboarding_link_id, event_type, details, actor)
  values (v_sub.link_id, 'ONBOARDING_REJECTED',
          format('Onboarding rejected by %s: %s', v_actor_name, p_reason), v_actor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ONBOARDING_REJECTED', 'OnboardingSubmission', p_submission_id::text, v_actor_name,
          format('Onboarding rejected: %s', p_reason), 'warning');

  return jsonb_build_object('ok', true);
end; $$;




-- ------------------------------------------------------------
-- 5. FUNCTION REWRITES (create or replace)
-- ------------------------------------------------------------

-- 5a. can_manage_bankone — rename + financial controller (finance owns BankOne).
create or replace function public.can_manage_bankone()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'head_of_operations',
    'financial_controller'
  );
$$;





create or replace function public.can_manage_hr_config()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources'
  );
$$;




-- 5b. can_manage_reconciliation — rename + financial controller.
create or replace function public.can_manage_reconciliation()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_role() in (
    'super_admin',
    'admin',
    'head_of_human_resources',
    'hr_officer',
    'head_of_operations',
    'financial_controller',
    'branch_manager'
  );
$$;




-- ============================================================
-- 3. RPC: request_onboarding_correction (HR only)
--    Creates correction records preserving previous values from payload
-- ============================================================
create or replace function public.request_onboarding_correction(
  p_submission_id uuid,
  p_corrections jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_sub record;
  v_corr record;
  v_field text;
  v_label text;
  v_section text;
  v_comment text;
  v_prev text;
  v_count int := 0;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to request corrections';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_sub from public.employee_onboarding_submissions where id = p_submission_id;
  if v_sub.id is null then
    raise exception 'Submission not found.';
  end if;

  for v_corr in select * from jsonb_array_elements(p_corrections)
  loop
    v_field := v_corr.value ->> 'field_name';
    v_label := v_corr.value ->> 'field_label';
    v_section := v_corr.value ->> 'section';
    v_comment := v_corr.value ->> 'hr_comment';

    if v_comment is null or trim(v_comment) = '' then
      raise exception 'HR comment is required for field %', v_field;
    end if;

    -- Get previous value from the submission payload
    v_prev := v_sub.payload ->> v_field;

    insert into public.onboarding_corrections (submission_id, field_name, field_label, section, previous_value, hr_comment, status)
    values (p_submission_id, v_field, v_label, v_section, v_prev, v_comment, 'pending');
    v_count := v_count + 1;
  end loop;

  -- Update submission status
  update public.employee_onboarding_submissions set onboarding_status = 'correction_requested'
  where id = p_submission_id and onboarding_status not in ('approved', 'completed', 'rejected');

  -- Event + audit
  insert into public.onboarding_events (onboarding_link_id, event_type, details, actor)
  values (v_sub.link_id, 'CORRECTION_REQUESTED',
          format('%s onboarding field corrections requested by %s', v_count, v_actor_name), v_actor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ONBOARDING_CORRECTION_REQUESTED', 'OnboardingSubmission', p_submission_id::text, v_actor_name,
          format('%s field corrections requested', v_count), 'warning');

  return jsonb_build_object('ok', true, 'corrections_created', v_count);
end; $$;




-- ============================================================
-- 4. RPC: submit_onboarding_correction (HR enters corrected value)
--    HR records the corrected value provided by the candidate.
--    The corrected value does NOT become active until approved.
-- ============================================================
create or replace function public.submit_onboarding_correction(
  p_correction_id uuid,
  p_corrected_value text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_corr record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.onboarding_corrections
  set corrected_value = p_corrected_value,
      status = 'submitted',
      submitted_by = v_actor_name,
      submitted_at = now()
  where id = p_correction_id and status = 'pending'
  returning * into v_corr;

  if v_corr.id is null then
    raise exception 'Correction record not found or not in pending state.';
  end if;

  insert into public.onboarding_events (onboarding_link_id, event_type, details, actor)
  select s.link_id, 'CORRECTION_SUBMITTED',
         format('Field %s correction submitted by %s', v_corr.field_name, v_actor_name), v_actor_name
  from public.employee_onboarding_submissions s where s.id = v_corr.submission_id;

  return jsonb_build_object('ok', true, 'field', v_corr.field_name);
end; $$;




-- ============================================================
-- 5. RPC: approve_onboarding_correction (HR only)
--    Applies corrected value to the submission payload (active value)
--    Preserves old value in correction history.
-- ============================================================
create or replace function public.approve_onboarding_correction(p_correction_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_corr record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to approve corrections';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_corr from public.onboarding_corrections where id = p_correction_id;
  if v_corr.id is null then
    raise exception 'Correction record not found.';
  end if;
  if v_corr.status != 'submitted' then
    raise exception 'Correction has not been submitted yet.';
  end if;

  -- Apply corrected value to the submission payload
  update public.employee_onboarding_submissions
  set payload = jsonb_set(payload, array[v_corr.field_name], to_jsonb(v_corr.corrected_value))
  where id = v_corr.submission_id;

  -- Mark correction as approved
  update public.onboarding_corrections
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_correction_id;

  -- Event + audit
  insert into public.onboarding_events (onboarding_link_id, event_type, details, actor)
  select s.link_id, 'CORRECTION_APPROVED',
         format('Field %s correction approved by %s', v_corr.field_name, v_actor_name), v_actor_name
  from public.employee_onboarding_submissions s where s.id = v_corr.submission_id;
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ONBOARDING_CORRECTION_APPROVED', 'OnboardingCorrection', p_correction_id::text, v_actor_name,
          format('Field %s corrected from [%s] to [%s]', v_corr.field_name,
                 left(coalesce(v_corr.previous_value, ''), 30), left(coalesce(v_corr.corrected_value, ''), 30)), 'info');

  return jsonb_build_object('ok', true, 'field', v_corr.field_name);
end; $$;




-- ============================================================
-- 6. RPC: reject_onboarding_correction (HR only, requires reason)
-- ============================================================
create or replace function public.reject_onboarding_correction(p_correction_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_corr record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'Rejection reason is required';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.onboarding_corrections
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), rejection_reason = p_reason
  where id = p_correction_id and status = 'submitted'
  returning * into v_corr;

  if v_corr.id is null then
    raise exception 'Correction record not found or not in submitted state.';
  end if;

  insert into public.onboarding_events (onboarding_link_id, event_type, details, actor)
  select s.link_id, 'CORRECTION_REJECTED',
         format('Field %s correction rejected by %s: %s', v_corr.field_name, v_actor_name, p_reason), v_actor_name
  from public.employee_onboarding_submissions s where s.id = v_corr.submission_id;

  return jsonb_build_object('ok', true);
end; $$;




-- ------------------------------------------------------------
-- 9. HR SETTINGS — accept the new app_timezone key
-- ------------------------------------------------------------
create or replace function public.update_hr_settings(p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_current record;
  v_key text;
  v_old_val text;
  v_new_val text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to update HR settings.';
  end if;

  select * into v_current from public.hr_platform_settings where id = 1;

  for v_key in select jsonb_object_keys(p_settings) loop
    v_old_val := case v_key
      when 'require_gps_clock_in' then v_current.require_gps_clock_in::text
      when 'require_gps_clock_out' then v_current.require_gps_clock_out::text
      when 'geofence_enabled' then v_current.geofence_enabled::text
      when 'default_geofence_radius' then v_current.default_geofence_radius::text
      when 'allow_manual_correction' then v_current.allow_manual_correction::text
      when 'late_threshold_minutes' then v_current.late_threshold_minutes::text
      when 'early_departure_threshold_minutes' then v_current.early_departure_threshold_minutes::text
      when 'default_work_start_time' then v_current.default_work_start_time::text
      when 'default_work_end_time' then v_current.default_work_end_time::text
      when 'default_grace_period_minutes' then v_current.default_grace_period_minutes::text
      when 'default_break_duration_minutes' then v_current.default_break_duration_minutes::text
      when 'overtime_threshold_minutes' then v_current.overtime_threshold_minutes::text
      when 'app_timezone' then v_current.app_timezone
      when 'leave_annual_days' then v_current.leave_annual_days::text
      when 'leave_sick_days' then v_current.leave_sick_days::text
      when 'leave_casual_days' then v_current.leave_casual_days::text
      when 'leave_maternity_days' then v_current.leave_maternity_days::text
      when 'leave_paternity_days' then v_current.leave_paternity_days::text
      when 'leave_compassionate_days' then v_current.leave_compassionate_days::text
      when 'leave_study_days' then v_current.leave_study_days::text
      when 'leave_unpaid_days' then v_current.leave_unpaid_days::text
      when 'leave_approval_required' then v_current.leave_approval_required::text
      when 'leave_attachment_required' then v_current.leave_attachment_required::text
      when 'leave_carry_forward' then v_current.leave_carry_forward::text
      else null
    end;
    v_new_val := p_settings->>v_key;
    if v_old_val is distinct from v_new_val then
      insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
      values (v_key, v_old_val, v_new_val, auth.uid());
    end if;
  end loop;

  update public.hr_platform_settings set
    require_gps_clock_in = coalesce((p_settings->>'require_gps_clock_in')::boolean, require_gps_clock_in),
    require_gps_clock_out = coalesce((p_settings->>'require_gps_clock_out')::boolean, require_gps_clock_out),
    geofence_enabled = coalesce((p_settings->>'geofence_enabled')::boolean, geofence_enabled),
    default_geofence_radius = coalesce((p_settings->>'default_geofence_radius')::int, default_geofence_radius),
    allow_manual_correction = coalesce((p_settings->>'allow_manual_correction')::boolean, allow_manual_correction),
    late_threshold_minutes = coalesce((p_settings->>'late_threshold_minutes')::int, late_threshold_minutes),
    early_departure_threshold_minutes = coalesce((p_settings->>'early_departure_threshold_minutes')::int, early_departure_threshold_minutes),
    default_work_start_time = coalesce((p_settings->>'default_work_start_time')::time, default_work_start_time),
    default_work_end_time = coalesce((p_settings->>'default_work_end_time')::time, default_work_end_time),
    default_grace_period_minutes = coalesce((p_settings->>'default_grace_period_minutes')::int, default_grace_period_minutes),
    default_break_duration_minutes = coalesce((p_settings->>'default_break_duration_minutes')::int, default_break_duration_minutes),
    overtime_threshold_minutes = coalesce((p_settings->>'overtime_threshold_minutes')::int, overtime_threshold_minutes),
    app_timezone = coalesce(nullif(p_settings->>'app_timezone', ''), app_timezone),
    leave_annual_days = coalesce((p_settings->>'leave_annual_days')::int, leave_annual_days),
    leave_sick_days = coalesce((p_settings->>'leave_sick_days')::int, leave_sick_days),
    leave_casual_days = coalesce((p_settings->>'leave_casual_days')::int, leave_casual_days),
    leave_maternity_days = coalesce((p_settings->>'leave_maternity_days')::int, leave_maternity_days),
    leave_paternity_days = coalesce((p_settings->>'leave_paternity_days')::int, leave_paternity_days),
    leave_compassionate_days = coalesce((p_settings->>'leave_compassionate_days')::int, leave_compassionate_days),
    leave_study_days = coalesce((p_settings->>'leave_study_days')::int, leave_study_days),
    leave_unpaid_days = coalesce((p_settings->>'leave_unpaid_days')::int, leave_unpaid_days),
    leave_approval_required = coalesce((p_settings->>'leave_approval_required')::boolean, leave_approval_required),
    leave_attachment_required = coalesce((p_settings->>'leave_attachment_required')::boolean, leave_attachment_required),
    leave_carry_forward = coalesce((p_settings->>'leave_carry_forward')::boolean, leave_carry_forward),
    updated_at = now(),
    updated_by = auth.uid()
  where id = 1;

  return jsonb_build_object('ok', true);
end; $$;




-- ------------------------------------------------------------
-- 10. approve_user OVERLOADS — head roles are staff roles for
--     auto-linking and require super_admin/admin to assign.
-- ------------------------------------------------------------

-- 10a. 5-arg approve_user (Users.jsx).
create or replace function public.approve_user(
  p_user_id uuid,
  p_role text default 'staff',
  p_department text default null,
  p_branch text default null,
  p_user_type text default 'staff'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
  v_employee public.employees;
  v_dept text;
  v_branch text;
  v_designation text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to approve users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Cannot modify Super Admin accounts';
  end if;

  -- Validate role assignment (reuse enforce_role_change_policy logic)
  if p_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role in ('admin', 'area_manager', 'head_of_business', 'head_of_operations',
                'head_of_e_business', 'financial_controller',
                'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Not authorized to assign this role';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  -- Resolve the source-of-truth employee before writing the profile.
  -- Preference: real link, then auth-user link, then matching email.
  select e.* into v_employee
  from public.employees e
  where e.user_id = p_user_id
     or e.id = v_target.employee_id
     or (v_target.email is not null and lower(e.email) = lower(v_target.email))
  order by case
             when e.user_id = p_user_id then 0
             when e.id = v_target.employee_id then 1
             else 2
           end
  limit 1;

  v_dept := v_employee.department;
  v_branch := v_employee.branch;
  if v_employee.branch_id is not null then
    select branch_name into v_branch from public.branches where id = v_employee.branch_id;
    v_branch := coalesce(v_branch, v_employee.branch);
  end if;
  v_designation := public.employee_designation_label(v_employee."position", v_employee.designation_id);

  update public.profiles set
    role = p_role,
    status = 'active',
    approved = true,
    approved_by = auth.uid(),
    approved_at = now(),
    department = coalesce(nullif(trim(p_department), ''), v_dept, department),
    branch = coalesce(nullif(trim(p_branch), ''), v_branch, branch),
    employee_number = coalesce(v_employee.employee_number, employee_number),
    designation = coalesce(v_designation, designation),
    user_type = coalesce(nullif(trim(p_user_type), ''), 'staff')
  where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_APPROVED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s approved with role %s, dept %s, branch %s', coalesce(v_target.email, p_user_id::text), p_role, coalesce(nullif(trim(p_department), ''), v_dept, 'N/A'), coalesce(nullif(trim(p_branch), ''), v_branch, 'N/A')),
    'warning'
  );

  -- Notify the approved user
  insert into public.notifications (user_id, title, message, type, link)
  values (
    p_user_id,
    'Account Approved',
    format('Your account has been approved. You now have access as %s.', p_role),
    'system',
    '/'
  );

  -- Auto-create/link employee record for staff roles
  if p_role in ('staff', 'head_of_human_resources', 'hr_officer', 'branch_manager', 'area_manager',
                'head_of_business', 'head_of_operations', 'head_of_e_business',
                'financial_controller', 'head_of_risk_compliance', 'head_of_legal',
                'head_of_audit', 'loan_officer',
                'relationship_manager', 'customer_service', 'admin') then
    declare
      v_emp_id uuid;
      v_emp_code text;
    begin
      -- Check if employee already exists (by user_id or email)
      select id into v_emp_id from public.employees
        where user_id = p_user_id
           or (v_target.email is not null and lower(email) = lower(v_target.email))
        limit 1;

      if v_emp_id is null then
        -- Generate employee code
        v_emp_code := public.generate_employee_code();

        insert into public.employees (
          user_id, full_name, email, department, "position", branch,
          employment_status, employee_code, source, created_by, hire_date, updated_at
        ) values (
          p_user_id, coalesce(v_target.full_name, v_target.email, 'Unknown'),
          v_target.email, coalesce(nullif(trim(p_department), ''), v_dept), v_designation, coalesce(nullif(trim(p_branch), ''), v_branch),
          'active', v_emp_code, 'manual', auth.uid(), now()::date, now()
        )
        returning id into v_emp_id;

        insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
        values (
          'EMPLOYEE_AUTO_CREATED',
          'Employee',
          v_emp_id::text,
          coalesce(v_actor_name, auth.uid()::text),
          format('Employee auto-created for approved user %s (role: %s)', coalesce(v_target.email, p_user_id::text), p_role),
          'info'
        );

        -- Assign the standard employee number / staff id so the approval
        -- screen shows an identity for the new employee.
        perform public.generate_employee_number(v_emp_id);
      else
        -- Link existing employee to user_id if not already linked.
        -- The employee record itself is left untouched — HR data stays
        -- authoritative; the profile snapshot below mirrors it.
        update public.employees set user_id = p_user_id, updated_at = now()
          where id = v_emp_id and user_id is null;
      end if;

      -- Link profile to employee
      update public.profiles set employee_id = v_emp_id where id = p_user_id and employee_id is null;

      -- Final snapshot sync: employee record is the source of truth for
      -- the identity fields shown on the approval/review screen.
      update public.profiles p
      set employee_number = e.employee_number,
          designation = public.employee_designation_label(e."position", e.designation_id)
      from public.employees e
      where e.id = v_emp_id and p.id = p_user_id;
    end;
  end if;

  return jsonb_build_object('ok', true);
end; $$;




-- ============================================================
-- 7. RPC: reject_user (HR/admin only)
-- ============================================================
create or replace function public.reject_user(
  p_user_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to reject users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' then
    raise exception 'Cannot reject Super Admin accounts';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.profiles set
    status = 'rejected',
    approved = false,
    rejection_reason = p_reason
  where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_REJECTED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s rejected. Reason: %s', coalesce(v_target.email, p_user_id::text), coalesce(p_reason, 'No reason given')),
    'warning'
  );

  return jsonb_build_object('ok', true);
end; $$;




-- ============================================================
-- 8. RPC: deactivate_user / reactivate_user (HR/admin only)
-- ============================================================
create or replace function public.deactivate_user(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to deactivate users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' then
    raise exception 'Cannot deactivate Super Admin accounts';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.profiles set status = 'inactive' where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_DEACTIVATED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s deactivated', coalesce(v_target.email, p_user_id::text)),
    'warning'
  );

  return jsonb_build_object('ok', true);
end; $$;




create or replace function public.reactivate_user(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to reactivate users';
  end if;

  select * into v_target from public.profiles where id = p_user_id;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Cannot modify Super Admin accounts';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.profiles set status = 'active', approved = true where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_REACTIVATED',
    'User',
    p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('User %s reactivated', coalesce(v_target.email, p_user_id::text)),
    'info'
  );

  return jsonb_build_object('ok', true);
end; $$;




-- ============================================================
-- 9. RPC: create_employee_manual (HR/admin only)
--    Creates an employee record with duplicate checking.
--    Does NOT create a user account — that's a separate step.
-- ============================================================
create or replace function public.create_employee_manual(
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_department text default null,
  p_position text default null,
  p_branch text default null,
  p_area text default null,
  p_employment_type text default null,
  p_employment_status text default 'active',
  p_hire_date date default null,
  p_employee_code text default null,
  p_basic_salary numeric default null,
  p_bank_name text default null,
  p_account_name text default null,
  p_account_number text default null,
  p_bank_sort_code text default null,
  p_bvn text default null,
  p_nin text default null,
  p_tax_id text default null,
  p_pension_id text default null,
  p_gender text default null,
  p_date_of_birth date default null,
  p_nationality text default null,
  p_marital_status text default null,
  p_state_of_origin text default null,
  p_lga text default null,
  p_residential_address text default null,
  p_emergency_contact_name text default null,
  p_emergency_contact_phone text default null,
  p_next_of_kin_name text default null,
  p_next_of_kin_phone text default null,
  p_next_of_kin_relationship text default null,
  p_reporting_manager_id uuid default null,
  p_work_location text default null,
  p_probation_end_date date default null,
  p_preferred_name text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_existing record;
  v_new_id uuid;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to create employees';
  end if;

  -- Duplicate check: email or phone or employee_code
  if p_email is not null then
    select * into v_existing from public.employees where email = p_email limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this email already exists');
    end if;
  end if;

  if p_phone is not null then
    select * into v_existing from public.employees where phone = p_phone limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this phone number already exists');
    end if;
  end if;

  if p_employee_code is not null then
    select * into v_existing from public.employees where employee_code = p_employee_code limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this employee code already exists');
    end if;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  insert into public.employees (
    full_name, email, phone, department, "position", branch, area,
    employment_type, employment_status, hire_date, employee_code,
    basic_salary, bank_name, account_name, account_number, bank_sort_code,
    bvn, nin, tax_id, pension_id, gender, date_of_birth,
    nationality, marital_status, state_of_origin, lga, residential_address,
    emergency_contact_name, emergency_contact_phone,
    next_of_kin_name, next_of_kin_phone, next_of_kin_relationship,
    reporting_manager_id, work_location, probation_end_date,
    preferred_name, source, created_by, updated_at
  ) values (
    p_full_name, p_email, p_phone, p_department, p_position, p_branch, p_area,
    p_employment_type, p_employment_status, p_hire_date, p_employee_code,
    p_basic_salary, p_bank_name, p_account_name, p_account_number, p_bank_sort_code,
    p_bvn, p_nin, p_tax_id, p_pension_id, p_gender, p_date_of_birth,
    p_nationality, p_marital_status, p_state_of_origin, p_lga, p_residential_address,
    p_emergency_contact_name, p_emergency_contact_phone,
    p_next_of_kin_name, p_next_of_kin_phone, p_next_of_kin_relationship,
    p_reporting_manager_id, p_work_location, p_probation_end_date,
    p_preferred_name, 'manual', auth.uid(), now()
  )
  returning id into v_new_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_CREATED',
    'Employee',
    v_new_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('Employee %s manually created by HR (source: manual)', p_full_name),
    'info'
  );

  return jsonb_build_object('ok', true, 'employee_id', v_new_id::text);
end; $$;




-- ============================================================
-- 16. RPC: request_employee_info_update
--      HR/super_admin requests an employee to update specific fields.
--      Creates a notification + audit record.
-- ============================================================
create or replace function public.request_employee_info_update(
  p_employee_id uuid,
  p_fields text[],
  p_message text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to request employee updates';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  -- Notify the employee's linked user if they have one
  if v_emp.user_id is not null then
    insert into public.notifications (user_id, title, message, type, link)
    values (
      v_emp.user_id,
      'Employee Information Update Requested',
      coalesce(p_message, format('Please update the following: %s', array_to_string(p_fields, ', '))),
      'system',
      '/employees/' || p_employee_id::text
    );
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_UPDATE_REQUESTED',
    'Employee',
    p_employee_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('HR requested update for %s. Fields: %s. Message: %s',
           coalesce(v_emp.full_name, ''), array_to_string(p_fields, ', '), coalesce(p_message, 'N/A')),
    'warning'
  );

  return jsonb_build_object('ok', true);
end; $$;




-- ------------------------------------------------------------
-- 3. REWRITE: sara_batch_approve_leave
--    Walks the SAME 4-stage chain as the web UI. It only
--    approves when the authenticated user holds the CURRENT
--    stage's role (branch managers additionally must manage the
--    requester's branch). Final stage applies the real outcome:
--      - normal leave  -> approved + days deducted from balance
--      - cancellation  -> cancelled  + days restored to balance
--    Correct leave_approvals columns. Never bypasses authorization.
-- ------------------------------------------------------------
create or replace function public.sara_batch_approve_leave(
  p_request_ids uuid[],
  p_comments text default 'Approved via SARA voice command'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_id uuid;
  v_row record;
  v_stage int;
  v_stage_role text;
  v_stage_label text;
  v_can_act boolean;
  v_requester_branch_id uuid;
  v_balance_year int;
  v_approved int := 0;
  v_skipped int := 0;
  v_results jsonb := '[]'::jsonb;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'area_manager', 'head_of_business', 'branch_manager') then
    raise exception 'Not authorized to approve leave requests';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  foreach v_id in array p_request_ids loop
    begin
      select * into v_row from public.leave_requests where id = v_id;
      if v_row.id is null or v_row.status <> 'pending' then
        v_skipped := v_skipped + 1;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'skipped', 'reason', 'not pending or missing');
        continue;
      end if;

      v_stage := coalesce(v_row.approval_level, 1);

      select role, label into v_stage_role, v_stage_label
      from (values
        (1, 'branch_manager',   'Branch Manager'),
        (2, 'area_manager',     'Area Manager'),
        (3, 'head_of_business', 'Head of Business'),
        (4, 'head_of_human_resources',       'HR (Final)')
      ) t(level, role, label)
      where t.level = v_stage;

      -- Authorization at the current stage.
      v_can_act := false;
      if v_actor_role in ('super_admin', 'admin', 'head_of_human_resources') then
        v_can_act := true; -- HR/admin may act at any stage
      elsif v_actor_role = v_stage_role then
        if v_actor_role = 'branch_manager' then
          select e.branch_id into v_requester_branch_id
          from public.employees e
          where e.user_id = v_row.created_by
          limit 1;
          v_can_act := exists (
            select 1 from public.branches b
            where b.id = v_requester_branch_id and b.manager_id = auth.uid()
          );
        else
          v_can_act := true;
        end if;
      end if;

      if not v_can_act then
        v_skipped := v_skipped + 1;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'skipped', 'reason', 'not authorized at current stage');
        continue;
      end if;

      -- Trail entry (correct schema: stage_role + stage_label are NOT NULL).
      insert into public.leave_approvals
        (leave_request_id, stage, stage_role, stage_label, decision,
         approver_id, approver_name, comment, is_cancellation)
      values
        (v_id, v_stage, v_stage_role, v_stage_label, 'approved',
         auth.uid(), coalesce(v_actor_name, auth.uid()::text), p_comments, coalesce(v_row.is_cancellation, false));

      v_balance_year := extract(year from coalesce(v_row.start_date, now()))::int;

      if v_stage >= 4 then
        -- FINAL stage — apply the real outcome.
        if coalesce(v_row.is_cancellation, false) then
          update public.leave_requests
            set status = 'cancelled', is_cancellation = false,
                approved_by_name = coalesce(v_actor_name, 'HR'),
                approved_date = now(), approval_comments = p_comments
            where id = v_id;
          if v_row.leave_type <> 'unpaid' and coalesce(v_row.days, 0) > 0 then
            update public.leave_balances
              set used_days = greatest(0, used_days - v_row.days), updated_at = now()
              where employee_id = v_row.created_by
                and year = v_balance_year
                and leave_type = v_row.leave_type;
          end if;
          v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'cancelled');
        else
          update public.leave_requests
            set status = 'approved',
                approved_by_name = coalesce(v_actor_name, 'HR'),
                approved_date = now(), approval_comments = p_comments
            where id = v_id;
          if v_row.leave_type <> 'unpaid' and coalesce(v_row.days, 0) > 0 then
            update public.leave_balances
              set used_days = used_days + v_row.days, updated_at = now()
              where employee_id = v_row.created_by
                and year = v_balance_year
                and leave_type = v_row.leave_type;
          end if;
          v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'approved');
        end if;
      else
        -- Non-final stage — advance to the next approver.
        update public.leave_requests set approval_level = v_stage + 1 where id = v_id;
        v_results := v_results || jsonb_build_object('id', v_id::text, 'status', format('approved_stage_%s', v_stage));
      end if;

      v_approved := v_approved + 1;

      insert into public.notifications (user_id, title, message, type, link)
      values (v_row.created_by, 'Leave Update',
              format('Your %s leave request was approved at the %s stage by %s via SARA.',
                     v_row.leave_type, v_stage_label, coalesce(v_actor_name, 'HR')),
              'workflow', '/leave-requests');
    exception when others then
      v_results := v_results || jsonb_build_object('id', v_id::text, 'status', 'error', 'error', SQLERRM);
    end;
  end loop;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'SARA_BATCH_APPROVE_LEAVE',
    'LeaveRequest',
    array_to_string(p_request_ids, ','),
    coalesce(v_actor_name, auth.uid()::text),
    format('SARA batch approved/applied %s leave request(s), skipped %s', v_approved, v_skipped),
    'warning'
  );

  return jsonb_build_object('ok', true, 'approved_count', v_approved, 'skipped_count', v_skipped, 'results', v_results);
end; $$;




-- ============================================================
-- 8. CLOSE THE update_employee_hr_fields BYPASS
--
-- The pre-existing RPC allowed admin / hr_officer to set
-- employment_status = 'terminated'. That write path is the very
-- bypass this migration exists to close. Only super_admin and
-- head_of_human_resources may use that RPC to move an employee to 'terminated'.
-- ============================================================
create or replace function public.update_employee_hr_fields(
  p_employee_id uuid,
  p_fields jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
  v_patch jsonb := '{}'::jsonb;
  v_allowed text[] := array[
    'full_name', 'email', 'phone', 'department', 'position',
    'employment_status', 'employment_type', 'hire_date',
    'salary', 'basic_salary', 'allowances', 'branch',
    'branch_manager_name', 'area_manager_name',
    'bank_name', 'account_number', 'account_name', 'bank_sort_code',
    'bvn', 'nin', 'pension_id', 'tax_id', 'nhf_id',
    'employee_code', 'manager_id', 'reporting_manager_id',
    'probation_end_date', 'work_location', 'area',
    'date_of_birth', 'sex', 'state_of_origin', 'lga', 'town',
    'residential_address', 'religion', 'denomination', 'nationality',
    'marital_status', 'spouse_name', 'spouse_occupation', 'spouse_age',
    'spouse_business_address', 'spouse_email', 'spouse_phone',
    'living_with_spouse', 'number_of_children', 'children_age_range',
    'next_of_kin_name', 'next_of_kin_relationship', 'next_of_kin_phone', 'next_of_kin_address',
    'beneficiary_name', 'beneficiary_relationship', 'beneficiary_phone', 'beneficiary_address',
    'emergency_contact_name', 'emergency_contact_phone',
    'preferred_name', 'gender', 'hmo'
  ];
  k text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to update employee fields';
  end if;

  -- STRICT TERMINATION GATE: setting the status to 'terminated' (the
  -- canonical firing transition) is reserved for super_admin/head_of_human_resources.
  if p_fields ? 'employment_status'
     and p_fields ->> 'employment_status' = 'terminated'
     and v_actor_role not in ('super_admin', 'head_of_human_resources') then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_termination_denied', 'Employee', p_employee_id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()), 'user'),
      format('Termination attempt blocked via HR update path: role %s is not authorized to terminate employees.', v_actor_role),
      'high'
    );
    raise exception 'Your role is not authorized to terminate employees.';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;

  -- Build safe patch from only allowed keys
  for k in select jsonb_object_keys(p_fields)
  loop
    if k = any(v_allowed) then
      v_patch := v_patch || jsonb_build_object(k, p_fields -> k);
    end if;
  end loop;

  -- Keep the printed staff identity in sync with the employee code so the
  -- ID card always shows the latest code (the card reads employee_number first).
  if v_patch ? 'employee_code' and nullif(v_patch ->> 'employee_code', '') is not null then
    v_patch := v_patch
      || jsonb_build_object('staff_id', v_patch ->> 'employee_code')
      || jsonb_build_object('employee_number', v_patch ->> 'employee_code');
  end if;

  if v_patch = '{}'::jsonb then
    raise exception 'No valid fields provided.';
  end if;

  -- Add updated_at
  v_patch := v_patch || jsonb_build_object('updated_at', now()::text);

  -- Execute the update (nullif converts empty strings to NULL so date/numeric
  -- columns never see an invalid cast like ''::date or ''::numeric, and each
  -- value is cast to the target column's type so text input works for
  -- timestamps/dates/numerics alike).
  execute format(
    'UPDATE public.employees SET %s WHERE id = $1 RETURNING id',
    (select string_agg(
       format('%I = nullif(($2->>''%s'')::text, '''')::%s', key, key,
         coalesce((select quote_ident(t.typname)
                    from pg_catalog.pg_attribute a
                    join pg_catalog.pg_type t on t.oid = a.atttypid
                    where a.attrelid = 'public.employees'::regclass
                      and a.attname = key and not a.attisdropped), 'text')),
       ', ')
     from jsonb_object_keys(v_patch) key)
  )
  using p_employee_id, v_patch;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('EMPLOYEE_HR_FIELDS_UPDATED', 'Employee', p_employee_id::text, v_actor_name,
          format('HR fields updated for %s: %s', v_emp.full_name,
                 (select string_agg(key, ', ') from jsonb_object_keys(v_patch) key)), 'info');

  return jsonb_build_object('ok', true, 'fields_updated', v_patch);
end; $$;




-- RPC: generate_employee_number — assigns IMFB/<n> (official format).
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
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
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

  select count(*) into v_next from public.employees where employee_number is not null;

  loop
    v_code := 'IMFB/' || (v_next + 1)::text;
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




-- ------------------------------------------------------------
-- 5. RPC: approve_fidelity_verification (HR only)
-- ------------------------------------------------------------
create or replace function public.approve_fidelity_verification(p_verification_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_verif record;
  v_actor_name text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to approve fidelity bond verifications';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_verif from public.fidelity_bond_verifications where id = p_verification_id;
  if v_verif.id is null then
    raise exception 'Verification not found.';
  end if;

  update public.fidelity_bond_verifications
     set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = p_verification_id;

  -- Reflect on the fidelity bond record itself
  if v_verif.bond_id is not null then
    update public.employee_fidelity_bonds
       set verification_status = 'verified', updated_at = now()
     where id = v_verif.bond_id;
  end if;

  insert into public.onboarding_events (event_type, details, actor, fidelity_verification_id)
  values ('FIDELITY_APPROVED',
          format('Fidelity bond verification approved by %s for %s', v_actor_name, v_verif.surety_name),
          v_actor_name, v_verif.id);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('FIDELITY_VERIFICATION_APPROVED', 'FidelityBondVerification', p_verification_id::text, v_actor_name,
          format('Fidelity bond verification approved for %s', v_verif.surety_name), 'info');

  return jsonb_build_object('ok', true, 'verification_id', v_verif.id);
end;
$$;




-- ------------------------------------------------------------
-- 6. RPC: reject_fidelity_verification (HR only)
-- ------------------------------------------------------------
create or replace function public.reject_fidelity_verification(p_verification_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_verif record;
  v_actor_name text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to reject fidelity bond verifications';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A rejection reason is required.';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_verif from public.fidelity_bond_verifications where id = p_verification_id;
  if v_verif.id is null then
    raise exception 'Verification not found.';
  end if;

  update public.fidelity_bond_verifications
     set status = 'rejected', hr_comments = p_reason,
         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = p_verification_id;

  if v_verif.bond_id is not null then
    update public.employee_fidelity_bonds
       set verification_status = 'rejected', verification_comments = p_reason, updated_at = now()
     where id = v_verif.bond_id;
  end if;

  insert into public.onboarding_events (event_type, details, actor, fidelity_verification_id)
  values ('FIDELITY_REJECTED',
          format('Fidelity bond verification rejected by %s for %s. %s', v_actor_name, v_verif.surety_name, p_reason),
          v_actor_name, v_verif.id);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('FIDELITY_VERIFICATION_REJECTED', 'FidelityBondVerification', p_verification_id::text, v_actor_name,
          format('Fidelity bond verification rejected for %s: %s', v_verif.surety_name, p_reason), 'warning');

  return jsonb_build_object('ok', true, 'verification_id', v_verif.id);
end;
$$;




-- ------------------------------------------------------------
-- 2. create_employee_manual — accept optional branch_id
-- ------------------------------------------------------------
create or replace function public.create_employee_manual(
  p_full_name text,
  p_email text default null,
  p_phone text default null,
  p_department text default null,
  p_position text default null,
  p_branch text default null,
  p_branch_id uuid default null,
  p_area text default null,
  p_employment_type text default null,
  p_employment_status text default 'active',
  p_hire_date date default null,
  p_employee_code text default null,
  p_basic_salary numeric default null,
  p_bank_name text default null,
  p_account_name text default null,
  p_account_number text default null,
  p_bank_sort_code text default null,
  p_bvn text default null,
  p_nin text default null,
  p_tax_id text default null,
  p_pension_id text default null,
  p_gender text default null,
  p_date_of_birth date default null,
  p_nationality text default null,
  p_marital_status text default null,
  p_state_of_origin text default null,
  p_lga text default null,
  p_residential_address text default null,
  p_emergency_contact_name text default null,
  p_emergency_contact_phone text default null,
  p_next_of_kin_name text default null,
  p_next_of_kin_phone text default null,
  p_next_of_kin_relationship text default null,
  p_reporting_manager_id uuid default null,
  p_work_location text default null,
  p_probation_end_date date default null,
  p_preferred_name text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_existing record;
  v_new_id uuid;
  v_branch_id uuid := p_branch_id;
  v_branch_name text := p_branch;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to create employees';
  end if;

  -- Resolve branch: prefer explicit id, else look up from name/code
  if v_branch_id is null and v_branch_name is not null then
    select id into v_branch_id from public.branches
    where branch_name = v_branch_name or branch_code = v_branch_name
    order by case when branch_name = v_branch_name then 0 else 1 end
    limit 1;
  elsif v_branch_id is not null and v_branch_name is null then
    select branch_name into v_branch_name from public.branches where id = v_branch_id;
  end if;

  -- Duplicate check: email or phone or employee_code
  if p_email is not null then
    select * into v_existing from public.employees where email = p_email limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this email already exists');
    end if;
  end if;

  if p_phone is not null then
    select * into v_existing from public.employees where phone = p_phone limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this phone number already exists');
    end if;
  end if;

  if p_employee_code is not null then
    select * into v_existing from public.employees where employee_code = p_employee_code limit 1;
    if v_existing.id is not null then
      return jsonb_build_object('ok', false, 'error', 'duplicate', 'existing_id', v_existing.id::text, 'message', 'An employee with this employee code already exists');
    end if;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  insert into public.employees (
    full_name, email, phone, department, "position", branch, branch_id, area,
    employment_type, employment_status, hire_date, employee_code,
    basic_salary, bank_name, account_name, account_number, bank_sort_code,
    bvn, nin, tax_id, pension_id, gender, date_of_birth,
    nationality, marital_status, state_of_origin, lga, residential_address,
    emergency_contact_name, emergency_contact_phone,
    next_of_kin_name, next_of_kin_phone, next_of_kin_relationship,
    reporting_manager_id, work_location, probation_end_date,
    preferred_name, source, created_by, updated_at
  ) values (
    p_full_name, p_email, p_phone, p_department, p_position, v_branch_name, v_branch_id, p_area,
    p_employment_type, p_employment_status, p_hire_date, p_employee_code,
    p_basic_salary, p_bank_name, p_account_name, p_account_number, p_bank_sort_code,
    p_bvn, p_nin, p_tax_id, p_pension_id, p_gender, p_date_of_birth,
    p_nationality, p_marital_status, p_state_of_origin, p_lga, p_residential_address,
    p_emergency_contact_name, p_emergency_contact_phone,
    p_next_of_kin_name, p_next_of_kin_phone, p_next_of_kin_relationship,
    p_reporting_manager_id, p_work_location, p_probation_end_date,
    p_preferred_name, 'manual', auth.uid(), now()
  )
  returning id into v_new_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_CREATED',
    'Employee',
    v_new_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format('Employee %s manually created by HR (source: manual)', p_full_name),
    'info'
  );

  return jsonb_build_object('ok', true, 'employee_id', v_new_id::text, 'branch_id', v_branch_id);
end; $$;


-- ============================================================
-- Phase 24: Attendance Employee-ID Lookup + WebAuthn support
--          + HR document read consistency (additive, idempotent)
--
-- Fixes the CRITICAL attendance bug where entering the official
-- employee number IMFB/26 on the Attendance Terminal returned
-- "Unknown employee ID". Root cause: the terminal (and the
-- ingest_attendance_event RPC) resolved employees ONLY through
-- employee_biometric_identifiers.external_user_id, never through
-- the canonical employees.employee_number / staff_id / employee_code.
--
-- This migration:
--   1. Re-creates ingest_attendance_event to resolve employees by
--      the canonical employee number (normalized, case-insensitive)
--      when no biometric mapping matches, and to accept an optional
--      pre-resolved p_employee_id (used by the WebAuthn flow). The
--      attendance record still references the employee UUID.
--   2. Widens the verification_method CHECK constraints to accept
--      'WEBAUTHN' (idempotent DO blocks).
--   3. Adds head_of_human_resources/hr_officer/super_admin to the documents
--      read policy — HR can already delete documents (Phase 22) but
--      could not read documents they did not upload.
--
-- ALL ADDITIVE / IDEMPOTENT. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ingest_attendance_event — employee-number resolution
-- ------------------------------------------------------------
create or replace function public.ingest_attendance_event(
  p_device_id uuid,
  p_external_user_id text,
  p_event_type text,
  p_event_time timestamptz DEFAULT now(),
  p_verification_method text DEFAULT 'FINGERPRINT',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_employee_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_device public.attendance_devices%ROWTYPE;
  v_biometric public.employee_biometric_identifiers%ROWTYPE;
  v_employee public.employees%ROWTYPE;
  v_normalized text;
  v_existing_count int;
  v_attendance_id uuid;
  v_event_id uuid;
BEGIN
  -- 1. Validate device
  SELECT * INTO v_device FROM public.attendance_devices WHERE id = p_device_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown device');
  END IF;
  IF v_device.status != 'active' OR NOT v_device.active THEN
    RETURN jsonb_build_object('success', false, 'error', 'Device inactive or suspended');
  END IF;

  -- 2a. Pre-resolved employee (WebAuthn / device authenticated flow).
  --     The caller already proved identity via a registered credential.
  IF p_employee_id IS NOT NULL THEN
    SELECT * INTO v_employee FROM public.employees WHERE id = p_employee_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
    END IF;
  ELSE
    -- 2b. Biometric mapping match (fingerprint device user IDs / PINs)
    SELECT * INTO v_biometric FROM public.employee_biometric_identifiers
    WHERE device_id = p_device_id
      AND external_user_id = p_external_user_id
      AND enrollment_status = 'enrolled'
      AND active = true;
    IF NOT FOUND THEN
      -- 2c. Canonical employee-number lookup. Normalize the input the same
      --     way the UI does (uppercase + collapse whitespace around slash)
      --     and compare case-insensitively across all three identifier columns.
      v_normalized := upper(trim(regexp_replace(p_external_user_id, '\s*/\s*', '/', 'g')));
      SELECT * INTO v_employee FROM public.employees
      WHERE upper(trim(coalesce(employee_number, ''))) = v_normalized
         OR upper(trim(coalesce(staff_id, ''))) = v_normalized
         OR upper(trim(coalesce(employee_code, ''))) = v_normalized
      LIMIT 1;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
      END IF;
    ELSE
      SELECT * INTO v_employee FROM public.employees WHERE id = v_biometric.employee_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
      END IF;
    END IF;
  END IF;

  -- 3. Validate employee is eligible to clock in/out
  IF v_employee.employment_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Employee is %s and cannot clock in or out.', coalesce(v_employee.employment_status, 'inactive'))
    );
  END IF;

  -- 4. Duplicate protection — check for existing event in last 5 minutes
  SELECT count(*) INTO v_existing_count FROM public.attendance_events
  WHERE employee_id = v_employee.id
    AND event_type = p_event_type
    AND event_time > p_event_time - interval '5 minutes';
  IF v_existing_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Duplicate event within 5 minutes');
  END IF;

  -- 5. Create attendance record if CLOCK_IN
  IF p_event_type IN ('CLOCK_IN', 'DEVICE_CLOCK_IN') THEN
    SELECT count(*) INTO v_existing_count FROM public.attendance_records
    WHERE employee_id = v_employee.id
      AND attendance_date = (p_event_time AT TIME ZONE 'UTC')::date
      AND clock_out IS NULL;
    IF v_existing_count > 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Open attendance session already exists');
    END IF;
    INSERT INTO public.attendance_records (employee_id, attendance_date, source, source_detail, verification_method, device_id)
    VALUES (v_employee.id, (p_event_time AT TIME ZONE 'UTC')::date, 'fingerprint', 'FINGERPRINT', p_verification_method, p_device_id)
    RETURNING id INTO v_attendance_id;
  END IF;

  -- 6. Close attendance record if CLOCK_OUT
  IF p_event_type IN ('CLOCK_OUT', 'DEVICE_CLOCK_OUT') THEN
    SELECT id INTO v_attendance_id FROM public.attendance_records
    WHERE employee_id = v_employee.id
      AND clock_out IS NULL
    ORDER BY clock_in DESC LIMIT 1;
    IF v_attendance_id IS NOT NULL THEN
      UPDATE public.attendance_records
      SET clock_out = p_event_time,
          work_hours = round(extract(epoch FROM (p_event_time - clock_in)) / 3600.0, 2),
          status = 'present',
          verification_method = p_verification_method,
          device_id = p_device_id
      WHERE id = v_attendance_id;
    END IF;
  END IF;

  -- 7. Create central event
  INSERT INTO public.attendance_events (
    employee_id, user_id, attendance_record_id, event_type, event_time,
    source, device_id, verification_method, verification_status, metadata
  ) VALUES (
    v_employee.id, v_employee.user_id, v_attendance_id, p_event_type, p_event_time,
    'FINGERPRINT', p_device_id, p_verification_method, 'verified', p_metadata
  ) RETURNING id INTO v_event_id;

  -- 8. Update device last seen
  UPDATE public.attendance_devices SET last_seen_at = now() WHERE id = p_device_id;

  RETURN jsonb_build_object(
    'success', true,
    'event_id', v_event_id,
    'attendance_id', v_attendance_id,
    'employee_name', v_employee.full_name,
    'employee_id', v_employee.id,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'department', v_employee.department,
    'position', v_employee.position
  );
END; $$;




-- No direct client access — challenges are created and consumed only
-- by the Edge Functions (service role). No SELECT/INSERT/UPDATE policies.

-- ------------------------------------------------------------
-- 3. RPC: revoke_employee_credential (HR or owning employee)
-- ------------------------------------------------------------
create or replace function public.revoke_employee_credential(
  p_credential_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cred public.employee_auth_credentials%ROWTYPE;
  v_actor_employee_id uuid;
  v_owns boolean;
BEGIN
  select * into v_cred from public.employee_auth_credentials where id = p_credential_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Credential not found');
  end if;

  -- Actor must be HR/manager, or the employee who owns the credential
  select e.id into v_actor_employee_id from public.employees e where e.user_id = auth.uid();

  v_owns := v_actor_employee_id is not null and v_actor_employee_id = v_cred.employee_id;

  if not (
    public.current_role() IN ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    or v_owns
  ) then
    return jsonb_build_object('success', false, 'error', 'Not authorized to revoke this credential');
  end if;

  if v_cred.revoked_at is not null then
    return jsonb_build_object('success', true, 'already_revoked', true, 'credential_id', v_cred.id);
  end if;

  update public.employee_auth_credentials
    set revoked_at = now(), revoked_by = auth.uid()
  where id = p_credential_id;

  insert into public.audit_logs (
    action, entity_type, entity_id, user_name,
    details, severity
  ) values (
    'CREDENTIAL_REVOKED',
    'EmployeeCredential',
    v_cred.id::text,
    (select full_name from public.profiles where id = auth.uid()),
    format('WebAuthn credential %s for employee %s revoked', v_cred.external_id, v_cred.employee_id),
    'warning'
  );

  return jsonb_build_object('success', true, 'credential_id', v_cred.id);
END; $$;




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
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
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
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
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
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
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
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
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
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
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




-- ------------------------------------------------------------
-- 2. WHITELIST RPC — update ONLY the currency keys (security definer)
-- ------------------------------------------------------------
create or replace function public.update_platform_currency(p_currency jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_current record;
  v_key text;
  v_old_val text;
  v_new_val text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to update platform currency.';
  end if;

  select * into v_current from public.hr_platform_settings where id = 1;

  for v_key in select jsonb_object_keys(p_currency) loop
    -- Only the 4 currency keys are whitelisted — everything else is ignored.
    if v_key not in ('currency_code', 'currency_symbol', 'currency_position', 'currency_decimal_places') then
      continue;
    end if;
    v_old_val := case v_key
      when 'currency_code'           then v_current.currency_code::text
      when 'currency_symbol'         then v_current.currency_symbol::text
      when 'currency_position'       then v_current.currency_position::text
      when 'currency_decimal_places' then v_current.currency_decimal_places::text
      else null
    end;
    v_new_val := p_currency->>v_key;
    if v_new_val is not null and v_new_val <> v_old_val then
      insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
      values (v_key, v_old_val, v_new_val, auth.uid());
    end if;
  end loop;

  update public.hr_platform_settings set
    currency_code           = coalesce((p_currency->>'currency_code')::text,        currency_code),
    currency_symbol         = coalesce((p_currency->>'currency_symbol')::text,      currency_symbol),
    currency_position       = lower(coalesce((p_currency->>'currency_position')::text, 'prefix')),
    currency_decimal_places = coalesce((p_currency->>'currency_decimal_places')::int, currency_decimal_places),
    updated_at = now(),
    updated_by = auth.uid()
  where id = 1;

  return jsonb_build_object('ok', true);
end; $$;




-- ------------------------------------------------------------
-- 10. CONFIRM EMPLOYEES — HR bulk confirmation with audit trail
-- ------------------------------------------------------------
create or replace function public.confirm_employees(
  p_employee_ids uuid[],
  p_reason text default 'HR confirmation'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor_name text;
  v_id uuid;
  v_previous text;
  v_confirmed int := 0;
  v_skipped int := 0;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to confirm employees';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  foreach v_id in array p_employee_ids loop
    select confirmation_status into v_previous
    from public.employees where id = v_id;
    if v_previous is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if v_previous = 'CONFIRMED' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    update public.employees
      set confirmation_status = 'CONFIRMED', updated_at = now()
      where id = v_id;
    v_confirmed := v_confirmed + 1;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'EMPLOYEE_CONFIRMED', 'Employee', v_id::text,
      coalesce(v_actor_name, v_role, auth.uid()::text),
      format('Confirmation status %s → CONFIRMED (%s)', coalesce(v_previous, '-'), coalesce(p_reason, 'no reason')),
      'warning'
    );
  end loop;

  return jsonb_build_object(
    'ok', true,
    'confirmed', v_confirmed,
    'skipped', v_skipped,
    'actor', coalesce(v_actor_name, v_role, auth.uid()::text),
    'at', now()
  );
end; $$;





-- ============================================================
-- 5. payroll_push_calc — BankOne push preview honours the manual
--    outcome overrides (what HR edits in the master flows through)
-- ============================================================
create or replace function public.payroll_push_calc(p_period_label text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ratio numeric := 0.5;
  v_period record;
  v_currency text := 'NGN';
  v_employees jsonb;
  v_count int := 0;
  v_total_gross numeric := 0;
  v_total_allow numeric := 0;
  v_total_ded numeric := 0;
  v_total_net numeric := 0;
  v_total_mid numeric := 0;
  v_total_end numeric := 0;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to calculate payroll push';
  end if;

  select coalesce(config->>'mid_month_ratio', '0.5')::numeric into v_ratio
  from public.payroll_config where id = 1;
  if v_ratio is null or v_ratio <= 0 or v_ratio >= 1 then v_ratio := 0.5; end if;

  select coalesce(currency_code, 'NGN') into v_currency from public.hr_platform_settings limit 1;
  v_currency := coalesce(v_currency, 'NGN');

  select * into v_period from public.payroll_periods where period_label = p_period_label;

  with rows as (
    select
      p.employee_id,
      p.employee_name,
      coalesce(p.salary, 0) as salary,
      coalesce(p.allowances, 0) as allowances,
      coalesce(p.deductions, 0) as deductions,
      coalesce(e.payroll_net_override, p.net_pay,
        coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)) as net_pay,
      coalesce(e.payroll_mid_override,
        round(coalesce(e.payroll_net_override, p.net_pay,
          coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)) * v_ratio, 2)) as mid_month,
      coalesce(e.payroll_end_override,
        greatest(0,
          coalesce(e.payroll_net_override, p.net_pay,
            coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0))
          - round(coalesce(e.payroll_net_override, p.net_pay,
            coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)) * v_ratio, 2))) as month_end,
      e.payroll_net_override is not null as has_net_override
    from public.payroll p
    left join public.employees e on e.id = p.employee_id
    where p.payroll_period = p_period_label
      and p.status is distinct from 'cancelled'
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', r.employee_id,
      'employee_name', r.employee_name,
      'salary', r.salary,
      'allowances', r.allowances,
      'deductions', r.deductions,
      'net_pay', r.net_pay,
      'mid_month', r.mid_month,
      'month_end', r.month_end,
      'manual_override', r.has_net_override
    )), '[]'::jsonb),
    count(*),
    coalesce(sum(r.salary), 0),
    coalesce(sum(r.allowances), 0),
    coalesce(sum(r.deductions), 0),
    coalesce(sum(r.net_pay), 0),
    coalesce(sum(r.mid_month), 0),
    coalesce(sum(r.month_end), 0)
  into v_employees, v_count, v_total_gross, v_total_allow, v_total_ded, v_total_net, v_total_mid, v_total_end
  from rows r;

  return jsonb_build_object(
    'period_label', p_period_label,
    'period_start', v_period.start_date,
    'period_end', v_period.end_date,
    'employee_count', v_count,
    'gross_total', v_total_gross,
    'allowances_total', v_total_allow,
    'deductions_total', v_total_ded,
    'net_total', v_total_net,
    'mid_month_total', v_total_mid,
    'month_end_total', v_total_end,
    'currency', v_currency,
    'mid_month_ratio', v_ratio,
    'employees', v_employees
  );
end; $$;




-- BankOne configuration state, exposed to HR without leaking secrets.
create or replace function public.payroll_bankone_config_state()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_super boolean := public.current_role() = 'super_admin';
  v_row record;
  v_state text := 'NOT_CONFIGURED';
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to view BankOne configuration';
  end if;

  select * into v_row from public.integration_connections
  where provider = 'bankone' and enabled = true
  order by (environment = 'live') desc, updated_at desc nulls last
  limit 1;

  if v_row.id is not null then
    v_state := case
      when v_row.environment = 'live' then 'PRODUCTION_ENABLED'
      else 'TEST_MODE'
    end;
  elsif exists (select 1 from public.integration_connections where provider = 'bankone') then
    v_state := 'NOT_CONFIGURED';
  end if;

  return jsonb_build_object(
    'state', v_state,
    'environment', coalesce(v_row.environment, 'none'),
    'base_url', case when v_super then coalesce(v_row.base_url, '') else null end,
    'write_enabled', coalesce(v_row.write_enabled, false),
    'read_enabled', coalesce(v_row.read_enabled, false)
  );
end; $$;




-- Notify every HR approver. Reuses the existing notifications table.
create or replace function public.payroll_push_notify_hr(
  p_request_id uuid, p_title text, p_message text
) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, title, message, type, link)
  select id, p_title, p_message, 'payroll', '/payroll'
  from public.profiles
  where role in ('super_admin', 'admin', 'head_of_human_resources');
$$;





-- ============================================================================
-- 4. RPCs
-- ============================================================================

-- Create a CALCULATED request from the server-side calculation. Idempotent on
-- idempotency_key so a double click / retry cannot create two requests.
create or replace function public.create_payroll_push_request(
  p_period_label text,
  p_idempotency_key text default null
)
returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_actor_email text;
  v_emp record;
  v_calc jsonb;
  v_existing public.payroll_push_requests;
  v_row public.payroll_push_requests;
  v_key text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to create a payroll push request';
  end if;
  if p_period_label is null or length(trim(p_period_label)) = 0 then
    raise exception 'A payroll period is required.';
  end if;

  v_key := coalesce(nullif(p_idempotency_key, ''), gen_random_uuid()::text);

  select * into v_existing from public.payroll_push_requests where idempotency_key = v_key;
  if v_existing.id is not null then
    return v_existing;  -- idempotent replay
  end if;

  v_calc := public.payroll_push_calc(p_period_label);
  if coalesce((v_calc->>'employee_count')::int, 0) = 0 then
    raise exception 'No calculated payroll rows exist for period "%". Run Calculate first.', p_period_label;
  end if;

  select full_name, email into v_actor_name, v_actor_email from public.profiles where id = auth.uid();
  select employee_code, employee_number, account_number, bank_name into v_emp
  from public.employees where user_id = auth.uid() limit 1;

  insert into public.payroll_push_requests (
    period_label, period_start, period_end, employee_count,
    gross_total, allowances_total, deductions_total,
    mid_month_total, month_end_total, total_payroll, currency,
    calculation, config_snapshot, status,
    sender_id, sender_name, sender_email, sender_employee_id,
    sender_account_number, sender_bank_name, idempotency_key
  ) values (
    p_period_label,
    (v_calc->>'period_start')::date,
    (v_calc->>'period_end')::date,
    (v_calc->>'employee_count')::int,
    coalesce((v_calc->>'gross_total')::numeric, 0),
    coalesce((v_calc->>'allowances_total')::numeric, 0),
    coalesce((v_calc->>'deductions_total')::numeric, 0),
    coalesce((v_calc->>'mid_month_total')::numeric, 0),
    coalesce((v_calc->>'month_end_total')::numeric, 0),
    coalesce((v_calc->>'net_total')::numeric, 0),
    coalesce(v_calc->>'currency', 'NGN'),
    v_calc, jsonb_build_object('mid_month_ratio', v_calc->'mid_month_ratio'),
    'calculated',
    auth.uid(), v_actor_name, v_actor_email,
    coalesce(v_emp.employee_code, v_emp.employee_number),
    v_emp.account_number, v_emp.bank_name,
    v_key
  ) returning * into v_row;

  perform public.payroll_push_event(v_row.id, 'REQUEST_CREATED', v_actor_name,
    jsonb_build_object('period_label', p_period_label));

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_REQUEST_CREATED', 'PayrollPushRequest', v_row.id::text, v_actor_name,
          format('Payroll push request created for %s', p_period_label), 'info');

  return v_row;
end; $$;




-- Sender signs and submits for HR approval.
create or replace function public.submit_payroll_push_request(
  p_request_id uuid, p_signature text
) returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text;
  v_row public.payroll_push_requests;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to submit a payroll push request';
  end if;
  if p_signature is null or length(trim(p_signature)) < 20 then
    raise exception 'A signature is required before submitting.';
  end if;

  select * into v_row from public.payroll_push_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;
  if v_row.status not in ('calculated', 'draft', 'correction_required', 'rejected') then
    raise exception 'Request cannot be submitted from status "%".', v_row.status;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.payroll_push_requests set
    status = 'pending_hr_approval',
    sender_signature = p_signature,
    sender_signed_at = now(),
    rejection_reason = null, rejected_by = null, rejected_at = null,
    updated_at = now()
  where id = p_request_id
  returning * into v_row;

  insert into public.payroll_push_approvals (request_id, action, actor_id, actor_name, actor_email, actor_role, signature)
  values (p_request_id, 'submit', auth.uid(), v_actor_name, v_row.sender_email, public.current_role(), p_signature);

  perform public.payroll_push_event(p_request_id, 'SUBMITTED_FOR_APPROVAL', v_actor_name, '{}'::jsonb);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_SUBMITTED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
          format('Payroll push for %s submitted for HR approval', v_row.period_label), 'info');

  perform public.payroll_push_notify_hr(p_request_id, 'Payroll approval required',
    format('A payroll push for %s (%s employees) needs your approval.', v_row.period_label, v_row.employee_count));

  return v_row;
end; $$;




-- HR manager approves with signature. Segregation of duties: the sender cannot
-- approve their own request.
create or replace function public.approve_payroll_push_request(
  p_request_id uuid, p_signature text
) returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text; v_actor_email text;
  v_row public.payroll_push_requests;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Only an HR manager or admin can approve a payroll push request';
  end if;
  if p_signature is null or length(trim(p_signature)) < 20 then
    raise exception 'An HR manager signature is required to approve.';
  end if;

  select * into v_row from public.payroll_push_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;
  if v_row.status <> 'pending_hr_approval' then
    raise exception 'Request is not awaiting HR approval (status "%").', v_row.status;
  end if;
  if v_row.sender_id = auth.uid() then
    raise exception 'Segregation of duties: the sender cannot approve their own payroll request.';
  end if;

  select full_name, email into v_actor_name, v_actor_email from public.profiles where id = auth.uid();

  update public.payroll_push_requests set
    status = 'approved', updated_at = now()
  where id = p_request_id
  returning * into v_row;

  insert into public.payroll_push_approvals (request_id, action, actor_id, actor_name, actor_email, actor_role, signature)
  values (p_request_id, 'approve', auth.uid(), v_actor_name, v_actor_email, public.current_role(), p_signature);

  perform public.payroll_push_event(p_request_id, 'APPROVED', v_actor_name, '{}'::jsonb);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_APPROVED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
          format('Payroll push for %s approved', v_row.period_label), 'info');

  perform public.payroll_push_notify_sender(p_request_id, 'Payroll request approved',
    format('Your payroll push for %s has been approved.', v_row.period_label));

  return v_row;
end; $$;




-- HR manager rejects with a reason. Returns the request to the sender.
create or replace function public.reject_payroll_push_request(
  p_request_id uuid, p_reason text
) returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text;
  v_row public.payroll_push_requests;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Only an HR manager or admin can reject a payroll push request';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A rejection reason is required.';
  end if;

  select * into v_row from public.payroll_push_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;
  if v_row.status <> 'pending_hr_approval' then
    raise exception 'Request is not awaiting HR approval (status "%").', v_row.status;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.payroll_push_requests set
    status = 'correction_required',
    rejection_reason = p_reason, rejected_by = auth.uid(), rejected_at = now(),
    updated_at = now()
  where id = p_request_id
  returning * into v_row;

  insert into public.payroll_push_approvals (request_id, action, actor_id, actor_name, actor_email, actor_role, reason)
  values (p_request_id, 'reject', auth.uid(), v_actor_name, v_row.sender_email, public.current_role(), p_reason);

  perform public.payroll_push_event(p_request_id, 'REJECTED', v_actor_name, jsonb_build_object('reason', p_reason));
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_REJECTED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
          format('Payroll push for %s rejected: %s', v_row.period_label, p_reason), 'warning');

  perform public.payroll_push_notify_sender(p_request_id, 'Payroll request returned for correction',
    format('Your payroll push for %s was returned: %s', v_row.period_label, p_reason));

  return v_row;
end; $$;




-- Queue the approved request to the BankOne integration outbound queue.
-- Idempotent: an already-queued/sent request is returned unchanged. When the
-- integration is not configured it records the state and NEVER pretends the
-- payment was sent.
create or replace function public.send_payroll_push_to_bankone(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text;
  v_row public.payroll_push_requests;
  v_env text;
  v_state text;
  v_ref text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to send payroll to BankOne';
  end if;

  select * into v_row from public.payroll_push_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;

  -- Idempotency: never submit twice.
  if v_row.api_status in ('queued', 'sent') then
    return jsonb_build_object('ok', true, 'idempotent', true, 'api_status', v_row.api_status,
                              'reference', v_row.bankone_reference);
  end if;
  if v_row.status <> 'approved' then
    raise exception 'Only an approved request can be sent to BankOne (status "%").', v_row.status;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select environment, case when enabled then environment else null end
  into v_env, v_state
  from public.integration_connections
  where provider = 'bankone' and enabled = true
  order by (environment = 'live') desc, updated_at desc nulls last
  limit 1;

  if v_env is null then
    update public.payroll_push_requests
    set api_status = 'not_configured', bankone_environment = 'not_configured',
        api_response = jsonb_build_object('state', 'NOT_CONFIGURED'),
        updated_at = now()
    where id = p_request_id;
    perform public.payroll_push_event(p_request_id, 'BANKONE_NOT_CONFIGURED', v_actor_name, '{}'::jsonb);
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('PAYROLL_PUSH_NOT_CONFIGURED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
            'BankOne API is not configured; nothing was sent.', 'warning');
    return jsonb_build_object('ok', false, 'state', 'NOT_CONFIGURED',
                              'message', 'BankOne API is not configured. Approval and export remain available; nothing was sent.');
  end if;

  v_ref := 'PUSH-' || v_row.period_label || '-' || substr(p_request_id::text, 1, 8);

  -- Reuse the Phase 15 outbound queue (existing BankOne integration architecture).
  insert into public.integration_outbound_queue (
    provider, environment, event_type, entity_reference, payload, created_by, status
  ) values (
    'bankone', v_env, 'payroll_disbursement', p_request_id::text,
    jsonb_build_object(
      'request_id', p_request_id,
      'period_label', v_row.period_label,
      'employee_count', v_row.employee_count,
      'total_payroll', v_row.total_payroll,
      'mid_month_total', v_row.mid_month_total,
      'month_end_total', v_row.month_end_total,
      'currency', v_row.currency,
      'reference', v_ref
    ),
    auth.uid(), 'queued'
  );

  update public.payroll_push_requests set
    status = 'sent_to_bankone',
    api_status = 'queued',
    api_requested_at = now(),
    bankone_environment = v_env,
    bankone_reference = v_ref,
    updated_at = now()
  where id = p_request_id
  returning * into v_row;

  insert into public.payroll_push_approvals (request_id, action, actor_id, actor_name, actor_role)
  values (p_request_id, 'send', auth.uid(), v_actor_name, public.current_role());

  perform public.payroll_push_event(p_request_id, 'QUEUED_TO_BANKONE', v_actor_name,
    jsonb_build_object('environment', v_env, 'reference', v_ref));

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_QUEUED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
          format('Payroll push for %s queued to BankOne (%s), ref %s', v_row.period_label, v_env, v_ref), 'info');

  perform public.payroll_push_notify_sender(p_request_id, 'Payroll queued to BankOne',
    format('Payroll push for %s was queued to BankOne (%s).', v_row.period_label, v_env));

  return jsonb_build_object('ok', true, 'state', 'QUEUED', 'environment', v_env, 'reference', v_ref);
end; $$;





-- ============================================================
-- 4a. list_payroll_master — surface the manual outcome overrides
--     (recreated: gross/net/mid/end prefer the manual override)
-- ============================================================
create or replace function public.list_payroll_master()
returns table (
  employee_id uuid,
  employee_name text,
  employee_code text,
  department text,
  "position" text,
  branch text,
  bank_name text,
  account_name text,
  account_number text,
  bank_sort_code text,
  salary numeric,
  allowances numeric,
  gross numeric,
  deductions_total numeric,
  tax_paye numeric,
  pension numeric,
  other_deductions numeric,
  net numeric,
  mid_month numeric,
  end_month numeric,
  has_compensation boolean,
  employment_status text,
  effective_date date,
  bankone_employee_number text,
  payroll_eligible boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_ratio numeric := 0.5;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to view the payroll master';
  end if;

  select coalesce((config ->> 'mid_month_ratio')::numeric, 0.5) into v_ratio
  from public.payroll_config where id = 1;

  return query
  with comp as (
    select
      p.employee_id,
      coalesce(sum(case when p.snapshot ->> 'component_type' = 'allowance' then p.amount else 0 end), 0) as allowances,
      coalesce(sum(case when p.snapshot ->> 'component_type' <> 'allowance' then p.amount else 0 end), 0) as component_deductions,
      bool_or(p.active) as has_packages
    from public.employee_salary_packages p
    where p.active
    group by p.employee_id
  ),
  snap as (
    select distinct on (s.employee_id)
      s.employee_id, s.basic_monthly, s.allowances_total, s.gross_monthly,
      s.deductions_total, s.tax_paye, s.pension, s.other_deductions,
      s.net_monthly, s.mid_month, s.end_month
    from public.employee_salary_snapshots s
    where s.period_label = 'CURRENT'
    order by s.employee_id, s.calc_timestamp desc
  )
  select
    e.id,
    e.full_name,
    coalesce(e.employee_code, e.employee_number, e.staff_id),
    e.department, e.position, e.branch,
    e.bank_name, e.account_name, e.account_number, e.bank_sort_code,
    coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) as salary,
    coalesce(sn.allowances_total, c.allowances, e.allowances, 0) as allowances,
    coalesce(e.payroll_gross_override, sn.gross_monthly,
      coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0)) as gross,
    coalesce(sn.deductions_total,
      coalesce(sn.tax_paye, 0) + coalesce(sn.pension, 0) + coalesce(sn.other_deductions, 0) + coalesce(c.component_deductions, 0)) as deductions_total,
    coalesce(sn.tax_paye, 0) as tax_paye,
    coalesce(sn.pension, 0) as pension,
    coalesce(sn.other_deductions, 0) as other_deductions,
    coalesce(e.payroll_net_override, sn.net_monthly,
      greatest(0, coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) as net,
    coalesce(e.payroll_mid_override, sn.mid_month,
      round(greatest(0, coalesce(e.payroll_net_override, sn.net_monthly,
        coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) * v_ratio, 2)) as mid_month,
    coalesce(e.payroll_end_override, sn.end_month,
      greatest(0, coalesce(e.payroll_net_override, sn.net_monthly,
        coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))
        - round(greatest(0, coalesce(sn.net_monthly,
          coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
          - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) * v_ratio, 2))) as end_month,
    (coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) > 0
     or coalesce(c.has_packages, false)
     or coalesce(c.allowances, 0) > 0) as has_compensation,
    e.employment_status,
    e.hire_date,
    bi.bankone_employee_number,
    (e.employment_status = 'active' and e.account_number is not null and e.bank_name is not null)
  from public.employees e
  left join comp c on c.employee_id = e.id
  left join snap sn on sn.employee_id = e.id
  left join public.employee_bankone_identifiers bi on bi.employee_id = e.id
  where e.employment_status in ('active', 'probation', 'on_leave')
  order by e.full_name;
end; $$;




-- ============================================================
-- 2. CANONICAL AUTHORIZATION FUNCTIONS
--    canTerminateEmployee(userId) == current_role() in
--                   ('super_admin', 'head_of_human_resources')
-- ============================================================
create or replace function public.can_terminate_employee()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'head_of_human_resources');
$$;




-- Archive is a sensitive employee-lifecycle action, so it inherits the
-- SAME restricted authorization as termination.
create or replace function public.can_archive_employee()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'head_of_human_resources');
$$;




-- No INSERT/UPDATE/DELETE policies: writes happen ONLY inside the
-- SECURITY DEFINER RPCs below, which re-verify the actor role.

-- ============================================================
-- 4. terminate_employee RPC  (SUPER_ADMIN / HR_MANAGER ONLY)
--
-- Security hierarchy enforced inside this one atomic function:
--   authenticated session (auth.uid)
--     -> InfinityCore profile (public.current_role)
--       -> role is exactly 'super_admin' OR 'head_of_human_resources'
--         -> employee update + history + audit
--
-- NO actor parameters are accepted. The actor is ALWAYS derived from
-- the session. The LLM / browser / API can never claim authorization.
-- ============================================================
create or replace function public.terminate_employee(
  p_employee_id uuid,
  p_effective_date date default current_date,
  p_reason text default '',
  p_hr_notes text default null,
  p_rehire_eligible boolean default true,
  p_source text default 'ui'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
begin
  if v_actor_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_actor_role not in ('super_admin', 'head_of_human_resources') then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_termination_denied', 'Employee', p_employee_id::text,
      coalesce((select full_name from public.profiles where id = v_actor_id), 'user'),
      format('Termination attempt blocked: role %s is not authorized to terminate employees.', v_actor_role),
      'high'
    );
    raise exception 'Your role is not authorized to terminate employees.';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;
  if v_emp.employment_status = 'terminated' then
    raise exception 'Employee is already terminated.';
  end if;
  if p_effective_date is null then
    raise exception 'A termination effective date is required.';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A termination reason is required.';
  end if;
  if p_effective_date < coalesce(v_emp.hire_date, p_effective_date) then
    raise exception 'Termination effective date cannot precede the hire date.';
  end if;

  select full_name into v_actor_name from public.profiles where id = v_actor_id;

  -- Preserve the previous employment status for audit + history.
  insert into public.employee_employment_history (
    employee_id, previous_status, new_status, changed_by, actor_role, reason, source
  ) values (
    v_emp.id, v_emp.employment_status, 'terminated', v_actor_id, v_actor_role, p_reason,
    coalesce(nullif(p_source, ''), 'ui')
  );

  update public.employees set
    employment_status = 'terminated',
    previous_employment_status = v_emp.employment_status,
    terminated_at = now(),
    termination_effective_date = p_effective_date,
    termination_reason = p_reason,
    termination_hr_notes = p_hr_notes,
    rehire_eligible = coalesce(p_rehire_eligible, true),
    updated_at = now()
  where id = v_emp.id;

  insert into public.employee_termination_records (
    employee_id, employee_name, employee_code, staff_id, department, position,
    branch, hire_date, previous_employment_status, new_employment_status,
    termination_effective_date, termination_reason, hr_notes, rehire_eligible,
    actor_user_id, actor_role, actor_name, source
  ) values (
    v_emp.id, v_emp.full_name, coalesce(v_emp.employee_code, v_emp.employee_number),
    v_emp.staff_id, v_emp.department, v_emp.position, v_emp.branch, v_emp.hire_date,
    v_emp.employment_status, 'terminated', p_effective_date, p_reason, p_hr_notes,
    coalesce(p_rehire_eligible, true), v_actor_id, v_actor_role, v_actor_name,
    coalesce(nullif(p_source, ''), 'ui')
  );

  -- Immutable audit record. Actor selection is handled here, never by
  -- the caller, so the actor role is always trustworthy.
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'employee_terminated', 'Employee', v_emp.id::text, v_actor_name,
    jsonb_build_object(
      'actor_user_id', v_actor_id,
      'actor_role', v_actor_role,
      'actor_name', v_actor_name,
      'employee_id', v_emp.id,
      'employee_name', v_emp.full_name,
      'previous_employment_status', v_emp.employment_status,
      'new_employment_status', 'terminated',
      'termination_effective_date', p_effective_date,
      'termination_reason', p_reason,
      'hr_notes', p_hr_notes,
      'rehire_eligible', coalesce(p_rehire_eligible, true),
      'source', coalesce(nullif(p_source, ''), 'ui')
    )::text,
    'high'
  );

  return jsonb_build_object(
    'ok', true,
    'employee_id', v_emp.id,
    'employee_name', v_emp.full_name,
    'previous_employment_status', v_emp.employment_status,
    'new_employment_status', 'terminated',
    'termination_effective_date', p_effective_date,
    'actor_role', v_actor_role
  );
end; $$;




-- ============================================================
-- 5. archive_employee RPC  (SUPER_ADMIN / HR_MANAGER ONLY)
--
-- Archive hides/inactivates the employee while preserving full
-- history. Share the SAME restricted authorization as termination.
-- p_restore = true brings an archived employee back.
-- ============================================================
create or replace function public.archive_employee(
  p_employee_id uuid,
  p_reason text default '',
  p_restore boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
begin
  if v_actor_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_actor_role not in ('super_admin', 'head_of_human_resources') then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_archive_denied', 'Employee', p_employee_id::text,
      coalesce((select full_name from public.profiles where id = v_actor_id), 'user'),
      format('Archive attempt blocked: role %s is not authorized to archive employees.', v_actor_role),
      'high'
    );
    raise exception 'Your role is not authorized to archive employees.';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;

  select full_name into v_actor_name from public.profiles where id = v_actor_id;

  if p_restore then
    if not coalesce(v_emp.is_archived, false) then
      raise exception 'Employee is not archived.';
    end if;
    update public.employees set
      is_archived = false,
      archived_at = null,
      archive_reason = null,
      archive_actor = null,
      updated_at = now()
    where id = v_emp.id;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_restored_from_archive', 'Employee', v_emp.id::text, v_actor_name,
      jsonb_build_object('actor_user_id', v_actor_id, 'actor_role', v_actor_role,
                         'employee_name', v_emp.full_name)::text,
      'info'
    );
    return jsonb_build_object('ok', true, 'employee_id', v_emp.id, 'employee_name', v_emp.full_name, 'restored', true);
  end if;

  update public.employees set
    is_archived = true,
    archived_at = now(),
    archive_reason = p_reason,
    archive_actor = v_actor_id,
    updated_at = now()
  where id = v_emp.id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'employee_archived', 'Employee', v_emp.id::text, v_actor_name,
    jsonb_build_object('actor_user_id', v_actor_id, 'actor_role', v_actor_role,
                       'employee_name', v_emp.full_name, 'archive_reason', p_reason)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'employee_id', v_emp.id, 'employee_name', v_emp.full_name, 'archived', true, 'actor_role', v_actor_role);
end; $$;




-- ============================================================
-- 6. HARD GUARD TRIGGER on employees
--
-- Any write that moves an employee towards termination/archive is
-- rejected unless the authenticated actor is super_admin or
-- head_of_human_resources. This covers direct RLS updates, the HR-fields RPC, and
-- every other future write path — a SINGLE authoritative gate.
-- ============================================================
create or replace function public.employees_termination_guard()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
begin
  if (new.employment_status = 'terminated' and old.employment_status is distinct from 'terminated')
     or (new.terminated_at is distinct from old.terminated_at)
     or (new.termination_effective_date is distinct from old.termination_effective_date)
     or (new.termination_reason is distinct from old.termination_reason)
     or (new.termination_hr_notes is distinct from old.termination_hr_notes)
     or (new.previous_employment_status is distinct from old.previous_employment_status)
     or (new.rehire_eligible is distinct from old.rehire_eligible)
     or (new.is_archived is distinct from old.is_archived)
     or (new.archived_at is distinct from old.archived_at)
     or (new.archive_reason is distinct from old.archive_reason)
     or (new.archive_actor is distinct from old.archive_actor)
  then
    if v_actor_role not in ('super_admin', 'head_of_human_resources') then
      raise exception 'Your role is not authorized to terminate employees.';
    end if;
  end if;
  return new;
end; $$;




-- ------------------------------------------------------------
-- 2. delete_employee SECURITY DEFINER RPC
--    Actor role re-verified server-side; NEVER trusts a client role.
--    Decommissions the employee end-to-end:
--      archive (history-preserving) + cancel open payroll +
--      drop from active roster + deactivate the linked platform login.
-- ------------------------------------------------------------
create or replace function public.delete_employee(
  p_employee_id uuid,
  p_reason text default ''
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
  v_target_role text;
  v_prev_status text;
  v_payroll_cancelled int := 0;
  v_platform_deactivated boolean := false;
begin
  if v_actor_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_actor_role not in ('super_admin', 'head_of_human_resources') then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_delete_denied', 'Employee', p_employee_id::text,
      coalesce((select full_name from public.profiles where id = v_actor_id), 'user'),
      format('Delete attempt blocked: role %s is not authorized to delete employees.', v_actor_role),
      'high'
    );
    raise exception 'Your role is not authorized to delete employees.';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;
  if coalesce(v_emp.is_archived, false) then
    raise exception 'Employee is already deleted (archived).';
  end if;

  -- Self-delete guard: an HR manager/super_admin must never be able to
  -- decommission their own employee record (self-lockout).
  if v_emp.user_id is not null and v_emp.user_id = v_actor_id then
    raise exception 'You cannot delete your own employee record.';
  end if;

  -- Super Admin protection: an employee whose linked login is a
  -- super_admin account can NEVER be deleted (server-enforced).
  if v_emp.user_id is not null then
    select role into v_target_role from public.profiles where id = v_emp.user_id;
    if v_target_role = 'super_admin' then
      insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
      values (
        'employee_delete_superadmin_blocked', 'Employee', v_emp.id::text,
        coalesce((select full_name from public.profiles where id = v_actor_id), 'user'),
        format('Delete of %s blocked: the linked account is a Super Admin and is protected.', v_emp.full_name),
        'high'
      );
      raise exception 'Super Admin accounts are protected and cannot be deleted.';
    end if;
  end if;

  select full_name into v_actor_name from public.profiles where id = v_actor_id;

  -- 1. REMOVE FROM PAYROLL — cancel any not-yet-paid rows. 'paid' rows
  --    stay for reconciliation history.
  if to_regclass('public.payroll') is not null then
    update public.payroll set
      status = 'cancelled',
      updated_at = now()
    where employee_id = v_emp.id
      and status in ('draft', 'pending', 'approved', 'processed');
    get diagnostics v_payroll_cancelled = row_count;
  end if;

  -- 2. History transition + drop from the active roster / payroll master.
  insert into public.employee_employment_history (
    employee_id, previous_status, new_status, changed_by, actor_role, reason, source
  ) values (
    v_emp.id, v_emp.employment_status, 'terminated', v_actor_id, v_actor_role,
    coalesce(nullif(p_reason, ''), 'Deleted via employee action menu'), 'delete'
  );

  update public.employees set
    employment_status = 'terminated',
    previous_employment_status = v_emp.employment_status,
    terminated_at = now(),
    termination_effective_date = current_date,
    termination_reason = coalesce(nullif(p_reason, ''), 'Deleted via employee action menu'),
    termination_hr_notes = null,
    is_archived = true,
    archived_at = now(),
    archive_reason = coalesce(nullif(p_reason, ''), 'Deleted via employee action menu'),
    archive_actor = v_actor_id,
    updated_at = now()
  where id = v_emp.id;

  -- 3. REMOVE FROM THE PLATFORM — deactivate the linked login so the
  --    person can no longer access InfinityCore. Reversible by an admin
  --    (activate_user / restore). Skipped when no login is linked.
  if v_emp.user_id is not null then
    select status into v_prev_status from public.profiles where id = v_emp.user_id;
    if v_prev_status is not null and v_prev_status <> 'suspended' then
      update public.profiles set
        status = 'suspended',
        rejected_reason = format('Employee deleted from the platform (%s)', coalesce(nullif(p_reason, ''), 'no reason'))
      where id = v_emp.user_id;
      v_platform_deactivated := true;

      if to_regclass('public.user_approval_audit') is not null then
        insert into public.user_approval_audit (
          user_id, action, previous_status, new_status,
          approver_id, approver_name, reason
        ) values (
          v_emp.user_id, 'USER_SUSPENDED', v_prev_status, 'suspended',
          v_actor_id, v_actor_name,
          format('Employee deleted from the platform (%s)', coalesce(nullif(p_reason, ''), 'no reason'))
        );
      end if;
    end if;
  end if;

  -- 4. Immutable audit record. Actor selection is handled here, never by
  --    the caller, so the actor role is always trustworthy.
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'employee_deleted', 'Employee', v_emp.id::text, v_actor_name,
    jsonb_build_object(
      'actor_user_id', v_actor_id,
      'actor_role', v_actor_role,
      'actor_name', v_actor_name,
      'employee_id', v_emp.id,
      'employee_name', v_emp.full_name,
      'previous_employment_status', v_emp.employment_status,
      'new_employment_status', 'terminated',
      'is_archived', true,
      'payroll_rows_cancelled', v_payroll_cancelled,
      'platform_access_deactivated', v_platform_deactivated,
      'reason', coalesce(nullif(p_reason, ''), 'not provided'),
      'source', 'ui'
    )::text,
    'high'
  );

  return jsonb_build_object(
    'ok', true,
    'employee_id', v_emp.id,
    'employee_name', v_emp.full_name,
    'deleted', true,
    'archived', true,
    'last_employment_status', v_emp.employment_status,
    'payroll_rows_cancelled', v_payroll_cancelled,
    'platform_access_deactivated', v_platform_deactivated,
    'actor_role', v_actor_role
  );
end; $$;




-- ============================================================
-- 1. AUTHZ HELPERS (security definer so RLS can call them without
--    recursion; stable so they can be used in SELECT policies)
-- ============================================================

create or replace function public.is_communication_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  );
$$;




-- 5c. can_author_announcement — management class now includes all head roles.
create or replace function public.can_author_announcement()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
                   'branch_manager', 'area_manager', 'head_of_operations',
                   'head_of_business', 'head_of_e_business', 'financial_controller',
                   'head_of_risk_compliance', 'head_of_legal', 'head_of_audit')
  );
$$;




-- ------------------------------------------------------------
-- 9. AUTO-CHANNEL MEMBERSHIP — management bucket includes head roles
-- ------------------------------------------------------------
create or replace function public.sync_auto_channel_members(p_channel_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_channel record;
  v_qualifying uuid[] := '{}';
  v_added int := 0;
  v_removed int := 0;
  v_total int := 0;
begin
  select * into v_channel from public.message_channels where id = p_channel_id;
  if v_channel.id is null then raise exception 'Channel not found'; end if;
  if not v_channel.is_auto then raise exception 'Channel is not an auto channel'; end if;
  v_me := coalesce(v_me, v_channel.creator_id);

  -- Recompute the set of user ids that currently qualify for this channel.
  if v_channel.auto_source = 'branch' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    where e.branch_id = v_channel.auto_source_id
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'area' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    join public.branch_area_assignments ba
      on ba.branch_id = e.branch_id and ba.is_current
    where ba.area_id = v_channel.auto_source_id
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'department' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    where public.employee_matches_department_channel(e.id, v_channel.auto_source_role)
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'role' then
    if v_channel.auto_source_role = 'all' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.status = 'active' and p.role <> 'customer';
    elsif v_channel.auto_source_role = 'management' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('super_admin', 'admin', 'head_of_business', 'head_of_operations',
                       'head_of_e_business', 'financial_controller',
                       'head_of_risk_compliance', 'head_of_legal', 'head_of_audit',
                       'branch_manager', 'area_manager')
        and p.status = 'active';
    elsif v_channel.auto_source_role = 'executive' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('super_admin', 'admin', 'head_of_business')
        and p.status = 'active';
    elsif v_channel.auto_source_role = 'hr' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('head_of_human_resources', 'hr_officer', 'super_admin', 'admin')
        and p.status = 'active';
    else
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role = v_channel.auto_source_role and p.status = 'active';
    end if;
  end if;

  -- Insert everyone who qualifies (as automatic members).
  insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
  select p_channel_id, q.uid, 'member', coalesce(v_me, v_channel.creator_id), true
  from unnest(v_qualifying) as q(uid)
  where not exists (
    select 1 from public.message_channel_members cm
    where cm.channel_id = p_channel_id and cm.member_id = q.uid
  );
  get diagnostics v_added = row_count;

  -- Remove memberships that no longer qualify — ONLY automatic ones
  -- (auto_added = true). Manual memberships and the owner row survive.
  delete from public.message_channel_members cm
  where cm.channel_id = p_channel_id
    and cm.auto_added = true
    and cm.member_id <> all(v_qualifying);
  get diagnostics v_removed = row_count;

  select count(*) into v_total
  from public.message_channel_members where channel_id = p_channel_id;

  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_members_synced', null,
    null, jsonb_build_object('member_count', v_total, 'added', v_added, 'removed', v_removed),
    'auto membership sync'
  );

  return jsonb_build_object(
    'ok', true, 'channel_id', p_channel_id,
    'member_count', v_total, 'added', v_added, 'removed', v_removed
  );
end; $$;




-- ============================================================
-- 9. ACCESS HELPERS
-- ============================================================
create or replace function public.is_medical_hr()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer');
$$;



-- Writes via RPC only.

-- ============================================================
-- 11. RPC: create_medical_referral (HR only)
--     The raw token is generated client-side; only its md5 hash arrives.
-- ============================================================
create or replace function public.create_medical_referral(
  p_token_hash text,
  p_candidate_id uuid default null,
  p_employee_id uuid default null,
  p_subject_name text default null,
  p_subject_identifier text default null,
  p_subject_position text default null,
  p_subject_department text default null,
  p_subject_branch text default null,
  p_screening_type text default 'pre_employment',
  p_other_screening_type text default null,
  p_hospital_id uuid default null,
  p_hospital_name text default null,
  p_expires_at timestamptz default null,
  p_notes text default null,
  p_status text default 'issued'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_subject_name text;
  v_subject_identifier text;
  v_subject_position text;
  v_subject_department text;
  v_subject_branch text;
  v_candidate record;
  v_employee record;
  v_referral_id uuid;
  v_reference text;
  v_hospital text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to create medical referrals';
  end if;
  if nullif(p_token_hash, '') is null then
    raise exception 'A secure referral token is required.';
  end if;
  if p_candidate_id is null and p_employee_id is null then
    raise exception 'A candidate or employee is required.';
  end if;
  if p_status not in ('draft', 'issued') then
    raise exception 'Invalid initial referral status.';
  end if;
  if p_screening_type not in ('pre_employment', 'periodic', 'fitness_for_work', 'medical_screening', 'other') then
    raise exception 'Invalid screening type.';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  -- Resolve subject from the employee record first, then the candidate record.
  if p_employee_id is not null then
    select * into v_employee from public.employees where id = p_employee_id;
    if v_employee.id is null then
      raise exception 'Employee record not found.';
    end if;
    v_subject_name := coalesce(nullif(p_subject_name, ''), v_employee.full_name);
    v_subject_identifier := coalesce(nullif(p_subject_identifier, ''),
      nullif(v_employee.employee_number, ''), nullif(v_employee.staff_id, ''),
      nullif(v_employee.employee_code, ''), 'EMP-' || upper(substr(replace(v_employee.id::text, '-', ''), 1, 8)));
    v_subject_position := coalesce(p_subject_position, v_employee."position");
    v_subject_department := coalesce(p_subject_department, v_employee.department);
    v_subject_branch := coalesce(p_subject_branch, v_employee.branch);
  end if;

  if p_candidate_id is not null and v_subject_name is null then
    select c.*, j.job_title, j.department as job_department
      into v_candidate
      from public.hr_candidates c
      left join public.hr_jobs j on j.id = c.job_id
      where c.id = p_candidate_id;
    if v_candidate.id is null then
      raise exception 'Candidate record not found.';
    end if;
    v_subject_name := nullif(p_subject_name, '');
    if v_subject_name is null then
      v_subject_name := v_candidate.full_name;
    end if;
    v_subject_identifier := coalesce(nullif(p_subject_identifier, ''),
      'CAN-' || upper(substr(replace(v_candidate.id::text, '-', ''), 1, 8)));
    v_subject_position := coalesce(nullif(p_subject_position, ''), v_candidate.job_title);
    v_subject_department := coalesce(nullif(p_subject_department, ''), v_candidate.job_department);
  end if;

  if v_subject_name is null then
    raise exception 'Subject name could not be resolved.';
  end if;

  select name into v_hospital from public.hospital_providers where id = p_hospital_id;

  insert into public.medical_referrals (
    referral_token_hash, candidate_id, employee_id,
    hiring_route,
    subject_name, subject_identifier, subject_position, subject_department, subject_branch,
    screening_type, other_screening_type,
    hospital_id, hospital_name,
    referring_hr_user_id, referring_hr_name,
    status, issued_at, issued_by, expires_at, notes
  ) values (
    p_token_hash, p_candidate_id, p_employee_id,
    case when p_employee_id is not null then 'employee' else 'candidate' end,
    v_subject_name, v_subject_identifier, v_subject_position, v_subject_department, v_subject_branch,
    p_screening_type, nullif(p_other_screening_type, ''),
    p_hospital_id, coalesce(nullif(p_hospital_name, ''), v_hospital),
    auth.uid(), coalesce(v_actor_name, 'Human Resources'),
    p_status, coalesce(now(), now()), auth.uid(), p_expires_at, p_notes
  )
  returning id, reference into v_referral_id, v_reference;

  insert into public.medical_screening_events (referral_id, event_type, details, actor, actor_id)
  values (v_referral_id, 'REFERRAL_CREATED',
    format('Medical referral %s created for %s (%s)', v_reference, v_subject_name, v_subject_identifier),
    v_actor_name, auth.uid());

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_REFERRAL_CREATED', 'MedicalReferral', v_referral_id::text, v_actor_name,
    format('Medical referral %s created for %s', v_reference, v_subject_name), 'info');

  return jsonb_build_object(
    'ok', true,
    'referral_id', v_referral_id,
    'reference', v_reference,
    'status', p_status,
    'subject_name', v_subject_name,
    'subject_identifier', v_subject_identifier,
    'subject_position', v_subject_position,
    'subject_department', v_subject_department,
    'subject_branch', v_subject_branch,
    'hospital_name', coalesce(nullif(p_hospital_name, ''), v_hospital),
    'issued_at', now() at time zone 'utc',
    'expires_at', p_expires_at
  );
end; $$;




-- ============================================================
-- 12. RPC: get_medical_referral_details (PUBLIC / token-scoped)
--     Minimum-data disclosure. No BVN, NIN, identifiers, results,
--     document paths, or database IDs beyond the referral id.
--     First open moves issued → qr_opened and logs the scan.
-- ============================================================
create or replace function public.get_medical_referral_details(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_ref record;
  v_lab jsonb;
  v_form jsonb;
  v_already boolean := false;
  v_status text;
begin
  select * into v_ref from public.medical_referrals where referral_token_hash = v_hash;
  if v_ref.id is null then
    raise exception 'Invalid or unrecognized medical screening referral.';
  end if;
  if v_ref.status = 'revoked' then
    raise exception 'This medical screening referral has been revoked. Contact Human Resources for a new referral.';
  end if;
  if v_ref.expires_at is not null and v_ref.expires_at < now() then
    raise exception 'This medical screening referral has expired. Contact Human Resources for a new referral.';
  end if;

  if v_ref.status in ('submitted', 'under_review', 'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared') then
    v_already := true;
    v_status := v_ref.status;
  else
    if v_ref.status = 'issued' then
      update public.medical_referrals set status = 'qr_opened', opened_at = now(), updated_at = now()
      where id = v_ref.id and status = 'issued';
      v_status := 'qr_opened';
      insert into public.medical_screening_events (referral_id, event_type, details, actor)
      values (v_ref.id, 'REFERRAL_OPENED',
        format('Referral %s QR opened', v_ref.reference), 'Hospital / unauthenticated');
      insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
      values ('MEDICAL_QR_OPENED', 'MedicalReferral', v_ref.id::text, 'Hospital / unauthenticated',
        format('QR code opened for referral %s', v_ref.reference), 'info');
      insert into public.notifications (user_id, title, message, type, link)
      select id, 'Medical screening QR opened',
        format('The QR card for %s (%s) has been opened at a medical facility.', v_ref.subject_name, v_ref.reference),
        'medical', '/medical-management'
      from public.profiles where role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer');
    else
      v_status := v_ref.status;
    end if;
  end if;

  select config_value into v_lab from public.medical_screening_config where config_key = 'lab_tests';
  select config_value into v_form from public.medical_screening_config where config_key = 'form_config';

  return jsonb_build_object(
    'id', v_ref.id,
    'reference', v_ref.reference,
    'subject_name', v_ref.subject_name,
    'subject_identifier', v_ref.subject_identifier,
    'subject_position', v_ref.subject_position,
    'subject_department', v_ref.subject_department,
    'screening_type', v_ref.screening_type,
    'other_screening_type', v_ref.other_screening_type,
    'status', v_status,
    'already_submitted', v_already,
    'hospital_name', v_ref.hospital_name,
    'expires_at', v_ref.expires_at,
    'lab_tests', coalesce(v_lab, '[]'::jsonb),
    'form_config', coalesce(v_form, '{}'::jsonb)
  );
end; $$;




-- ============================================================
-- 13. RPC: submit_medical_screening (PUBLIC / token + single-use)
--     Validates the referral, creates the IMMUTABLE screening version 1,
--     links documents (path-prefix checked against the token namespace),
--     moves the referral to submitted, notifies HR, audits.
-- ============================================================
create or replace function public.submit_medical_screening(p_token text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_ref record;
  v_screening_id uuid;
  v_doc record;
  v_req text;
  v_count int := 0;
  v_hr_id uuid;
  v_outcome text;
  v_sig text;
  v_officer text;
begin
  select * into v_ref from public.medical_referrals where referral_token_hash = v_hash for update;
  if v_ref.id is null then
    raise exception 'Invalid or unrecognized medical screening referral.';
  end if;
  if v_ref.status = 'revoked' then
    raise exception 'This medical screening referral has been revoked.';
  end if;
  if v_ref.expires_at is not null and v_ref.expires_at < now() then
    raise exception 'This medical screening referral has expired. Contact Human Resources for a new referral.';
  end if;
  if v_ref.status in ('submitted', 'under_review', 'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared') then
    raise exception 'This screening has already been submitted. A new referral is required for re-screening.';
  end if;

  v_officer := nullif(p_payload ->> 'medical_officer', '');
  if v_officer is null then
    raise exception 'Medical officer name is required.';
  end if;
  v_outcome := p_payload ->> 'outcome';
  if v_outcome not in ('fit_for_work', 'fit_with_restrictions', 'further_review', 'not_cleared', 'pending') then
    raise exception 'A valid final outcome is required (fit_for_work, fit_with_restrictions, further_review, not_cleared or pending).';
  end if;
  v_sig := nullif(p_payload ->> 'signature_data', '');
  if v_sig is null then
    raise exception 'The medical officer signature is required.';
  end if;

  insert into public.medical_screenings (
    referral_id, candidate_id, employee_id,
    screening_type, other_screening_type,
    hospital_name, hospital_id,
    medical_officer, screening_date,
    results, outcome, outcome_notes,
    signature_data, signature_date,
    version, submitted_by_actor, submitted_at
  ) values (
    v_ref.id, v_ref.candidate_id, v_ref.employee_id,
    v_ref.screening_type, v_ref.other_screening_type,
    coalesce(nullif(p_payload ->> 'hospital_name', ''), v_ref.hospital_name),
    v_ref.hospital_id,
    v_officer, nullif(p_payload ->> 'screening_date', '')::date,
    coalesce(p_payload -> 'results', '{}'::jsonb),
    v_outcome, p_payload ->> 'outcome_notes',
    v_sig, now(),
    1, 'HOSPITAL_PORTAL', now()
  )
  returning id into v_screening_id;

  -- Documents — only accept paths scoped to this referral's token namespace.
  if p_payload ? 'documents' and jsonb_typeof(p_payload -> 'documents') = 'array' then
    v_req := 'medical/' || v_hash || '/';
    for v_doc in select * from jsonb_array_elements(p_payload -> 'documents')
    loop
      if position(v_req in coalesce(v_doc.value ->> 'file_path', '')) = 1 then
        insert into public.medical_documents (
          screening_id, referral_id, document_type, file_name, file_path, file_size, mime_type, status
        ) values (
          v_screening_id, v_ref.id,
          coalesce(v_doc.value ->> 'document_type', 'other'),
          v_doc.value ->> 'file_name',
          v_doc.value ->> 'file_path',
          nullif(v_doc.value ->> 'file_size', '')::int,
          v_doc.value ->> 'mime_type',
          'pending'
        );
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  update public.medical_referrals
    set status = 'submitted', submitted_at = now(), updated_at = now()
  where id = v_ref.id;

  insert into public.medical_screening_events (referral_id, screening_id, event_type, details, actor)
  values (v_ref.id, v_screening_id, 'SCREENING_SUBMITTED',
    format('Screening submitted by %s (%s documents attached)', v_officer, v_count),
    v_officer);

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_SCREENING_SUBMITTED', 'MedicalScreening', v_screening_id::text, v_officer,
    format('Medical screening %s submitted by %s', v_ref.reference, v_officer), 'info');

  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  loop
    insert into public.notifications (user_id, title, message, type, link)
    values (v_hr_id, 'Medical screening submitted',
      format('A medical screening result for %s (%s) has been submitted and requires review.', v_ref.subject_name, v_ref.reference),
      'medical', '/medical-management');
  end loop;

  return jsonb_build_object('ok', true, 'screening_id', v_screening_id,
    'reference', v_ref.reference, 'documents', v_count);
end; $$;




-- ============================================================
-- 14. RPC: get_medical_screening_result (HR only)
--     Returns the referral + every immutable version + documents +
--     amendment requests + events for the review workbench.
-- ============================================================
create or replace function public.get_medical_screening_result(p_referral_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_ref record;
  v_screenings jsonb;
  v_documents jsonb;
  v_amendments jsonb;
  v_events jsonb;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to view medical results';
  end if;
  select * into v_ref from public.medical_referrals where id = p_referral_id;
  if v_ref.id is null then
    raise exception 'Referral not found.';
  end if;

  select coalesce(jsonb_agg(s order by s.version), '[]'::jsonb) into v_screenings
  from (select jsonb_build_object(
      'id', sc.id, 'version', sc.version, 'screening_date', sc.screening_date,
      'hospital_name', sc.hospital_name, 'medical_officer', sc.medical_officer,
      'outcome', sc.outcome, 'outcome_notes', sc.outcome_notes,
      'amends_screening_id', sc.amends_screening_id, 'amendment_reason', sc.amendment_reason,
      'amended_by', sc.amended_by, 'amended_at', sc.amended_at,
      'submitted_at', sc.submitted_at, 'results', sc.results, 'signature_data', sc.signature_data
    ) as s
    from public.medical_screenings sc
    where sc.referral_id = p_referral_id
  ) s;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'document_type', d.document_type, 'file_name', d.file_name,
      'file_path', d.file_path, 'mime_type', d.mime_type, 'status', d.status,
      'screening_id', d.screening_id, 'created_at', d.created_at
    )), '[]'::jsonb) into v_documents
  from public.medical_documents d
  where d.referral_id = p_referral_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'screening_id', a.screening_id, 'status', a.status,
      'reason', a.reason, 'requested_by_name', a.requested_by_name,
      'requested_at', a.requested_at, 'decision_notes', a.decision_notes,
      'decided_by', a.decided_by, 'decided_at', a.decided_at
    ) order by a.requested_at), '[]'::jsonb) into v_amendments
  from public.medical_screening_amendments a
  where a.screening_id in (select id from public.medical_screenings where referral_id = p_referral_id);

  select coalesce(jsonb_agg(jsonb_build_object(
      'event_type', e.event_type, 'details', e.details, 'actor', e.actor,
      'created_at', e.created_at
    ) order by e.created_at), '[]'::jsonb) into v_events
  from public.medical_screening_events e
  where e.referral_id = p_referral_id;

  return jsonb_build_object(
    'referral', jsonb_build_object(
      'id', v_ref.id, 'reference', v_ref.reference,
      'subject_name', v_ref.subject_name, 'subject_identifier', v_ref.subject_identifier,
      'subject_position', v_ref.subject_position, 'subject_department', v_ref.subject_department,
      'subject_branch', v_ref.subject_branch,
      'screening_type', v_ref.screening_type, 'other_screening_type', v_ref.other_screening_type,
      'candidate_id', v_ref.candidate_id, 'employee_id', v_ref.employee_id,
      'hospital_name', v_ref.hospital_name,
      'status', v_ref.status, 'issued_at', v_ref.issued_at, 'expires_at', v_ref.expires_at,
      'opened_at', v_ref.opened_at, 'submitted_at', v_ref.submitted_at,
      'revoked_at', v_ref.revoked_at, 'revoke_reason', v_ref.revoke_reason,
      'referring_hr_name', v_ref.referring_hr_name, 'notes', v_ref.notes
    ),
    'screenings', v_screenings,
    'documents', v_documents,
    'amendments', v_amendments,
    'events', v_events
  );
end; $$;




-- ============================================================
-- 15. RPC: set_medical_referral_status (HR review workflow)
-- ============================================================
create or replace function public.set_medical_referral_status(
  p_referral_id uuid,
  p_status text,
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_ref record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to update medical referrals';
  end if;
  if p_status not in ('issued', 'qr_opened', 'screening_started', 'submitted', 'under_review',
                      'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared', 'revoked') then
    raise exception 'Invalid referral status.';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();
  select * into v_ref from public.medical_referrals where id = p_referral_id;
  if v_ref.id is null then
    raise exception 'Referral not found.';
  end if;

  if p_status = 'revoked' then
    update public.medical_referrals
      set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(),
          revoke_reason = coalesce(p_note, revoke_reason), updated_at = now()
    where id = p_referral_id;
    insert into public.medical_screening_events (referral_id, event_type, details, actor, actor_id)
    values (p_referral_id, 'REFERRAL_REVOKED',
      format('Referral %s revoked: %s', v_ref.reference, coalesce(p_note, '')), v_actor_name, auth.uid());
  else
    update public.medical_referrals
      set status = p_status,
          started_at = case when p_status = 'screening_started' and started_at is null then now() else started_at end,
          updated_at = now()
    where id = p_referral_id;
    insert into public.medical_screening_events (referral_id, event_type, details, actor, actor_id)
    values (p_referral_id, 'STATUS_CHANGED',
      format('Referral status changed to %s. %s', p_status, coalesce(p_note, '')), v_actor_name, auth.uid());
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_REFERRAL_STATUS', 'MedicalReferral', p_referral_id::text, v_actor_name,
    format('Referral %s -> %s', v_ref.reference, p_status), 'info');

  return jsonb_build_object('ok', true, 'status', p_status);
end; $$;




-- ============================================================
-- 15b. RPC: extend_medical_referral_expiry (HR only)
--      Moves a referral's validity window forward (or clears it) without
--      touching any submitted results. Audited.
-- ============================================================
create or replace function public.extend_medical_referral_expiry(
  p_referral_id uuid,
  p_expires_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_ref record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to update medical referrals';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The new expiry date must be in the future.';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();
  select * into v_ref from public.medical_referrals where id = p_referral_id;
  if v_ref.id is null then
    raise exception 'Referral not found.';
  end if;
  if v_ref.status in ('cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared', 'revoked') then
    raise exception 'Completed or revoked referrals cannot be re-opened by extending expiry.';
  end if;

  update public.medical_referrals
    set expires_at = p_expires_at, updated_at = now()
  where id = p_referral_id;

  insert into public.medical_screening_events (referral_id, event_type, details, actor, actor_id)
  values (p_referral_id, 'EXPIRY_EXTENDED',
    format('Referral expiry extended to %s by %s', coalesce(p_expires_at::text, 'no expiry'), v_actor_name),
    v_actor_name, auth.uid());

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_REFERRAL_EXPIRY_EXTENDED', 'MedicalReferral', p_referral_id::text, v_actor_name,
    format('Referral %s expiry extended to %s', v_ref.reference, coalesce(p_expires_at::text, 'no expiry')), 'info');

  return jsonb_build_object('ok', true, 'expires_at', p_expires_at);
end; $$;




-- ============================================================
-- 16. RPC: request_medical_amendment (HR only)
--     Creates an audited correction request against an ORIGINAL result.
--     The original is never modified at this stage.
-- ============================================================
create or replace function public.request_medical_amendment(p_screening_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_scr record;
  v_amendment_id uuid;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to request medical amendments';
  end if;
  if nullif(p_reason, '') is null then
    raise exception 'An amendment reason is required.';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();
  select * into v_scr from public.medical_screenings where id = p_screening_id;
  if v_scr.id is null then
    raise exception 'Screening record not found.';
  end if;
  if v_scr.amends_screening_id is not null then
    raise exception 'Only the originating screening version can be amended.';
  end if;

  insert into public.medical_screening_amendments (screening_id, requested_by, requested_by_name, reason)
  values (p_screening_id, auth.uid(), v_actor_name, p_reason)
  returning id into v_amendment_id;

  insert into public.medical_screening_events (referral_id, screening_id, event_type, details, actor, actor_id)
  values (v_scr.referral_id, p_screening_id, 'CORRECTION_REQUESTED',
    format('Correction requested by %s: %s', v_actor_name, p_reason), v_actor_name, auth.uid());

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_AMENDMENT_REQUESTED', 'MedicalScreening', p_screening_id::text, v_actor_name,
    format('Correction requested for screening %s: %s', p_screening_id, p_reason), 'warning');

  return jsonb_build_object('ok', true, 'amendment_id', v_amendment_id);
end; $$;




-- ============================================================
-- 17. RPC: approve_medical_amendment (HR only)
--     Creates a NEW immutable version from the corrected payload. The
--     original row is untouched. Records who/when/why.
-- ============================================================
create or replace function public.approve_medical_amendment(p_amendment_id uuid, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_amend record;
  v_orig record;
  v_new_version int;
  v_new_id uuid;
  v_outcome text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to approve medical amendments';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_amend from public.medical_screening_amendments where id = p_amendment_id for update;
  if v_amend.id is null then
    raise exception 'Amendment request not found.';
  end if;
  if v_amend.status <> 'requested' then
    raise exception 'This amendment request has already been decided.';
  end if;

  select * into v_orig from public.medical_screenings where id = v_amend.screening_id;
  if v_orig.id is null then
    raise exception 'Original screening record not found.';
  end if;

  v_outcome := p_payload ->> 'outcome';
  if v_outcome not in ('fit_for_work', 'fit_with_restrictions', 'further_review', 'not_cleared', 'pending') then
    raise exception 'A valid final outcome is required for the amended record.';
  end if;

  select coalesce(max(version), 0) + 1 into v_new_version
  from public.medical_screenings where referral_id = v_orig.referral_id;

  insert into public.medical_screenings (
    referral_id, candidate_id, employee_id,
    screening_type, other_screening_type,
    hospital_name, hospital_id,
    medical_officer, screening_date,
    results, outcome, outcome_notes,
    signature_data, signature_date,
    version, amends_screening_id, amendment_reason,
    amended_by, amended_at, submitted_by_actor, submitted_at
  ) values (
    v_orig.referral_id, v_orig.candidate_id, v_orig.employee_id,
    v_orig.screening_type, v_orig.other_screening_type,
    coalesce(nullif(p_payload ->> 'hospital_name', ''), v_orig.hospital_name), v_orig.hospital_id,
    nullif(p_payload ->> 'medical_officer', ''), nullif(p_payload ->> 'screening_date', '')::date,
    coalesce(p_payload -> 'results', v_orig.results),
    v_outcome, p_payload ->> 'outcome_notes',
    coalesce(nullif(p_payload ->> 'signature_data', ''), v_orig.signature_data), now(),
    v_new_version, v_orig.id, v_amend.reason,
    auth.uid(), now(), 'HR_AMENDMENT', now()
  )
  returning id into v_new_id;

  update public.medical_screening_amendments
    set status = 'approved', decided_by = auth.uid(), decided_at = now(),
        decision_notes = p_payload ->> 'decision_notes'
  where id = p_amendment_id;

  update public.medical_referrals
    set status = 'under_review', updated_at = now()
  where id = v_orig.referral_id and status in ('submitted', 'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared');

  insert into public.medical_screening_events (referral_id, screening_id, event_type, details, actor, actor_id)
  values (v_orig.referral_id, v_new_id, 'AMENDMENT_APPROVED',
    format('Amendment approved by %s. New version %s created (reason: %s)', v_actor_name, v_new_version, v_amend.reason),
    v_actor_name, auth.uid());

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_AMENDMENT_APPROVED', 'MedicalScreening', v_orig.id::text, v_actor_name,
    format('Amendment approved; new version %s created for screening %s', v_new_version, v_orig.id), 'warning');

  return jsonb_build_object('ok', true, 'new_screening_id', v_new_id, 'version', v_new_version);
end; $$;




-- ============================================================
-- 18. RPC: reject_medical_amendment (HR only)
-- ============================================================
create or replace function public.reject_medical_amendment(p_amendment_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_amend record;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to reject medical amendments';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();
  select * into v_amend from public.medical_screening_amendments where id = p_amendment_id for update;
  if v_amend.id is null then
    raise exception 'Amendment request not found.';
  end if;
  if v_amend.status <> 'requested' then
    raise exception 'This amendment request has already been decided.';
  end if;

  update public.medical_screening_amendments
    set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
        decision_notes = coalesce(p_reason, decision_notes)
  where id = p_amendment_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_AMENDMENT_REJECTED', 'MedicalScreening', v_amend.screening_id::text, v_actor_name,
    format('Amendment request rejected: %s', coalesce(p_reason, '')), 'info');

  return jsonb_build_object('ok', true);
end; $$;




-- ============================================================
-- 19. RPC: upsert_medical_config (HR only) + get_medical_config
-- ============================================================
create or replace function public.upsert_medical_config(p_config_key text, p_config_value jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to configure medical screening.';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  insert into public.medical_screening_config (config_key, config_value, updated_by, updated_at)
  values (p_config_key, p_config_value, auth.uid(), now())
  on conflict (config_key)
  do update set config_value = excluded.config_value, updated_by = excluded.updated_by, updated_at = now();

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_CONFIG_UPDATED', 'MedicalConfig', p_config_key, v_actor_name,
    format('Medical screening configuration %s updated', p_config_key), 'info');

  return jsonb_build_object('ok', true, 'config_key', p_config_key);
end; $$;




create or replace function public.get_medical_config(p_config_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_value jsonb;
  v_actor_role text := public.current_role();
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select config_value into v_value from public.medical_screening_config where config_key = p_config_key;
  return coalesce(v_value, '{}'::jsonb);
end; $$;




-- ============================================================
-- 20. RPC: backfill_medical_screening_links (HR only)
--     When a candidate becomes an employee (employees.candidate_id),
--     link existing medical referrals/screenings to the employee so the
--     medical history is preserved across the conversion.
-- ============================================================
create or replace function public.backfill_medical_screening_links(p_employee_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_emp record;
  v_refs int := 0;
  v_scrs int := 0;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;
  if v_emp.candidate_id is null then
    raise exception 'This employee has no linked candidate record.';
  end if;

  update public.medical_referrals
    set employee_id = p_employee_id, updated_at = now()
  where employee_id is null and candidate_id = v_emp.candidate_id;
  get diagnostics v_refs = row_count;

  update public.medical_screenings
    set employee_id = p_employee_id
  where employee_id is null and candidate_id = v_emp.candidate_id;
  get diagnostics v_scrs = row_count;

  return jsonb_build_object('ok', true, 'referrals_linked', v_refs, 'screenings_linked', v_scrs);
end; $$;




-- ============================================================
-- 13. RLS POLICIES (new tables)
-- ============================================================
-- Integration helper: are we an HR-staff member?
create or replace function public.is_hr_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer');
$$;




-- ------------------------------------------------------------
-- 5. Safer HR profile/status/config RPCs
-- ------------------------------------------------------------
create or replace function public.hr_advance_application(p_candidate_id uuid, p_status text, p_note text default null)
returns public.hr_candidates language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidates;
  v_from text;
  v_allowed boolean := false;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  if p_status not in ('received', 'screening', 'shortlisted', 'assessment', 'assessment_passed', 'interview', 'interviewed', 'recommended', 'offer', 'offer_accepted', 'onboarding', 'hired', 'rejected', 'withdrawn', 'talent_pool', 'blacklisted') then raise exception 'Invalid recruitment stage'; end if;
  select application_status into v_from from public.hr_candidates where id = p_candidate_id;
  if v_from is null then raise exception 'Candidate not found'; end if;
  if v_from = p_status then v_allowed := true;
  elsif v_from in ('new', 'received') and p_status in ('screening', 'shortlisted', 'assessment', 'interview', 'rejected', 'withdrawn', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'screening' and p_status in ('shortlisted', 'assessment', 'interview', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'shortlisted' and p_status in ('assessment', 'interview', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'assessment' and p_status in ('assessment_passed', 'interview', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'assessment_passed' and p_status in ('interview', 'interviewed', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'interview' and p_status in ('interviewed', 'recommended', 'offer', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'interviewed' and p_status in ('recommended', 'offer', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'recommended' and p_status in ('offer', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'offer' and p_status in ('offer_accepted', 'onboarding', 'rejected', 'talent_pool', 'blacklisted') then v_allowed := true;
  elsif v_from = 'offer_accepted' and p_status in ('onboarding', 'hired') then v_allowed := true;
  elsif v_from = 'onboarding' and p_status = 'hired' then v_allowed := true;
  elsif v_from = 'talent_pool' and p_status in ('screening', 'shortlisted', 'assessment', 'interview', 'rejected', 'blacklisted') then v_allowed := true;
  end if;
  if not v_allowed then raise exception 'Invalid transition from % to %', v_from, p_status; end if;
  update public.hr_candidates set application_status = p_status, status_change_note = p_note where id = p_candidate_id returning * into v_row;
  perform public.hr_audit('APPLICATION_STATUS_CHANGED', 'Candidate', p_candidate_id::text, format('%s -> %s', v_from, p_status));
  return v_row;
end; $$;




create or replace function public.hr_update_candidate_profile(p_candidate_id uuid, p_data jsonb)
returns public.hr_candidates language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  update public.hr_candidates set
    full_name = coalesce(nullif(p_data ->> 'full_name', ''), full_name),
    email = coalesce(nullif(lower(p_data ->> 'email'), ''), email),
    phone = coalesce(nullif(p_data ->> 'phone', ''), phone),
    location = coalesce(nullif(p_data ->> 'location', ''), location),
    current_company = coalesce(nullif(p_data ->> 'current_company', ''), current_company),
    years_experience = case when nullif(p_data ->> 'years_experience', '') is null then years_experience else (p_data ->> 'years_experience')::int end,
    education = coalesce(p_data -> 'education', education), work_experience = coalesce(p_data -> 'work_experience', work_experience),
    skills = case when jsonb_typeof(p_data -> 'skills') = 'array' then array(select jsonb_array_elements_text(p_data -> 'skills')) else skills end,
    certifications = coalesce(p_data -> 'certifications', certifications), candidate_references = coalesce(p_data -> 'candidate_references', candidate_references),
    status_change_note = 'Candidate profile updated by HR', updated_at = now()
    where id = p_candidate_id returning * into v_row;
  if v_row.id is null then raise exception 'Candidate not found'; end if;
  perform public.record_recruitment_event(p_candidate_id, 'CANDIDATE_EDITED', 'Candidate profile updated', '{}'::jsonb);
  perform public.hr_audit('CANDIDATE_EDITED', 'Candidate', p_candidate_id::text, 'Candidate profile updated');
  return v_row;
end; $$;




-- Add an HR note to a candidate.
create or replace function public.hr_add_candidate_note(p_candidate_id uuid, p_note text)
returns public.hr_candidate_notes
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidate_notes;
  v_name text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select coalesce(full_name, '') into v_name from public.profiles where id = auth.uid();
  insert into public.hr_candidate_notes (candidate_id, note, author_id, author_name)
  values (p_candidate_id, p_note, auth.uid(), v_name)
  returning * into v_row;
  return v_row;
end; $$;




create or replace function public.upsert_screening_config(p_job_id uuid, p_config jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_version int;
  v_weight_total numeric;
  v_job public.hr_jobs;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then raise exception 'Not authorized to configure screening'; end if;
  select * into v_job from public.hr_jobs where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  select coalesce(sum(value::numeric), 0)
    into v_weight_total from jsonb_each_text(coalesce(p_config -> 'weights', '{}'::jsonb));
  if v_weight_total <> 100 then raise exception 'Recruitment criteria weights must total 100 (received %)', v_weight_total; end if;
  select coalesce(max(version), 0) + 1 into v_version from public.hr_screening_configs where job_id = p_job_id;
  update public.hr_screening_configs set active = false where job_id = p_job_id and active = true;
  insert into public.hr_screening_configs (
    job_id, version, active, weights, min_overall, min_components, mandatory_requirements, preferred_requirements,
    required_qualifications, required_certifications, required_skills, preferred_skills, criteria_notes,
    assessment_threshold, experience_threshold, assessment_flag_tolerance, created_by
  ) values (
    p_job_id, v_version, true, coalesce(p_config -> 'weights', '{}'::jsonb), coalesce((p_config ->> 'min_overall')::numeric, 60),
    coalesce(p_config -> 'min_components', '{}'::jsonb), coalesce(p_config -> 'mandatory_requirements', '[]'::jsonb),
    coalesce(p_config -> 'preferred_requirements', '[]'::jsonb), coalesce(p_config -> 'required_qualifications', '[]'::jsonb),
    coalesce(p_config -> 'required_certifications', '[]'::jsonb), coalesce(p_config -> 'required_skills', v_job.required_skills, '[]'::jsonb),
    coalesce(p_config -> 'preferred_skills', v_job.preferred_skills, '[]'::jsonb), nullif(p_config ->> 'criteria_notes', ''),
    (p_config ->> 'assessment_threshold')::numeric, coalesce((p_config ->> 'experience_threshold')::int, coalesce(v_job.experience_years, 0)),
    coalesce((p_config ->> 'assessment_flag_tolerance')::int, 0), auth.uid()
  );
  update public.hr_jobs set recruitment_criteria = p_config where id = p_job_id;
  perform public.hr_audit('SCREENING_CONFIG_SAVED', 'Job', p_job_id::text, format('Recruitment criteria v%s saved; weights total 100', v_version));
  return jsonb_build_object('ok', true, 'version', v_version, 'weight_total', v_weight_total);
end; $$;




-- Manual (non-AI) screening fallback so HR work never blocks on AI.
-- Weights come from the job's active screening config. Rule-based scoring:
-- experience, skills match, assessment score, interview score, text relevance.
create or replace function public.hr_run_manual_screening(p_candidate_ids uuid[], p_job_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_cfg record;
  v_candidate record;
  v_weights jsonb;
  v_experience numeric;
  v_skills numeric;
  v_assessment numeric;
  v_interview numeric;
  v_cv numeric;
  v_cover numeric;
  v_overall numeric;
  v_skills_list text[];
  v_all_text text;
  v_count int := 0;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  select * into v_cfg from public.hr_screening_configs
  where job_id = p_job_id and active = true order by version desc limit 1;

  v_weights := coalesce(v_cfg.weights, '{}'::jsonb);

  for v_candidate in
    select c.* from public.hr_candidates c where c.id = any(p_candidate_ids)
  loop
    -- experience (0-100)
    v_experience := least(100, round(coalesce(v_candidate.years_experience, 0) / greatest(coalesce(v_cfg.experience_threshold, 2), 1) * 100));

    -- skills match: overlap of job required+preferred skills with candidate skills + text
    v_skills_list := array(
      select jsonb_array_elements_text(coalesce(v_cfg.weights -> 'skills_source', '[]'::jsonb))
    );
    v_all_text := lower(coalesce(v_candidate.full_name, '') || ' ' || coalesce(v_candidate.cover_letter, '') || ' ' || coalesce(array_to_string(v_candidate.skills, ' '), ''));
    select round(100 * count(*)) into v_skills -- placeholder, refined below
    from unnest(v_skills_list) s where position(lower(s) in v_all_text) > 0;

    -- assessment
    select coalesce(max(a.score), 0) into v_assessment from public.hr_assessments a
    where a.candidate_id = v_candidate.id and a.status = 'completed';

    -- interview
    select coalesce(max(h.rating), 0) * 20 into v_interview from public.hr_interviews h
    where h.candidate_id = v_candidate.id and h.status = 'completed';

    v_cv := 0; v_cover := 0;
    -- crude relevance: share of required skills found in text
    if (select count(*) from jsonb_array_elements_text(coalesce(v_cfg.required_qualifications, '[]'::jsonb)) e) > 0 then
      select round(avg(m)) into v_cv from (
        select case when position(lower(e::text) in v_all_text) > 0 then 100 else 0 end as m
        from jsonb_array_elements_text(v_cfg.required_qualifications) e
      ) t;
    end if;

    v_overall := round(
      coalesce((v_weights ->> 'education')::numeric, 0) / 100 * 50 +
      coalesce((v_weights ->> 'experience')::numeric, 25) / 100 * v_experience +
      coalesce((v_weights ->> 'technical_skills')::numeric, 20) / 100 * coalesce(v_skills, 50) +
      coalesce((v_weights ->> 'cv_relevance')::numeric, 10) / 100 * v_cv +
      coalesce((v_weights ->> 'cover_letter_relevance')::numeric, 10) / 100 * v_cover +
      coalesce((v_weights ->> 'assessment_score')::numeric, 15) / 100 * v_assessment +
      coalesce((v_weights ->> 'interview_score')::numeric, 5) / 100 * v_interview
    , 2);

    if v_overall > 100 then v_overall := 100; end if;

    insert into public.candidate_screening_results
      (candidate_id, job_id, config_version, config_snapshot, components, overall_score,
       cv_match, experience_match, assessment_score, interview_score, skills_match,
       flags, strengths, concerns, summary, recommended_action, ai_generated, created_by)
    values (v_candidate.id, p_job_id, coalesce(v_cfg.version, 1), v_weights,
      jsonb_build_object('education', 50, 'experience', v_experience, 'technical_skills', coalesce(v_skills, 50),
        'cv_relevance', v_cv, 'cover_letter_relevance', v_cover, 'assessment_score', v_assessment, 'interview_score', v_interview),
      v_overall, v_cv, v_experience, v_assessment, v_interview, coalesce(v_skills, 50),
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      'Manual screening (AI unavailable) — HR to review.',
      case when v_overall >= coalesce(v_cfg.min_overall, 60) then 'recommended_interview' else 'manual_review' end,
      false, auth.uid());

    v_count := v_count + 1;
  end loop;

  perform public.hr_audit('SCREENING_MANUAL_RUN', 'Job', p_job_id::text,
    format('Manual screening computed for %s candidates', v_count));

  return jsonb_build_object('ok', true, 'candidates', v_count);
end; $$;




-- HR records an explicit screening decision.
create or replace function public.hr_set_screening_decision(p_result_id uuid, p_decision text, p_notes text default null)
returns public.candidate_screening_results
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.candidate_screening_results;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  update public.candidate_screening_results
  set hr_decision = p_decision, hr_decision_by = auth.uid(),
      hr_decision_at = now(), hr_decision_notes = p_notes
  where id = p_result_id
  returning * into v_row;
  return v_row;
end; $$;




-- Create an assessment invitation for a candidate (returns link token).
create or replace function public.hr_create_assessment_invitation(
  p_candidate_id uuid, p_template_id uuid, p_job_id uuid default null, p_expires_days int default 7
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_token text := public.generate_secure_token();
  v_template public.assessment_templates;
  v_id uuid;
  v_name text;
  v_candidate public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_template from public.assessment_templates where id = p_template_id;
  if v_template.id is null then
    raise exception 'Assessment template not found';
  end if;
  if v_template.status <> 'published' then
    raise exception 'Assessment template must be published before inviting candidates';
  end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then
    raise exception 'Candidate not found';
  end if;

  insert into public.hr_assessments (
    candidate_id, job_id, template_id, assessment_type, test_name, status,
    invitation_token_hash, expires_at, retake_limit, retake_time_hours,
    keep_previous_attempt, created_by
  ) values (
    p_candidate_id, coalesce(p_job_id, v_candidate.job_id),
    p_template_id, v_template.category, v_template.title, 'pending',
    md5(v_token), now() + (greatest(1, least(p_expires_days, 90)) || ' days')::interval,
    coalesce((v_template.anti_cheat ->> 'retake_limit')::int, 0),
    coalesce((v_template.anti_cheat ->> 'retake_time_hours')::numeric, 48),
    coalesce((v_template.anti_cheat ->> 'keep_previous_attempt')::bool, true),
    auth.uid()
  ) returning id into v_id;

  update public.hr_candidates
  set application_status = 'assessment', status_change_note = 'Assessment invitation sent'
  where id = p_candidate_id and application_status in ('received', 'screening', 'shortlisted');

  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ASSESSMENT_INVITED', 'Assessment', v_id::text, coalesce(v_name, ''),
          format('%s invited to %s', v_candidate.full_name, v_template.title), 'info');

  return jsonb_build_object('ok', true, 'assignment_id', v_id,
    'invitation_token', v_token,
    'url', '/careers/assessment/' || v_token,
    'expires_at', now() + (greatest(1, least(p_expires_days, 90)) || ' days')::interval);
end; $$;




-- Approve / reject a retake request.
create or replace function public.hr_decide_assessment_retake(p_request_id uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_request public.assessment_retake_requests;
  v_attempt_id uuid;
  v_assignment uuid;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized';
  end if;
  select * into v_request from public.assessment_retake_requests where id = p_request_id;
  if v_request.id is null then
    raise exception 'Retake request not found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Retake request already decided';
  end if;

  update public.assessment_retake_requests
  set status = p_decision, decided_by = auth.uid(), decided_at = now(), decision_note = p_note
  where id = p_request_id;

  if p_decision = 'approved' then
    -- mark previous attempt, reopen the assignment for the next attempt
    update public.assessment_attempts
    set review_status = 'retake_approved', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = p_note
    where id = v_request.attempt_id;

    update public.hr_assessments
    set status = 'pending', updated_at = now()
    where id = v_request.assignment_id;

    insert into public.assessment_monitoring_events
      (attempt_id, assessment_id, candidate_id, event_type, severity, sequence_number, event_data)
    values (v_request.attempt_id, v_request.assignment_id, v_request.candidate_id, 'restored', 'low',
      (select coalesce(max(sequence_number), 0) + 1 from public.assessment_monitoring_events where attempt_id = v_request.attempt_id),
      jsonb_build_object('retake_approved_by', auth.uid()));
  end if;

  perform public.hr_audit('RETAKE_' || upper(p_decision), 'AssessmentRetake', p_request_id::text,
    format('Retake request %s by HR', p_decision));

  return jsonb_build_object('ok', true, 'status', p_decision);
end; $$;




-- HR marks an attempt review status / grades a subjective question.
create or replace function public.hr_mark_attempt_review(p_attempt_id uuid, p_status text, p_notes text default null)
returns public.assessment_attempts
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.assessment_attempts;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized';
  end if;
  update public.assessment_attempts
  set review_status = p_status, review_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_attempt_id
  returning * into v_row;
  return v_row;
end; $$;




create or replace function public.hr_grade_assessment_question(p_attempt_id uuid, p_question_id uuid, p_marks numeric, p_feedback text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.assessment_attempt_answers;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized';
  end if;
  update public.assessment_attempt_answers
  set marks_earned = p_marks, is_correct = true,
      answer = jsonb_set(coalesce(answer, '{}'::jsonb), '{hr_feedback}', to_jsonb(coalesce(p_feedback, '')))
  where attempt_id = p_attempt_id and question_id = p_question_id
  returning * into v_row;
  perform public.recompute_attempt_score(p_attempt_id);
  return jsonb_build_object('ok', true, 'recomputed', true);
end; $$;




-- 3. Create offers with the server reference and a complete structured
-- snapshot. HR officers may generate offers through this guarded RPC.
create or replace function public.hr_create_offer(p_candidate_id uuid, p_job_id uuid default null, p_offer jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_name text;
  v_token text := public.generate_secure_token();
  v_offer_id uuid;
  v_offer_no text;
  v_prefix text;
  v_candidate public.hr_candidates;
  v_offer_date date := coalesce(nullif(p_offer -> 'salary_structure' -> 'document' ->> 'offer_date', '')::date, current_date);
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to generate offers';
  end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  select coalesce(full_name, '') into v_name from public.profiles where id = auth.uid();
  select coalesce(nullif(t.reference_prefix, ''), 'OFR') into v_prefix
  from public.offer_letter_templates t
  where t.id = nullif(p_offer ->> 'template_id', '')::uuid;
  v_offer_no := public.next_offer_reference_with_prefix(coalesce(v_prefix, 'OFR'));

  insert into public.offer_letters (
    candidate_id, job_id, candidate_name, "position", company_name,
    department, branch, employment_type, annual_salary, monthly_salary,
    mid_month_salary, end_month_salary, salary, allowances, benefits,
    start_date, probation_months, reporting_manager, working_hours,
    leave_entitlement, conditions, other_terms, acceptance_deadline,
    issue_date, offer_date, template_id, template_type, candidate_address,
    remuneration, salary_structure, document_id, digital_file_name,
    body_content, version, generated_by, offer_number, token_hash,
    status, created_by
  ) values (
    p_candidate_id, coalesce(p_job_id, v_candidate.job_id), v_candidate.full_name,
    coalesce(nullif(p_offer ->> 'position', ''), v_candidate.applied_role),
    coalesce(nullif(p_offer ->> 'company_name', ''), 'Infinity Microfinance Bank Ltd'),
    coalesce(nullif(p_offer ->> 'department', ''), v_candidate.department),
    coalesce(nullif(p_offer ->> 'branch', ''), v_candidate.branch),
    coalesce(nullif(p_offer ->> 'employment_type', ''), 'full_time'),
    coalesce((p_offer ->> 'annual_salary')::numeric, 0),
    coalesce((p_offer ->> 'monthly_salary')::numeric, 0),
    coalesce((p_offer ->> 'mid_month_salary')::numeric, 0),
    coalesce((p_offer ->> 'end_month_salary')::numeric, 0),
    coalesce((p_offer ->> 'salary')::numeric, (p_offer ->> 'monthly_salary')::numeric, 0),
    coalesce(p_offer -> 'allowances', '[]'::jsonb),
    nullif(btrim(coalesce(p_offer ->> 'benefits', '')), ''),
    coalesce((p_offer ->> 'start_date')::date, current_date),
    coalesce((p_offer ->> 'probation_months')::int, 3),
    nullif(btrim(coalesce(p_offer ->> 'reporting_manager', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'working_hours', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'leave_entitlement', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'conditions', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'other_terms', '')), ''),
    coalesce((p_offer ->> 'acceptance_deadline')::date, current_date + 7),
    v_offer_date, v_offer_date,
    nullif(p_offer ->> 'template_id', '')::uuid,
    nullif(btrim(coalesce(p_offer ->> 'template_type', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'candidate_address', '')), ''),
    coalesce(p_offer -> 'remuneration', '{}'::jsonb),
    coalesce(p_offer -> 'salary_structure', '{}'::jsonb),
    nullif(p_offer ->> 'document_id', '')::uuid,
    nullif(btrim(coalesce(p_offer ->> 'digital_file_name', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'body_content', '')), ''),
    1, coalesce(nullif(p_offer ->> 'generated_by', ''), 'manual'),
    v_offer_no, md5(v_token), 'draft', auth.uid()
  ) returning id into v_offer_id;

  update public.hr_candidates
  set application_status = 'offer', status_change_note = 'Offer created'
  where id = p_candidate_id
    and application_status not in ('hired', 'offer_accepted', 'onboarding', 'guarantor');

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('OFFER_GENERATED', 'OfferLetter', v_offer_id::text, coalesce(v_name, ''),
    format('Offer %s created for %s', v_offer_no, v_candidate.full_name), 'info');

  return jsonb_build_object('ok', true, 'offer_id', v_offer_id, 'offer_number', v_offer_no,
    'token', v_token, 'status', 'draft');
end;
$$;




-- 5. Issue an offer with a stable offer date.
create or replace function public.hr_issue_offer(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := public.current_role(); v_offer public.offer_letters;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then raise exception 'Offer not found'; end if;
  if v_offer.status = 'issued' then raise exception 'Offer is already issued'; end if;
  if v_offer.status = 'accepted' then raise exception 'Offer already accepted'; end if;
  update public.offer_letters set status = 'issued', issue_date = coalesce(issue_date, current_date), offer_date = coalesce(offer_date, current_date), issued_by = auth.uid(), issued_at = now(), updated_at = now() where id = p_offer_id;
  update public.hr_candidates set application_status = 'offer', status_change_note = 'Offer issued' where id = v_offer.candidate_id and application_status in ('recommended', 'interviewed', 'offer');
  perform public.hr_audit('OFFER_ISSUED', 'OfferLetter', p_offer_id::text, format('Offer %s issued', v_offer.offer_number));
  return jsonb_build_object('ok', true, 'status', 'issued');
end;
$$;




-- 4. Draft edits update in place; issued edits always create an immutable new
-- version with a new reference and no inherited PDF/document pointer.
create or replace function public.hr_modify_offer(p_offer_id uuid, p_offer jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
  v_token text := public.generate_secure_token();
  v_new_id uuid;
  v_new_no text;
  v_prefix text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then raise exception 'Offer not found'; end if;

  if v_offer.status = 'draft' then
    update public.offer_letters set
      "position" = coalesce(nullif(p_offer ->> 'position', ''), "position"),
      company_name = coalesce(nullif(p_offer ->> 'company_name', ''), company_name),
      department = coalesce(nullif(p_offer ->> 'department', ''), department),
      branch = coalesce(nullif(p_offer ->> 'branch', ''), branch),
      employment_type = coalesce(nullif(p_offer ->> 'employment_type', ''), employment_type),
      salary = coalesce((p_offer ->> 'salary')::numeric, salary),
      annual_salary = coalesce((p_offer ->> 'annual_salary')::numeric, annual_salary),
      monthly_salary = coalesce((p_offer ->> 'monthly_salary')::numeric, monthly_salary),
      mid_month_salary = coalesce((p_offer ->> 'mid_month_salary')::numeric, mid_month_salary),
      end_month_salary = coalesce((p_offer ->> 'end_month_salary')::numeric, end_month_salary),
      allowances = coalesce(p_offer -> 'allowances', allowances),
      benefits = coalesce(nullif(p_offer ->> 'benefits', ''), benefits),
      start_date = coalesce((p_offer ->> 'start_date')::date, start_date),
      probation_months = coalesce((p_offer ->> 'probation_months')::int, probation_months),
      reporting_manager = coalesce(nullif(p_offer ->> 'reporting_manager', ''), reporting_manager),
      working_hours = coalesce(nullif(p_offer ->> 'working_hours', ''), working_hours),
      leave_entitlement = coalesce(nullif(p_offer ->> 'leave_entitlement', ''), leave_entitlement),
      conditions = coalesce(nullif(p_offer ->> 'conditions', ''), conditions),
      other_terms = coalesce(nullif(p_offer ->> 'other_terms', ''), other_terms),
      acceptance_deadline = coalesce((p_offer ->> 'acceptance_deadline')::date, acceptance_deadline),
      template_id = coalesce(nullif(p_offer ->> 'template_id', '')::uuid, template_id),
      template_type = coalesce(nullif(p_offer ->> 'template_type', ''), template_type),
      candidate_address = coalesce(nullif(p_offer ->> 'candidate_address', ''), candidate_address),
      remuneration = coalesce(p_offer -> 'remuneration', remuneration),
      salary_structure = coalesce(p_offer -> 'salary_structure', salary_structure),
      body_content = coalesce(nullif(p_offer ->> 'body_content', ''), body_content),
      updated_at = now()
    where id = p_offer_id;
    perform public.hr_audit('OFFER_MODIFIED', 'OfferLetter', p_offer_id::text, 'Draft offer updated');
    return jsonb_build_object('ok', true, 'offer_id', p_offer_id, 'new_version', v_offer.version);
  end if;

  if v_offer.status <> 'issued' then raise exception 'Offer in status %s cannot be modified', v_offer.status; end if;
  select coalesce(nullif(t.reference_prefix, ''), 'OFR') into v_prefix
  from public.offer_letter_templates t
  where t.id = coalesce(nullif(p_offer ->> 'template_id', '')::uuid, v_offer.template_id);
  v_new_no := public.next_offer_reference_with_prefix(coalesce(v_prefix, 'OFR'));
  insert into public.offer_letters (
    candidate_id, job_id, candidate_name, "position", company_name, department, branch,
    employment_type, salary, annual_salary, monthly_salary, mid_month_salary, end_month_salary,
    allowances, benefits, start_date, probation_months, reporting_manager, working_hours,
    leave_entitlement, conditions, other_terms, acceptance_deadline, issue_date, offer_date,
    template_id, template_type, candidate_address, remuneration, salary_structure,
    document_id, digital_file_name, body_content, version, generated_by, offer_number,
    token_hash, status, created_by
  ) values (
    v_offer.candidate_id, v_offer.job_id, v_offer.candidate_name,
    coalesce(nullif(p_offer ->> 'position', ''), v_offer."position"),
    coalesce(nullif(p_offer ->> 'company_name', ''), v_offer.company_name),
    coalesce(nullif(p_offer ->> 'department', ''), v_offer.department),
    coalesce(nullif(p_offer ->> 'branch', ''), v_offer.branch),
    coalesce(nullif(p_offer ->> 'employment_type', ''), v_offer.employment_type),
    coalesce((p_offer ->> 'salary')::numeric, v_offer.salary),
    coalesce((p_offer ->> 'annual_salary')::numeric, v_offer.annual_salary),
    coalesce((p_offer ->> 'monthly_salary')::numeric, v_offer.monthly_salary),
    coalesce((p_offer ->> 'mid_month_salary')::numeric, v_offer.mid_month_salary),
    coalesce((p_offer ->> 'end_month_salary')::numeric, v_offer.end_month_salary),
    coalesce(p_offer -> 'allowances', v_offer.allowances),
    coalesce(nullif(p_offer ->> 'benefits', ''), v_offer.benefits),
    coalesce((p_offer ->> 'start_date')::date, v_offer.start_date),
    coalesce((p_offer ->> 'probation_months')::int, v_offer.probation_months),
    coalesce(nullif(p_offer ->> 'reporting_manager', ''), v_offer.reporting_manager),
    coalesce(nullif(p_offer ->> 'working_hours', ''), v_offer.working_hours),
    coalesce(nullif(p_offer ->> 'leave_entitlement', ''), v_offer.leave_entitlement),
    coalesce(nullif(p_offer ->> 'conditions', ''), v_offer.conditions),
    coalesce(nullif(p_offer ->> 'other_terms', ''), v_offer.other_terms),
    coalesce((p_offer ->> 'acceptance_deadline')::date, v_offer.acceptance_deadline),
    current_date, current_date,
    coalesce(nullif(p_offer ->> 'template_id', '')::uuid, v_offer.template_id),
    coalesce(nullif(p_offer ->> 'template_type', ''), v_offer.template_type),
    coalesce(nullif(p_offer ->> 'candidate_address', ''), v_offer.candidate_address),
    coalesce(p_offer -> 'remuneration', v_offer.remuneration),
    coalesce(p_offer -> 'salary_structure', v_offer.salary_structure),
    null, null, coalesce(nullif(p_offer ->> 'body_content', ''), v_offer.body_content),
    v_offer.version + 1, coalesce(nullif(p_offer ->> 'generated_by', ''), v_offer.generated_by),
    v_new_no, md5(v_token), 'draft', auth.uid()
  ) returning id into v_new_id;

  update public.offer_letters set superseded_by = v_new_id, status = 'withdrawn', updated_at = now() where id = p_offer_id;
  perform public.hr_audit('OFFER_MODIFIED', 'OfferLetter', p_offer_id::text,
    format('Offer %s v%s superseded by %s v%s', v_offer.offer_number, v_offer.version, v_new_no, v_offer.version + 1));
  return jsonb_build_object('ok', true, 'offer_id', v_new_id, 'offer_number', v_new_no,
    'new_version', v_offer.version + 1, 'token', v_token, 'status', 'draft');
end;
$$;




create or replace function public.hr_withdraw_offer(p_offer_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := public.current_role(); v_offer public.offer_letters;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then raise exception 'Offer not found'; end if;
  if v_offer.status = 'accepted' then raise exception 'Accepted offers cannot be withdrawn'; end if;
  update public.offer_letters set status = 'withdrawn', other_terms = coalesce(other_terms, '') || E'\nWithdrawn: ' || coalesce(p_note, ''), updated_at = now() where id = p_offer_id;
  perform public.hr_audit('OFFER_WITHDRAWN', 'OfferLetter', p_offer_id::text, coalesce(p_note, 'Offer withdrawn'));
  return jsonb_build_object('ok', true);
end;
$$;




-- Create an onboarding link for an accepted candidate (HR-manual alternative).
create or replace function public.hr_create_onboarding_link_for_offer(p_offer_id uuid, p_expires_days int default 7)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
  v_candidate public.hr_candidates;
  v_token text := public.generate_secure_token();
  v_link uuid;
  v_expires timestamptz := now() + (greatest(1, least(p_expires_days, 90)) || ' days')::interval;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;
  select * into v_candidate from public.hr_candidates where id = v_offer.candidate_id;
  if v_candidate.id is null then
    raise exception 'Candidate not found';
  end if;

  insert into public.employee_onboarding_links
    (token_hash, candidate_name, candidate_email, candidate_phone, "position",
     department, branch, employment_type, expiry, expires_at, status, created_by)
  values (md5(v_token), v_candidate.full_name, coalesce(v_candidate.email, ''),
          v_candidate.phone, coalesce(v_offer."position", v_candidate.applied_role),
          coalesce(v_offer.department, v_candidate.department),
          coalesce(v_offer.branch, v_candidate.branch),
          v_offer.employment_type, v_expires, v_expires, 'PENDING', auth.uid())
  returning id into v_link;

  update public.hr_candidates set onb_link_id = v_link, application_status = 'onboarding',
    status_change_note = 'Onboarding link generated'
  where id = v_candidate.id;
  update public.employee_onboarding_links set candidate_id = v_candidate.id, job_id = v_offer.job_id
  where id = v_link;

  perform public.hr_audit('ONBOARDING_LINK_GENERATED', 'Candidate', v_candidate.id::text,
    format('Onboarding link created from offer %s', v_offer.offer_number));

  return jsonb_build_object('ok', true, 'link_id', v_link,
    'token', v_token, 'url', '/onboarding/' || v_token, 'expires_at', v_expires);
end; $$;




-- ============================================================
-- 17. PAYROLL RPCs — components + breakdown snapshots
-- ============================================================
create or replace function public.upsert_salary_component(p_comp jsonb)
returns public.payroll_salary_components
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.payroll_salary_components;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage payroll configuration';
  end if;
  insert into public.payroll_salary_components
    (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
  values (
    btrim(coalesce(p_comp ->> 'name', '')),
    coalesce(p_comp ->> 'component_type', 'allowance'),
    coalesce(p_comp ->> 'basis', 'percentage'),
    coalesce((p_comp ->> 'rate')::numeric, 0),
    coalesce((p_comp ->> 'taxable')::bool, true),
    coalesce((p_comp ->> 'recurring')::bool, true),
    coalesce(p_comp ->> 'payment_schedule', 'both'),
    coalesce(p_comp ->> 'category', 'other'),
    coalesce((p_comp ->> 'active')::bool, true),
    auth.uid()
  )
  on conflict (name)
  do update set
    component_type = excluded.component_type,
    basis = excluded.basis,
    rate = excluded.rate,
    taxable = excluded.taxable,
    recurring = excluded.recurring,
    payment_schedule = excluded.payment_schedule,
    category = excluded.category,
    active = excluded.active,
    updated_at = now()
  returning * into v_row;
  return v_row;
end; $$;




-- Assign a component to an employee with an amount snapshot.
create or replace function public.assign_employee_salary_component(
  p_employee_id uuid, p_component_id uuid, p_amount numeric default null, p_rate numeric default null
) returns public.employee_salary_packages
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_comp public.payroll_salary_components;
  v_rate numeric;
  v_amount numeric;
  v_row public.employee_salary_packages;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;
  select * into v_comp from public.payroll_salary_components where id = p_component_id;
  if v_comp.id is null then raise exception 'Component not found'; end if;

  v_rate := coalesce(p_rate, v_comp.rate, 0);
  v_amount := coalesce(p_amount,
    case when v_comp.basis = 'percentage'
         then round(coalesce(v_emp.salary, 0) * v_rate / 100, 2)
         else v_rate end);

  insert into public.employee_salary_packages
    (employee_id, component_id, amount, rate, snapshot, active, created_by)
  values (p_employee_id, p_component_id, v_amount, v_rate,
    to_jsonb(v_comp), true, auth.uid())
  on conflict (employee_id, component_id)
  do update set amount = excluded.amount, rate = excluded.rate,
                snapshot = excluded.snapshot, active = true, effective_date = current_date
  returning * into v_row;
  return v_row;
end; $$;




-- Remove an employee component (soft).
create or replace function public.remove_employee_salary_component(p_employee_id uuid, p_component_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized';
  end if;
  update public.employee_salary_packages
  set active = false
  where employee_id = p_employee_id and component_id = p_component_id;
  return jsonb_build_object('ok', true);
end; $$;




-- ============================================================
-- 2. Rewrite company breakdown to persist through the SAME engine
-- ============================================================
create or replace function public.calculate_employee_salary_breakdown(p_employee_id uuid, p_period_label text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_package record;
  v_basic numeric := 0;
  v_allowances numeric := 0;
  v_taxable_allow numeric := 0;
  v_deductions numeric := 0;
  v_comps jsonb := '[]'::jsonb;
  v_break jsonb;
  v_label text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  v_basic := coalesce(v_emp.salary, 0);

  for v_package in
    select * from public.employee_salary_packages where employee_id = p_employee_id and active = true
  loop
    if v_package.snapshot ->> 'component_type' = 'allowance' then
      v_allowances := v_allowances + coalesce(v_package.amount, 0);
      if coalesce((v_package.snapshot ->> 'taxable')::bool, true) then
        v_taxable_allow := v_taxable_allow + coalesce(v_package.amount, 0);
      end if;
      v_comps := v_comps || jsonb_build_object(
        'name', v_package.snapshot ->> 'name', 'component_type', 'allowance',
        'amount', coalesce(v_package.amount, 0), 'payment_schedule', v_package.snapshot ->> 'payment_schedule');
    else
      v_deductions := v_deductions + coalesce(v_package.amount, 0);
      v_comps := v_comps || jsonb_build_object(
        'name', v_package.snapshot ->> 'name', 'component_type', 'deduction',
        'amount', coalesce(v_package.amount, 0), 'payment_schedule', v_package.snapshot ->> 'payment_schedule');
    end if;
  end loop;

  v_break := public._salary_breakdown(v_basic, v_allowances, v_taxable_allow, v_deductions);
  v_label := coalesce(nullif(p_period_label, ''), 'CURRENT');

  insert into public.employee_salary_snapshots
    (employee_id, period_label, gross_annual, gross_monthly, basic_monthly,
     allowances_total, deductions_total, tax_paye, pension, other_deductions,
     net_monthly, mid_month, end_month, components)
  values (p_employee_id, v_label,
          (v_break ->> 'gross_annual')::numeric, (v_break ->> 'gross_monthly')::numeric,
          (v_break ->> 'basic_monthly')::numeric, (v_break ->> 'allowances_total')::numeric,
          (v_break ->> 'deductions_total')::numeric, (v_break ->> 'tax_paye')::numeric,
          (v_break ->> 'pension')::numeric, (v_break ->> 'other_deductions')::numeric,
          (v_break ->> 'net_monthly')::numeric, (v_break ->> 'mid_month')::numeric,
          (v_break ->> 'end_month')::numeric, v_comps)
  on conflict (employee_id, period_label)
  do update set
    gross_annual = excluded.gross_annual, gross_monthly = excluded.gross_monthly,
    basic_monthly = excluded.basic_monthly, allowances_total = excluded.allowances_total,
    deductions_total = excluded.deductions_total, tax_paye = excluded.tax_paye,
    pension = excluded.pension, other_deductions = excluded.other_deductions,
    net_monthly = excluded.net_monthly, mid_month = excluded.mid_month,
    end_month = excluded.end_month, components = excluded.components,
    calc_timestamp = now();

  return jsonb_build_object(
    'ok', true, 'employee_id', p_employee_id, 'period_label', v_label,
    'breakdown', v_break || jsonb_build_object('components', v_comps)
  );
end; $$;


-- ============================================================
-- PHASE 42 — Medical Screening workflow completions (idempotent)
--
-- Run after schema_phase40_medical_screening_workflow.sql.
-- Closes the tracking + expiry gaps in the hospital referral loop:
--
--   1. begin_medical_screening(p_token)  — PUBLIC, token-scoped.
--      Moves an issued/qr_opened referral to `screening_started`,
--      records a SCREENING_STARTED event, audits and notifies HR so
--      "In Progress" is tracked the moment the hospital starts.
--
--   2. notify_expiring_medical_referrals() — HR RPC (no scheduler
--      exists in this project). Called opportunistically from HR
--      dashboard / workbench loads. Fires ONE in-app notification per
--      expiring referral per 24h, so a listing never spams HR.
--
-- Both are additive and safe to re-run.
--
-- FIX (42601): v_hr_id was used as a `FOR v_hr_id IN SELECT id FROM ...`
-- loop target without being declared, which PL/pgSQL rejected with
-- "loop variable of loop over rows must be a record variable or list
-- of scalar variables". Declared explicitly as uuid (matches
-- profiles.id) in both functions so the loop resolves as the
-- single-scalar-variable form.
-- ============================================================

-- ============================================================
-- 1. RPC: begin_medical_screening (PUBLIC / token + single-use)
--     Mirrors submit_medical_screening's guards. `started_at` already
--     exists on medical_referrals (Phase 40).
-- ============================================================
create or replace function public.begin_medical_screening(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_ref record;
  v_hr_id uuid;
begin
  select * into v_ref from public.medical_referrals where referral_token_hash = v_hash for update;
  if v_ref.id is null then
    raise exception 'Invalid or unrecognized medical screening referral.';
  end if;
  if v_ref.status = 'revoked' then
    raise exception 'This medical screening referral has been revoked. Contact Human Resources for a new referral.';
  end if;
  if v_ref.expires_at is not null and v_ref.expires_at < now() then
    raise exception 'This medical screening referral has expired. Contact Human Resources for a new referral.';
  end if;
  if v_ref.status in ('submitted', 'under_review', 'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared') then
    raise exception 'This screening has already been submitted. A new referral is required for re-screening.';
  end if;

  if v_ref.status = 'screening_started' then
    -- Idempotent: already started (e.g. re-click or reload). Return without
    -- creating a duplicate event/notification.
    return jsonb_build_object('ok', true, 'status', 'screening_started', 'reference', v_ref.reference);
  end if;

  update public.medical_referrals
    set status = 'screening_started', started_at = coalesce(started_at, now()), updated_at = now()
  where id = v_ref.id;

  insert into public.medical_screening_events (referral_id, event_type, details, actor)
  values (v_ref.id, 'SCREENING_STARTED',
    format('Screening started for referral %s', v_ref.reference), 'Hospital / unauthenticated');

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_SCREENING_STARTED', 'MedicalReferral', v_ref.id::text, 'Hospital / unauthenticated',
    format('Screening started for referral %s', v_ref.reference), 'info');

  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
  loop
    insert into public.notifications (user_id, title, message, type, link)
    values (v_hr_id, 'Medical screening started',
      format('The hospital has begun the medical screening for %s (%s).', v_ref.subject_name, v_ref.reference),
      'medical', '/medical-management');
  end loop;

  return jsonb_build_object('ok', true, 'status', 'screening_started', 'reference', v_ref.reference);
end; $$;




-- ============================================================
-- 2. RPC: notify_expiring_medical_referrals (HR only)
--     Opportunistic scheduler: call after HR loads a medical surface.
--     Creates one in-app notification per active referral expiring
--     within 7 days, deduped per 24h (so a page refresh never repeats).
-- ============================================================
create or replace function public.notify_expiring_medical_referrals()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_ref record;
  v_hr_id uuid;
  v_created int := 0;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  for v_ref in
    select * from public.medical_referrals r
    where r.status in ('draft', 'issued', 'qr_opened', 'screening_started')
      and r.expires_at is not null
      and r.expires_at > now()
      and r.expires_at < now() + interval '7 days'
  loop
    if exists (
      select 1 from public.notifications n
      where n.type = 'medical'
        and n.title = 'Medical referral expiring soon'
        and strpos(coalesce(n.message, ''), v_ref.reference) > 0
        and n.created_at > now() - interval '24 hours'
    ) then
      continue;
    end if;

    for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    loop
      insert into public.notifications (user_id, title, message, type, link)
      values (v_hr_id, 'Medical referral expiring soon',
        format('The medical screening referral %s for %s expires on %s.', v_ref.reference, v_ref.subject_name, to_char(v_ref.expires_at, 'DD Mon YYYY')),
        'medical', '/medical-management');
    end loop;
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('ok', true, 'notified', v_created);
end; $$;




-- 6. A document can only be linked to the offer that owns its private file.
create or replace function public.hr_set_offer_document(p_offer_id uuid, p_document_id uuid, p_file_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := public.current_role(); v_offer public.offer_letters; v_doc public.documents;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then raise exception 'Offer not found'; end if;
  select * into v_doc from public.documents where id = p_document_id and entity_type = 'offer_letter' and entity_id = p_offer_id;
  if v_doc.id is null then raise exception 'The document does not belong to this offer'; end if;
  update public.offer_letters set document_id = p_document_id, digital_file_name = coalesce(nullif(p_file_name, ''), v_doc.file_name), updated_at = now() where id = p_offer_id;
  perform public.hr_audit('OFFER_DOCUMENT_ATTACHED', 'OfferLetter', p_offer_id::text, format('Digital copy attached to offer %s', v_offer.offer_number));
  return jsonb_build_object('ok', true, 'document_id', p_document_id);
end;
$$;




create or replace function public.hr_send_offer(p_offer_id uuid, p_emailed_to text default null, p_document_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := public.current_role(); v_offer public.offer_letters; v_doc public.documents;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then raise exception 'Offer not found'; end if;
  if v_offer.status not in ('draft', 'issued') then raise exception 'Offer in status %s cannot be sent', v_offer.status; end if;
  if p_document_id is not null then
    select * into v_doc from public.documents where id = p_document_id and entity_type = 'offer_letter' and entity_id = p_offer_id;
    if v_doc.id is null then raise exception 'The document does not belong to this offer'; end if;
  end if;
  update public.offer_letters set
    status = 'issued', issued_by = auth.uid(), issued_at = coalesce(issued_at, now()),
    issue_date = coalesce(issue_date, current_date), offer_date = coalesce(offer_date, current_date),
    sent_at = coalesce(sent_at, now()), emailed_to = coalesce(nullif(p_emailed_to, ''), emailed_to),
    document_id = coalesce(nullif(p_document_id, null), document_id), updated_at = now()
  where id = p_offer_id;
  update public.hr_candidates set application_status = 'offer', status_change_note = 'Offer issued'
  where id = v_offer.candidate_id and application_status in ('recommended', 'interviewed', 'offer');
  perform public.hr_audit('OFFER_SENT', 'OfferLetter', p_offer_id::text,
    format('Offer %s sent to %s', v_offer.offer_number, coalesce(p_emailed_to, v_offer.candidate_name)));
  return jsonb_build_object('ok', true, 'status', 'issued');
end;
$$;




create or replace function public.hr_allocate_offer_reference()
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  return public.next_offer_reference();
end;
$$;




create or replace function public.hr_allocate_offer_reference_with_prefix(p_prefix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  return public.next_offer_reference_with_prefix(coalesce(p_prefix, 'OFR'));
end;
$$;




create or replace function public.revoke_guarantor_verification(p_verification_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_name text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then raise exception 'Not authorized to revoke verification links.'; end if;
  update public.guarantor_verifications
  set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), updated_at = now()
  where id = p_verification_id and status <> 'approved'
  returning guarantor_name into v_name;
  if v_name is null then raise exception 'Verification not found or already approved.'; end if;
  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (p_verification_id, 'GUARANTOR_LINK_REVOKED', 'Guarantor verification link revoked.',
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text));
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('GUARANTOR_LINK_REVOKED', 'GuarantorVerification', p_verification_id::text,
          coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
          'Guarantor verification link revoked.', 'warning');
  return jsonb_build_object('ok', true, 'revoked', true);
end; $$;




-- ------------------------------------------------------------
-- Filter options. This is an authorized option list, not a raw employees
-- table read. Branch/area managers receive only their real scope.
-- ------------------------------------------------------------
create or replace function public.get_dashboard_filter_options(
  p_branch_id uuid default null,
  p_department text default null,
  p_area text default null
)
returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_org_scope boolean := false;
  v_branch_scope uuid;
  v_area_scope text;
  v_employee_scope uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_me from public.employees where user_id = auth.uid() order by created_at desc limit 1;
  v_org_scope := v_role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_business')
    or upper(trim(coalesce(v_me."position", ''))) in ('MD', 'MD/CEO');

  if v_role = 'branch_manager' then
    v_branch_scope := v_me.branch_id;
    if p_branch_id is not null and p_branch_id is distinct from v_branch_scope then
      raise exception 'Not authorized for this branch';
    end if;
    if v_branch_scope is null then v_employee_scope := v_me.id; end if;
  elsif v_role = 'area_manager' then
    v_area_scope := v_me.area;
    if p_area is not null and lower(p_area) <> lower(coalesce(v_area_scope, '')) then
      raise exception 'Not authorized for this area';
    end if;
    if v_area_scope is null then v_employee_scope := v_me.id; end if;
  elsif not v_org_scope then
    v_employee_scope := v_me.id;
  end if;

  return jsonb_build_object(
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'branch_name', b.branch_name, 'branch_code', b.branch_code) order by b.branch_name)
      from public.branches b
      where b.status = 'active'
        and (v_org_scope or v_me.id is not null)
        and (v_branch_scope is null or b.id = v_branch_scope)
        and (v_area_scope is null or exists (
          select 1 from public.branch_area_assignments baa
          join public.areas a on a.id = baa.area_id
          where baa.branch_id = b.id and baa.is_current and lower(a.area_code) = lower(v_area_scope)
        ))
    ), '[]'::jsonb),
    'areas', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'area_code', a.area_code, 'area_name', a.area_name) order by a.area_code)
      from public.areas a
      where a.is_active
        and (v_org_scope or v_me.id is not null)
        and (v_area_scope is null or lower(a.area_code) = lower(v_area_scope))
        and (v_branch_scope is null or exists (
          select 1 from public.branch_area_assignments baa
          where baa.area_id = a.id and baa.branch_id = v_branch_scope and baa.is_current
        ))
    ), '[]'::jsonb),
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.name, 'name', x.name) order by x.name)
      from (
      select distinct coalesce(nullif(trim(e.department), ''), 'Unassigned') as name
        from public.employees e
        where coalesce(e.is_archived, false) = false
          and (v_org_scope or v_me.id is not null)
          and (v_employee_scope is null or e.id = v_employee_scope)
          and (v_branch_scope is null or e.branch_id = v_branch_scope)
          and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope))
          and (p_branch_id is null or e.branch_id = p_branch_id)
          and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area))
      ) x
    ), '[]'::jsonb),
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'full_name', x.full_name, 'department', x.department,
        'branch_id', x.branch_id, 'branch', x.branch, 'area', x.area
      ) order by x.full_name)
      from (
        select e.id, e.full_name, e.department, e.branch_id, e.branch, e.area
        from public.employees e
        where coalesce(e.is_archived, false) = false
          and (v_org_scope or v_me.id is not null)
          and (v_employee_scope is null or e.id = v_employee_scope)
          and (v_branch_scope is null or e.branch_id = v_branch_scope)
          and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope))
          and (p_branch_id is null or e.branch_id = p_branch_id)
          and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department))
          and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area))
        order by e.full_name
        limit 500
      ) x
    ), '[]'::jsonb)
  );
end;
$$;




-- ------------------------------------------------------------
-- Dashboard snapshot. All sensitive filtering happens here, never in the
-- browser. The returned values are aggregates or the selected employee's
-- permitted detail, not the underlying organization-wide tables.
-- ------------------------------------------------------------
create or replace function public.get_dashboard_snapshot(
  p_branch_id uuid default null,
  p_department text default null,
  p_employee_id uuid default null,
  p_area text default null,
  p_start_date date default null,
  p_end_date date default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_org_scope boolean := false;
  v_scope text := 'management';
  v_branch_scope uuid;
  v_area_scope text;
  v_employee_id uuid := p_employee_id;
  v_ids uuid[] := '{}'::uuid[];
  v_start date := coalesce(p_start_date, current_date - 30);
  v_end date := coalesce(p_end_date, current_date);
  v_late_count integer := 0;
  v_pending_leave integer := 0;
  v_below_kpi integer := 0;
  v_overdue_tasks integer := 0;
  v_onboarding_pending integer := 0;
  v_onboarding_complete integer := 0;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_me from public.employees where user_id = auth.uid() order by created_at desc limit 1;
  v_org_scope := v_role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_business')
    or upper(trim(coalesce(v_me."position", ''))) in ('MD', 'MD/CEO');

  if v_role = 'branch_manager' then
    v_branch_scope := v_me.branch_id;
    if p_branch_id is not null and p_branch_id is distinct from v_branch_scope then raise exception 'Not authorized for this branch'; end if;
    if v_branch_scope is null then v_employee_id := v_me.id; end if;
  elsif v_role = 'area_manager' then
    v_area_scope := v_me.area;
    if p_area is not null and lower(p_area) <> lower(coalesce(v_area_scope, '')) then raise exception 'Not authorized for this area'; end if;
    if v_area_scope is null then v_employee_id := v_me.id; end if;
  elsif not v_org_scope then
    v_scope := 'self';
    v_employee_id := v_me.id;
    v_branch_scope := null;
    v_area_scope := null;
  end if;

  if v_scope = 'management' and v_employee_id is null and v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_business')
     and upper(trim(coalesce(v_me."position", ''))) not in ('MD', 'MD/CEO') then
    v_scope := 'self';
    v_employee_id := v_me.id;
  end if;

  select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids
  from public.employees e
  where coalesce(e.is_archived, false) = false
    and (v_org_scope or v_me.id is not null)
    and (v_employee_id is null or e.id = v_employee_id)
    and (v_branch_scope is null or e.branch_id = v_branch_scope)
    and (p_branch_id is null or e.branch_id = p_branch_id)
    and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope)
      or exists (
        select 1 from public.branch_area_assignments baa
        join public.areas a on a.id = baa.area_id
        where baa.branch_id = e.branch_id and baa.is_current and lower(a.area_code) = lower(v_area_scope)
      ))
    and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area))
    and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department));

  select count(*) into v_late_count
  from public.attendance_records ar where ar.employee_id = any(v_ids)
    and ar.attendance_date between v_start and v_end
    and (coalesce(ar.late_minutes, 0) > 0 or ar.status = 'late');
  select count(*) into v_pending_leave
  from public.leave_requests lr
  where lr.created_by in (select e.user_id from public.employees e where e.id = any(v_ids) and e.user_id is not null)
    and lr.status = 'pending';
  select count(*) into v_below_kpi
  from public.employee_kpis k where k.employee_id = any(v_ids)
    and k.target_value <> 0 and coalesce(k.actual_value, 0) < k.target_value;
  select count(*) into v_overdue_tasks
  from public.work_tasks wt where wt.employee_id = any(v_ids)
    and wt.due_date < current_date and wt.status not in ('completed', 'cancelled', 'submitted');
  select count(distinct s.employee_id) into v_onboarding_pending
  from public.employee_onboarding_submissions s
  where s.employee_id = any(v_ids)
    and s.onboarding_status in ('submitted', 'under_review', 'pending_guarantor', 'guarantor_submitted', 'correction_requested');
  select count(distinct s.employee_id) into v_onboarding_complete
  from public.employee_onboarding_submissions s
  where s.employee_id = any(v_ids) and s.onboarding_status in ('approved', 'completed');

  return jsonb_build_object(
    'scope', v_scope,
    'filtering_allowed', v_org_scope,
    'viewer', jsonb_build_object('role', v_role, 'user_id', auth.uid()),
    'employee', case when v_scope = 'self' then jsonb_build_object(
      'id', v_me.id, 'full_name', v_me.full_name, 'email', v_me.email,
      'department', v_me.department, 'position', v_me."position", 'branch', v_me.branch,
      'branch_id', v_me.branch_id, 'area', v_me.area, 'employment_status', v_me.employment_status,
      'employee_number', v_me.employee_number, 'staff_id', v_me.staff_id
    ) else null end,
    'selected_employee', case when v_scope = 'management' and v_employee_id is not null then (
      select jsonb_build_object(
        'id', e.id, 'full_name', e.full_name, 'email', e.email, 'department', e.department,
        'position', e."position", 'branch', e.branch, 'branch_id', e.branch_id, 'area', e.area,
        'employment_status', e.employment_status, 'employee_number', e.employee_number, 'staff_id', e.staff_id
      ) from public.employees e where e.id = v_employee_id and e.id = any(v_ids)
    ) else null end,
    'headcount', jsonb_build_object(
      'total', cardinality(v_ids),
      'active', (select count(*) from public.employees e where e.id = any(v_ids) and e.employment_status = 'active'),
      'on_leave', (select count(*) from public.employees e where e.id = any(v_ids) and e.employment_status = 'on_leave'),
      'terminated', (select count(*) from public.employees e where e.id = any(v_ids) and e.employment_status = 'terminated'),
      'unconfirmed', (select count(*) from public.employees e where e.id = any(v_ids) and e.confirmation_status = 'UNCONFIRMED')
    ),
    'onboarding', case when v_scope = 'self' then public.get_my_onboarding_status() else jsonb_build_object(
      'complete', v_onboarding_complete, 'pending_review', v_onboarding_pending,
      'not_started', greatest(cardinality(v_ids) - v_onboarding_complete - v_onboarding_pending, 0)
    ) end,
    'attendance', jsonb_build_object(
      'records', (select count(*) from public.attendance_records ar where ar.employee_id = any(v_ids) and ar.attendance_date between v_start and v_end),
      'present', (select count(*) from public.attendance_records ar where ar.employee_id = any(v_ids) and ar.attendance_date between v_start and v_end and ar.clock_in is not null),
      'late', v_late_count,
      'open_sessions', (select count(*) from public.attendance_records ar where ar.employee_id = any(v_ids) and ar.clock_in is not null and ar.clock_out is null),
      'issues_pending', (select count(*) from public.attendance_issues ai where ai.employee_id = any(v_ids) and ai.status = 'pending'),
      'exceptions_pending', (select count(*) from public.attendance_exceptions ae where ae.employee_id = any(v_ids) and ae.status = 'pending')
    ),
    'attendance_recent', case when v_scope = 'self' then coalesce((
      select jsonb_agg(to_jsonb(ar) order by ar.attendance_date desc)
      from (
        select id, attendance_date, clock_in, clock_out, work_hours, status, late_minutes
        from public.attendance_records
        where employee_id = v_me.id
        order by attendance_date desc
        limit 5
      ) ar
    ), '[]'::jsonb) else '[]'::jsonb end,
    'leave', jsonb_build_object(
      'pending', v_pending_leave,
      'approved_recent', (select count(*) from public.leave_requests lr where lr.created_by in (select e.user_id from public.employees e where e.id = any(v_ids) and e.user_id is not null) and lr.status = 'approved' and lr.created_at >= v_start)
    ),
    'performance', jsonb_build_object(
      'kpi_count', (select count(*) from public.employee_kpis k where k.employee_id = any(v_ids)),
      'below_target', v_below_kpi,
      'avg_achievement', (select round(avg((coalesce(k.actual_value, 0) / nullif(k.target_value, 0) * 100))::numeric, 1) from public.employee_kpis k where k.employee_id = any(v_ids) and k.target_value <> 0)
    ),
    'work', jsonb_build_object(
      'pending', (select count(*) from public.work_tasks wt where wt.employee_id = any(v_ids) and wt.status in ('assigned', 'accepted', 'in_progress')),
      'submitted', (select count(*) from public.work_tasks wt where wt.employee_id = any(v_ids) and wt.status in ('submitted', 'under_review')),
      'overdue', v_overdue_tasks,
      'completed', (select count(*) from public.work_tasks wt where wt.employee_id = any(v_ids) and wt.status = 'completed')
    ),
    'recruitment', case when v_role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') or upper(trim(coalesce(v_me."position", ''))) in ('MD', 'MD/CEO') then jsonb_build_object(
      'total', (select count(*) from public.hr_candidates),
      'active', (select count(*) from public.hr_candidates where application_status not in ('hired', 'rejected', 'withdrawn'))
    ) else null end,
    'branch_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('branch', x.branch_name, 'employees', x.employee_count, 'active', x.active_count) order by x.branch_name)
      from (
        select coalesce(b.branch_name, e.branch, 'Unassigned') branch_name, count(*) employee_count,
          count(*) filter (where e.employment_status = 'active') active_count
        from public.employees e left join public.branches b on b.id = e.branch_id
        where e.id = any(v_ids) group by coalesce(b.branch_name, e.branch, 'Unassigned')
      ) x
    ), '[]'::jsonb),
    'department_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('department', x.department, 'employees', x.employee_count, 'active', x.active_count) order by x.department)
      from (
        select coalesce(nullif(e.department, ''), 'Unassigned') department, count(*) employee_count,
          count(*) filter (where e.employment_status = 'active') active_count
        from public.employees e where e.id = any(v_ids) group by coalesce(nullif(e.department, ''), 'Unassigned')
      ) x
    ), '[]'::jsonb),
    'kpis', case when v_employee_id is not null then coalesce((
      select jsonb_agg(jsonb_build_object('id', k.id, 'kpi_name', k.kpi_name, 'target_value', k.target_value, 'actual_value', k.actual_value, 'unit', k.unit, 'status', k.status) order by k.updated_at desc)
      from public.employee_kpis k where k.employee_id = v_employee_id limit 8
    ), '[]'::jsonb) else '[]'::jsonb end,
    'leave_balances', case when v_scope = 'self' then coalesce((
      select jsonb_agg(jsonb_build_object('leave_type', lb.leave_type, 'entitled_days', lb.entitled_days, 'used_days', lb.used_days) order by lb.leave_type)
      from public.leave_balances lb where lb.employee_id = auth.uid() and lb.year = extract(year from current_date)::integer
    ), '[]'::jsonb) else '[]'::jsonb end,
    'recent_leave', case when v_scope = 'self' then coalesce((
      select jsonb_agg(to_jsonb(lr) order by lr.created_at desc)
      from (select * from public.leave_requests where created_by = auth.uid() order by created_at desc limit 5) lr
    ), '[]'::jsonb) else '[]'::jsonb end,
    'recent_tasks', case when v_scope = 'self' then coalesce((
      select jsonb_agg(to_jsonb(wt) order by wt.created_at desc)
      from (select * from public.work_tasks where assigned_to_user_id = auth.uid() order by created_at desc limit 5) wt
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;




-- 5d. training_is_manager — rename + all head roles (frontend grants them hr.training.read).
create or replace function public.training_is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in (
    'super_admin', 'admin', 'head_of_human_resources', 'hr_officer',
    'head_of_business', 'area_manager', 'branch_manager',
    'head_of_operations', 'head_of_e_business', 'financial_controller',
    'head_of_risk_compliance', 'head_of_legal', 'head_of_audit'
  );
$$;




create or replace function public.training_is_hr()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer');
$$;




-- ------------------------------------------------------------
-- 8. TRAINING DASHBOARD READ MODEL
-- ------------------------------------------------------------
create or replace function public.get_training_dashboard(
  p_start_date date default null,
  p_end_date date default null,
  p_area text default null,
  p_branch_id uuid default null,
  p_department text default null,
  p_employee_id uuid default null
) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_start date := coalesce(p_start_date, date_trunc('month', current_date)::date);
  v_end date := coalesce(p_end_date, current_date);
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_ids uuid[];
  v_area_scope text;
  v_branch_scope uuid;
  v_out jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;
  select * into v_me from public.employees where user_id = auth.uid() order by created_at desc limit 1;
  if v_role = 'branch_manager' then v_branch_scope := v_me.branch_id;
  elsif v_role = 'area_manager' then v_area_scope := v_me.area;
  elsif v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_business') then
    v_ids := array[v_me.id];
  end if;
  if p_branch_id is not null and v_branch_scope is not null and p_branch_id <> v_branch_scope then raise exception 'Not authorized for this branch.'; end if;
  if p_area is not null and v_area_scope is not null and lower(p_area) <> lower(v_area_scope) then raise exception 'Not authorized for this area.'; end if;
  if v_ids is null then
    select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids
    from public.employees e
    where coalesce(e.is_archived, false) = false
      and (p_employee_id is null or e.id = p_employee_id)
      and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department))
      and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area) or exists (
        select 1 from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id
        where baa.branch_id = e.branch_id and baa.is_current and lower(a.area_code) = lower(p_area)
      ))
      and (p_branch_id is null or e.branch_id = p_branch_id)
      and (v_branch_scope is null or e.branch_id = v_branch_scope)
      and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope) or exists (
        select 1 from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id
        where baa.branch_id = e.branch_id and baa.is_current and lower(a.area_code) = lower(v_area_scope)
      ));
  end if;
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'training_hours', coalesce((select round(sum(r.duration_minutes)::numeric / 60, 2) from public.employee_training_records r where r.employee_id = any(v_ids) and r.training_date between v_start and v_end), 0),
      'training_man_hours', coalesce((select round(sum(s.duration_minutes * x.participants)::numeric / 60, 2) from public.training_sessions s join lateral (
        select count(distinct tp.employee_id)::numeric as participants from public.training_participants tp where tp.session_id = s.id and tp.status not in ('absent', 'withdrawn') and tp.employee_id = any(v_ids)
      ) x on true where s.training_date between v_start and v_end and s.status <> 'cancelled'), 0),
      'employees_trained', (select count(distinct r.employee_id) from public.employee_training_records r where r.employee_id = any(v_ids) and r.training_date between v_start and v_end),
      'trainings_conducted', (select count(*) from public.training_sessions s where s.training_date between v_start and v_end and s.status <> 'cancelled'),
      'kss_sessions', (select count(*) from public.training_sessions s where s.training_date between v_start and v_end and s.training_type = 'kss' and s.status <> 'cancelled'),
      'certificates_issued', (select count(*) from public.training_certificates c where c.employee_id = any(v_ids) and c.training_date between v_start and v_end and c.verification_status = 'valid'),
      'average_assessment_score', (select round(avg(r.assessment_percentage), 2) from public.employee_training_records r where r.employee_id = any(v_ids) and r.training_date between v_start and v_end and r.assessment_percentage is not null),
      'completion_percentage', coalesce((select round(100.0 * count(*) filter (where tp.status = 'completed') / nullif(count(*), 0), 2) from public.training_participants tp join public.training_sessions s on s.id = tp.session_id where tp.employee_id = any(v_ids) and s.training_date between v_start and v_end), 0)
    ),
    'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', x.month_label, 'hours', x.hours) order by x.month_label) from (
      select to_char(date_trunc('month', r.training_date), 'YYYY-MM') as month_label, round(sum(r.duration_minutes)::numeric / 60, 2) hours
      from public.employee_training_records r where r.employee_id = any(v_ids) and r.training_date between v_start and v_end group by 1
    ) x), '[]'::jsonb),
    'by_area', coalesce((select jsonb_agg(jsonb_build_object('area', x.area, 'hours', x.hours, 'employees', x.employees) order by x.area) from (
      select coalesce(e.area, (select a.area_code from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id where baa.branch_id = e.branch_id and baa.is_current limit 1), 'Unassigned') area, round(sum(r.duration_minutes)::numeric / 60, 2) hours, count(distinct r.employee_id) employees
      from public.employee_training_records r join public.employees e on e.id = r.employee_id where r.employee_id = any(v_ids) and r.training_date between v_start and v_end group by 1
    ) x), '[]'::jsonb),
    'by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch', x.branch, 'hours', x.hours, 'employees', x.employees) order by x.branch) from (
      select coalesce(b.branch_name, e.branch, 'Unassigned') branch, round(sum(r.duration_minutes)::numeric / 60, 2) hours, count(distinct r.employee_id) employees
      from public.employee_training_records r join public.employees e on e.id = r.employee_id left join public.branches b on b.id = e.branch_id where r.employee_id = any(v_ids) and r.training_date between v_start and v_end group by 1
    ) x), '[]'::jsonb),
    'by_department', coalesce((select jsonb_agg(jsonb_build_object('department', x.department, 'hours', x.hours, 'employees', x.employees) order by x.department) from (
      select coalesce(e.department, 'Unassigned') department, round(sum(r.duration_minutes)::numeric / 60, 2) hours, count(distinct r.employee_id) employees
      from public.employee_training_records r join public.employees e on e.id = r.employee_id where r.employee_id = any(v_ids) and r.training_date between v_start and v_end group by 1
    ) x), '[]'::jsonb),
    'by_employee', coalesce((select jsonb_agg(jsonb_build_object('employee_id', x.employee_id, 'employee', x.employee, 'hours', x.hours, 'sessions', x.sessions) order by x.employee) from (
      select r.employee_id, e.full_name employee, round(sum(r.duration_minutes)::numeric / 60, 2) hours, count(*) sessions
      from public.employee_training_records r join public.employees e on e.id = r.employee_id where r.employee_id = any(v_ids) and r.training_date between v_start and v_end group by r.employee_id, e.full_name
    ) x), '[]'::jsonb),
    'mandatory', coalesce((select jsonb_agg(jsonb_build_object('session_id', x.session_id, 'title', x.title, 'assigned', x.assigned, 'completed', x.completed, 'completion_percentage', x.completion_percentage) order by x.training_date desc) from (
      select s.id session_id, s.title, s.training_date, count(tp.id) assigned, count(tp.id) filter (where tp.status = 'completed') completed,
        coalesce(round(100.0 * count(tp.id) filter (where tp.status = 'completed') / nullif(count(tp.id), 0), 2), 0) completion_percentage
      from public.training_sessions s join public.training_participants tp on tp.session_id = s.id and tp.employee_id = any(v_ids)
      where s.is_mandatory and s.training_date between v_start and v_end group by s.id, s.title, s.training_date
    ) x), '[]'::jsonb),
    'scope_employee_ids', to_jsonb(v_ids), 'start_date', v_start, 'end_date', v_end
  ) into v_out;
  return v_out;
end;
$$;




-- ------------------------------------------------------------
-- 8. MAN-HOUR INTELLIGENCE SCOPE (head roles see the whole org)
-- ------------------------------------------------------------
create or replace function public.get_man_hour_intelligence(
  p_start_date date default null,
  p_end_date date default null,
  p_area text default null,
  p_branch_id uuid default null,
  p_department text default null,
  p_employee_id uuid default null
) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_start date := coalesce(p_start_date, date_trunc('month', current_date)::date);
  v_end date := coalesce(p_end_date, current_date);
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_ids uuid[];
  v_area_scope text;
  v_branch_scope uuid;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;
  select * into v_me from public.employees where user_id = auth.uid() order by created_at desc limit 1;
  if v_role = 'branch_manager' then v_branch_scope := v_me.branch_id;
  elsif v_role = 'area_manager' then v_area_scope := v_me.area;
  elsif v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_business',
                       'head_of_operations', 'head_of_e_business', 'financial_controller',
                       'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') then v_ids := array[v_me.id]; end if;
  if p_branch_id is not null and v_branch_scope is not null and p_branch_id <> v_branch_scope then raise exception 'Not authorized for this branch.'; end if;
  if p_area is not null and v_area_scope is not null and lower(p_area) <> lower(v_area_scope) then raise exception 'Not authorized for this area.'; end if;
  if v_ids is null then
    select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids from public.employees e
    where coalesce(e.is_archived, false) = false
      and (p_employee_id is null or e.id = p_employee_id)
      and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department))
      and (p_branch_id is null or e.branch_id = p_branch_id)
      and (v_branch_scope is null or e.branch_id = v_branch_scope)
      and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area) or exists (select 1 from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id where baa.branch_id = e.branch_id and baa.is_current and lower(a.area_code) = lower(p_area)))
      and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope) or exists (select 1 from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id where baa.branch_id = e.branch_id and baa.is_current and lower(a.area_code) = lower(v_area_scope)));
  end if;
  with settings as (
    select coalesce(default_work_start_time, time '08:00') start_time, coalesce(default_work_end_time, time '17:00') end_time,
           coalesce(default_break_duration_minutes, 60) break_minutes, coalesce(default_working_days, array['mon','tue','wed','thu','fri']) working_days
    from public.hr_platform_settings where id = 1
  ), days as (
    select gs::date as work_day from generate_series(v_start, v_end, interval '1 day') gs
  ), employee_days as (
    select e.id employee_id, e.full_name, e.department,
      coalesce(e.area, (select a.area_code from public.branch_area_assignments baa join public.areas a on a.id = baa.area_id where baa.branch_id = e.branch_id and baa.is_current limit 1)) area,
      e.branch_id, coalesce(b.branch_name, e.branch, 'Unassigned') branch_name,
      d.work_day, coalesce(b.work_start_time, s.start_time) start_time, coalesce(b.work_end_time, s.end_time) end_time,
      coalesce(b.working_days, s.working_days) working_days, coalesce(b.grace_period_minutes, 15) grace_minutes,
      greatest(0, extract(epoch from (coalesce(b.work_end_time, s.end_time) - coalesce(b.work_start_time, s.start_time))) / 3600 - (s.break_minutes / 60.0)) scheduled_day_hours
    from public.employees e cross join days d cross join settings s left join public.branches b on b.id = e.branch_id
    where e.id = any(v_ids) and (e.hire_date is null or e.hire_date <= d.work_day) and e.employment_status <> 'terminated'
  ), workdays as (
    select * from employee_days where case extract(isodow from work_day)::int
      when 1 then 'mon' when 2 then 'tue' when 3 then 'wed' when 4 then 'thu' when 5 then 'fri' when 6 then 'sat' when 7 then 'sun' end = any(working_days)
  ), attendance as (
    select ar.employee_id, ar.attendance_date, sum(coalesce(ar.work_hours, ar.total_minutes::numeric / 60.0, case when ar.clock_in is not null and ar.clock_out is not null then extract(epoch from (ar.clock_out - ar.clock_in)) / 3600 else 0 end)) actual_hours,
      sum(coalesce(ar.late_minutes, 0)) late_minutes, sum(coalesce(ar.early_departure_minutes, 0)) early_minutes, count(*) records
    from public.attendance_records ar where ar.employee_id = any(v_ids) and ar.attendance_date between v_start and v_end group by ar.employee_id, ar.attendance_date
  ), workforce as (
    select w.employee_id, max(w.full_name) full_name, max(w.department) department, max(w.area) area, max(w.branch_name) branch_name,
      round(sum(w.scheduled_day_hours)::numeric, 2) scheduled_hours,
      round(sum(coalesce(a.actual_hours, 0))::numeric, 2) actual_hours,
      round(sum(case when coalesce(a.actual_hours, 0) = 0 then w.scheduled_day_hours else 0 end)::numeric, 2) absence_hours,
      round(sum(coalesce(a.late_minutes, 0))::numeric / 60, 2) late_hours,
      round(sum(coalesce(a.early_minutes, 0))::numeric / 60, 2) early_departure_hours,
      round(sum(greatest(0, coalesce(a.actual_hours, 0) - w.scheduled_day_hours))::numeric, 2) overtime_hours,
      sum(coalesce(a.records, 0)) attendance_records
    from workdays w left join attendance a on a.employee_id = w.employee_id and a.attendance_date = w.work_day group by w.employee_id
  ), training as (
    select r.employee_id, round(sum(r.duration_minutes)::numeric / 60, 2) training_hours,
      round(sum(case when r.training_type = 'kss' then r.duration_minutes else 0 end)::numeric / 60, 2) kss_hours,
      count(*) training_sessions
    from public.employee_training_records r where r.employee_id = any(v_ids) and r.training_date between v_start and v_end group by r.employee_id
  ), all_rows as (
    select w.*, coalesce(t.training_hours, 0) training_hours, coalesce(t.kss_hours, 0) kss_hours, coalesce(t.training_sessions, 0) training_sessions,
      coalesce((select round(sum(s.duration_minutes * p.participant_count)::numeric / 60, 2) from public.training_sessions s join lateral (
        select count(*)::numeric participant_count from public.training_participants tp where tp.session_id = s.id and tp.status not in ('absent', 'withdrawn') and tp.employee_id = w.employee_id
      ) p on true where s.training_date between v_start and v_end), 0) training_man_hours
    from workforce w left join training t on t.employee_id = w.employee_id
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'scheduled_hours', coalesce(round(sum(scheduled_hours)::numeric, 2), 0),
      'actual_attendance_hours', coalesce(round(sum(actual_hours)::numeric, 2), 0),
      'training_hours', coalesce(round(sum(training_hours)::numeric, 2), 0),
      'kss_hours', coalesce(round(sum(kss_hours)::numeric, 2), 0),
      'training_man_hours', coalesce((select round(sum(s.duration_minutes * p.participant_count)::numeric / 60, 2) from public.training_sessions s join lateral (select count(*)::numeric participant_count from public.training_participants tp where tp.session_id = s.id and tp.status not in ('absent', 'withdrawn') and tp.employee_id = any(v_ids)) p on true where s.training_date between v_start and v_end), 0),
      'overtime_hours', coalesce(round(sum(overtime_hours)::numeric, 2), 0),
      'absence_hours', coalesce(round(sum(absence_hours)::numeric, 2), 0),
      'late_hours', coalesce(round(sum(late_hours)::numeric, 2), 0),
      'early_departure_hours', coalesce(round(sum(early_departure_hours)::numeric, 2), 0),
      'attendance_compliance', coalesce(round(100 * sum(actual_hours) / nullif(sum(scheduled_hours), 0), 2), 0)
    ),
    'by_area', coalesce((select jsonb_agg(jsonb_build_object('area', x.area, 'scheduled_hours', x.scheduled_hours, 'actual_hours', x.actual_hours, 'training_hours', x.training_hours, 'training_man_hours', x.training_man_hours, 'employees', x.employees) order by x.area) from (select coalesce(area, 'Unassigned') area, round(sum(scheduled_hours)::numeric, 2) scheduled_hours, round(sum(actual_hours)::numeric, 2) actual_hours, round(sum(training_hours)::numeric, 2) training_hours, round(sum(training_man_hours)::numeric, 2) training_man_hours, count(*) employees from all_rows group by 1) x), '[]'::jsonb),
    'by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch', x.branch_name, 'scheduled_hours', x.scheduled_hours, 'actual_hours', x.actual_hours, 'training_hours', x.training_hours, 'training_man_hours', x.training_man_hours, 'employees', x.employees) order by x.branch_name) from (select branch_name, round(sum(scheduled_hours)::numeric, 2) scheduled_hours, round(sum(actual_hours)::numeric, 2) actual_hours, round(sum(training_hours)::numeric, 2) training_hours, round(sum(training_man_hours)::numeric, 2) training_man_hours, count(*) employees from all_rows group by 1) x), '[]'::jsonb),
    'by_department', coalesce((select jsonb_agg(jsonb_build_object('department', x.department, 'scheduled_hours', x.scheduled_hours, 'actual_hours', x.actual_hours, 'training_hours', x.training_hours, 'training_man_hours', x.training_man_hours, 'employees', x.employees) order by x.department) from (select coalesce(department, 'Unassigned') department, round(sum(scheduled_hours)::numeric, 2) scheduled_hours, round(sum(actual_hours)::numeric, 2) actual_hours, round(sum(training_hours)::numeric, 2) training_hours, round(sum(training_man_hours)::numeric, 2) training_man_hours, count(*) employees from all_rows group by 1) x), '[]'::jsonb),
    'by_employee', coalesce((select jsonb_agg(to_jsonb(x) order by x.full_name) from (select employee_id, full_name, department, area, branch_name, scheduled_hours, actual_hours, absence_hours, late_hours, early_departure_hours, overtime_hours, training_hours, kss_hours, training_man_hours, training_sessions from all_rows) x), '[]'::jsonb),
    'start_date', v_start, 'end_date', v_end, 'scope_employee_ids', to_jsonb(v_ids)
  ) into v_result from all_rows;
  return coalesce(v_result, jsonb_build_object('summary', '{}'::jsonb, 'by_employee', '[]'::jsonb));
end;
$$;




-- ------------------------------------------------------------
-- 2. provision_employee_account — never null-wipes employee-backed profile
--    fields. Employee values still take precedence when present.
-- ------------------------------------------------------------
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
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
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
    v_branch := coalesce(nullif(trim(v_branch_name), ''), v_branch);
  end if;

  update public.profiles
  set full_name = coalesce(v_employee.full_name, v_target.full_name),
      phone = coalesce(nullif(trim(v_employee.phone), ''), v_target.phone),
      department = coalesce(v_department, v_target.department),
      branch = coalesce(v_branch, v_target.branch),
      employee_number = coalesce(v_employee.employee_number, v_target.employee_number),
      designation = coalesce(public.employee_designation_label(v_employee."position", v_employee.designation_id), v_target.designation),
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
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources') then
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




create or replace function public.hr_move_candidate_to_talent_pool(
  p_candidate_id uuid,
  p_note text default null,
  p_preferred_areas jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  update public.hr_candidates set application_status = 'talent_pool', talent_pool_added_at = coalesce(talent_pool_added_at, now()),
    status_change_note = coalesce(nullif(p_note, ''), 'Moved to talent pool') where id = p_candidate_id;
  insert into public.recruitment_talent_pool (candidate_id, added_by, preferred_areas, notes)
  values (p_candidate_id, auth.uid(), coalesce(p_preferred_areas, '[]'::jsonb), nullif(p_note, ''))
  on conflict (candidate_id) do update set active = true, updated_at = now(), notes = coalesce(excluded.notes, recruitment_talent_pool.notes),
    preferred_areas = coalesce(excluded.preferred_areas, recruitment_talent_pool.preferred_areas);
  perform public.record_recruitment_event(p_candidate_id, 'TALENT_POOL_ADDED', 'Candidate moved to Talent Pool',
    jsonb_build_object('note', coalesce(p_note, '')));
  perform public.hr_audit('CANDIDATE_MOVED_TO_TALENT_POOL', 'Candidate', p_candidate_id::text, coalesce(p_note, 'Candidate retained in Talent Pool'));
  return jsonb_build_object('ok', true, 'candidate_id', p_candidate_id, 'status', 'talent_pool');
end; $$;




create or replace function public.hr_blacklist_candidate(p_candidate_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then raise exception 'Only authorized HR managers can blacklist candidates'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A documented reason is required'; end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  update public.hr_candidates set application_status = 'blacklisted', blacklisted_at = now(), blacklisted_by = auth.uid(),
    blacklist_reason = btrim(p_reason), status_change_note = 'Candidate blacklisted with documented reason' where id = p_candidate_id;
  update public.recruitment_talent_pool set active = false, updated_at = now() where candidate_id = p_candidate_id;
  perform public.record_recruitment_event(p_candidate_id, 'CANDIDATE_BLACKLISTED', 'Candidate blacklisted',
    jsonb_build_object('reason', btrim(p_reason)));
  perform public.hr_audit('CANDIDATE_BLACKLISTED', 'Candidate', p_candidate_id::text, btrim(p_reason));
  return jsonb_build_object('ok', true, 'candidate_id', p_candidate_id, 'status', 'blacklisted');
end; $$;




create or replace function public.hr_generate_talent_pool_matches(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_job public.hr_jobs;
  v_candidate record;
  v_requirements jsonb;
  v_required_count int;
  v_match_count int;
  v_skill_score numeric;
  v_experience_score numeric;
  v_score numeric;
  v_reasons jsonb;
  v_count int := 0;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_job from public.hr_jobs where id = p_job_id;
  if v_job.id is null then raise exception 'Job not found'; end if;
  v_requirements := coalesce(v_job.required_skills, '[]'::jsonb) || coalesce(v_job.preferred_skills, '[]'::jsonb);
  v_required_count := jsonb_array_length(v_requirements);

  for v_candidate in
    select c.* from public.recruitment_talent_pool p
    join public.hr_candidates c on c.id = p.candidate_id
    where p.active = true and c.application_status <> 'blacklisted'
  loop
    if v_required_count = 0 then
      v_skill_score := 50;
      v_match_count := 0;
    else
      select count(*) into v_match_count
      from jsonb_array_elements_text(v_requirements) req
      where exists (
        select 1 from unnest(coalesce(v_candidate.skills, '{}'::text[])) skill
        where lower(skill) = lower(req) or lower(skill) like '%' || lower(req) || '%'
      ) or position(lower(req) in lower(coalesce(v_candidate.cover_letter, '') || ' ' || coalesce(v_candidate.current_company, ''))) > 0;
      v_skill_score := round((v_match_count::numeric / greatest(v_required_count, 1)) * 100, 2);
    end if;
    v_experience_score := case when coalesce(v_job.experience_years, 0) <= 0 then 100
      else least(100, round(coalesce(v_candidate.years_experience, 0)::numeric / v_job.experience_years * 100, 2)) end;
    v_score := round(v_skill_score * 0.7 + v_experience_score * 0.3, 2);
    if v_score >= 70 then
      v_reasons := jsonb_build_array(
        format('%s of %s configured skills appear in the documented profile', v_match_count, greatest(v_required_count, 0)),
        format('%s years documented experience against %s years requested', coalesce(v_candidate.years_experience, 0), coalesce(v_job.experience_years, 0))
      );
      insert into public.recruitment_talent_pool_matches (job_id, candidate_id, match_score, reasons)
      values (p_job_id, v_candidate.id, v_score, v_reasons)
      on conflict (job_id, candidate_id) do update set match_score = excluded.match_score, reasons = excluded.reasons,
        status = case when recruitment_talent_pool_matches.status = 'dismissed' then 'dismissed' else 'open' end, updated_at = now();
      update public.hr_candidates set match_score = v_score, match_breakdown = jsonb_build_object(
        'skills', v_skill_score, 'experience', v_experience_score, 'weights', jsonb_build_object('skills', 70, 'experience', 30),
        'reasons', v_reasons) where id = v_candidate.id;
      begin
        insert into public.notifications (user_id, title, message, type, link)
        values (v_job.created_by, 'SARA Talent Pool Match',
          format('Boss, I noticed the new %s role. A Talent Pool candidate has a documented %s%% job-related match. Can we review the candidate together?', v_job.job_title, v_score),
          'hr', '/recruitment?job=' || p_job_id::text || '&tab=talent-pool');
      exception when others then null;
      end;
      v_count := v_count + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'job_id', p_job_id, 'matches', v_count);
end; $$;




create or replace function public.recruitment_job_pool_match_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.id is not null and public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    perform public.hr_generate_talent_pool_matches(new.id);
  end if;
  return new;
end; $$;




-- ------------------------------------------------------------
-- 4. Secure candidate creation/CV replacement and interviews
-- ------------------------------------------------------------
create or replace function public.hr_create_manual_candidate(p_data jsonb)
returns public.hr_candidates language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
  v_job_id uuid;
  v_job public.hr_jobs;
  v_name text := nullif(btrim(coalesce(p_data ->> 'full_name', '')), '');
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  if v_name is null then raise exception 'Full name is required'; end if;
  if nullif(p_data ->> 'job_id', '') is not null then v_job_id := (p_data ->> 'job_id')::uuid; end if;
  if v_job_id is not null then
    select * into v_job from public.hr_jobs where id = v_job_id;
    if v_job.id is null then raise exception 'Job not found'; end if;
  end if;
  insert into public.hr_candidates (
    job_id, full_name, email, phone, location, current_company, years_experience, cover_letter,
    applied_role, department, branch, application_status, application_source, source_detail, skills
  ) values (
    v_job_id, v_name, nullif(lower(btrim(coalesce(p_data ->> 'email', ''))), ''),
    nullif(btrim(coalesce(p_data ->> 'phone', '')), ''), nullif(btrim(coalesce(p_data ->> 'location', '')), ''),
    nullif(btrim(coalesce(p_data ->> 'current_company', '')), ''),
    case when nullif(p_data ->> 'years_experience', '') is null then null else (p_data ->> 'years_experience')::int end,
    nullif(btrim(coalesce(p_data ->> 'cover_letter', '')), ''),
    coalesce(nullif(btrim(coalesce(p_data ->> 'applied_role', '')), ''), v_job.job_title),
    coalesce(nullif(btrim(coalesce(p_data ->> 'department', '')), ''), v_job.department),
    coalesce(nullif(btrim(coalesce(p_data ->> 'branch', '')), ''), v_job.branch),
    'received', 'manual', nullif(btrim(coalesce(p_data ->> 'source_detail', '')), ''),
    case when jsonb_typeof(p_data -> 'skills') = 'array'
      then array(select jsonb_array_elements_text(p_data -> 'skills')) else '{}'::text[] end
  ) returning * into v_candidate;
  insert into public.hr_candidate_status_history (candidate_id, from_status, to_status, changed_by, changed_by_name, note)
  values (v_candidate.id, null, 'received', auth.uid(), (select full_name from public.profiles where id = auth.uid()), 'Manual candidate created by HR');
  perform public.hr_audit('CANDIDATE_CREATED', 'Candidate', v_candidate.id::text, 'Manual candidate created');
  return v_candidate;
end; $$;




create or replace function public.hr_attach_candidate_cv(
  p_candidate_id uuid, p_path text, p_name text, p_size int, p_mime text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
  v_mime text := lower(coalesce(p_mime, ''));
  v_name text := lower(coalesce(p_name, ''));
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  if p_path is null or position('..' in p_path) > 0 then raise exception 'Invalid CV path'; end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  if p_path not like 'cvs/%' and p_path not like ('recruitment/' || p_candidate_id::text || '/cv/%') then raise exception 'CV path is outside the recruitment namespace'; end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then raise exception 'CV must be between 1 byte and 10 MB'; end if;
  if v_mime not in ('application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
     and v_name !~* '\.(pdf|doc|docx)$' then raise exception 'CV must be PDF, DOC or DOCX'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'career' and name = p_path) then raise exception 'Uploaded CV object was not found'; end if;

  update public.hr_candidates set cv_file_path = p_path, cv_file_name = p_name, cv_file_size = p_size, cv_file_mime = p_mime,
    status_change_note = 'CV uploaded or replaced' where id = p_candidate_id;
  insert into public.documents (entity_type, entity_id, document_type, file_name, file_path, file_size, mime_type, is_required, uploaded_by)
  values ('hr_candidate', p_candidate_id, 'cv', coalesce(p_name, 'resume'), p_path, p_size, p_mime, true, auth.uid());
  perform public.record_recruitment_event(p_candidate_id, 'CV_UPLOADED', 'CV uploaded or replaced',
    jsonb_build_object('file_name', p_name, 'file_size', p_size, 'mime_type', p_mime));
  perform public.hr_audit('CV_UPLOADED', 'Candidate', p_candidate_id::text, coalesce(p_name, 'CV uploaded or replaced'));
  return jsonb_build_object('ok', true, 'candidate_id', p_candidate_id, 'path', p_path);
end; $$;




create or replace function public.hr_schedule_recruitment_interview(p_candidate_id uuid, p_data jsonb)
returns public.hr_interviews language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_candidate public.hr_candidates;
  v_interview public.hr_interviews;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then raise exception 'Candidate not found'; end if;
  if nullif(p_data ->> 'scheduled_date', '') is null then raise exception 'Interview date and time are required'; end if;
  insert into public.hr_interviews (
    candidate_id, candidate_name, candidate_email, "position", interview_type, location, platform, meeting_url,
    scheduled_date, duration_minutes, status, interviewer_id, interview_instructions, notification_status,
    interview_round
  ) values (
    p_candidate_id, v_candidate.full_name, coalesce(v_candidate.email, ''),
    coalesce(nullif(p_data ->> 'position', ''), v_candidate.applied_role),
    coalesce(nullif(p_data ->> 'interview_type', ''), 'PHYSICAL'),
    nullif(p_data ->> 'location', ''), nullif(p_data ->> 'platform', ''), nullif(p_data ->> 'meeting_url', ''),
    (p_data ->> 'scheduled_date')::timestamptz, coalesce((p_data ->> 'duration_minutes')::int, 30), 'scheduled',
    coalesce(nullif(p_data ->> 'interviewer_id', '')::uuid, auth.uid()), nullif(p_data ->> 'notes', ''), 'pending',
    coalesce((p_data ->> 'interview_round')::int, 1)
  ) returning * into v_interview;
  update public.hr_candidates set application_status = 'interview', status_change_note = 'Interview invitation created'
    where id = p_candidate_id and application_status in ('received', 'screening', 'shortlisted', 'assessment_passed', 'assessment');
  perform public.hr_audit('INTERVIEW_CREATED', 'Interview', v_interview.id::text, 'Interview invitation created');
  return v_interview;
end; $$;




create or replace function public.hr_complete_recruitment_interview(
  p_interview_id uuid, p_feedback text, p_rating numeric, p_competency_scores jsonb default '{}',
  p_strengths text default null, p_concerns text default null, p_recommendation text default 'hold', p_outcome text default null
)
returns public.hr_interviews language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_interview public.hr_interviews;
  v_target text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  if p_rating is null or p_rating < 0 or p_rating > 5 then raise exception 'Rating must be between 0 and 5'; end if;
  if p_recommendation not in ('proceed', 'hold', 'reject') then raise exception 'Invalid interview recommendation'; end if;
  update public.hr_interviews set status = 'completed', feedback = nullif(p_feedback, ''), rating = p_rating,
    competency_scores = coalesce(p_competency_scores, '{}'::jsonb), strengths = nullif(p_strengths, ''),
    concerns = nullif(p_concerns, ''), recommendation = p_recommendation, outcome = nullif(p_outcome, ''), updated_at = now()
    where id = p_interview_id returning * into v_interview;
  if v_interview.id is null then raise exception 'Interview not found'; end if;
  v_target := case when p_recommendation = 'proceed' then 'recommended' when p_recommendation = 'reject' then 'rejected' else 'interviewed' end;
  update public.hr_candidates set application_status = v_target, status_change_note = 'Interview completed: ' || p_recommendation
    where id = v_interview.candidate_id and application_status not in ('hired', 'offer_accepted', 'onboarding', 'blacklisted');
  perform public.record_recruitment_event(v_interview.candidate_id, 'INTERVIEW_COMPLETED', 'Interview completed',
    jsonb_build_object('interview_id', p_interview_id, 'rating', p_rating, 'recommendation', p_recommendation,
      'competency_scores', coalesce(p_competency_scores, '{}'::jsonb)));
  perform public.hr_audit('INTERVIEW_COMPLETED', 'Interview', p_interview_id::text, 'Interview feedback recorded');
  return v_interview;
end; $$;




-- ------------------------------------------------------------
-- 8. Real recruitment dashboard aggregates
-- ------------------------------------------------------------
create or replace function public.hr_recruitment_dashboard_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_by_job jsonb;
  v_by_department jsonb;
  v_funnel jsonb;
  v_stage_time jsonb;
  v_sources jsonb;
  v_assessment_pass numeric;
  v_interview_conversion numeric;
  v_offer_conversion numeric;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then raise exception 'Not authorized'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('job_id', x.job_id, 'job_title', x.job_title, 'applications', x.applications) order by x.applications desc), '[]'::jsonb)
    into v_by_job from (select c.job_id, coalesce(j.job_title, c.applied_role, 'Unassigned') job_title, count(*) applications
      from public.hr_candidates c left join public.hr_jobs j on j.id = c.job_id group by c.job_id, j.job_title, c.applied_role) x;
  select coalesce(jsonb_agg(jsonb_build_object('department', coalesce(department, 'Unassigned'), 'applications', applications) order by applications desc), '[]'::jsonb)
    into v_by_department from (select department, count(*) applications from public.hr_candidates group by department) x;
  select coalesce(jsonb_object_agg(application_status, total), '{}'::jsonb) into v_funnel
    from (select application_status, count(*) total from public.hr_candidates group by application_status) x;
  select coalesce(jsonb_object_agg(stage, round(avg(days_in_stage)::numeric, 2)), '{}'::jsonb) into v_stage_time
    from (with transitions as (
      select to_status stage, created_at, lead(created_at) over (partition by candidate_id order by created_at) next_at
      from public.hr_candidate_status_history
    ) select stage, extract(epoch from (coalesce(next_at, now()) - created_at)) / 86400 days_in_stage from transitions) x;
  select coalesce(jsonb_object_agg(coalesce(application_source, 'other'), total), '{}'::jsonb) into v_sources
    from (select application_source, count(*) total from public.hr_candidates group by application_source) x;
  select case when count(*) = 0 then 0 else round((count(*) filter (where coalesce(score, 0) >= coalesce(pass_score, 60))::numeric / count(*) * 100), 2) end into v_assessment_pass
    from public.hr_assessments where status = 'completed';
  select case when count(*) = 0 then 0 else round((count(*) filter (where status = 'completed')::numeric / count(*) * 100), 2) end into v_interview_conversion
    from public.hr_interviews;
  select case when count(*) = 0 then 0 else round((count(*) filter (where status = 'accepted')::numeric / count(*) * 100), 2) end into v_offer_conversion
    from public.offer_letters where status in ('issued', 'accepted', 'declined');
  return jsonb_build_object(
    'open_jobs', (select count(*) from public.hr_jobs where status = 'published'),
    'applications', (select count(*) from public.hr_candidates),
    'new_applicants', (select count(*) from public.hr_candidates where created_at >= current_date),
    'assessment_pending', (select count(*) from public.hr_candidates where application_status = 'assessment'),
    'assessment_completed', (select count(*) from public.hr_assessments where status = 'completed'),
    'interview_pending', (select count(*) from public.hr_candidates where application_status = 'interview'),
    'offers_pending', (select count(*) from public.hr_candidates where application_status = 'offer'),
    'hired', (select count(*) from public.hr_candidates where application_status = 'hired'),
    'talent_pool', (select count(*) from public.recruitment_talent_pool where active = true),
    'rejected', (select count(*) from public.hr_candidates where application_status = 'rejected'),
    'blacklisted', (select count(*) from public.hr_candidates where application_status = 'blacklisted'),
    'by_job', v_by_job, 'by_department', v_by_department, 'funnel', v_funnel,
    'average_time_in_stage_days', v_stage_time, 'assessment_pass_rate', v_assessment_pass,
    'interview_conversion', v_interview_conversion, 'offer_conversion', v_offer_conversion, 'source_breakdown', v_sources
  );
end; $$;


-- ============================================================
-- PHASE 55: SCOPED DASHBOARD ATTENDANCE TODAY
-- ------------------------------------------------------------
-- The dashboard must calculate today's attendance from the same
-- authorized employee scope used by get_dashboard_snapshot. This prevents
-- a valid clock-in being hidden when the viewer is an MD/CEO, branch
-- manager, or area manager (roles not covered by the old global summary).
-- ============================================================

create or replace function public.get_dashboard_attendance_today(
  p_branch_id uuid default null,
  p_department text default null,
  p_employee_id uuid default null,
  p_area text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_me public.employees%rowtype;
  v_org_scope boolean := false;
  v_branch_scope uuid;
  v_area_scope text;
  v_employee_id uuid := p_employee_id;
  v_ids uuid[] := '{}'::uuid[];
  v_today date := (clock_timestamp() at time zone public.att_app_timezone())::date;
  v_dow text := lower(to_char(clock_timestamp() at time zone public.att_app_timezone(), 'Dy'));
  v_working_days text[];
  v_working_day boolean := false;
  v_total integer := 0;
  v_present integer := 0;
  v_late integer := 0;
  v_on_leave integer := 0;
  v_avg numeric := 0;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into v_me
  from public.employees
  where user_id = auth.uid()
  order by created_at desc
  limit 1;

  v_org_scope := v_role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'head_of_business')
    or upper(trim(coalesce(v_me."position", ''))) in ('MD', 'MD/CEO');

  if v_role = 'branch_manager' then
    v_branch_scope := v_me.branch_id;
    if p_branch_id is not null and p_branch_id is distinct from v_branch_scope then
      raise exception 'Not authorized for this branch';
    end if;
    if v_branch_scope is null then v_employee_id := v_me.id; end if;
  elsif v_role = 'area_manager' then
    v_area_scope := v_me.area;
    if p_area is not null and lower(p_area) <> lower(coalesce(v_area_scope, '')) then
      raise exception 'Not authorized for this area';
    end if;
    if v_area_scope is null then v_employee_id := v_me.id; end if;
  elsif not v_org_scope then
    v_employee_id := v_me.id;
  end if;

  select coalesce(array_agg(e.id), '{}'::uuid[]) into v_ids
  from public.employees e
  where e.employment_status = 'active'
    and coalesce(e.is_archived, false) = false
    and (v_org_scope or v_me.id is not null)
    and (v_employee_id is null or e.id = v_employee_id)
    and (v_branch_scope is null or e.branch_id = v_branch_scope)
    and (p_branch_id is null or e.branch_id = p_branch_id)
    and (v_area_scope is null or lower(coalesce(e.area, '')) = lower(v_area_scope)
      or exists (
        select 1
        from public.branch_area_assignments baa
        join public.areas a on a.id = baa.area_id
        where baa.branch_id = e.branch_id and baa.is_current
          and lower(a.area_code) = lower(v_area_scope)
      ))
    and (p_area is null or lower(coalesce(e.area, '')) = lower(p_area))
    and (p_department is null or lower(coalesce(e.department, '')) = lower(p_department));

  select default_working_days into v_working_days
  from public.hr_platform_settings
  where id = 1;
  select exists (
    select 1 from unnest(coalesce(v_working_days, '{}'::text[])) day_name
    where lower(left(day_name, 3)) = v_dow
  ) into v_working_day;

  v_total := cardinality(v_ids);
  select count(distinct ar.employee_id) into v_present
  from public.attendance_records ar
  where ar.employee_id = any(v_ids)
    and ar.attendance_date = v_today
    and ar.clock_in is not null;
  select count(distinct ar.employee_id) into v_late
  from public.attendance_records ar
  where ar.employee_id = any(v_ids)
    and ar.attendance_date = v_today
    and ar.clock_in is not null
    and (coalesce(ar.late_minutes, 0) > 0 or ar.status = 'late');
  select count(distinct e.id) into v_on_leave
  from public.employees e
  join public.leave_requests lr on lr.created_by = e.user_id
  where e.id = any(v_ids)
    and lr.status = 'approved'
    and lr.start_date <= v_today
    and lr.end_date >= v_today;
  select coalesce(round(avg(coalesce(ar.work_hours, extract(epoch from (ar.clock_out - ar.clock_in)) / 3600.0))::numeric, 1), 0)
    into v_avg
  from public.attendance_records ar
  where ar.employee_id = any(v_ids)
    and ar.attendance_date = v_today
    and ar.clock_in is not null
    and ar.clock_out is not null;

  return jsonb_build_object(
    'date', v_today,
    'timezone', public.att_app_timezone(),
    'working_day', v_working_day,
    'working_days', coalesce(v_working_days, '{}'::text[]),
    'total_employees', v_total,
    'present_today', v_present,
    'absent_today', case when v_working_day then greatest(0, v_total - v_on_leave - v_present) else 0 end,
    'on_leave_today', v_on_leave,
    'late_today', v_late,
    'attendance_percent', case when v_total > 0 then round((v_present::numeric / v_total) * 100, 1) else 0 end,
    'average_hours', v_avg
  );
end;
$$;




create or replace function public.update_hr_signature(
  p_signature_type text,
  p_signature_path text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_old_path text;
  v_key text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to update document signatures.';
  end if;
  if p_signature_type not in ('management', 'head_of_human_resources') then
    raise exception 'Invalid document signature type.';
  end if;
  if p_signature_path is not null and (
    length(trim(p_signature_path)) = 0
    or p_signature_path !~ '^signatures/(management|hr-manager)/[A-Za-z0-9._/-]+\.png$'
  ) then
    raise exception 'Invalid signature storage path.';
  end if;

  if p_signature_type = 'management' then
    select management_signature_path into v_old_path
    from public.hr_platform_settings where id = 1;
    v_key := 'management_signature_path';
    update public.hr_platform_settings
    set management_signature_path = nullif(trim(p_signature_path), ''),
        updated_at = now(), updated_by = auth.uid()
    where id = 1;
  else
    select hr_manager_signature_path into v_old_path
    from public.hr_platform_settings where id = 1;
    v_key := 'hr_manager_signature_path';
    update public.hr_platform_settings
    set hr_manager_signature_path = nullif(trim(p_signature_path), ''),
        updated_at = now(), updated_by = auth.uid()
    where id = 1;
  end if;

  if v_old_path is distinct from nullif(trim(p_signature_path), '') then
    insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
    values (v_key, v_old_path, nullif(trim(p_signature_path), ''), auth.uid());
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'DOCUMENT_SIGNATURE_UPDATED',
      'PlatformSettings',
      '1',
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      format('Updated %s document signature configuration.', p_signature_type),
      'info'
    );
  end if;

  return jsonb_build_object('ok', true, 'signature_type', p_signature_type,
    'signature_path', nullif(trim(p_signature_path), ''));
end;
$$;




create or replace function public.update_employee_signature(
  p_employee_id uuid,
  p_signature_path text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_employee public.employees;
  v_allowed boolean := false;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then raise exception 'Employee not found.'; end if;
  if p_signature_path is not null and (
    length(trim(p_signature_path)) = 0
    or p_signature_path !~ '^signatures/employees/[A-Za-z0-9-]+/[A-Za-z0-9._/-]+\.png$'
  ) then
    raise exception 'Invalid employee signature storage path.';
  end if;

  v_allowed := v_role in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
    or v_employee.user_id = auth.uid();
  if not v_allowed then raise exception 'Not authorized to update this employee signature.'; end if;

  update public.employees
  set signature_url = nullif(trim(p_signature_path), ''), updated_at = now()
  where id = p_employee_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_SIGNATURE_UPDATED',
    'Employee',
    p_employee_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    'Employee card-holder signature updated.',
    'info'
  );

  return jsonb_build_object('ok', true, 'employee_id', p_employee_id,
    'signature_path', nullif(trim(p_signature_path), ''));
end;
$$;




-- 10b. 4-arg approve_user (userApprovalService / WorkManagement).
create or replace function public.approve_user(
  p_user_id uuid,
  p_role text default 'customer',
  p_department text default null,
  p_modules jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_target record;
  v_employee public.employees;
  v_dept text;
  v_branch text;
  v_designation text;
  v_prev_status text;
  v_prev_role text;
  v_prev_employee_id uuid;
  v_emp_id uuid;
  v_emp_code text;
  v_effective_role text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'head_of_human_resources', 'area_manager', 'branch_manager', 'head_of_business', 'head_of_operations', 'head_of_e_business', 'financial_controller', 'head_of_risk_compliance', 'head_of_legal', 'head_of_audit') then
    raise exception 'Not authorized to approve users';
  end if;
  if p_role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can assign the super_admin role';
  end if;
  if p_role = 'admin' and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Only super_admin or admin can assign the admin role';
  end if;
  if p_role in ('area_manager', 'head_of_business', 'head_of_operations', 'head_of_e_business',
                'financial_controller', 'head_of_risk_compliance', 'head_of_legal', 'head_of_audit')
     and v_actor_role not in ('super_admin', 'admin') then
    raise exception 'Only super_admin or admin can assign this role';
  end if;
  if v_actor_role in ('branch_manager', 'area_manager') and p_role not in ('staff', 'loan_officer', 'relationship_manager', 'customer_service') then
    raise exception 'This role cannot be assigned by you';
  end if;

  select * into v_target
  from public.profiles
  where id = p_user_id
  for update;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.role = 'super_admin' and v_actor_role <> 'super_admin' then
    raise exception 'Cannot modify Super Admin accounts';
  end if;

  v_prev_status := v_target.status;
  v_prev_role := v_target.role;
  v_prev_employee_id := v_target.employee_id;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  -- Resolve the source-of-truth employee (link, auth-user link, email).
  select e.* into v_employee
  from public.employees e
  where e.user_id = p_user_id
     or e.id = v_target.employee_id
     or (v_target.email is not null and lower(e.email) = lower(v_target.email))
  order by case
             when e.user_id = p_user_id then 0
             when e.id = v_target.employee_id then 1
             else 2
           end
  limit 1;

  v_dept := v_employee.department;
  v_branch := v_employee.branch;
  if v_employee.branch_id is not null then
    select branch_name into v_branch from public.branches where id = v_employee.branch_id;
    v_branch := coalesce(v_branch, v_employee.branch);
  end if;
  v_designation := public.employee_designation_label(v_employee."position", v_employee.designation_id);
  v_effective_role := coalesce(nullif(trim(p_role), ''), 'customer');

  update public.profiles
  set status = 'active',
      approved = true,
      role = v_effective_role,
      department = coalesce(nullif(trim(p_department), ''), v_dept, department),
      branch = coalesce(v_branch, branch),
      employee_number = coalesce(v_employee.employee_number, employee_number),
      designation = coalesce(v_designation, designation),
      approved_by = auth.uid(),
      approved_at = now(),
      rejected_reason = null
  where id = p_user_id;

  -- Access profile
  if p_modules is not null then
    insert into public.user_access_profiles (user_id, modules, granted_by, granted_at, updated_at)
    values (p_user_id, p_modules, auth.uid(), now(), now())
    on conflict (user_id)
    do update set modules = excluded.modules,
                  granted_by = auth.uid(),
                  granted_at = now(),
                  updated_at = now();
  end if;

  -- Approval audit
  insert into public.user_approval_audit (user_id, action, previous_status, new_status, previous_role, new_role, department, approver_id, approver_name)
  values (p_user_id, 'USER_APPROVED', v_prev_status, 'active', v_prev_role, v_effective_role, coalesce(nullif(trim(p_department), ''), v_dept), auth.uid(), v_actor_name);

  -- Role change audit
  if v_prev_role is distinct from v_effective_role then
    insert into public.user_approval_audit (user_id, action, previous_role, new_role, approver_id, approver_name)
    values (p_user_id, 'USER_ROLE_CHANGED', v_prev_role, v_effective_role, auth.uid(), v_actor_name);
  end if;

  -- Department audit
  if p_department is not null then
    insert into public.user_approval_audit (user_id, action, department, approver_id, approver_name)
    values (p_user_id, 'USER_DEPARTMENT_CHANGED', p_department, auth.uid(), v_actor_name);
  end if;

  -- Access audit
  if p_modules is not null then
    insert into public.user_approval_audit (user_id, action, approver_id, approver_name)
    values (p_user_id, 'USER_ACCESS_CHANGED', auth.uid(), v_actor_name);
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('USER_APPROVED', 'User', p_user_id::text, v_actor_name,
          format('User approved: role=%s, department=%s', v_effective_role, coalesce(nullif(trim(p_department), ''), v_dept, 'none')),
          'critical');

  -- Link/create the employee record for staff roles (never duplicate).
  if v_effective_role in ('staff', 'head_of_human_resources', 'hr_officer', 'branch_manager', 'area_manager',
                          'head_of_business', 'head_of_operations', 'head_of_e_business',
                          'financial_controller', 'head_of_risk_compliance', 'head_of_legal',
                          'head_of_audit', 'loan_officer',
                          'relationship_manager', 'customer_service', 'admin') then
    if v_prev_employee_id is not null then
      v_emp_id := v_prev_employee_id;
    else
      select id into v_emp_id from public.employees
        where user_id = p_user_id
           or (v_target.email is not null and lower(email) = lower(v_target.email))
        limit 1;
    end if;

    if v_emp_id is null then
      v_emp_code := public.generate_employee_code();
      insert into public.employees (
        user_id, full_name, email, department, "position", branch,
        employment_status, employee_code, source, created_by, hire_date, updated_at
      ) values (
        p_user_id, coalesce(v_target.full_name, v_target.email, 'Unknown'),
        v_target.email, coalesce(nullif(trim(p_department), ''), v_dept), v_designation, v_branch,
        'active', v_emp_code, 'manual', auth.uid(), now()::date, now()
      )
      returning id into v_emp_id;

      insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
      values ('EMPLOYEE_AUTO_CREATED', 'Employee', v_emp_id::text, v_actor_name,
              format('Employee auto-created for approved user %s (role: %s)', coalesce(v_target.email, p_user_id::text), v_effective_role),
              'info');

      -- Assign the standard employee number / staff id so the approval
      -- screen shows an identity for the new employee.
      perform public.generate_employee_number(v_emp_id);
    else
      update public.employees set user_id = p_user_id, updated_at = now()
        where id = v_emp_id and user_id is null;
    end if;

    update public.profiles set employee_id = v_emp_id where id = p_user_id and employee_id is null;

    update public.profiles p
    set employee_number = e.employee_number,
        designation = public.employee_designation_label(e."position", e.designation_id)
    from public.employees e
    where e.id = v_emp_id and p.id = p_user_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;




create or replace function public.reconcile_auto_channel_membership_for_employee(p_employee_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_e record;
  v_eligible boolean;
  v_added int := 0;
  v_removed int := 0;
  v_matches boolean;
  v_role_matches boolean;
  v_chan record;
  v_p record;
begin
  if auth.uid() is not null
     and not public.is_communication_admin()
     and not exists (select 1 from public.employees where id = p_employee_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select * into v_e from public.employees where id = p_employee_id;
  if v_e.id is null then return jsonb_build_object('ok', true, 'skipped', 'not_found'); end if;
  if v_e.user_id is null then return jsonb_build_object('ok', true, 'skipped', 'not_linked'); end if;

  v_eligible := v_e.employment_status in ('active', 'on_leave') and coalesce(v_e.is_archived, false) = false;

  select role, status into v_p from public.profiles where id = v_e.user_id;
  if v_p.role is null then v_p.role := 'customer'; v_p.status := coalesce(v_p.status, 'pending'); end if;

  for v_chan in
    select * from public.message_channels
    where is_auto and status = 'active'
  loop
    v_matches := false;
    if v_chan.auto_source = 'branch' then
      v_matches := v_e.branch_id is not null and v_e.branch_id = v_chan.auto_source_id;
    elsif v_chan.auto_source = 'area' then
      v_matches := v_e.branch_id is not null and exists (
        select 1 from public.branch_area_assignments ba
        where ba.branch_id = v_e.branch_id and ba.area_id = v_chan.auto_source_id and ba.is_current
      );
    elsif v_chan.auto_source = 'department' then
      v_matches := public.employee_matches_department_channel(v_e.id, v_chan.auto_source_role);
    elsif v_chan.auto_source = 'role' then
      v_role_matches := false;
      if v_chan.auto_source_role = 'all' then
        v_role_matches := v_p.role <> 'customer' and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'management' then
        v_role_matches := v_p.role in ('super_admin', 'admin', 'head_of_business', 'head_of_operations',
                                       'head_of_e_business', 'financial_controller',
                                       'head_of_risk_compliance', 'head_of_legal', 'head_of_audit',
                                       'branch_manager', 'area_manager') and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'executive' then
        v_role_matches := v_p.role in ('super_admin', 'admin', 'head_of_business') and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'hr' then
        v_role_matches := v_p.role in ('head_of_human_resources', 'hr_officer', 'super_admin', 'admin') and v_p.status = 'active';
      else
        v_role_matches := v_p.role = v_chan.auto_source_role and v_p.status = 'active';
      end if;
      v_matches := v_role_matches;
    end if;

    if v_matches and v_eligible then
      if not exists (
        select 1 from public.message_channel_members
        where channel_id = v_chan.id and member_id = v_e.user_id
      ) then
        insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
        values (v_chan.id, v_e.user_id, 'member', v_chan.creator_id, true)
        on conflict (channel_id, member_id) do nothing;
        v_added := v_added + 1;
      end if;
    else
      delete from public.message_channel_members
      where channel_id = v_chan.id and member_id = v_e.user_id and auto_added = true;
      if found then v_removed := v_removed + 1; end if;
    end if;
  end loop;

  perform public.write_communication_audit(
    'channel', null, 'employee_auto_membership_reconciled', null, null,
    jsonb_build_object('employee_id', p_employee_id, 'user_id', v_e.user_id, 'added', v_added, 'removed', v_removed),
    'employee org provisioning'
  );

  return jsonb_build_object('ok', true, 'employee_id', p_employee_id, 'added', v_added, 'removed', v_removed);
end; $$;




-- ---------------------------------------------------------------------------
-- 5. REVOKE — flip the active token to 'revoked' (never delete).
-- ---------------------------------------------------------------------------
create or replace function public.revoke_attendance_terminal(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
  v_now timestamptz := clock_timestamp();
  v_who uuid := auth.uid();
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;

  update public.attendance_devices
     set device_token = null,
         status = 'revoked',
         active = false,
         token_generated_at = null,
         updated_at = now()
   where id = p_device_id and device_type = 'attendance_terminal'
   returning device_name into v_name;

  if v_name is null then
    raise exception 'Attendance terminal not found.';
  end if;

  update public.attendance_terminal_token_history
     set status = 'revoked',
         revoked_at = v_now,
         revoked_by = v_who
   where device_id = p_device_id
     and status = 'active';

  delete from public.attendance_terminal_view_links where device_id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_REVOKED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = v_who), v_who::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'revoked', true);
end;
$$;




-- suspend — reversible pause; token + view link are preserved so Resume works
-- without printing a fresh QR.
create or replace function public.suspend_attendance_terminal(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_dev public.attendance_devices%rowtype;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;

  select * into v_dev from public.attendance_devices where id = p_device_id for update;
  if not found or v_dev.device_type <> 'attendance_terminal' then
    raise exception 'Attendance terminal not found.';
  end if;

  if v_dev.status = 'revoked' then
    raise exception 'This terminal is revoked and cannot be suspended.';
  end if;

  update public.attendance_devices
     set status = 'suspended', active = false, updated_at = now()
   where id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_SUSPENDED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'suspended', true);
end;
$$;




-- resume — reactivate a suspended terminal, preserving its token/view link.
create or replace function public.resume_attendance_terminal(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_dev public.attendance_devices%rowtype;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;

  select * into v_dev from public.attendance_devices where id = p_device_id for update;
  if not found or v_dev.device_type <> 'attendance_terminal' then
    raise exception 'Attendance terminal not found.';
  end if;

  if v_dev.status <> 'suspended' then
    raise exception 'Only suspended terminals can be resumed.';
  end if;

  update public.attendance_devices
     set status = 'active', active = true, updated_at = now()
   where id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_RESUMED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_dev.device_name, 'success', true)::text,
    'info'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'resumed', true);
end;
$$;




-- ---------------------------------------------------------------------------
-- 6. DELETE — SOFT delete: only from revoked, status='deleted', history kept.
-- ---------------------------------------------------------------------------
create or replace function public.delete_attendance_terminal(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_dev public.attendance_devices%rowtype;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;

  select * into v_dev from public.attendance_devices where id = p_device_id for update;
  if not found or v_dev.device_type <> 'attendance_terminal' then
    raise exception 'Attendance terminal not found.';
  end if;

  if v_dev.status <> 'revoked' then
    raise exception 'Only revoked terminals can be deleted. Revoke the terminal first.';
  end if;

  update public.attendance_devices
     set status = 'deleted', active = false, updated_at = now()
   where id = p_device_id;

  delete from public.attendance_terminal_view_links where device_id = p_device_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_DELETED', 'AttendanceDevice', p_device_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object(
      'module', 'attendance', 'device_name', v_dev.device_name,
      'soft_delete', true, 'history_preserved', true, 'success', true
    )::text,
    'warning'
  );

  return jsonb_build_object('ok', true, 'device_id', p_device_id, 'deleted', true, 'soft_delete', true);
end;
$$;


-- Phase 63 — Payroll Master compensation editing
--
-- The Payroll & BankOne → Payroll Master tab previously rendered
-- employees.salary / employees.allowances directly, which are EMPTY for
-- most staff — the real compensation lives in the Phase 41 Salary Structure
-- architecture (payroll_salary_components → employee_salary_packages →
-- employee_salary_snapshots, computed by calculate_employee_salary_breakdown
-- using payroll_config). The master therefore showed ₦0.00 for everyone.
--
-- This phase makes the single source of truth explicit and keeps ONE payroll
-- calculation engine:
--   1. A pure arithmetic helper  public._salary_breakdown(...)
--      implements pension + consolidated relief + PAYE bands + mid/end split
--      from payroll_config. calculate_employee_salary_breakdown, the new
--      preview RPC and (indirectly, via snapshot) the master list all call it.
--   2. calculate_employee_salary_breakdown is rewritten to persist the same
--      breakdown in the CURRENT snapshot (same engine, same shape).
--   3. NEW public.upsert_employee_compensation(...) — super_admin/admin/
--      head_of_human_resources only, REQUIRES a reason, updates employees.salary (basic)
--      + employee_salary_packages, resyncs employees.allowances, recomputes
--      the CURRENT snapshot and writes an EMPLOYEE_COMPENSATION_UPDATED row
--      to audit_logs (before + after + reason). Transactional.
--   4. NEW public.preview_employee_compensation(...) — same engine, NO writes,
--      so the Payroll Master editor can show derived totals while typing.
--   5. NEW public.get_employee_compensation(...) — single-call compensation
--      bundle for the Payroll Master editor and the Employee 360 Payroll tab.
--   6. list_payroll_master is rewritten to surface the derived breakdown from
--      the CURRENT snapshot (with live package fallback) + a
--      has_compensation flag instead of the empty salary columns.
--   7. compute_payroll no longer hardcodes allowances = 0 — it reads the
--      active allowance/deduction packages so Payroll runs and the BankOne
--      push preview reflect edited compensation.
--
-- Idempotent/additive. Run in the Supabase SQL Editor after Phase 62.

-- ============================================================
-- 1. Single arithmetic engine: _salary_breakdown
--    (pure config-driven calculation — no RLS, shared by all callers)
-- ============================================================
create or replace function public._salary_breakdown(
  p_basic numeric,
  p_allowances numeric,
  p_allowances_taxable numeric,
  p_deductions numeric
) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_config jsonb;
  v_pension_rate numeric;
  v_relief_min numeric;
  v_relief_pct numeric;
  v_other numeric;
  v_bands jsonb;
  v_mid_ratio numeric := 0.5;
  v_gross numeric;
  v_pension numeric;
  v_annual numeric;
  v_relief numeric;
  v_taxable numeric;
  v_tax_annual numeric := 0;
  v_prev numeric;
  v_upper numeric;
  v_tax numeric;
  v_net numeric;
  v_mid numeric;
  v_end numeric;
  v_band jsonb;
  v_band_count int;
  v_i int;
begin
  select config into v_config from public.payroll_config where id = 1;
  v_pension_rate := coalesce((v_config ->> 'pension_employee_rate')::numeric, 0.08);
  v_relief_min := coalesce((v_config ->> 'consolidated_relief_min')::numeric, 200000);
  v_relief_pct := coalesce((v_config ->> 'consolidated_relief_percent')::numeric, 0.20);
  v_other := coalesce((v_config ->> 'default_other_deduction')::numeric, 0);
  v_bands := coalesce(v_config -> 'tax_bands', '[{"up_to":null,"rate":0.0}]'::jsonb);
  v_mid_ratio := coalesce((v_config ->> 'mid_month_ratio')::numeric, 0.5);

  v_gross := round(p_basic + coalesce(p_allowances, 0), 2);
  v_pension := round(p_basic * v_pension_rate, 2);
  v_annual := (p_basic + coalesce(p_allowances_taxable, 0)) * 12;
  v_relief := greatest(v_relief_min, v_relief_pct * v_annual);
  v_taxable := greatest(0, v_annual - (v_pension * 12) - v_relief);

  v_tax_annual := 0;
  v_prev := 0;
  v_band_count := jsonb_array_length(v_bands);
  v_i := 0;
  while v_i < v_band_count loop
    v_band := v_bands -> v_i;
    if v_taxable <= v_prev then
      exit;
    end if;
    if (v_band ->> 'up_to') is null then
      v_upper := v_taxable;
    else
      v_upper := least(v_taxable, (v_band ->> 'up_to')::numeric);
    end if;
    v_tax_annual := v_tax_annual + greatest(0, (v_upper - v_prev) * coalesce((v_band ->> 'rate')::numeric, 0));
    if v_taxable <= v_upper then
      exit;
    end if;
    v_prev := v_upper;
    v_i := v_i + 1;
  end loop;
  v_tax := round(v_tax_annual / 12, 2);

  v_net := greatest(0, round(v_gross - v_tax - v_pension - v_other - coalesce(p_deductions, 0), 2));
  v_mid := round(v_net * v_mid_ratio, 2);
  v_end := round(v_net - v_mid, 2);

  return jsonb_build_object(
    'gross_annual', round(v_annual, 2),
    'basic_monthly', round(p_basic, 2),
    'allowances_total', round(coalesce(p_allowances, 0), 2),
    'gross_monthly', v_gross,
    'pension', v_pension,
    'tax_paye', v_tax,
    'other_deductions', v_other,
    'component_deductions', round(coalesce(p_deductions, 0), 2),
    'deductions_total', round(v_tax + v_pension + v_other + coalesce(p_deductions, 0), 2),
    'net_monthly', v_net,
    'mid_month', v_mid,
    'end_month', v_end
  );
end; $$;




-- ============================================================
-- 3. upsert_employee_compensation — the ONLY compensation write path
--    (super_admin / admin / head_of_human_resources). Reason mandatory. Audited.
-- ============================================================
create or replace function public.upsert_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_entry jsonb;
  v_comp_id uuid;
  v_comp_name text;
  v_amount numeric;
  v_actor text;
  v_before_deductions numeric := 0;
  v_before_allowances numeric := 0;
  v_before_net numeric;
  v_result jsonb;
  v_component public.payroll_salary_components;
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to edit employee compensation';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  -- capture the pre-edit state for the audit trail
  select coalesce(sum(amount), 0) into v_before_allowances
  from public.employee_salary_packages
  where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'allowance';
  select coalesce(sum(amount), 0) into v_before_deductions
  from public.employee_salary_packages
  where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'deduction';
  select net_monthly into v_before_net
  from public.employee_salary_snapshots
  where employee_id = p_employee_id and period_label = 'CURRENT'
  order by calc_timestamp desc limit 1;

  -- basic salary (monhtly)
  update public.employees set salary = coalesce(p_basic, 0) where id = p_employee_id;

  -- allowances: [{"component_id","name","category","amount"}]
  for v_entry in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
    v_comp_name := nullif(btrim(coalesce(v_entry ->> 'name', '')), '');
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;

    -- resolve existing component first (by id when it looks like a uuid, else by name)
    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select * into v_component from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
        v_comp_name := coalesce(v_comp_name, v_component.name);
      end if;
    end if;
    if v_comp_id is null and v_comp_name is not null then
      select * into v_component from public.payroll_salary_components
        where name = v_comp_name and component_type = 'allowance' limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
      end if;
    end if;
    if v_comp_id is null then
      if v_comp_name is null then
        continue;
      end if;
      insert into public.payroll_salary_components
        (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
      values (v_comp_name, 'allowance', 'fixed', null, true, true, 'both',
              coalesce(nullif(v_entry ->> 'category', ''), 'other'), true, auth.uid())
      returning * into v_component;
      v_comp_id := v_component.id;
    end if;

    if v_amount <= 0 then
      update public.employee_salary_packages set active = false
      where employee_id = p_employee_id and component_id = v_comp_id;
    else
      insert into public.employee_salary_packages
        (employee_id, component_id, amount, rate, snapshot, active, created_by)
      values (p_employee_id, v_comp_id, round(v_amount, 2), 0, to_jsonb(v_component), true, auth.uid())
      on conflict (employee_id, component_id)
      do update set amount = excluded.amount, rate = excluded.rate,
                    snapshot = excluded.snapshot, active = true, effective_date = current_date;
    end if;
  end loop;

  -- deductions: [{"component_id","name","amount"}]
  for v_entry in select * from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) loop
    v_comp_name := nullif(btrim(coalesce(v_entry ->> 'name', '')), '');
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;

    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select * into v_component from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
        v_comp_name := coalesce(v_comp_name, v_component.name);
      end if;
    end if;
    if v_comp_id is null and v_comp_name is not null then
      select * into v_component from public.payroll_salary_components
        where name = v_comp_name and component_type = 'deduction' limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
      end if;
    end if;
    if v_comp_id is null then
      if v_comp_name is null then
        continue;
      end if;
      insert into public.payroll_salary_components
        (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
      values (v_comp_name, 'deduction', 'fixed', null, false, true, 'both', 'other', true, auth.uid())
      returning * into v_component;
      v_comp_id := v_component.id;
    end if;

    if v_amount <= 0 then
      update public.employee_salary_packages set active = false
      where employee_id = p_employee_id and component_id = v_comp_id;
    else
      insert into public.employee_salary_packages
        (employee_id, component_id, amount, rate, snapshot, active, created_by)
      values (p_employee_id, v_comp_id, round(v_amount, 2), 0, to_jsonb(v_component), true, auth.uid())
      on conflict (employee_id, component_id)
      do update set amount = excluded.amount, rate = excluded.rate,
                    snapshot = excluded.snapshot, active = true, effective_date = current_date;
    end if;
  end loop;

  -- keep the legacy employees.allowances aggregate in sync (Phase 12 column)
  update public.employees e set allowances = coalesce(x.total, 0)
  from (
    select coalesce(sum(amount), 0) as total
    from public.employee_salary_packages
    where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'allowance'
  ) x
  where e.id = p_employee_id;

  -- recompute the CURRENT snapshot through the shared engine
  v_result := public.calculate_employee_salary_breakdown(p_employee_id, 'CURRENT');

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_COMPENSATION_UPDATED', 'Employee', p_employee_id::text, v_actor,
    jsonb_build_object(
      'reason', p_reason,
      'before', jsonb_build_object(
        'basic_monthly', coalesce(v_emp.salary, 0),
        'allowances', v_before_allowances,
        'component_deductions', v_before_deductions,
        'net_monthly', coalesce(v_before_net, 0)
      ),
      'after', v_result -> 'breakdown'
    )::text,
    'info'
  );

  return v_result;
end; $$;




-- ============================================================
-- 4. preview_employee_compensation — same engine, NO writes
-- ============================================================
create or replace function public.preview_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_entry jsonb;
  v_comp_id uuid;
  v_amount numeric;
  v_allow numeric := 0;
  v_taxable numeric := 0;
  v_ded numeric := 0;
  v_allowable bool;
  v_component public.payroll_salary_components;
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  for v_entry in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;
    v_allowable := true;

    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select taxable into v_allowable from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid;
      if v_allowable is not null then
        v_comp_id := (v_entry ->> 'component_id')::uuid;
      end if;
    end if;
    if v_allowable is null then
      v_allowable := true;
    end if;
    if v_comp_id is null then
      select v_component.taxable into v_allowable from public.payroll_salary_components v_component
        where v_component.name = v_entry ->> 'name' and v_component.component_type = 'allowance' limit 1;
      v_allowable := coalesce(v_allowable, true);
    end if;
    if v_allowable then v_taxable := v_taxable + v_amount; end if;
    v_allow := v_allow + v_amount;
  end loop;

  for v_entry in select * from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) loop
    v_ded := v_ded + coalesce((v_entry ->> 'amount')::numeric, 0);
  end loop;

  return jsonb_build_object(
    'ok', true, 'employee_id', p_employee_id,
    'breakdown', public._salary_breakdown(
      coalesce(p_basic, 0), v_allow, v_taxable, v_ded
    )
  );
end; $$;





-- ============================================================
-- 4b. get_employee_compensation — include the manual overrides so
--     the Payroll Master editor can prefill them
-- ============================================================
create or replace function public.get_employee_compensation(p_employee_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_packages jsonb;
  v_snapshot jsonb;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'component_id', p.component_id,
    'name', p.snapshot ->> 'name',
    'component_type', p.snapshot ->> 'component_type',
    'category', p.snapshot ->> 'category',
    'taxable', coalesce((p.snapshot ->> 'taxable')::bool, true),
    'payment_schedule', p.snapshot ->> 'payment_schedule',
    'amount', coalesce(p.amount, 0), 'active', p.active
  ) order by p.snapshot ->> 'name'), '[]'::jsonb)
  into v_packages
  from public.employee_salary_packages p
  where p.employee_id = p_employee_id;

  select jsonb_build_object(
    'gross_annual', s.gross_annual, 'gross_monthly', s.gross_monthly,
    'basic_monthly', s.basic_monthly, 'allowances_total', s.allowances_total,
    'deductions_total', s.deductions_total, 'tax_paye', s.tax_paye,
    'pension', s.pension, 'other_deductions', s.other_deductions,
    'net_monthly', s.net_monthly, 'mid_month', s.mid_month,
    'end_month', s.end_month, 'components', s.components, 'calc_timestamp', s.calc_timestamp
  ) into v_snapshot
  from public.employee_salary_snapshots s
  where s.employee_id = p_employee_id and s.period_label = 'CURRENT'
  order by s.calc_timestamp desc limit 1;

  return jsonb_build_object(
    'employee_id', v_emp.id, 'employee_name', v_emp.full_name,
    'employee_code', coalesce(v_emp.employee_code, v_emp.employee_number, v_emp.staff_id),
    'department', v_emp.department, 'position', v_emp.position,
    'basic_monthly', coalesce(v_emp.salary, v_emp.basic_salary, 0),
    'packages', v_packages, 'snapshot', coalesce(v_snapshot, jsonb_build_object()),
    'payroll_gross_override', v_emp.payroll_gross_override,
    'payroll_net_override', v_emp.payroll_net_override,
    'payroll_mid_override', v_emp.payroll_mid_override,
    'payroll_end_override', v_emp.payroll_end_override,
    'payroll_override_at', v_emp.payroll_override_at,
    'has_compensation', (
      coalesce(v_emp.salary, v_emp.basic_salary, 0) > 0
      or coalesce((select count(*) from public.employee_salary_packages where employee_id = p_employee_id and active), 0) > 0
    )
  );
end; $$;





-- ============================================================
-- 3. save_payroll_import — adopt the uploaded workbook structure
-- ============================================================
create or replace function public.save_payroll_import(
  p_filename text,
  p_source_format text,
  p_period_label text default null,
  p_currency text default 'NGN',
  p_match_key text default null,
  p_columns jsonb default '[]'::jsonb,
  p_rows jsonb default '[]'::jsonb,
  p_confirm_override boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor text;
  v_import_id uuid;
  v_active uuid;
  v_row jsonb;
  v_code text;
  v_affected integer := 0;
  v_override boolean := false;
  v_col_count integer;
  v_row_count integer;
  v_period text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to import the payroll file';
  end if;
  if coalesce(btrim(p_filename), '') = '' then
    raise exception 'A file name is required';
  end if;
  if p_source_format not in ('xlsx', 'xls', 'csv') then
    raise exception 'Only .xlsx, .xls and .csv files are supported';
  end if;
  select count(*) into v_col_count from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb));
  select count(*) into v_row_count from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb));
  if v_col_count = 0 then
    raise exception 'The file contains no recognizable column headers';
  end if;
  if v_row_count = 0 then
    raise exception 'The file contains no data rows';
  end if;

  -- an active import already exists → require explicit override
  select id into v_active from public.payroll_imports
  where is_active order by created_at desc limit 1;
  if v_active is not null and not coalesce(p_confirm_override, false) then
    return jsonb_build_object('ok', false, 'code', 'override_required');
  end if;
  if v_active is not null then
    update public.payroll_imports set is_active = false where is_active;
    update public.employees
    set payroll_import_id = null, payroll_import_snapshot = null, payroll_import_at = null
    where payroll_import_id = v_active;
    v_override := true;
  end if;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();
  v_period := nullif(btrim(coalesce(p_period_label, '')), '');

  insert into public.payroll_imports
    (filename, source_format, period_label, currency, match_key, columns, rows,
     row_count, imported_by, imported_by_name, is_active)
  values
    (p_filename, p_source_format, v_period, coalesce(nullif(btrim(p_currency), ''), 'NGN'),
     nullif(nullif(btrim(coalesce(p_match_key, '')), ''), ''),
     p_columns, p_rows, v_row_count, auth.uid(), v_actor, true)
  returning id into v_import_id;

  -- link imported rows to employee profiles by staff identifier
  if nullif(btrim(coalesce(p_match_key, '')), '') is not null then
    for v_row in select * from jsonb_array_elements(p_rows) loop
      v_code := nullif(btrim(coalesce(v_row ->> p_match_key, '')), '');
      if v_code is null then
        continue;
      end if;
      update public.employees e
      set payroll_import_id = v_import_id,
          payroll_import_snapshot = v_row,
          payroll_import_at = now()
      where coalesce(e.employee_code, e.employee_number, e.staff_id) = v_code
        and coalesce(e.is_archived, false) = false;
    end loop;
  end if;

  update public.payroll_imports
  set matched_profiles = (select count(*) from public.employees where payroll_import_id = v_import_id)
  where id = v_import_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_IMPORT_SAVED', 'payroll_import', v_import_id, v_actor,
    jsonb_build_object(
      'filename', p_filename,
      'source_format', p_source_format,
      'period_label', v_period,
      'currency', coalesce(nullif(btrim(p_currency), ''), 'NGN'),
      'match_key', nullif(btrim(coalesce(p_match_key, '')), ''),
      'columns', v_col_count,
      'rows', v_row_count,
      'matched_profiles', (select count(*) from public.employees where payroll_import_id = v_import_id),
      'override_applied', v_override
    ), 'info');

  return jsonb_build_object(
    'ok', true,
    'id', v_import_id,
    'filename', p_filename,
    'columns', v_col_count,
    'rows', v_row_count,
    'matched_profiles', (select count(*) from public.employees where payroll_import_id = v_import_id),
    'override_applied', v_override
  );
end; $$;





-- ============================================================
-- 4. get_active_payroll_import — current adopted structure
-- ============================================================
create or replace function public.get_active_payroll_import()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_r record;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to view the payroll master';
  end if;
  select id, filename, source_format, period_label, currency, match_key,
         columns, rows, row_count, matched_profiles, imported_by_name, created_at
  into v_r
  from public.payroll_imports
  where is_active
  order by created_at desc
  limit 1;
  if v_r.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_r.id,
    'filename', v_r.filename,
    'source_format', v_r.source_format,
    'period_label', v_r.period_label,
    'currency', v_r.currency,
    'match_key', v_r.match_key,
    'columns', v_r.columns,
    'rows', v_r.rows,
    'row_count', v_r.row_count,
    'matched_profiles', v_r.matched_profiles,
    'imported_by_name', v_r.imported_by_name,
    'created_at', v_r.created_at
  );
end; $$;





-- ============================================================
-- 5. deactivate_payroll_import — remove import + clear snapshots
-- ============================================================
create or replace function public.deactivate_payroll_import(
  p_import_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor text;
  v_existed boolean;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to modify the payroll import';
  end if;
  select exists(select 1 from public.payroll_imports where id = p_import_id) into v_existed;
  if not v_existed then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  update public.payroll_imports set is_active = false where id = p_import_id;

  update public.employees
  set payroll_import_id = null, payroll_import_snapshot = null, payroll_import_at = null
  where payroll_import_id = p_import_id;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_IMPORT_REMOVED', 'payroll_import', p_import_id, v_actor,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'info');

  return jsonb_build_object('ok', true, 'id', p_import_id);
end; $$;





-- ============================================================
-- 6. get_employee_payroll_import — profile snapshot (Employee 360)
-- ============================================================
create or replace function public.get_employee_payroll_import(p_employee_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_columns jsonb;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to view payroll records';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    return null;
  end if;
  if v_emp.payroll_import_snapshot is null then
    return null;
  end if;
  select columns into v_columns
  from public.payroll_imports
  where id = v_emp.payroll_import_id;
  return jsonb_build_object(
    'import_id', v_emp.payroll_import_id,
    'snapshot', v_emp.payroll_import_snapshot,
    'columns', coalesce(v_columns, '[]'::jsonb),
    'at', v_emp.payroll_import_at
  );
end; $$;





-- ============================================================
-- 7. list_payroll_audit — read-only trail fetch
-- ============================================================
create or replace function public.list_payroll_audit(
  p_employee_id uuid default null,
  p_limit integer default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_limit integer;
  v_rows jsonb;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to view the payroll audit trail';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
      'id', a.id,
      'action', a.action,
      'edited_by', a.edited_by,
      'edited_by_role', a.edited_by_role,
      'edited_by_name', a.edited_by_name,
      'employee_id', a.employee_id,
      'employee_name', e.full_name,
      'employee_code', coalesce(e.employee_code, e.employee_number, e.staff_id),
      'previous_values', a.previous_values,
      'new_values', a.new_values,
      'field_diff', a.field_diff,
      'signature_data_url', a.signature_data_url,
      'ip_address', a.ip_address,
      'reason', a.reason,
      'details', a.details,
      'created_at', a.created_at
    ) as x
    from public.payroll_audit_logs a
    left join public.employees e on e.id = a.employee_id
    where p_employee_id is null or a.employee_id = p_employee_id
    order by a.created_at desc
    limit v_limit
  ) t;

  return v_rows;
end; $$;




create or replace function public.upsert_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb,
  p_reason text,
  p_signature text default null,
  p_ip_address text default null,
  p_gross_override numeric default null,
  p_net_override numeric default null,
  p_mid_override numeric default null,
  p_end_override numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_entry jsonb;
  v_comp_id uuid;
  v_comp_name text;
  v_amount numeric;
  v_actor text;
  v_before_deductions numeric := 0;
  v_before_allowances numeric := 0;
  v_before_net numeric := 0;
  v_before_gross numeric := 0;
  v_before_mid numeric := 0;
  v_before_end numeric := 0;
  v_has_override boolean;
  v_result jsonb;
  v_prev jsonb;
  v_now jsonb;
  v_diff jsonb := '{}'::jsonb;
  v_f text;
  v_sig text;
  v_component public.payroll_salary_components;
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  -- Editable roles (all other roles are read-only by spec).
  if v_role not in ('super_admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to edit employee payroll';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;

  v_sig := nullif(btrim(coalesce(p_signature, '')), '');
  -- HR Officer edits are only persisted after a captured signature.
  if v_role = 'hr_officer' and (v_sig is null or left(v_sig, 11) <> 'data:image/') then
    raise exception 'An HR Officer signature is required to save payroll changes';
  end if;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  -- capture the pre-edit state for the audit trail
  select coalesce(sum(amount), 0) into v_before_allowances
  from public.employee_salary_packages
  where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'allowance';
  select coalesce(sum(amount), 0) into v_before_deductions
  from public.employee_salary_packages
  where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'deduction';
  select coalesce(net_monthly, 0), coalesce(gross_monthly, 0), coalesce(mid_month, 0), coalesce(end_month, 0)
  into v_before_net, v_before_gross, v_before_mid, v_before_end
  from public.employee_salary_snapshots
  where employee_id = p_employee_id and period_label = 'CURRENT'
  order by calc_timestamp desc limit 1;

  -- basic salary (monthly)
  update public.employees set salary = coalesce(p_basic, 0) where id = p_employee_id;

  -- allowances: [{"component_id","name","category","amount"}]
  for v_entry in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
    v_comp_name := nullif(btrim(coalesce(v_entry ->> 'name', '')), '');
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;

    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select * into v_component from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
        v_comp_name := coalesce(v_comp_name, v_component.name);
      end if;
    end if;
    if v_comp_id is null and v_comp_name is not null then
      select * into v_component from public.payroll_salary_components
        where name = v_comp_name and component_type = 'allowance' limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
      end if;
    end if;
    if v_comp_id is null then
      if v_comp_name is null then
        continue;
      end if;
      insert into public.payroll_salary_components
        (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
      values (v_comp_name, 'allowance', 'fixed', null, true, true, 'both',
              coalesce(nullif(v_entry ->> 'category', ''), 'other'), true, auth.uid())
      returning * into v_component;
      v_comp_id := v_component.id;
    end if;

    if v_amount <= 0 then
      update public.employee_salary_packages set active = false
      where employee_id = p_employee_id and component_id = v_comp_id;
    else
      insert into public.employee_salary_packages
        (employee_id, component_id, amount, rate, snapshot, active, created_by)
      values (p_employee_id, v_comp_id, round(v_amount, 2), 0, to_jsonb(v_component), true, auth.uid())
      on conflict (employee_id, component_id)
      do update set amount = excluded.amount, rate = excluded.rate,
                    snapshot = excluded.snapshot, active = true, effective_date = current_date;
    end if;
  end loop;

  -- deductions: [{"component_id","name","amount"}]
  for v_entry in select * from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) loop
    v_comp_name := nullif(btrim(coalesce(v_entry ->> 'name', '')), '');
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;

    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select * into v_component from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
        v_comp_name := coalesce(v_comp_name, v_component.name);
      end if;
    end if;
    if v_comp_id is null and v_comp_name is not null then
      select * into v_component from public.payroll_salary_components
        where name = v_comp_name and component_type = 'deduction' limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
      end if;
    end if;
    if v_comp_id is null then
      if v_comp_name is null then
        continue;
      end if;
      insert into public.payroll_salary_components
        (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
      values (v_comp_name, 'deduction', 'fixed', null, false, true, 'both', 'other', true, auth.uid())
      returning * into v_component;
      v_comp_id := v_component.id;
    end if;

    if v_amount <= 0 then
      update public.employee_salary_packages set active = false
      where employee_id = p_employee_id and component_id = v_comp_id;
    else
      insert into public.employee_salary_packages
        (employee_id, component_id, amount, rate, snapshot, active, created_by)
      values (p_employee_id, v_comp_id, round(v_amount, 2), 0, to_jsonb(v_component), true, auth.uid())
      on conflict (employee_id, component_id)
      do update set amount = excluded.amount, rate = excluded.rate,
                    snapshot = excluded.snapshot, active = true, effective_date = current_date;
    end if;
  end loop;

  -- keep the legacy employees.allowances aggregate in sync (Phase 12 column)
  update public.employees e set allowances = coalesce(x.total, 0)
  from (
    select coalesce(sum(amount), 0) as total
    from public.employee_salary_packages
    where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'allowance'
  ) x
  where e.id = p_employee_id;

  -- recompute the CURRENT snapshot through the shared engine
  v_result := public.calculate_employee_salary_breakdown(p_employee_id, 'CURRENT');

  -- ---- manual payroll-outcome overrides (gross / net / mid / end) ----
  v_has_override := coalesce(p_gross_override, p_net_override, p_mid_override, p_end_override) is not null;
  update public.employees
  set payroll_gross_override = p_gross_override,
      payroll_net_override = p_net_override,
      payroll_mid_override = p_mid_override,
      payroll_end_override = p_end_override,
      payroll_override_at = case when v_has_override then now() else payroll_override_at end,
      payroll_override_by = case when v_has_override then auth.uid() else payroll_override_by end
  where id = p_employee_id;

  -- ---- field-level diff (source inputs + derived/override outcomes) ----
  v_prev := jsonb_build_object(
    'basic_monthly', coalesce(v_emp.salary, 0),
    'allowances', v_before_allowances,
    'component_deductions', v_before_deductions,
    'net_monthly', v_before_net,
    'gross_override', coalesce(v_emp.payroll_gross_override, v_before_gross),
    'net_override', coalesce(v_emp.payroll_net_override, v_before_net),
    'mid_override', coalesce(v_emp.payroll_mid_override, v_before_mid),
    'end_override', coalesce(v_emp.payroll_end_override, v_before_end)
  );
  v_now := jsonb_build_object(
    'basic_monthly', coalesce(p_basic, 0),
    'allowances', coalesce((v_result -> 'breakdown' ->> 'allowances_total')::numeric, 0),
    'component_deductions', coalesce((v_result -> 'breakdown' ->> 'component_deductions')::numeric, 0),
    'net_monthly', coalesce((v_result -> 'breakdown' ->> 'net_monthly')::numeric, 0),
    'gross_override', coalesce(p_gross_override, (v_result -> 'breakdown' ->> 'gross_monthly')::numeric),
    'net_override', coalesce(p_net_override, (v_result -> 'breakdown' ->> 'net_monthly')::numeric),
    'mid_override', coalesce(p_mid_override, (v_result -> 'breakdown' ->> 'mid_month')::numeric),
    'end_override', coalesce(p_end_override, (v_result -> 'breakdown' ->> 'end_month')::numeric)
  );
  foreach v_f in array array['basic_monthly', 'allowances', 'component_deductions', 'net_monthly',
                            'gross_override', 'net_override', 'mid_override', 'end_override'] loop
    if coalesce((v_prev ->> v_f)::numeric, 0) <> coalesce((v_now ->> v_f)::numeric, 0) then
      v_diff := v_diff || jsonb_build_object(
        v_f,
        jsonb_build_object(
          'from', coalesce((v_prev ->> v_f)::numeric, 0),
          'to', coalesce((v_now ->> v_f)::numeric, 0)
        )
      );
    end if;
  end loop;

  -- ---- audit (skipped entirely for super_admin per spec) ----
  if v_role <> 'super_admin' then
    insert into public.payroll_audit_logs
      (action, edited_by, edited_by_role, edited_by_name, employee_id,
       previous_values, new_values, field_diff, signature_data_url, ip_address, reason)
    values
      ('EMPLOYEE_COMPENSATION_EDITED', auth.uid(), v_role, v_actor, p_employee_id,
       v_prev, v_now, v_diff,
       case when v_role = 'hr_officer' then v_sig else null end,
       nullif(btrim(coalesce(p_ip_address, '')), ''), p_reason);

    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'EMPLOYEE_COMPENSATION_UPDATED', 'Employee', p_employee_id::text, v_actor,
      jsonb_build_object(
        'reason', p_reason,
        'edited_by_role', v_role,
        'signature_data_url', case when v_role = 'hr_officer' then v_sig else null end,
        'ip_address', nullif(btrim(coalesce(p_ip_address, '')), ''),
        'before', v_prev,
        'after', v_result -> 'breakdown',
        'diff', v_diff
      )::text,
      'info'
    );
  end if;

  return v_result;
end; $$;




create or replace function public.save_payroll_import(
  p_filename text,
  p_source_format text,
  p_period_label text default null,
  p_currency text default 'NGN',
  p_match_key text default null,
  p_columns jsonb default '[]'::jsonb,
  p_rows jsonb default '[]'::jsonb,
  p_confirm_override boolean default false,
  p_ip_address text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor text;
  v_import_id uuid;
  v_active uuid;
  v_row jsonb;
  v_code text;
  v_affected integer := 0;
  v_override boolean := false;
  v_col_count integer;
  v_row_count integer;
  v_period text;
  v_prev_cols jsonb := null;
  v_prev_match text := null;
  v_added jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_c jsonb;
  v_ckey text;
  v_diff jsonb;
  v_matched integer;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to import the payroll file';
  end if;
  if coalesce(btrim(p_filename), '') = '' then
    raise exception 'A file name is required';
  end if;
  if p_source_format not in ('xlsx', 'xls', 'csv') then
    raise exception 'Only .xlsx, .xls and .csv files are supported';
  end if;
  select count(*) into v_col_count from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb));
  select count(*) into v_row_count from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb));
  if v_col_count = 0 then
    raise exception 'The file contains no recognizable column headers';
  end if;
  if v_row_count = 0 then
    raise exception 'The file contains no data rows';
  end if;

  -- an active import already exists → require explicit override
  select id into v_active from public.payroll_imports
  where is_active order by created_at desc limit 1;
  if v_active is not null and not coalesce(p_confirm_override, false) then
    return jsonb_build_object('ok', false, 'code', 'override_required');
  end if;
  if v_active is not null then
    select columns, match_key into v_prev_cols, v_prev_match from public.payroll_imports where id = v_active;
    update public.payroll_imports set is_active = false where is_active;
    update public.employees
    set payroll_import_id = null, payroll_import_snapshot = null, payroll_import_at = null
    where payroll_import_id = v_active;
    v_override := true;
  end if;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();
  v_period := nullif(btrim(coalesce(p_period_label, '')), '');

  insert into public.payroll_imports
    (filename, source_format, period_label, currency, match_key, columns, rows,
     row_count, imported_by, imported_by_name, is_active)
  values
    (p_filename, p_source_format, v_period, coalesce(nullif(btrim(p_currency), ''), 'NGN'),
     nullif(nullif(btrim(coalesce(p_match_key, '')), ''), ''),
     p_columns, p_rows, v_row_count, auth.uid(), v_actor, true)
  returning id into v_import_id;

  -- link imported rows to employee profiles by staff identifier
  if nullif(btrim(coalesce(p_match_key, '')), '') is not null then
    for v_row in select * from jsonb_array_elements(p_rows) loop
      v_code := nullif(btrim(coalesce(v_row ->> p_match_key, '')), '');
      if v_code is null then
        continue;
      end if;
      update public.employees e
      set payroll_import_id = v_import_id,
          payroll_import_snapshot = v_row,
          payroll_import_at = now()
      where coalesce(e.employee_code, e.employee_number, e.staff_id) = v_code
        and coalesce(e.is_archived, false) = false;
    end loop;
  end if;

  select count(*) into v_matched from public.employees where payroll_import_id = v_import_id;

  update public.payroll_imports
  set matched_profiles = v_matched
  where id = v_import_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_IMPORT_SAVED', 'payroll_import', v_import_id, v_actor,
    jsonb_build_object(
      'filename', p_filename,
      'source_format', p_source_format,
      'period_label', v_period,
      'currency', coalesce(nullif(btrim(p_currency), ''), 'NGN'),
      'match_key', nullif(btrim(coalesce(p_match_key, '')), ''),
      'columns', v_col_count,
      'rows', v_row_count,
      'matched_profiles', v_matched,
      'override_applied', v_override
    ), 'info');

  -- ---- structure-override audit trail row (skipped for super_admin) ----
  if v_role <> 'super_admin' then
    for v_c in select value from jsonb_array_elements(coalesce(v_prev_cols, '[]'::jsonb)) loop
      v_ckey := v_c ->> 'key';
      if not exists (
        select 1 from jsonb_array_elements(p_columns) where value ->> 'key' = v_ckey
      ) then
        v_removed := v_removed || to_jsonb(v_ckey);
      end if;
    end loop;
    for v_c in select value from jsonb_array_elements(p_columns) loop
      v_ckey := v_c ->> 'key';
      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_prev_cols, '[]'::jsonb)) where value ->> 'key' = v_ckey
      ) then
        v_added := v_added || to_jsonb(v_ckey);
      end if;
    end loop;
    v_diff := jsonb_build_object('added_columns', v_added, 'removed_columns', v_removed, 'override_applied', v_override);

    insert into public.payroll_audit_logs
      (action, edited_by, edited_by_role, edited_by_name, employee_id,
       previous_values, new_values, field_diff, ip_address, reason, details)
    values
      ('PAYROLL_STRUCTURE_OVERRIDE', auth.uid(), v_role, v_actor, null,
       jsonb_build_object('columns', coalesce(v_prev_cols, '[]'::jsonb), 'match_key', v_prev_match),
       jsonb_build_object('columns', p_columns, 'match_key', nullif(btrim(coalesce(p_match_key, '')), '')),
       v_diff,
       nullif(btrim(coalesce(p_ip_address, '')), ''),
       format('Payroll Excel imported (%s) — %s columns, %s rows, %s matched', p_filename, v_col_count, v_row_count, v_matched),
       jsonb_build_object(
         'filename', p_filename,
         'source_format', p_source_format,
         'period_label', v_period,
         'currency', coalesce(nullif(btrim(p_currency), ''), 'NGN'),
         'rows', v_row_count,
         'matched_profiles', v_matched,
         'override_applied', v_override
       ));
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_import_id,
    'filename', p_filename,
    'columns', v_col_count,
    'rows', v_row_count,
    'matched_profiles', v_matched,
    'override_applied', v_override
  );
end; $$;




-- ---------------------------------------------------------------------------
-- 4. GENERATE — archive the superseded token, then mint the new one.
-- ---------------------------------------------------------------------------
create or replace function public.create_attendance_terminal_token(
  p_device_id uuid default null,
  p_device_name text default 'QR Attendance Terminal'
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_device public.attendance_devices%rowtype;
  v_raw text := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash text;
  v_now timestamptz := clock_timestamp();
  v_who uuid := auth.uid();
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to manage attendance terminals.';
  end if;

  if p_device_id is null then
    select * into v_device
      from public.attendance_devices
     where device_type = 'attendance_terminal'
       and status = 'active'
       and active = true
     order by created_at
     limit 1;

    if not found then
      insert into public.attendance_devices (device_name, device_type, status, active, created_by)
      values (coalesce(nullif(trim(p_device_name), ''), 'QR Attendance Terminal'),
              'attendance_terminal', 'active', true, v_who)
      returning * into v_device;
    end if;
  else
    select * into v_device from public.attendance_devices where id = p_device_id for update;
    if not found or v_device.device_type <> 'attendance_terminal' then
      raise exception 'Attendance terminal not found.';
    end if;
  end if;

  v_hash := encode(extensions.digest(convert_to(v_raw, 'UTF8'), 'sha256'), 'hex');

  -- Archive any currently-active token before issuing the new one.
  update public.attendance_terminal_token_history
     set status = 'revoked',
         revoked_at = v_now,
         revoked_by = v_who
   where device_id = v_device.id
     and status = 'active';

  insert into public.attendance_terminal_token_history (
    device_id, token_hash, token_preview, status, created_at, created_by
  ) values (
    v_device.id, v_hash, left(v_raw, 8) || '…', 'active', v_now, v_who
  );

  update public.attendance_devices
     set device_token = v_hash,
         status = 'active',
         active = true,
         token_generated_at = v_now,
         updated_at = now()
   where id = v_device.id;

  insert into public.attendance_terminal_view_links (device_id, token_hex, created_at, updated_at)
  values (v_device.id, v_raw, v_now, v_now)
  on conflict (device_id)
  do update set token_hex = excluded.token_hex, updated_at = excluded.updated_at;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_TERMINAL_TOKEN_REGENERATED', 'AttendanceDevice', v_device.id::text,
    coalesce((select full_name from public.profiles where id = v_who), v_who::text),
    jsonb_build_object('module', 'attendance', 'device_name', v_device.device_name, 'success', true)::text,
    'warning'
  );

  return jsonb_build_object(
    'ok', true, 'device_id', v_device.id, 'device_name', v_device.device_name,
    'token', v_raw, 'generated_at', v_now
  );
end;
$$;




create or replace function public.list_attendance_device_bindings(
  p_date date default null
) returns table (
  device_fingerprint_hash text,
  binding_date date,
  attendance_date date,
  employee_full_name text,
  employee_number text,
  last_terminal_name text,
  status text,
  first_used_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_date date := coalesce(p_date, (clock_timestamp() at time zone public.att_app_timezone())::date);
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to manage attendance device bindings.';
  end if;
  return query
  select b.device_fingerprint_hash, b.binding_date, b.binding_date,
         e.full_name,
         coalesce(e.employee_number, e.staff_id, e.employee_code),
         b.last_terminal_name,
         'Active'::text,
         b.first_used_at, b.last_seen_at
    from public.attendance_device_bindings b
    left join public.employees e on e.id = b.employee_id
   where b.binding_date = v_date
   order by b.last_seen_at desc;
end;
$$;




create or replace function public.list_attendance_device_binding_blocks(
  p_date date default null,
  p_limit int default 20
) returns table (
  created_at timestamptz,
  details text,
  severity text
)
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_date date := coalesce(p_date, (clock_timestamp() at time zone public.att_app_timezone())::date);
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to view attendance device binding events.';
  end if;
  return query
  select a.created_at, a.details, a.severity
    from public.audit_logs a
   where a.action = 'ATTENDANCE_DEVICE_BINDING_BLOCKED'
     and a.created_at::date = v_date
   order by a.created_at desc
   limit greatest(1, p_limit);
end;
$$;




create or replace function public.clear_attendance_device_binding(
  p_device_fingerprint_hash text,
  p_binding_date date,
  p_reason text default null
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_date date := coalesce(p_binding_date, (clock_timestamp() at time zone public.att_app_timezone())::date);
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to manage attendance device bindings.';
  end if;
  if coalesce(p_device_fingerprint_hash, '') = '' then
    raise exception 'A device fingerprint reference is required.';
  end if;

  delete from public.attendance_device_bindings
   where device_fingerprint_hash = p_device_fingerprint_hash
     and binding_date = v_date;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'ATTENDANCE_DEVICE_BINDING_OVERRIDE', 'AttendanceDeviceBinding', p_device_fingerprint_hash,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object(
      'module', 'attendance',
      'binding_date', v_date,
      'reason', coalesce(p_reason, 'Device re-assigned by HR')
    )::text,
    'critical'
  );

  return jsonb_build_object('ok', true, 'binding_date', v_date);
end;
$$;




-- gated QR view — returns the raw token for the CURRENT live QR so the HR UI
-- can re-render the exact link without regenerating. hr roles only.
create or replace function public.get_attendance_terminal_qr_link(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_dev public.attendance_devices%rowtype;
  v_view public.attendance_terminal_view_links%rowtype;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to view attendance terminal QR data.';
  end if;

  select * into v_dev from public.attendance_devices where id = p_device_id;
  if not found or v_dev.device_type <> 'attendance_terminal' then
    raise exception 'Attendance terminal not found.';
  end if;

  select * into v_view from public.attendance_terminal_view_links where device_id = p_device_id;
  if not found then
    return jsonb_build_object(
      'ok', true, 'device_id', p_device_id, 'has_qr', false,
      'status', v_dev.status, 'generated_at', v_dev.token_generated_at
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'device_id', p_device_id, 'has_qr', true,
    'token', v_view.token_hex, 'status', v_dev.status, 'generated_at', v_view.updated_at
  );
end;
$$;




-- ---------------------------------------------------------------------------
-- 7. QR HISTORY LIST — masked previews only, newest first, optional filter.
-- ---------------------------------------------------------------------------
create or replace function public.list_attendance_terminal_qr_history(
  p_device_id uuid default null,
  p_status text default null
) returns table (
  id uuid,
  device_id uuid,
  device_name text,
  status text,
  token_preview text,
  created_at timestamptz,
  created_by_name text,
  revoked_at timestamptz,
  revoked_by_name text,
  expires_at timestamptz
)
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager') then
    raise exception 'Not authorized to view attendance terminal QR history.';
  end if;
  if p_status is not null and p_status not in ('active', 'revoked', 'expired', 'deleted') then
    raise exception 'Invalid status filter. Use active, revoked, expired or deleted.';
  end if;

  return query
  select h.id, h.device_id,
         d.device_name,
         h.status,
         h.token_preview,
         h.created_at,
         coalesce(pc.full_name, h.created_by::text),
         h.revoked_at,
         coalesce(pr.full_name, h.revoked_by::text),
         h.expires_at
    from public.attendance_terminal_token_history h
    left join public.attendance_devices d on d.id = h.device_id
    left join public.profiles pc on pc.id = h.created_by
    left join public.profiles pr on pr.id = h.revoked_by
   where (p_device_id is null or h.device_id = p_device_id)
     and (p_status is null or h.status = p_status)
   order by h.created_at desc;
end;
$$;




-- ============================================================
-- 2. HR RPCs
-- ============================================================

-- Assessor Reports / completion breakdown. One row per submitted attempt with
-- candidate, applied role, template, dates, percentage, pass/fail, flags and
-- a percentage comparison against the same template and same applied role.
create or replace function public.hr_list_assessment_completions()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_rows jsonb;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  select coalesce(jsonb_agg(row_json order by (row_json ->> 'submitted_at') desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
      'attempt_id', at.id,
      'attempt_number', at.attempt_number,
      'status', at.status,
      'percentage', at.percentage,
      'max_score', at.max_score,
      'score', at.score,
      'passed', at.passed,
      'flagged', at.flagged,
      'flags_count', at.flags_count,
      'started_at', at.started_at,
      'submitted_at', at.submitted_at,
      'completed_at', at.completed_at,
      'time_taken_seconds', case
        when at.submitted_at is not null and at.started_at is not null
        then greatest(0, extract(epoch from (at.submitted_at - at.started_at)))::int
        else null end,
      'review_status', at.review_status,
      'candidate', jsonb_build_object(
        'candidate_id', c.id,
        'full_name', c.full_name,
        'email', c.email,
        'applied_role', c.applied_role,
        'application_status', c.application_status
      ),
      'assignment', jsonb_build_object(
        'assignment_id', a.id,
        'status', a.status,
        'invited_at', a.created_at,
        'test_name', a.test_name
      ),
      'template', jsonb_build_object(
        'template_id', t.id,
        'title', t.title,
        'category', t.category,
        'pass_mark', t.pass_mark,
        'duration_minutes', t.duration_minutes,
        'shuffle_questions', t.shuffle_questions
      ),
      'job', case when j.id is not null then jsonb_build_object(
        'job_id', j.id,
        'job_title', j.job_title,
        'department', j.department,
        'role_category', j.role_category
      ) else null end,
      'stats', jsonb_build_object(
        'template_average_percentage', tv.template_avg,
        'role_average_percentage', rv.role_avg
      )
    ) as row_json
    from public.assessment_attempts at
    left join public.hr_assessments a on a.id = at.assignment_id
    left join public.assessment_templates t on t.id = a.template_id
    left join public.hr_candidates c on c.id = at.candidate_id
    left join public.hr_jobs j on j.id = coalesce(at.job_id, a.job_id, c.job_id)
    left join lateral (
      select round(avg(x.percentage), 2) as template_avg
      from public.assessment_attempts x
      join public.hr_assessments xa on xa.id = x.assignment_id
      where xa.template_id = a.template_id
        and x.percentage is not null
        and x.status in ('submitted', 'auto_submitted', 'flagged')
    ) tv on true
    left join lateral (
      select round(avg(x.percentage), 2) as role_avg
      from public.assessment_attempts x
      left join public.hr_assessments xa on xa.id = x.assignment_id
      left join public.hr_candidates xc on xc.id = x.candidate_id
      where coalesce(x.job_id, xa.job_id, xc.job_id) = coalesce(at.job_id, a.job_id, c.job_id)
        and x.percentage is not null
        and x.status in ('submitted', 'auto_submitted', 'flagged')
    ) rv on true
    where at.status in ('submitted', 'auto_submitted', 'flagged')
      and at.percentage is not null
  ) sub;

  return v_rows;
end; $$;




-- Mark a suggestion Apply / Dismissed (advisory advice stays logged forever).
create or replace function public.hr_act_on_assessment_suggestion(
  p_suggestion_id uuid,
  p_action text,
  p_note text default null
) returns public.assessment_suggestions
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.assessment_suggestions;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  if p_action not in ('applied', 'dismissed') then
    raise exception 'Invalid action';
  end if;
  update public.assessment_suggestions
     set status = p_action,
         resolved_at = now(),
         resolved_by = auth.uid(),
         resolution_note = coalesce(p_note, resolution_note)
   where id = p_suggestion_id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Suggestion not found';
  end if;
  perform public.hr_audit('ASSESSMENT_SUGGESTION_' || upper(p_action), 'AssessmentSuggestion',
    p_suggestion_id::text, format('Sara suggestion %s', p_action));
  return v_row;
end; $$;




-- Apply a role-fit suggestion: safely re-point the candidate's role.
create or replace function public.hr_reassign_candidate_role(
  p_candidate_id uuid,
  p_job_id uuid default null,
  p_applied_role text default null,
  p_note text default null,
  p_suggestion_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_row public.hr_candidates;
  v_job public.hr_jobs;
  v_old_job uuid;
  v_old_role text;
  v_job_title text;
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.hr_candidates where id = p_candidate_id;
  if v_row.id is null then
    raise exception 'Candidate not found';
  end if;
  v_old_job := v_row.job_id;
  v_old_role := v_row.applied_role;

  if p_job_id is not null and p_job_id <> v_old_job then
    select * into v_job from public.hr_jobs where id = p_job_id;
    if v_job.id is null then
      raise exception 'Job not found';
    end if;
    v_job_title := v_job.job_title;
  end if;

  if p_job_id is null and p_applied_role is null then
    raise exception 'Nothing to change';
  end if;

  update public.hr_candidates
     set job_id = coalesce(p_job_id, job_id),
         applied_role = coalesce(nullif(p_applied_role, ''), applied_role),
         status_change_note = coalesce(p_note, status_change_note)
   where id = p_candidate_id
  returning * into v_row;

  perform public.hr_audit('CANDIDATE_ROLE_REASSIGNED', 'Candidate', p_candidate_id::text,
    format('Role: "%s" -> "%s"', coalesce(v_old_role, coalesce(v_old_job::text, 'none')),
           coalesce(v_job_title, p_applied_role, coalesce(v_old_role, '—'))));

  if p_suggestion_id is not null then
    update public.assessment_suggestions
       set status = 'applied', resolved_at = now(), resolved_by = auth.uid(),
           resolution_note = coalesce(p_note, 'Role-fit suggestion applied')
     where id = p_suggestion_id;
  end if;

  return jsonb_build_object('ok', true, 'candidate', to_jsonb(v_row));
end; $$;


commit;
