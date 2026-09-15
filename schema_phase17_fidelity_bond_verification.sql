-- ============================================================
-- PHASE 17 — FIDELITY BOND VERIFICATION WORKFLOW
--
-- Mirrors the Phase 7 guarantor verification flow for fidelity
-- bonds: HR generates a secure one-time link (md5-hashed token),
-- the surety completes an identity form + uploads documents, and
-- HR approves/rejects the verification in the review centre.
--
-- ALL ADDITIVE. Idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- ------------------------------------------------------------
-- 1. FIDELITY BOND VERIFICATIONS — main verification record
-- ------------------------------------------------------------
create table if not exists public.fidelity_bond_verifications (
  id uuid primary key default gen_random_uuid(),
  onboarding_link_id uuid references public.employee_onboarding_links(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  submission_id uuid references public.employee_onboarding_submissions(id) on delete set null,
  bond_id uuid references public.employee_fidelity_bonds(id) on delete set null,
  surety_name text not null,
  surety_email text not null,
  surety_relationship text,
  token_hash text unique not null,
  status text default 'pending_link' check (status in (
    'pending_link', 'link_sent', 'started', 'submitted',
    'under_review', 'correction_requested', 'approved', 'rejected'
  )),
  -- Identity fields (filled by surety)
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
alter table public.fidelity_bond_verifications enable row level security;
create index if not exists idx_fidelity_verif_token on public.fidelity_bond_verifications(token_hash);
create index if not exists idx_fidelity_verif_employee on public.fidelity_bond_verifications(employee_id);
create index if not exists idx_fidelity_verif_submission on public.fidelity_bond_verifications(submission_id);

-- Track fidelity events on the shared onboarding_events timeline
-- (runs AFTER the table exists so the FK resolves on a fresh apply)
alter table public.onboarding_events
  add column if not exists fidelity_verification_id uuid
    references public.fidelity_bond_verifications(id) on delete set null;
create index if not exists idx_onboard_events_fidelity
  on public.onboarding_events(fidelity_verification_id);
create index if not exists idx_fidelity_verif_bond on public.fidelity_bond_verifications(bond_id);
create index if not exists idx_fidelity_verif_status on public.fidelity_bond_verifications(status);

-- RLS: HR read/write; anon access exclusively via the token RPCs below
drop policy if exists "fidelity_verif_read" on public.fidelity_bond_verifications;
create policy "fidelity_verif_read" on public.fidelity_bond_verifications
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager'));
drop policy if exists "fidelity_verif_write" on public.fidelity_bond_verifications;
create policy "fidelity_verif_write" on public.fidelity_bond_verifications
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));
drop policy if exists "fidelity_verif_update" on public.fidelity_bond_verifications;
create policy "fidelity_verif_update" on public.fidelity_bond_verifications
  for update using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- ------------------------------------------------------------
-- 2. FIDELITY BOND DOCUMENTS — uploaded evidence (metadata only)
-- ------------------------------------------------------------
create table if not exists public.fidelity_bond_documents (
  id uuid primary key default gen_random_uuid(),
  fidelity_verification_id uuid not null references public.fidelity_bond_verifications(id) on delete cascade,
  document_type text not null,
  file_name text not null,
  file_path text not null,
  file_size bigint default 0,
  mime_type text,
  status text default 'pending' check (status in ('pending', 'verified', 'rejected')),
  created_at timestamptz default now()
);
alter table public.fidelity_bond_documents enable row level security;
create index if not exists idx_fidelity_docs_verif on public.fidelity_bond_documents(fidelity_verification_id);

drop policy if exists "fidelity_docs_read" on public.fidelity_bond_documents;
create policy "fidelity_docs_read" on public.fidelity_bond_documents
  for select using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager'));
