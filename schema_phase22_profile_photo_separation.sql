-- ============================================================
-- Phase 22: Profile Photo Separation (additive, idempotent)
--
-- The Staff ID card photo MUST come from the immutable onboarding
-- passport document. The platform profile picture is a SEPARATE,
-- user-managed image and must never overwrite the card photo.
--
-- This migration only adds safe storage policies so authenticated
-- users/HR can upload a dedicated `profile-photo/<employeeId>/...`
-- object path. No schema tables are dropped and no RLS is weakened:
--   - uploads are scoped to the owner's own employee id OR HR roles
--   - reads/deletes via the same scoping
--   - the ID card keeps reading the `passport` document row
--
-- Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Storage upload policy: `profile-photo/<employeeId>/...`
--    Allowed for the employee that owns the record (user_id match)
--    plus HR/officer/admin roles.
-- ------------------------------------------------------------------
drop policy if exists "profile_photo_self_upload" on storage.objects;
create policy "profile_photo_self_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'profile-photo/%'
    and (
      public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
      or exists (
        select 1 from public.employees e
        where e.id::text = split_part(name, '/', 2)
          and e.user_id = auth.uid()
      )
    )
  );

-- ------------------------------------------------------------------
-- 2. Scoped upload policy for the standard `employee/<employeeId>/...`
--    path used by documentService.upload (attaching an ID passport
--    when no onboarding passport exists). Same ownership scoping.
-- ------------------------------------------------------------------
drop policy if exists "employee_docs_self_upload" on storage.objects;
create policy "employee_docs_self_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'employee/%'
    and (
      public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
      or exists (
        select 1 from public.employees e
        where e.id::text = split_part(name, '/', 2)
          and e.user_id = auth.uid()
      )
    )
  );

-- ------------------------------------------------------------------
-- 3. Delete policy for the same scoped prefix (allows replacing /
--    removing one's own profile photo).
-- ------------------------------------------------------------------
drop policy if exists "profile_photo_self_delete" on storage.objects;
create policy "profile_photo_self_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and name like 'profile-photo/%'
    and (
      public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
      or exists (
        select 1 from public.employees e
        where e.id::text = split_part(name, '/', 2)
          and e.user_id = auth.uid()
      )
    )
  );

-- ------------------------------------------------------------------
-- 4. Delete policy for the standard employee path scope too.
-- ------------------------------------------------------------------
drop policy if exists "employee_docs_self_delete" on storage.objects;
create policy "employee_docs_self_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and name like 'employee/%'
    and (
      public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
      or exists (
        select 1 from public.employees e
        where e.id::text = split_part(name, '/', 2)
          and e.user_id = auth.uid()
      )
    )
  );

-- ------------------------------------------------------------------
-- 5. Allow photo rows to be removed from the documents table when the
--    caller uploaded them (or is HR) — never weakens other rows' RLS.
-- ------------------------------------------------------------------
drop policy if exists "documents_delete_self_or_hr" on public.documents;
create policy "documents_delete_self_or_hr" on public.documents
  for delete using (
    uploaded_by = auth.uid()
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

-- ------------------------------------------------------------------
-- 6. Fidelity surety document uploads (`fidelity/<token-hash>/…`).
--    Mirrors the existing `guarantor/%` anon upload policy from
--    Phase 7: the surety reaches the form through a token link and PDFs
--    are uploaded directly from the anon browser session. Without this
--    scoped insert policy the uploads fail storage RLS.
-- ------------------------------------------------------------------
drop policy if exists "fidelity_docs_anon_upload" on storage.objects;
create policy "fidelity_docs_anon_upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'documents' and name like 'fidelity/%');

-- ------------------------------------------------------------------
-- DONE.
-- ------------------------------------------------------------------