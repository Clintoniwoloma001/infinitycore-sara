-- ============================================================================
-- PHASE 49 - GUARANTOR LIFECYCLE, MESSAGE INTEGRITY, BANKONE DIAGNOSTICS
-- ============================================================================
-- Additive and idempotent. Requires the existing Phase 6/7 onboarding,
-- Phase 40 communication, Phase 45 chat engagement, Phase 48 preferences,
-- and Phase 43 BankOne audit objects.
--
-- This migration deliberately does not weaken NOT NULL constraints. Candidate
-- onboarding stores expected guarantor name/email in the submission payload;
-- employee_guarantors is populated only after the guarantor supplies and passes
-- the required verification fields.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. GUARANTOR VERIFICATION LIFECYCLE
-- ---------------------------------------------------------------------------
alter table public.employee_guarantors
  add column if not exists phone text,
  add column if not exists profession text,
  add column if not exists email text;

alter table public.guarantor_verifications
  add column if not exists verified_full_name text,
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id) on delete set null;

update public.guarantor_verifications
set expires_at = coalesce(expires_at, created_at + interval '7 days')
where expires_at is null;

alter table public.guarantor_verifications
  alter column expires_at set default (now() + interval '7 days');

alter table public.guarantor_verifications
  drop constraint if exists guarantor_verifications_status_check;
alter table public.guarantor_verifications
  add constraint guarantor_verifications_status_check
  check (status in (
    'pending_link', 'link_sent', 'started', 'submitted',
    'under_review', 'correction_requested', 'approved', 'rejected', 'revoked'
  ));

alter table public.guarantor_documents
  drop constraint if exists guarantor_documents_document_type_check;
alter table public.guarantor_documents
  add constraint guarantor_documents_document_type_check
  check (document_type in ('passport', 'id_card', 'nin', 'work_id', 'utility_bill', 'other'));

create index if not exists idx_guarantor_verif_expiry
  on public.guarantor_verifications(expires_at);

