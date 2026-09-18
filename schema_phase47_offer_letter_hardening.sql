-- ============================================================================
-- schema_phase47_offer_letter_hardening.sql
-- ============================================================================
-- Additive hardening for the structured Infinity MFB offer-letter flow.
-- Requires the existing Phase 41 career lifecycle and Phase 45 offer template
-- migrations. Safe to re-run.
-- ============================================================================

-- 1. Persist the document date and template date format without changing old
-- rows or removing any historical offer data.
alter table public.offer_letter_templates
  add column if not exists date_format text default 'en-GB';

alter table public.offer_letters
  add column if not exists offer_date date;

update public.offer_letters
set offer_date = coalesce(offer_date, issue_date, issued_at::date, created_at::date, current_date)
where offer_date is null;

update public.offer_letter_templates
set date_format = coalesce(nullif(date_format, ''), 'en-GB')
where date_format is null or date_format = '';

-- Remove only the placeholder contact values shipped by the earlier seed;
-- genuine HR-entered company details are left untouched.
update public.offer_letter_templates
set company_info = jsonb_set(
  jsonb_set(company_info, '{address}', '""'::jsonb, true),
  '{email}', '""'::jsonb, true
)
where company_info ->> 'address' = 'Lagos, Nigeria'
  and company_info ->> 'email' = 'hr@infinitymfb.com.ng';

-- 2. Server-assigned, human-readable references: OFR-YYYYMMDD-0001.
create table if not exists public.offer_reference_sequences (
  reference_date date primary key,
  last_value integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.offer_reference_sequences enable row level security;

create or replace function public.next_offer_reference_with_prefix(p_prefix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date := current_date;
  v_number integer;
begin
  insert into public.offer_reference_sequences (reference_date, last_value)
  values (v_date, 1)
  on conflict (reference_date) do update
    set last_value = public.offer_reference_sequences.last_value + 1,
        updated_at = now()
  returning last_value into v_number;

  return coalesce(nullif(regexp_replace(upper(trim(p_prefix)), '[^A-Z0-9]', '', 'g'), ''), 'OFR')
    || '-' || to_char(v_date, 'YYYYMMDD') || '-' || lpad(v_number::text, 4, '0');
end;
$$;
revoke all on function public.next_offer_reference_with_prefix(text) from public;

create or replace function public.next_offer_reference()
returns text
language sql
security definer
set search_path = public
as $$ select public.next_offer_reference_with_prefix('OFR'); $$;
revoke all on function public.next_offer_reference() from public;

create or replace function public.hr_allocate_offer_reference()
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  return public.next_offer_reference();
end;
$$;
grant execute on function public.hr_allocate_offer_reference() to authenticated;

create or replace function public.hr_allocate_offer_reference_with_prefix(p_prefix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  return public.next_offer_reference_with_prefix(coalesce(p_prefix, 'OFR'));
end;
$$;
grant execute on function public.hr_allocate_offer_reference_with_prefix(text) to authenticated;

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
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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
grant execute on function public.hr_create_offer(uuid, uuid, jsonb) to authenticated;

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
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
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
grant execute on function public.hr_modify_offer(uuid, jsonb) to authenticated;

-- 5. Issue an offer with a stable offer date.
create or replace function public.hr_issue_offer(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := public.current_role(); v_offer public.offer_letters;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
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
grant execute on function public.hr_issue_offer(uuid) to authenticated;

-- 6. A document can only be linked to the offer that owns its private file.
create or replace function public.hr_set_offer_document(p_offer_id uuid, p_document_id uuid, p_file_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := public.current_role(); v_offer public.offer_letters; v_doc public.documents;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then raise exception 'Offer not found'; end if;
  select * into v_doc from public.documents where id = p_document_id and entity_type = 'offer_letter' and entity_id = p_offer_id;
  if v_doc.id is null then raise exception 'The document does not belong to this offer'; end if;
  update public.offer_letters set document_id = p_document_id, digital_file_name = coalesce(nullif(p_file_name, ''), v_doc.file_name), updated_at = now() where id = p_offer_id;
  perform public.hr_audit('OFFER_DOCUMENT_ATTACHED', 'OfferLetter', p_offer_id::text, format('Digital copy attached to offer %s', v_offer.offer_number));
  return jsonb_build_object('ok', true, 'document_id', p_document_id);
end;
$$;
grant execute on function public.hr_set_offer_document(uuid, uuid, text) to authenticated;

create or replace function public.hr_send_offer(p_offer_id uuid, p_emailed_to text default null, p_document_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := public.current_role(); v_offer public.offer_letters; v_doc public.documents;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
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
grant execute on function public.hr_send_offer(uuid, text, uuid) to authenticated;

create or replace function public.hr_withdraw_offer(p_offer_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_role text := public.current_role(); v_offer public.offer_letters;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then raise exception 'Not authorized'; end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then raise exception 'Offer not found'; end if;
  if v_offer.status = 'accepted' then raise exception 'Accepted offers cannot be withdrawn'; end if;
  update public.offer_letters set status = 'withdrawn', other_terms = coalesce(other_terms, '') || E'\nWithdrawn: ' || coalesce(p_note, ''), updated_at = now() where id = p_offer_id;
  perform public.hr_audit('OFFER_WITHDRAWN', 'OfferLetter', p_offer_id::text, coalesce(p_note, 'Offer withdrawn'));
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.hr_withdraw_offer(uuid, text) to authenticated;

-- 7. Scope offer-file uploads to HR roles while preserving existing document
-- uploads for the other modules.
drop policy if exists "offer_letter_hr_upload" on storage.objects;
create policy "offer_letter_hr_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'offer_letter/%'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

drop policy if exists "offer_letter_hr_delete" on storage.objects;
create policy "offer_letter_hr_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and name like 'offer_letter/%'
    and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );

drop policy if exists "documents authenticated read" on storage.objects;
create policy "documents authenticated read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (
      public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
      or exists (
        select 1 from public.documents d
        where d.file_path = name and d.uploaded_by = auth.uid()
      )
      or (
        name like 'employee/%'
        and exists (
          select 1 from public.employees e
          where e.id::text = split_part(name, '/', 2) and e.user_id = auth.uid()
        )
      )
    )
  );

drop policy if exists "documents_insert_user" on public.documents;
create policy "documents_insert_user" on public.documents
  for insert with check (
    auth.role() = 'authenticated'
    and (entity_type <> 'offer_letter' or public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'))
  );

-- The public candidate flow remains token-gated through public_get_offer_by_token;
-- no public table or storage policy is added for offer documents.
