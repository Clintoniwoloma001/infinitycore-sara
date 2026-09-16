-- ============================================================================
-- schema_phase34_documents_rls_recursion_fix.sql
-- ============================================================================
-- Fixes: 42P17  infinite recursion detected in policy for relation "documents"
--
-- Symptoms
--   Uploading a Profile Picture or an ID Card Photo failed with:
--     "infinite recursion detected in policy for relation \"documents\""
--   documentService.upload()/uploadProfilePicture() do
--   .insert(...).select().single(), and .select() re-evaluates the SELECT
--   policy on public.documents.
--
-- Root cause
--   The SELECT policy `documents_read_authorized` authorised the current row
--   by re-querying the same relation it guards:
--
--     auth.uid() in (select verified_by from public.documents where id = documents.id)
--     auth.uid() in (select uploaded_by from public.documents where id = documents.id)
--
--   Evaluating the policy on a `documents` row again evaluates the policy for
--   every row produced by the sub-select on `documents` -> the policy
--   re-enters itself, which PostgreSQL rejects as infinite recursion.
--   (Identical definition in schema_phase1_migrations.sql and
--    schema_phase24_attendance_employee_lookup.sql.)
--
-- Fix
--   Authorise from the current row's OWN columns (uploaded_by / verified_by),
--   from independent relations (employees, loan_applications), and from the
--   existing role model. No sub-select against `documents` -> no cycle.
--   RLS stays enabled, no table/data changes, no security removed.
--
-- Idempotent / additive: drops and recreates only this one policy.
-- ============================================================================

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
      'hr_manager',
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