-- The original Phase 6 dynamic policies used one quoted comma-separated value,
-- which never matched any role. Keep the table private and make the intended
-- employee-own/HR rules explicit.
drop policy if exists "employee_guarantors_read" on public.employee_guarantors;
create policy "employee_guarantors_read" on public.employee_guarantors
  for select using (
    employee_id in (select id from public.employees where user_id = auth.uid())
    or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

drop policy if exists "employee_guarantors_write" on public.employee_guarantors;
create policy "employee_guarantors_write" on public.employee_guarantors
  for all using (public.current_role() in ('super_admin', 'admin', 'hr_manager'))
  with check (public.current_role() in ('super_admin', 'admin', 'hr_manager'));

-- Token-scoped detail lookup. It never returns the raw token and refuses
-- expired, revoked, rejected, or completed links.
create or replace function public.get_guarantor_verification_details(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(coalesce(p_token, ''));
  v_verif record;
  v_docs jsonb;
  v_corrections jsonb;
  v_employee_name text;
  v_position text;
begin
  if coalesce(btrim(p_token), '') = '' then
    raise exception 'Invalid verification link.';
  end if;

  select * into v_verif
  from public.guarantor_verifications
  where token_hash = v_hash;

  if v_verif.id is null then raise exception 'Invalid verification link.'; end if;
  if v_verif.revoked_at is not null or v_verif.status = 'revoked' then
    raise exception 'This verification link has been revoked.';
  end if;
  if v_verif.expires_at is not null and v_verif.expires_at <= now() then
    raise exception 'This verification link has expired.';
  end if;
  if v_verif.status = 'approved' then raise exception 'This verification has been completed.'; end if;
  if v_verif.status = 'rejected' then raise exception 'This verification has been rejected.'; end if;

  if v_verif.status = 'link_sent' then
    update public.guarantor_verifications
    set status = 'started', updated_at = now()
    where id = v_verif.id and status = 'link_sent';
  end if;

  select full_name, position into v_employee_name, v_position
  from public.employees where id = v_verif.employee_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'document_type', d.document_type, 'file_name', d.file_name,
    'file_path', d.file_path, 'status', d.status
  )), '[]'::jsonb) into v_docs
  from public.guarantor_documents d
  where d.guarantor_verification_id = v_verif.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'field_name', c.field_name, 'field_label', c.field_label,
    'previous_value', c.previous_value, 'hr_comment', c.hr_comment,
    'status', c.status
  )), '[]'::jsonb) into v_corrections
  from public.guarantor_corrections c
  where c.guarantor_verification_id = v_verif.id
    and c.status in ('pending', 'submitted', 'approved', 'rejected');

  return jsonb_build_object(
    'id', v_verif.id,
    'guarantor_name', v_verif.guarantor_name,
    'verified_full_name', v_verif.verified_full_name,
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
end; $$;

grant execute on function public.get_guarantor_verification_details(text) to anon, authenticated;

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

  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer') loop
    insert into public.notifications (user_id, title, message, type, link)
    values (v_hr_id, 'Guarantor verification submitted',
            format('%s has completed guarantor verification.', v_full_name), 'onboarding', '/onboarding-links');
  end loop;

  return jsonb_build_object('ok', true, 'verification_id', v_verif.id, 'documents', v_count);
end; $$;

grant execute on function public.submit_guarantor_verification(text, jsonb) to anon, authenticated;

create or replace function public.revoke_guarantor_verification(p_verification_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_name text;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then raise exception 'Not authorized to revoke verification links.'; end if;
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

grant execute on function public.revoke_guarantor_verification(uuid) to authenticated;

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

  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer') loop
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

grant execute on function public.submit_onboarding(text, jsonb) to anon, authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then raise exception 'Not authorized to approve verification'; end if;
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

grant execute on function public.approve_guarantor_verification(uuid) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager') then raise exception 'Not authorized to approve onboarding'; end if;
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
  from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer');

  return jsonb_build_object('ok', true, 'employee_id', v_employee_id);
end; $$;

grant execute on function public.approve_onboarding(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. MESSAGING ATTACHMENT METADATA, READ STATE, AND STORAGE AUTHORIZATION
-- ---------------------------------------------------------------------------
alter table public.message_attachments
  add column if not exists attachment_type text not null default 'file',
  add column if not exists checksum text,
  add column if not exists security_status text not null default 'pending';

do $$
begin
  alter table public.message_attachments
    drop constraint if exists message_attachments_attachment_type_check;
  alter table public.message_attachments
    add constraint message_attachments_attachment_type_check
    check (attachment_type in ('file', 'image', 'document', 'pdf', 'spreadsheet', 'presentation', 'archive', 'voice_note', 'audio', 'video'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.message_attachments
    drop constraint if exists message_attachments_security_status_check;
  alter table public.message_attachments
    add constraint message_attachments_security_status_check
    check (security_status in ('pending', 'accepted', 'rejected', 'scanned'));
exception when duplicate_object then null;
end $$;

create table if not exists public.chat_read_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_type text not null check (conversation_type in ('direct', 'group', 'channel')),
  conversation_id uuid not null,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_read_state_unique unique (user_id, conversation_type, conversation_id)
);
alter table public.chat_read_state enable row level security;
create index if not exists idx_chat_read_state_user on public.chat_read_state(user_id, updated_at desc);

drop policy if exists "chat_read_state_own" on public.chat_read_state;
create policy "chat_read_state_own" on public.chat_read_state
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.mark_chat_thread_read(p_thread_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not exists (
    select 1 from public.chat_threads
    where id = p_thread_id and (member_a = v_me or member_b = v_me)
  ) then raise exception 'Not authorized in this conversation'; end if;
  insert into public.chat_read_state (user_id, conversation_type, conversation_id, last_read_at, updated_at)
  values (v_me, 'direct', p_thread_id, now(), now())
  on conflict (user_id, conversation_type, conversation_id)
  do update set last_read_at = now(), updated_at = now();
  return jsonb_build_object('ok', true, 'conversation_id', p_thread_id, 'read_at', now());
end; $$;
grant execute on function public.mark_chat_thread_read(uuid) to authenticated;

create or replace function public.get_unread_message_counts()
returns table (conversation_type text, conversation_id uuid, unread_count bigint)
language sql stable security definer set search_path = public as $$
  with direct_counts as (
    select 'direct'::text as conversation_type, t.id as conversation_id, count(m.id)::bigint as unread_count
    from public.chat_threads t
    join public.chat_messages m on m.thread_id = t.id and m.message_type = 'direct'
      and m.sender_id <> auth.uid()
    left join public.chat_read_state rs on rs.user_id = auth.uid()
      and rs.conversation_type = 'direct' and rs.conversation_id = t.id
    where (t.member_a = auth.uid() or t.member_b = auth.uid())
      and m.created_at > coalesce(rs.last_read_at, 'epoch'::timestamptz)
    group by t.id
  ), group_counts as (
    select 'group'::text as conversation_type, m.group_id as conversation_id, count(m.id)::bigint as unread_count
    from public.chat_messages m
    join public.message_group_members gm on gm.group_id = m.group_id and gm.member_id = auth.uid()
    left join public.chat_read_state rs on rs.user_id = auth.uid()
      and rs.conversation_type = 'group' and rs.conversation_id = m.group_id
    where m.message_type = 'group' and m.sender_id <> auth.uid()
      and m.created_at > coalesce(rs.last_read_at, 'epoch'::timestamptz)
    group by m.group_id
  ), channel_counts as (
    select 'channel'::text as conversation_type, m.channel_id as conversation_id, count(m.id)::bigint as unread_count
    from public.chat_messages m
    join public.message_channel_members cm on cm.channel_id = m.channel_id and cm.member_id = auth.uid()
    left join public.chat_read_state rs on rs.user_id = auth.uid()
      and rs.conversation_type = 'channel' and rs.conversation_id = m.channel_id
    where m.message_type = 'channel' and m.sender_id <> auth.uid()
      and m.created_at > coalesce(rs.last_read_at, 'epoch'::timestamptz)
    group by m.channel_id
  )
  select * from direct_counts where unread_count > 0
  union all select * from group_counts where unread_count > 0
  union all select * from channel_counts where unread_count > 0;
$$;
grant execute on function public.get_unread_message_counts() to authenticated;

-- Attachment rows are visible only with message access. Storage reads below
-- use the same relationship, so knowing a path is not sufficient.
drop policy if exists "chat_attachment_upload" on storage.objects;
create policy "chat_attachment_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'chat/%'
    and position('..' in name) = 0
    and split_part(name, '/', 4) = auth.uid()::text
    and (
      (split_part(name, '/', 2) = 'direct' and exists (
        select 1 from public.chat_threads t
        where t.id = nullif(split_part(name, '/', 3), '')::uuid
          and (t.member_a = auth.uid() or t.member_b = auth.uid())
      ))
      or (split_part(name, '/', 2) = 'group' and public.is_group_member(nullif(split_part(name, '/', 3), '')::uuid))
      or (split_part(name, '/', 2) = 'channel' and public.is_channel_member(nullif(split_part(name, '/', 3), '')::uuid))
    )
  );

drop policy if exists "chat_attachment_read" on storage.objects;
create policy "chat_attachment_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and name like 'chat/%'
    and exists (
      select 1 from public.message_attachments a
      where a.file_path = name and public.can_read_message(a.message_id)
    )
  );

-- Guarantor documents are uploaded through the token-scoped form but are
-- readable only by authorized HR users through a matching metadata row. Do
-- not leave the legacy anonymous or unrestricted authenticated policies in
-- place, and keep the generic documents policy from overriding this rule.
drop policy if exists "guarantor_docs_anon_read" on storage.objects;
drop policy if exists "guarantor_docs_hr_read" on storage.objects;
drop policy if exists "documents authenticated read" on storage.objects;
create policy "documents authenticated read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and name not like 'guarantor/%'
    and name not like 'chat/%'
  );
create policy "guarantor_docs_hr_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and name like 'guarantor/%'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    and exists (
      select 1 from public.guarantor_documents d
      where d.file_path = name
    )
  );

