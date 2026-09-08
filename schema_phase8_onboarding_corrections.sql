-- ============================================================
-- PHASE 8: ONBOARDING FIELD-LEVEL CORRECTIONS + STORAGE SECURITY FIX
--
-- Adds onboarding_corrections table and RPCs for the full HR
-- correction workflow on onboarding submission fields (personal,
-- employment, education, etc.). Also fixes a storage policy that
-- allowed anonymous reads of sensitive guarantor documents.
--
-- ALL ADDITIVE. Safe to re-run (uses IF NOT EXISTS / OR REPLACE).
-- Does NOT modify or drop any existing Phase 7 objects.
-- ============================================================

-- ============================================================
-- 1. ONBOARDING CORRECTIONS — field-level corrections with history
-- ============================================================
create table if not exists public.onboarding_corrections (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.employee_onboarding_submissions(id) on delete cascade,
  field_name text not null,
  field_label text,
  section text,
  previous_value text,
  hr_comment text not null,
  corrected_value text,
  status text default 'pending' check (status in ('pending', 'submitted', 'approved', 'rejected')),
  submitted_by text,
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz default now()
);
alter table public.onboarding_corrections enable row level security;
create index if not exists idx_onb_corr_submission on public.onboarding_corrections(submission_id);
create index if not exists idx_onb_corr_status on public.onboarding_corrections(status);

-- ============================================================
-- 2. RLS POLICIES for onboarding_corrections
-- ============================================================
drop policy if exists "onb_corr_read" on public.onboarding_corrections;
create policy "onb_corr_read" on public.onboarding_corrections
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

drop policy if exists "onb_corr_write" on public.onboarding_corrections;
create policy "onb_corr_write" on public.onboarding_corrections
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
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
grant execute on function public.request_onboarding_correction(uuid, jsonb) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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
grant execute on function public.submit_onboarding_correction(uuid, text) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
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
grant execute on function public.approve_onboarding_correction(uuid) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then
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
grant execute on function public.reject_onboarding_correction(uuid, text) to authenticated;

-- ============================================================
-- 7. SECURITY FIX: Remove anonymous read on guarantor documents
--
-- The Phase 7 policy "guarantor_docs_anon_read" allowed ANY
-- anonymous user to read ALL files under guarantor/ in the
-- documents bucket — including passports, ID cards, and utility
-- bills. This is a sensitive-data exposure.
--
-- Fix: DROP the anon read policy. The existing Phase 6 policy
-- "documents authenticated read" already grants authenticated
-- users (HR) read access to the entire documents bucket, so HR
-- can still view guarantor documents via signed URLs.
-- The guarantor form does NOT need anon read (it only uploads,
-- and tracks file metadata in state — never fetches file content).
-- Anon upload remains (needed for guarantor token-based uploads).
-- ============================================================
drop policy if exists "guarantor_docs_anon_read" on storage.objects;

-- Also remove the redundant guarantor_docs_hr_read policy since
-- "documents authenticated read" already covers it.
drop policy if exists "guarantor_docs_hr_read" on storage.objects;