drop policy if exists "fidelity_docs_write" on public.fidelity_bond_documents;
create policy "fidelity_docs_write" on public.fidelity_bond_documents
  for insert with check (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- ------------------------------------------------------------
-- 3. RPC: get_fidelity_verification_details (anon, token-scoped)
-- ------------------------------------------------------------
create or replace function public.get_fidelity_verification_details(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_verif record;
  v_employee record;
  v_docs jsonb;
begin
  select * into v_verif from public.fidelity_bond_verifications where token_hash = v_hash;
  if v_verif.id is null then
    raise exception 'Invalid verification link.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'document_type', d.document_type, 'file_name', d.file_name,
    'file_path', d.file_path, 'mime_type', d.mime_type, 'status', d.status
  )), '[]'::jsonb) into v_docs
  from public.fidelity_bond_documents d where d.fidelity_verification_id = v_verif.id;

  if v_verif.status in ('approved', 'rejected') then
    return jsonb_build_object(
      'id', v_verif.id, 'status', v_verif.status,
      'surety_name', v_verif.surety_name, 'surety_email', v_verif.surety_email,
      'surety_relationship', v_verif.surety_relationship,
      'submitted_at', v_verif.submitted_at, 'reviewed_at', v_verif.reviewed_at,
      'hr_comments', v_verif.hr_comments,
      'documents', coalesce(v_docs, '[]'::jsonb)
    );
  end if;

  -- First open: mark as started
  if v_verif.status in ('pending_link', 'link_sent') then
    update public.fidelity_bond_verifications set status = 'started', updated_at = now()
    where id = v_verif.id;
    v_verif.status := 'started';
  end if;

  select full_name, "position", department into v_employee
  from public.employees where id = v_verif.employee_id;

  return jsonb_build_object(
    'id', v_verif.id, 'status', v_verif.status,
    'surety_name', v_verif.surety_name, 'surety_email', v_verif.surety_email,
    'surety_relationship', v_verif.surety_relationship,
    'employee_name', v_employee.full_name, 'position', v_employee."position",
    'phone', v_verif.phone, 'residential_address', v_verif.residential_address,
    'occupation', v_verif.occupation, 'employer', v_verif.employer,
    'bvn', v_verif.bvn, 'nin', v_verif.nin,
    'selfie_data', v_verif.selfie_data, 'selfie_captured_at', v_verif.selfie_captured_at,
    'signature_data', v_verif.signature_data, 'signature_date', v_verif.signature_date,
    'documents', coalesce(v_docs, '[]'::jsonb)
  );
end;
$$;
grant execute on function public.get_fidelity_verification_details(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. RPC: submit_fidelity_verification (anon, token-scoped)
-- ------------------------------------------------------------
create or replace function public.submit_fidelity_verification(p_token text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_verif record;
  v_phone text := p_payload ->> 'phone';
  v_address text := p_payload ->> 'residential_address';
  v_occupation text := p_payload ->> 'occupation';
  v_employer text := p_payload ->> 'employer';
  v_bvn text := p_payload ->> 'bvn';
  v_nin text := p_payload ->> 'nin';
  v_selfie text := p_payload ->> 'selfie_data';
  v_sig text := p_payload ->> 'signature_data';
  v_sig_date text := p_payload ->> 'signature_date';
  v_docs jsonb := p_payload -> 'documents';
begin
  select * into v_verif from public.fidelity_bond_verifications where token_hash = v_hash;
  if v_verif.id is null then
    raise exception 'Invalid verification link.';
  end if;
  if v_verif.status = 'approved' then
    raise exception 'This verification has already been approved.';
  end if;
  if v_verif.status = 'rejected' then
    raise exception 'This verification has been rejected. Contact HR.';
  end if;

  update public.fidelity_bond_verifications
     set status = 'submitted',
         phone = coalesce(v_phone, phone),
         residential_address = coalesce(v_address, residential_address),
         occupation = coalesce(v_occupation, occupation),
         employer = coalesce(v_employer, employer),
         bvn = coalesce(v_bvn, bvn),
         nin = coalesce(v_nin, nin),
         selfie_data = coalesce(v_selfie, selfie_data),
         selfie_captured_at = case when v_selfie is not null then now() else selfie_captured_at end,
         signature_data = coalesce(v_sig, signature_data),
         signature_date = coalesce(v_sig_date::date, signature_date),
         submitted_at = now(),
         updated_at = now()
   where id = v_verif.id;

  -- Sync documents metadata
  if v_docs is not null and jsonb_array_length(v_docs) > 0 then
    insert into public.fidelity_bond_documents (
      fidelity_verification_id, document_type, file_name, file_path, mime_type
    )
    select v_verif.id, doc ->> 'document_type', doc ->> 'file_name', doc ->> 'file_path', doc ->> 'mime_type'
    from jsonb_array_elements(v_docs) doc
    on conflict do nothing;
  end if;

  insert into public.onboarding_events (event_type, details, actor, fidelity_verification_id)
  values ('FIDELITY_SUBMITTED',
          format('Fidelity bond verification submitted by %s', v_verif.surety_name),
          v_verif.surety_name, v_verif.id);

  return jsonb_build_object('ok', true, 'verification_id', v_verif.id);
end;
$$;
grant execute on function public.submit_fidelity_verification(text, jsonb) to anon, authenticated;

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
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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
grant execute on function public.approve_fidelity_verification(uuid) to authenticated;

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
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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
grant execute on function public.reject_fidelity_verification(uuid, text) to authenticated;