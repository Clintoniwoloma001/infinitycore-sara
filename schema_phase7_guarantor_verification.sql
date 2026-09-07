-- ============================================================
-- PHASE 7: GUARANTOR/BOND VERIFICATION WORKFLOW
--
-- Adds guarantor verification tables, RPCs, and RLS policies for the
-- secure guarantor verification workflow.
--
-- ALL ADDITIVE. Safe to re-run (uses IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- ============================================================
-- 1. ADD onboarding_status TO submissions (tracks overall workflow)
-- ============================================================
alter table public.employee_onboarding_submissions
  add column if not exists onboarding_status text default 'submitted';
alter table public.employee_onboarding_submissions drop constraint if exists submissions_onboarding_status_check;
alter table public.employee_onboarding_submissions add constraint submissions_onboarding_status_check
  check (onboarding_status in ('submitted', 'under_review', 'pending_guarantor', 'guarantor_submitted', 'correction_requested', 'approved', 'rejected', 'completed'));

-- ============================================================
-- 2. GUARANTOR VERIFICATIONS — main verification record
-- ============================================================
create table if not exists public.guarantor_verifications (
  id uuid primary key default gen_random_uuid(),
  onboarding_link_id uuid references public.employee_onboarding_links(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  submission_id uuid references public.employee_onboarding_submissions(id) on delete set null,
  guarantor_name text not null,
  guarantor_email text not null,
  guarantor_relationship text,
  token_hash text unique not null,
  status text default 'pending_link' check (status in (
    'pending_link', 'link_sent', 'started', 'submitted',
    'under_review', 'correction_requested', 'approved', 'rejected'
  )),
  -- Identity fields (filled by guarantor)
  phone text,
  residential_address text,
  occupation text,
  employer text,
  bvn text,
  nin text,
  -- Verification artifacts
  selfie_data text,
  selfie_captured_at timestamptz,
  signature_data text,
  signature_date date,
  -- HR review
  hr_comments text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  -- Timestamps
  submitted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.guarantor_verifications enable row level security;
create index if not exists idx_guarantor_verif_token on public.guarantor_verifications(token_hash);
create index if not exists idx_guarantor_verif_employee on public.guarantor_verifications(employee_id);
create index if not exists idx_guarantor_verif_submission on public.guarantor_verifications(submission_id);
create index if not exists idx_guarantor_verif_status on public.guarantor_verifications(status);

-- ============================================================
-- 3. GUARANTOR DOCUMENTS — documents uploaded by guarantor
-- ============================================================
create table if not exists public.guarantor_documents (
  id uuid primary key default gen_random_uuid(),
  guarantor_verification_id uuid not null references public.guarantor_verifications(id) on delete cascade,
  document_type text not null check (document_type in ('passport', 'id_card', 'work_id', 'utility_bill', 'other')),
  file_name text not null,
  file_path text not null,
  file_size int,
  mime_type text,
  status text default 'pending' check (status in ('pending', 'verified', 'rejected', 'correction_requested')),
  created_at timestamptz default now()
);
alter table public.guarantor_documents enable row level security;
create index if not exists idx_guarantor_docs_verif on public.guarantor_documents(guarantor_verification_id);

-- ============================================================
-- 4. GUARANTOR CORRECTIONS — field-level corrections with revision history
-- ============================================================
create table if not exists public.guarantor_corrections (
  id uuid primary key default gen_random_uuid(),
  guarantor_verification_id uuid not null references public.guarantor_verifications(id) on delete cascade,
  field_name text not null,
  field_label text,
  previous_value text,
  hr_comment text,
  corrected_value text,
  status text default 'pending' check (status in ('pending', 'submitted', 'approved', 'rejected')),
  submitted_by text,
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz default now()
);
alter table public.guarantor_corrections enable row level security;
create index if not exists idx_guarantor_corr_verif on public.guarantor_corrections(guarantor_verification_id);

-- ============================================================
-- 5. ONBOARDING EVENTS — workflow event log
-- ============================================================
create table if not exists public.onboarding_events (
  id uuid primary key default gen_random_uuid(),
  onboarding_link_id uuid references public.employee_onboarding_links(id) on delete set null,
  guarantor_verification_id uuid references public.guarantor_verifications(id) on delete set null,
  event_type text not null,
  details text,
  actor text,
  created_at timestamptz default now()
);
alter table public.onboarding_events enable row level security;
create index if not exists idx_onboard_events_link on public.onboarding_events(onboarding_link_id);
create index if not exists idx_onboard_events_verif on public.onboarding_events(guarantor_verification_id);

-- ============================================================
-- 6. RLS POLICIES
-- ============================================================

-- Guarantor verifications: HR can read/write, anon via RPC only
drop policy if exists "guarantor_verif_read" on public.guarantor_verifications;
create policy "guarantor_verif_read" on public.guarantor_verifications
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
drop policy if exists "guarantor_verif_write" on public.guarantor_verifications;
create policy "guarantor_verif_write" on public.guarantor_verifications
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- Guarantor documents: HR can read, writes via RPC
drop policy if exists "guarantor_docs_read" on public.guarantor_documents;
create policy "guarantor_docs_read" on public.guarantor_documents
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- Guarantor corrections: HR can read/write
drop policy if exists "guarantor_corr_read" on public.guarantor_corrections;
create policy "guarantor_corr_read" on public.guarantor_corrections
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
drop policy if exists "guarantor_corr_write" on public.guarantor_corrections;
create policy "guarantor_corr_write" on public.guarantor_corrections
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- Onboarding events: HR can read, writes via RPC
drop policy if exists "onboard_events_read" on public.onboarding_events;
create policy "onboard_events_read" on public.onboarding_events
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- ============================================================
-- 7. RPC: get_guarantor_verification_details (anon accessible)
--    Returns verification details + documents + pending corrections
-- ============================================================
create or replace function public.get_guarantor_verification_details(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_verif record;
  v_result jsonb;
  v_docs jsonb;
  v_corrections jsonb;
  v_employee_name text;
  v_position text;
begin
  select * into v_verif from public.guarantor_verifications where token_hash = v_hash;
  if v_verif.id is null then
    raise exception 'Invalid verification link.';
  end if;
  if v_verif.status = 'approved' then
    raise exception 'This verification has been completed.';
  end if;
  if v_verif.status = 'rejected' then
    raise exception 'This verification has been rejected.';
  end if;

  -- Mark as started if link was just sent
  if v_verif.status = 'link_sent' then
    update public.guarantor_verifications set status = 'started', updated_at = now()
    where id = v_verif.id and status = 'link_sent';
  end if;

  -- Get employee name for context
  select full_name, position into v_employee_name, v_position
  from public.employees where id = v_verif.employee_id;

  -- Get documents
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'document_type', d.document_type, 'file_name', d.file_name,
    'file_path', d.file_path, 'status', d.status
  )), '[]'::jsonb) into v_docs
  from public.guarantor_documents d
  where d.guarantor_verification_id = v_verif.id;

  -- Get pending corrections (ones the guarantor needs to fix)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'field_name', c.field_name, 'field_label', c.field_label,
    'previous_value', c.previous_value, 'hr_comment', c.hr_comment,
    'status', c.status
  )), '[]'::jsonb) into v_corrections
  from public.guarantor_corrections c
  where c.guarantor_verification_id = v_verif.id
    and c.status in ('pending', 'submitted', 'approved', 'rejected');

  v_result := jsonb_build_object(
    'id', v_verif.id,
    'guarantor_name', v_verif.guarantor_name,
    'guarantor_email', v_verif.guarantor_email,
    'guarantor_relationship', v_verif.guarantor_relationship,
    'status', case when v_verif.status = 'link_sent' then 'started' else v_verif.status end,
    'employee_name', v_employee_name,
    'position', v_position,
    'phone', v_verif.phone,
    'residential_address', v_verif.residential_address,
    'occupation', v_verif.occupation,
    'employer', v_verif.employer,
    'bvn', v_verif.bvn,
    'nin', v_verif.nin,
    'selfie_data', v_verif.selfie_data,
    'signature_data', v_verif.signature_data,
    'documents', v_docs,
    'corrections', v_corrections
  );

  return v_result;