do $$
declare v_table text;
begin
  foreach v_table in array array['message_attachments', 'chat_read_state'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Rich send now supports direct conversations as well as group/channel/thread
-- contexts. Attachment metadata is validated and all attachment/message audit
-- events are written server-side.
create or replace function public.send_rich_message(
  p_message_type text,
  p_context_id uuid,
  p_body text default null,
  p_priority text default null,
  p_requires_ack boolean default false,
  p_files jsonb default null,
  p_mention_ids uuid[] default null,
  p_parent_message_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_thread_id uuid;
  v_group_id uuid;
  v_channel_id uuid;
  v_priority text;
  v_body text;
  v_file record;
  v_attachment public.message_attachments%rowtype;
  v_mention uuid;
  v_role text;
  v_attachment_count int := 0;
  v_other uuid;
  v_member uuid;
  v_file_type text;
  v_attachment_type text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_message_type not in ('direct', 'group', 'channel', 'thread') then raise exception 'Invalid message type'; end if;
  if p_priority is not null and p_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'Invalid priority'; end if;
  if p_files is not null and jsonb_typeof(p_files) <> 'array' then raise exception 'Attachments must be an array'; end if;
  if p_files is not null and jsonb_array_length(p_files) > 6 then raise exception 'A message may contain at most six attachments'; end if;

  if p_message_type = 'direct' then
    if not exists (
      select 1 from public.chat_threads
      where id = p_context_id and (member_a = v_me or member_b = v_me)
    ) then raise exception 'You are not a member of this conversation'; end if;
    v_thread_id := p_context_id;
  elsif p_message_type = 'group' then
    if not public.is_group_member(p_context_id) then raise exception 'You are not a member of this group'; end if;
    v_group_id := p_context_id;
  elsif p_message_type = 'channel' then
    if not public.is_channel_member(p_context_id) then raise exception 'You are not a member of this channel'; end if;
    v_channel_id := p_context_id;
  else
    if p_parent_message_id is null or not public.can_read_message(p_parent_message_id) then
      raise exception 'Not authorized to reply in this thread';
    end if;
    select thread_id, group_id, channel_id into v_thread_id, v_group_id, v_channel_id
    from public.chat_messages where id = p_parent_message_id;
  end if;

  v_priority := coalesce(p_priority, 'normal');
  if p_requires_ack and v_priority not in ('high', 'urgent') then v_priority := 'high'; end if;
  if p_requires_ack then
    if p_message_type = 'direct' or p_message_type = 'thread' then
      raise exception 'Acknowledgment is only supported for group and channel messages';
    elsif p_message_type = 'group' then v_role := public.group_member_role(p_context_id);
    else v_role := public.channel_member_role(p_context_id); end if;
    if v_role is null or v_role not in ('owner', 'admin', 'moderator') then
      raise exception 'Only moderators can send messages that require acknowledgment';
    end if;
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' and p_files is not null and jsonb_array_length(p_files) > 0 then
    v_body := coalesce(p_files -> 0 ->> 'file_name', 'Attachment');
  end if;
  if v_body = '' then raise exception 'Message body required'; end if;

  if p_files is not null then
    for v_file in select * from jsonb_array_elements(p_files) loop
      v_file_type := lower(coalesce(v_file.value ->> 'file_type', 'application/octet-stream'));
      v_attachment_type := coalesce(v_file.value ->> 'attachment_type', 'file');
      if nullif(v_file.value ->> 'file_path', '') is null
         or position('chat/' in coalesce(v_file.value ->> 'file_path', '')) <> 1
         or position('..' in coalesce(v_file.value ->> 'file_path', '')) > 0 then
        raise exception 'Invalid chat attachment path';
      end if;
      if coalesce(nullif(v_file.value ->> 'file_size', '')::bigint, 0) > 25 * 1024 * 1024 then
        raise exception 'Chat attachment exceeds the 25MB limit';
      end if;
      if v_attachment_type not in ('file', 'image', 'document', 'pdf', 'spreadsheet', 'presentation', 'archive', 'voice_note', 'audio', 'video') then
        raise exception 'Unsupported chat attachment type';
      end if;
      if v_attachment_type = 'voice_note' and v_file_type not like 'audio/%' then
        raise exception 'Voice note attachment must be audio';
      end if;
    end loop;
  end if;

  insert into public.chat_messages (
    message_type, thread_id, group_id, channel_id, sender_id, body,
    parent_message_id, root_message_id, status, priority, requires_ack
  ) values (
    p_message_type, v_thread_id, v_group_id, v_channel_id, v_me, v_body,
    p_parent_message_id,
    case when p_parent_message_id is null then null else coalesce((select root_message_id from public.chat_messages where id = p_parent_message_id), p_parent_message_id) end,
    'sent', v_priority, p_requires_ack
  ) returning * into v_msg;

  if p_files is not null then
    for v_file in select * from jsonb_array_elements(p_files) loop
      insert into public.message_attachments (
        message_id, file_name, file_type, attachment_type, file_size, file_path,
        checksum, security_status, uploaded_by
      ) values (
        v_msg.id,
        coalesce(v_file.value ->> 'file_name', 'attachment'),
        coalesce(v_file.value ->> 'file_type', 'application/octet-stream'),
        coalesce(v_file.value ->> 'attachment_type', 'file'),
        nullif(v_file.value ->> 'file_size', '')::bigint,
        v_file.value ->> 'file_path',
        v_file.value ->> 'checksum', 'accepted', v_me
      ) returning * into v_attachment;
      v_attachment_count := v_attachment_count + 1;
      perform public.write_communication_audit(
        'message_attachment', v_attachment.id, 'message_attachment_uploaded', v_msg.id,
        null, jsonb_build_object('message_id', v_msg.id, 'attachment_type', v_attachment.attachment_type,
                                 'file_name', v_attachment.file_name, 'file_size', v_attachment.file_size), null
      );
    end loop;
  end if;

  if v_attachment_count > 0 and exists (
    select 1 from public.message_attachments where message_id = v_msg.id and attachment_type = 'voice_note'
  ) then
    perform public.write_communication_audit('message', v_msg.id, 'voice_note_sent', v_msg.id, null,
      jsonb_build_object('attachment_count', v_attachment_count), null);
  end if;

  if p_requires_ack and p_message_type in ('group', 'channel') then
    if p_message_type = 'group' then
      insert into public.chat_message_acks (message_id, user_id)
      select v_msg.id, m.member_id from public.message_group_members m
      where m.group_id = v_group_id and m.member_id is distinct from v_me
      on conflict (message_id, user_id) do nothing;
    else
      insert into public.chat_message_acks (message_id, user_id)
      select v_msg.id, m.member_id from public.message_channel_members m
      where m.channel_id = v_channel_id and m.member_id is distinct from v_me
      on conflict (message_id, user_id) do nothing;
    end if;
  end if;

  if p_mention_ids is not null then
    foreach v_mention in array p_mention_ids loop
      if v_mention is distinct from v_me and (
        (p_message_type = 'direct' and exists (select 1 from public.chat_threads t where t.id = v_thread_id and v_mention in (t.member_a, t.member_b)))
        or (p_message_type in ('group', 'thread') and exists (select 1 from public.message_group_members m where m.group_id = coalesce(v_group_id, (select group_id from public.chat_messages where id = p_parent_message_id)) and m.member_id = v_mention))
        or (p_message_type in ('channel', 'thread') and exists (select 1 from public.message_channel_members m where m.channel_id = coalesce(v_channel_id, (select channel_id from public.chat_messages where id = p_parent_message_id)) and m.member_id = v_mention))
      ) then
        insert into public.message_mentions (message_id, user_id, mention_type)
        values (v_msg.id, v_mention, 'employee')
        on conflict (message_id, user_id, mention_type) do nothing;
        insert into public.notifications (user_id, title, message, type, link)
        values (v_mention, 'You were mentioned', left(v_body, 120), 'chat', '/chat');
      end if;
    end loop;
  end if;

  -- One in-app notification per recipient, with mute respected for direct
  -- chats. The message itself remains available in the conversation history.
  if p_message_type = 'direct' then
    select case when member_a = v_me then member_b else member_a end into v_other
    from public.chat_threads where id = v_thread_id;
    if not exists (select 1 from public.chat_thread_user_settings where thread_id = v_thread_id and user_id = v_other and is_muted) then
      insert into public.notifications (user_id, title, message, type, link)
      values (v_other, 'New Message', left(v_body, 120), 'chat', '/chat');
    end if;
  elsif p_message_type = 'group' then
    for v_member in select member_id from public.message_group_members where group_id = v_group_id and member_id <> v_me loop
      insert into public.notifications (user_id, title, message, type, link)
      values (v_member, 'New group message', left(v_body, 120), 'chat', '/chat?tab=groups');
    end loop;
  elsif p_message_type = 'channel' then
    for v_member in select member_id from public.message_channel_members where channel_id = v_channel_id and member_id <> v_me loop
      insert into public.notifications (user_id, title, message, type, link)
      values (v_member, 'New channel message', left(v_body, 120), 'chat', '/chat?tab=channels');
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true, 'id', v_msg.id, 'message_type', v_msg.message_type, 'body', v_msg.body,
    'priority', v_msg.priority, 'requires_ack', v_msg.requires_ack, 'created_at', v_msg.created_at,
    'thread_id', v_msg.thread_id, 'group_id', v_msg.group_id, 'channel_id', v_msg.channel_id,
    'parent_message_id', v_msg.parent_message_id, 'content_hash', v_msg.content_hash,
    'message_seq', v_msg.message_seq, 'attachment_count', v_attachment_count
  );
end; $$;

grant execute on function public.send_rich_message(text, uuid, text, text, boolean, jsonb, uuid[], uuid) to authenticated;

-- Owner protection and explicit ownership transfer for groups/channels.
create or replace function public.remove_group_member(p_group_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_target_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.group_member_role(p_group_id);
  select role into v_target_role from public.message_group_members where group_id = p_group_id and member_id = p_member_id;
  if v_role is null then raise exception 'You are not a member of this group'; end if;
  if v_target_role = 'owner' then raise exception 'The group owner cannot be removed. Transfer ownership first.'; end if;
  if p_member_id = v_me then
    delete from public.message_group_members where group_id = p_group_id and member_id = v_me;
    perform public.write_communication_audit('group', p_group_id, 'group_member_left', null, null, jsonb_build_object('member_id', v_me), 'member left');
    return jsonb_build_object('ok', true);
  end if;
  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can remove members'; end if;
  delete from public.message_group_members where group_id = p_group_id and member_id = p_member_id;
  perform public.write_communication_audit('group', p_group_id, 'group_member_removed', null, null, jsonb_build_object('member_id', p_member_id), 'member removed');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;

create or replace function public.remove_channel_member(p_channel_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_target_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.channel_member_role(p_channel_id);
  select role into v_target_role from public.message_channel_members where channel_id = p_channel_id and member_id = p_member_id;
  if v_role is null then raise exception 'You are not a member of this channel'; end if;
  if v_target_role = 'owner' then raise exception 'The channel owner cannot be removed. Transfer ownership first.'; end if;
  if p_member_id = v_me then
    delete from public.message_channel_members where channel_id = p_channel_id and member_id = v_me;
    perform public.write_communication_audit('channel', p_channel_id, 'channel_member_left', null, null, jsonb_build_object('member_id', v_me), 'member left');
    return jsonb_build_object('ok', true);
  end if;
  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can remove members'; end if;
  delete from public.message_channel_members where channel_id = p_channel_id and member_id = p_member_id;
  perform public.write_communication_audit('channel', p_channel_id, 'channel_member_removed', null, null, jsonb_build_object('member_id', p_member_id), 'member removed');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.remove_channel_member(uuid, uuid) to authenticated;

create or replace function public.update_group_member_role(p_group_id uuid, p_member_id uuid, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_prev text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_role not in ('owner', 'admin', 'moderator', 'member') then raise exception 'Invalid role'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role <> 'owner' then raise exception 'Only the group owner can change member roles'; end if;
  select role into v_prev from public.message_group_members where group_id = p_group_id and member_id = p_member_id;
  if v_prev is null then raise exception 'Member not found in group'; end if;
  if v_prev = 'owner' and p_role <> 'owner' then raise exception 'Transfer ownership before demoting the current owner'; end if;
  if p_role = 'owner' and v_prev <> 'owner' then
    update public.message_group_members set role = 'member' where group_id = p_group_id and role = 'owner';
  end if;
  update public.message_group_members set role = p_role where group_id = p_group_id and member_id = p_member_id;
  perform public.write_communication_audit('group', p_group_id, 'group_member_role_changed', null,
    jsonb_build_object('member_id', p_member_id, 'role', v_prev), jsonb_build_object('member_id', p_member_id, 'role', p_role), 'member role changed');
  return jsonb_build_object('ok', true, 'ownership_transferred', p_role = 'owner');
end; $$;
grant execute on function public.update_group_member_role(uuid, uuid, text) to authenticated;

create or replace function public.update_channel_member_role(p_channel_id uuid, p_member_id uuid, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_prev text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_role not in ('owner', 'admin', 'moderator', 'member') then raise exception 'Invalid role'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role <> 'owner' then raise exception 'Only the channel owner can change member roles'; end if;
  select role into v_prev from public.message_channel_members where channel_id = p_channel_id and member_id = p_member_id;
  if v_prev is null then raise exception 'Member not found in channel'; end if;
  if v_prev = 'owner' and p_role <> 'owner' then raise exception 'Transfer ownership before demoting the current owner'; end if;
  if p_role = 'owner' and v_prev <> 'owner' then
    update public.message_channel_members set role = 'member' where channel_id = p_channel_id and role = 'owner';
  end if;
  update public.message_channel_members set role = p_role where channel_id = p_channel_id and member_id = p_member_id;
  perform public.write_communication_audit('channel', p_channel_id, 'channel_member_role_changed', null,
    jsonb_build_object('member_id', p_member_id, 'role', v_prev), jsonb_build_object('member_id', p_member_id, 'role', p_role), 'member role changed');
  return jsonb_build_object('ok', true, 'ownership_transferred', p_role = 'owner');
end; $$;
grant execute on function public.update_channel_member_role(uuid, uuid, text) to authenticated;

create or replace function public.trg_channel_creation_authorization()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.channel_type <> 'team' and not public.is_communication_admin() then
    raise exception 'Only authorized communication administrators can create official channels.';
  end if;
  return new;
end; $$;

drop trigger if exists trg_channel_creation_authorization on public.message_channels;
create trigger trg_channel_creation_authorization
  before insert on public.message_channels
  for each row execute function public.trg_channel_creation_authorization();

-- A skipped diagnostic must be auditable but must not mark BankOne connected,
-- failed, or authenticated. This is used when no harmless documented provider
-- health endpoint is available.
drop function if exists public.integration_record_provider_call(text, text, text, text, text, int, int, text, text, text, text);
drop function if exists public.integration_record_provider_call(text, text, text, text, text, int, int, text, text, text, text, uuid);

create or replace function public.integration_record_provider_call(
  p_environment text,
  p_operation text,
  p_endpoint text default null,
  p_direction text default 'out',
  p_status text default 'ok',
  p_http_status int default null,
  p_duration_ms int default null,
  p_correlation_id text default null,
  p_error_category text default null,
  p_masked_summary text default null,
  p_record_reference text default null,
  p_created_by uuid default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' and public.current_role() <> 'super_admin' then
    raise exception 'Only the server-side integration runtime can record provider calls.';
  end if;

  insert into public.integration_logs (
    environment, operation, endpoint, direction, status, http_status,
    duration_ms, record_reference, correlation_id, error_category, masked_summary, created_by
  ) values (
    p_environment, p_operation, p_endpoint, p_direction, p_status, p_http_status,
    p_duration_ms, p_record_reference, p_correlation_id,
    p_error_category, left(coalesce(p_masked_summary, ''), 2000), p_created_by
  );

  if p_status = 'ok' then
    update public.integration_connections
    set status = 'connected', last_connected_at = now(), last_success_at = now(),
        last_error = null, last_fail_at = null
    where provider = 'bankone' and environment = p_environment;
  elsif p_status <> 'skipped' then
    update public.integration_connections
    set last_fail_at = now(), last_error = left(coalesce(p_error_category, 'request_failed'), 200)
    where provider = 'bankone' and environment = p_environment;
  end if;
end; $$;

grant execute on function public.integration_record_provider_call(text, text, text, text, text, int, int, text, text, text, text, uuid)
  to authenticated;