end; $$;
grant execute on function public.get_guarantor_verification_details(text) to anon, authenticated;

-- ============================================================
-- 8. RPC: submit_guarantor_verification (anon accessible)
-- ============================================================
create or replace function public.submit_guarantor_verification(p_token text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_verif record;
  v_doc record;
  v_req text;
  v_count int := 0;
  v_hr_id uuid;
begin
  select * into v_verif from public.guarantor_verifications
  where token_hash = v_hash for update;

  if v_verif.id is null then
    raise exception 'Invalid verification link.';
  end if;
  if v_verif.status = 'submitted' then
    raise exception 'This verification has already been submitted.';
  end if;
  if v_verif.status = 'approved' then
    raise exception 'This verification has already been approved.';
  end if;
  if v_verif.status not in ('started', 'link_sent', 'correction_requested') then
    raise exception 'This verification link is not active.';
  end if;

  -- Update verification record with identity fields + artifacts
  update public.guarantor_verifications set
    phone = coalesce(nullif(p_payload ->> 'phone', ''), phone),
    residential_address = coalesce(nullif(p_payload ->> 'residential_address', ''), residential_address),
    occupation = coalesce(nullif(p_payload ->> 'occupation', ''), occupation),
    employer = coalesce(nullif(p_payload ->> 'employer', ''), employer),
    bvn = coalesce(nullif(p_payload ->> 'bvn', ''), bvn),
    nin = coalesce(nullif(p_payload ->> 'nin', ''), nin),
    selfie_data = coalesce(nullif(p_payload ->> 'selfie_data', ''), selfie_data),
    selfie_captured_at = case when p_payload ? 'selfie_data' then now() else selfie_captured_at end,
    signature_data = coalesce(nullif(p_payload ->> 'signature_data', ''), signature_data),
    signature_date = coalesce(nullif(p_payload ->> 'signature_date', '')::date, signature_date, now()::date),
    status = 'submitted',
    submitted_at = now(),
    updated_at = now()
  where id = v_verif.id;

  -- Insert documents (validate path prefix for security)
  if p_payload ? 'documents' and jsonb_typeof(p_payload -> 'documents') = 'array' then
    for v_doc in select * from jsonb_array_elements(p_payload -> 'documents')
    loop
      v_req := 'guarantor/' || v_hash || '/';
      if position(v_req in coalesce(v_doc.value ->> 'file_path', '')) = 1 then
        insert into public.guarantor_documents (guarantor_verification_id, document_type, file_name, file_path, file_size, mime_type, status)
        values (v_verif.id, coalesce(v_doc.value ->> 'document_type', 'other'),
                v_doc.value ->> 'file_name', v_doc.value ->> 'file_path',
                nullif(v_doc.value ->> 'file_size', '')::int, v_doc.value ->> 'mime_type', 'pending');
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  -- Create event
  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (v_verif.id, 'GUARANTOR_SUBMITTED', format('Guarantor %s submitted verification with %s documents', v_verif.guarantor_name, v_count), v_verif.guarantor_name);

  -- Audit log
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('GUARANTOR_VERIFICATION_SUBMITTED', 'GuarantorVerification', v_verif.id::text, v_verif.guarantor_name,
          format('Guarantor verification submitted by %s', v_verif.guarantor_name), 'info');

  -- Update submission onboarding_status
  if v_verif.submission_id is not null then
    update public.employee_onboarding_submissions
    set onboarding_status = 'guarantor_submitted'
    where id = v_verif.submission_id and onboarding_status in ('pending_guarantor', 'correction_requested');
  end if;

  -- Notify HR
  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  loop
    insert into public.notifications (user_id, title, message, type, link)
    values (v_hr_id, 'Guarantor verification submitted',
            format('%s has completed guarantor verification.', v_verif.guarantor_name),
            'onboarding', '/onboarding-links');
  end loop;

  return jsonb_build_object('ok', true, 'verification_id', v_verif.id, 'documents', v_count);
end; $$;
grant execute on function public.submit_guarantor_verification(text, jsonb) to anon, authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
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
grant execute on function public.request_guarantor_correction(uuid, jsonb) to authenticated;

-- ============================================================
-- 10. RPC: submit_guarantor_correction (anon accessible)
--     Guarantor submits corrected values for requested fields
-- ============================================================
create or replace function public.submit_guarantor_correction(
  p_token text,
  p_corrections jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_verif record;
  v_corr record;
  v_correction_id uuid;
  v_corrected_value text;
  v_count int := 0;
begin
  select * into v_verif from public.guarantor_verifications where token_hash = v_hash for update;
  if v_verif.id is null then
    raise exception 'Invalid verification link.';
  end if;
  if v_verif.status != 'correction_requested' then
    raise exception 'No corrections are pending for this verification.';
  end if;

  for v_corr in select * from jsonb_array_elements(p_corrections)
  loop
    v_correction_id := (v_corr.value ->> 'correction_id')::uuid;
    v_corrected_value := v_corr.value ->> 'corrected_value';

    update public.guarantor_corrections
    set corrected_value = v_corrected_value,
        status = 'submitted',
        submitted_by = v_verif.guarantor_name,
        submitted_at = now()
    where id = v_correction_id
      and guarantor_verification_id = v_verif.id
      and status = 'pending';
    v_count := v_count + 1;
  end loop;

  -- Handle document corrections (new uploads)
  if p_corrections ? 'documents' and jsonb_typeof(p_corrections -> 'documents') = 'array' then
    -- Mark old documents for corrected types as rejected, insert new ones
    -- (handled in the frontend by uploading new docs and passing metadata)
  end if;

  -- Update verification status back to submitted
  update public.guarantor_verifications
  set status = 'submitted', submitted_at = now(), updated_at = now()
  where id = v_verif.id;

  -- Update submission status
  if v_verif.submission_id is not null then
    update public.employee_onboarding_submissions set onboarding_status = 'guarantor_submitted'
    where id = v_verif.submission_id;
  end if;

  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (v_verif.id, 'CORRECTION_SUBMITTED', format('%s corrections submitted by guarantor', v_count), v_verif.guarantor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('CORRECTION_SUBMITTED', 'GuarantorVerification', v_verif.id::text, v_verif.guarantor_name,
          format('%s corrections submitted by guarantor', v_count), 'info');

  return jsonb_build_object('ok', true, 'corrections_submitted', v_count);
end; $$;
grant execute on function public.submit_guarantor_correction(text, jsonb) to anon, authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
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
grant execute on function public.approve_guarantor_correction(uuid) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
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
grant execute on function public.reject_guarantor_correction(uuid) to authenticated;

-- ============================================================
-- 13. RPC: approve_guarantor_verification (HR only)
--     Marks verification as approved, updates employee_guarantors
-- ============================================================
create or replace function public.approve_guarantor_verification(p_verification_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_verif record;
  v_employee_id uuid;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to approve verification';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_verif from public.guarantor_verifications where id = p_verification_id;
  if v_verif.id is null then
    raise exception 'Verification record not found.';
  end if;
  if v_verif.status = 'approved' then
    raise exception 'Verification already approved.';
  end if;

  -- Check no pending corrections
  if exists (select 1 from public.guarantor_corrections
             where guarantor_verification_id = p_verification_id and status in ('pending', 'submitted')) then
    raise exception 'There are unresolved corrections. Please approve or reject all corrections first.';
  end if;

  -- Update verification status
  update public.guarantor_verifications
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where id = p_verification_id;

  -- Update the employee_guarantors record with verified data
  v_employee_id := v_verif.employee_id;
  if v_employee_id is not null then
    update public.employee_guarantors set
      phone = coalesce(v_verif.phone, phone),
      profession = coalesce(v_verif.occupation, profession),
      business_address = coalesce(v_verif.employer, business_address),
      residential_address = coalesce(v_verif.residential_address, residential_address),
      email = coalesce(v_verif.guarantor_email, email),
      relationship = coalesce(v_verif.guarantor_relationship, relationship),
      bvn = coalesce(v_verif.bvn, bvn),
      nin = coalesce(v_verif.nin, nin),
      signature = coalesce(v_verif.signature_data, signature),
      signature_date = coalesce(v_verif.signature_date, signature_date),
      verification_status = 'verified',
      updated_at = now()
    where employee_id = v_employee_id
      and full_name = v_verif.guarantor_name;
  end if;

  -- Update submission status
  if v_verif.submission_id is not null then
    update public.employee_onboarding_submissions set onboarding_status = 'under_review'
    where id = v_verif.submission_id;
  end if;

  insert into public.onboarding_events (guarantor_verification_id, event_type, details, actor)
  values (p_verification_id, 'GUARANTOR_APPROVED',
          format('Guarantor verification approved by %s', v_actor_name), v_actor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('GUARANTOR_VERIFICATION_APPROVED', 'GuarantorVerification', p_verification_id::text, v_actor_name,
          format('Guarantor %s verification approved', v_verif.guarantor_name), 'info');

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.approve_guarantor_verification(uuid) to authenticated;

-- ============================================================
-- 14. RPC: approve_onboarding (HR only)
--     Activates employee, completes onboarding
-- ============================================================
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
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to approve onboarding';
  end if;
  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select * into v_sub from public.employee_onboarding_submissions where id = p_submission_id;
  if v_sub.id is null then
    raise exception 'Submission not found.';
  end if;
  if v_sub.onboarding_status = 'completed' then
    raise exception 'Onboarding already completed.';
  end if;

  -- Check all guarantor verifications are approved
  select count(*), count(*) filter (where status = 'approved')
  into v_verif_count, v_approved_count
  from public.guarantor_verifications where submission_id = p_submission_id;

  if v_verif_count > 0 and v_approved_count < v_verif_count then
    raise exception 'Not all guarantor verifications are approved.';
  end if;

  v_employee_id := v_sub.employee_id;

  -- Activate the employee
  if v_employee_id is not null then
    update public.employees
    set employment_status = 'active', hire_date = coalesce(hire_date, now()::date), updated_at = now()
    where id = v_employee_id;
  end if;

  -- Update submission status
  update public.employee_onboarding_submissions
  set onboarding_status = 'completed', status = 'approved',
      reviewed_by = auth.uid(), reviewed_at = now(), review_comments = 'Onboarding approved'
  where id = p_submission_id;

  insert into public.onboarding_events (onboarding_link_id, event_type, details, actor)
  values (v_sub.link_id, 'ONBOARDING_APPROVED',
          format('Onboarding approved by %s for %s', v_actor_name, coalesce(v_sub.candidate_name, 'employee')), v_actor_name);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('ONBOARDING_APPROVED', 'OnboardingSubmission', p_submission_id::text, v_actor_name,
          format('Onboarding approved for %s (employee: %s)', coalesce(v_sub.candidate_name, ''), v_employee_id), 'info');

  -- Notify HR
  insert into public.notifications (user_id, title, message, type, link)
  select id, 'Onboarding approved',
         format('%s has been approved and is now an active employee.', coalesce(v_sub.candidate_name, 'Employee')),
         'onboarding', '/employees'
  from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer');

  return jsonb_build_object('ok', true, 'employee_id', v_employee_id);
end; $$;
grant execute on function public.approve_onboarding(uuid) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
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
grant execute on function public.add_employee_to_payroll(uuid, text, numeric) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
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
grant execute on function public.reject_onboarding(uuid, text) to authenticated;

-- ============================================================
-- 17. STORAGE POLICIES for guarantor documents
--     Allow anon uploads/reads under guarantor/ paths in documents bucket
-- ============================================================
drop policy if exists "guarantor_docs_anon_upload" on storage.objects;
create policy "guarantor_docs_anon_upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'documents' and name like 'guarantor/%');

drop policy if exists "guarantor_docs_anon_read" on storage.objects;
create policy "guarantor_docs_anon_read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'documents' and name like 'guarantor/%');

drop policy if exists "guarantor_docs_hr_read" on storage.objects;
create policy "guarantor_docs_hr_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and name like 'guarantor/%');
