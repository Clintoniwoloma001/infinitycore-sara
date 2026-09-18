-- ============================================================================
-- schema_phase45_offer_letter_templates.sql
-- ============================================================================
-- Phase 45 — Professional Offer Letter documents.
--
-- Extends the existing offer-letter architecture (Phase 2 + Phase 41) with:
--   • Template structure: typed templates, opening paragraph, numbered
--     sections (shipped defaults), company/signatory blocks, salary structure,
--     reference prefix + validity.
--   • Offer rows: persisted remuneration/salary-structure snapshot, template
--     type, candidate address, attached digital copy (documents bucket),
--     sent timestamp + recipient.
--   • hr_create_offer / hr_modify_offer persist the new fields.
--   • hr_set_offer_document + hr_send_offer RPCs link the saved PDF and mark
--     an offer as sent (audited), reusing hr_issue_offer semantics.
--
-- Idempotent / additive: safe to re-run in the Supabase SQL Editor.
-- No destructive changes; historical offers keep rendering.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Offer letter templates — richer, typed, structured.
-- ----------------------------------------------------------------------------
alter table public.offer_letter_templates
  add column if not exists template_type text default 'standard'
    check (template_type in ('standard', 'executive', 'contract', 'intern')),
  add column if not exists reference_prefix text default 'OFR',
  add column if not exists validity_days int default 7,
  add column if not exists opening text,
  add column if not exists company_info jsonb default '{}'::jsonb,
  add column if not exists signatories jsonb default '{}'::jsonb,
  add column if not exists sections jsonb default '[]'::jsonb,
  add column if not exists salary_config jsonb default '{}'::jsonb,
  add column if not exists archived boolean default false;

-- ----------------------------------------------------------------------------
-- 2. Offer letters — remuneration snapshot + digital file + sent tracking.
-- ----------------------------------------------------------------------------
alter table public.offer_letters
  add column if not exists document_id uuid,
  add column if not exists remuneration jsonb default '{}'::jsonb,
  add column if not exists salary_structure jsonb default '{}'::jsonb,
  add column if not exists template_type text,
  add column if not exists candidate_address text,
  add column if not exists sent_at timestamptz,
  add column if not exists emailed_to text,
  add column if not exists digital_file_name text;

-- ----------------------------------------------------------------------------
-- 3. Default content constants for backfill + seed.
-- ----------------------------------------------------------------------------
create or replace function public.offer_letter_default_sections()
returns jsonb
language sql stable as $$
select '[
  {"number":"1.0","title":"HOURS OF WORK","body":"Your working hours shall be as may be determined by the Bank from time to time. As at the date of this offer the Bank''s working hours are as follows:\n\nResumption Time: {{resumption_time}}\nCustomer Service Hours: {{working_hours}}\nWorking Days: {{working_days}}\nLunch Break: {{lunch_break}}"},
  {"number":"2.0","title":"ORGANISATIONAL COMMITMENT","body":"As an employee of the Bank you are required to devote your full time, attention and ability to the duties assigned to you and to act at all times in the best interest of the Bank. You must not, without the prior written approval of the Bank, engage in any other business or occupation, whether remunerated or not."},
  {"number":"3.0","title":"PROBATION","body":"Your appointment is subject to a probationary period of {{probation_months}} month(s). During the probation period the Bank shall assess your performance, conduct and suitability for confirmation. The Bank may, at its discretion, extend or terminate the probationary period in line with the conditions of employment."},
  {"number":"4.0","title":"GUARANTOR / SURETY","body":"As a condition of your employment you are required to provide an acceptable guarantor who shall execute the Bank''s Guarantor form, confirming his/her responsibility for your fidelity and for the due performance of your duties. Your confirmation of appointment shall be subject to the satisfactory completion of this requirement."},
  {"number":"5.0","title":"MEDICAL FITNESS","body":"Your employment is conditional upon your being medically fit for the duties of the position. You may be required to undergo a medical examination at the Bank''s appointed medical facility, and continued employment may be subject to periodic medical checks in line with the Bank''s policy."},
  {"number":"6.0","title":"REMUNERATION","body":"Your remuneration shall be as set out in the Remuneration Schedule below. Basic pay and allowances attract statutory deductions (PAYE, pension and other contributions) as required by law and by the Bank''s policy."},
  {"number":"7.0","title":"LEAVE ENTITLEMENT","body":"You shall be entitled to {{leave_entitlement}} annual leave per calendar year, subject to the exigencies of the Bank''s operations and the approval of your supervisor. Leave not taken within the year shall be treated in line with the Bank''s leave policy."},
  {"number":"8.0","title":"CONFIDENTIALITY","body":"You shall treat as confidential all information relating to the Bank''s business, customers, staff, systems, records and affairs that may come to your knowledge during or in connection with your employment. You shall not, without the Bank''s written consent, disclose any such information to any person or use it for your own or another''s benefit, during or after your employment with the Bank."},
  {"number":"9.0","title":"CODE OF CONDUCT","body":"You are required to comply at all times with the Bank''s Code of Conduct, policies, procedures and standing instructions, and to conduct yourself with the highest degree of integrity, probity and professionalism consistent with the Bank''s standing as a licensed microfinance bank."},
  {"number":"10.0","title":"COMPANY POLICIES","body":"Your employment is subject to the Bank''s rules, policies and administrative circulars as issued and amended from time to time, including but not limited to those governing information technology, internet and electronic communications, gifts and entertainment, and anti-money-laundering and combating the financing of terrorism (AML/CFT) obligations."},
  {"number":"11.0","title":"TERMINATION / NOTICE","body":"Your employment may be terminated by either party giving the other the period of notice stipulated in the conditions of employment or by payment of salary in lieu of notice. The Bank reserves the right to summarily terminate your appointment in cases of gross misconduct, fraud, or any other action constituting a breach of the conditions of employment."},
  {"number":"12.0","title":"CONDITIONS OF EMPLOYMENT","body":"This offer is subject to the satisfactory completion of your medical fitness and guarantor requirements, and to the terms and conditions of employment operative at the Bank. {{conditions}}"},
  {"number":"13.0","title":"ACCEPTANCE OF OFFER","body":"Please indicate your acceptance of this offer by signing the acceptance section below and returning a copy of this letter on or before {{acceptance_deadline}}. Your acceptance confirms that you agree to be bound by the terms and conditions of employment as stated above and as may be issued by the Bank from time to time."}
]'::jsonb
$$;

create or replace function public.offer_letter_default_company()
returns jsonb language sql stable as $$
select '{"name":"Infinity Microfinance Bank Ltd","short_name":"Infinity MFB","address":"","rc_number":"","email":"","phone":"","website":"","tagline":""}'::jsonb
$$;

create or replace function public.offer_letter_default_signatories()
returns jsonb language sql stable as $$
select '{"hr_name":"Human Resources Manager","hr_title":"Human Resources Manager","md_name":"Managing Director / Chief Executive Officer","md_title":"Managing Director / Chief Executive Officer","signature_data":null,"department":"Human Resources Department"}'::jsonb
$$;

create or replace function public.offer_letter_default_opening()
returns text language sql stable as $$
select 'With reference to your application and the subsequent interview(s) conducted with us, we are pleased to offer you employment with {{company_name}} on the terms and conditions set out below. Please find below a summary of your offer and the terms and conditions of employment.'::text
$$;

create or replace function public.offer_letter_default_salary_config()
returns jsonb language sql stable as $$
select '{"annual_salary":0,"monthly_salary":0,"mid_month_salary":0,"end_month_salary":0,"mid_month_ratio":0.5,
  "pay":{"basic":0,"housing":0,"transport":0,"furniture":0,"medical":0,"dressing":0,"utility":0,"lunch":0,"telephone":0,"education":0},
  "coa":{"coa":0},
  "benefit":{"leave_allowance":0,"thirteenth_month":0,"other_benefit":0},
  "social":{"pension":0,"hmo":0,"group_life":0,"other_social":0}}'::jsonb
$$;

-- ----------------------------------------------------------------------------
-- 4. Backfill existing templates so historical offers keep rendering & every
--    template always has a complete structured document definition.
-- ----------------------------------------------------------------------------
update public.offer_letter_templates set
  template_type = coalesce(nullif(template_type, ''), 'standard'),
  reference_prefix = coalesce(nullif(reference_prefix, ''), 'OFR'),
  validity_days = coalesce(validity_days, 7),
  opening = coalesce(nullif(opening, ''), public.offer_letter_default_opening()),
  sections = case
    when sections is null or jsonb_typeof(sections) <> 'array' or jsonb_array_length(sections) = 0
      then public.offer_letter_default_sections()
    else sections end,
  company_info = case
    when company_info is null or jsonb_typeof(company_info) <> 'object' or nullif(company_info ->> 'name', '') is null
      then public.offer_letter_default_company()
    else company_info end,
  signatories = case
    when signatories is null or jsonb_typeof(signatories) <> 'object' or nullif(signatories ->> 'hr_name', '') is null
      then public.offer_letter_default_signatories()
    else signatories end,
  salary_config = case
    when salary_config is null or jsonb_typeof(salary_config) <> 'object'
      then public.offer_letter_default_salary_config()
    else salary_config end,
  archived = coalesce(archived, false);

-- Ensure a default template always exists.
insert into public.offer_letter_templates (
  name, subject, opening, body, sections, company_info, signatories, salary_config,
  reference_prefix, validity_days, template_type, is_default, active, archived
)
select
  'Standard Staff Offer', 'Offer of Employment — {{company_name}}',
  public.offer_letter_default_opening(), '',
  public.offer_letter_default_sections(),
  public.offer_letter_default_company(),
  public.offer_letter_default_signatories(),
  public.offer_letter_default_salary_config(),
  'OFR', 7, 'standard', true, true, false
where not exists (select 1 from public.offer_letter_templates where is_default = true and archived = false);

-- ----------------------------------------------------------------------------
-- 5. RPC: hr_create_offer — persist the Phase 45 fields.
-- ----------------------------------------------------------------------------
create or replace function public.hr_create_offer(p_candidate_id uuid, p_job_id uuid default null, p_offer jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_name text;
  v_token text := public.generate_secure_token();
  v_offer_id uuid;
  v_offer_no text;
  v_candidate public.hr_candidates;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to issue offers';
  end if;
  select * into v_candidate from public.hr_candidates where id = p_candidate_id;
  if v_candidate.id is null then
    raise exception 'Candidate not found';
  end if;
  select coalesce(full_name, '') into v_name from public.profiles where id = auth.uid();

  v_offer_no := 'OFR-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(v_token, 1, 6));

  insert into public.offer_letters (
    candidate_id, job_id, candidate_name, "position", company_name,
    department, branch, employment_type, annual_salary, monthly_salary,
    mid_month_salary, end_month_salary, allowances, benefits,
    start_date, probation_months, reporting_manager, working_hours,
    leave_entitlement, conditions, other_terms, acceptance_deadline,
    salary, template_id, template_type, candidate_address,
    remuneration, salary_structure, document_id, digital_file_name,
    body_content, version, generated_by,
    offer_number, token_hash, status, created_by
  ) values (
    p_candidate_id, coalesce(p_job_id, v_candidate.job_id),
    v_candidate.full_name,
    coalesce(nullif(p_offer ->> 'position', ''), v_candidate.applied_role),
    coalesce(nullif(p_offer ->> 'company_name', ''), 'Infinity Bank'),
    coalesce(nullif(p_offer ->> 'department', ''), v_candidate.department),
    coalesce(nullif(p_offer ->> 'branch', ''), v_candidate.branch),
    coalesce(nullif(p_offer ->> 'employment_type', ''), 'full_time'),
    coalesce((p_offer ->> 'annual_salary')::numeric, 0),
    coalesce((p_offer ->> 'monthly_salary')::numeric,
       round(coalesce((p_offer ->> 'annual_salary')::numeric, 0) / 12, 2)),
    coalesce((p_offer ->> 'mid_month_salary')::numeric,
       round(coalesce((p_offer ->> 'monthly_salary')::numeric,
             coalesce((p_offer ->> 'annual_salary')::numeric, 0) / 12) * 0.5, 2)),
    coalesce((p_offer ->> 'end_month_salary')::numeric, 0),
    coalesce(p_offer -> 'allowances', '[]'::jsonb),
    nullif(btrim(coalesce(p_offer ->> 'benefits', '')), ''),
    coalesce((p_offer ->> 'start_date')::date, current_date),
    coalesce((p_offer ->> 'probation_months')::int, 3),
    nullif(btrim(coalesce(p_offer ->> 'reporting_manager', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'working_hours', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'leave_entitlement', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'conditions', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'other_terms', '')), ''),
    coalesce((p_offer ->> 'acceptance_deadline')::date,
      (current_date + interval '7 days')::date),
    coalesce((p_offer ->> 'salary')::numeric, 0),
    nullif((p_offer ->> 'template_id')::uuid, null),
    nullif(btrim(coalesce(p_offer ->> 'template_type', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'candidate_address', '')), ''),
    coalesce(p_offer -> 'remuneration', '{}'::jsonb),
    coalesce(p_offer -> 'salary_structure', '{}'::jsonb),
    nullif((p_offer ->> 'document_id')::uuid, null),
    nullif(btrim(coalesce(p_offer ->> 'digital_file_name', '')), ''),
    nullif(btrim(coalesce(p_offer ->> 'body_content', '')), ''),
    1,
    coalesce(nullif(p_offer ->> 'generated_by', ''), 'manual'),
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
end; $$;
grant execute on function public.hr_create_offer(uuid, uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. RPC: hr_modify_offer — draft updates & new versions carry the Phase 45
--    fields too.
-- ----------------------------------------------------------------------------
create or replace function public.hr_modify_offer(p_offer_id uuid, p_offer jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
  v_token text := public.generate_secure_token();
  v_new_id uuid;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;

  if v_offer.status = 'draft' then
    update public.offer_letters set
      "position" = coalesce(nullif(p_offer ->> 'position', ''), "position"),
      company_name = coalesce(nullif(p_offer ->> 'company_name', ''), company_name),
      department = coalesce(nullif(p_offer ->> 'department', ''), department),
      branch = coalesce(nullif(p_offer ->> 'branch', ''), branch),
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
      template_id = coalesce(nullif((p_offer ->> 'template_id')::uuid, null), template_id),
      template_type = coalesce(nullif(btrim(coalesce(p_offer ->> 'template_type', '')), ''), template_type),
      candidate_address = coalesce(nullif(btrim(coalesce(p_offer ->> 'candidate_address', '')), ''), candidate_address),
      remuneration = coalesce(p_offer -> 'remuneration', remuneration),
      salary_structure = coalesce(p_offer -> 'salary_structure', salary_structure),
      document_id = coalesce(nullif((p_offer ->> 'document_id')::uuid, null), document_id),
      digital_file_name = coalesce(nullif(btrim(coalesce(p_offer ->> 'digital_file_name', '')), ''), digital_file_name),
      body_content = coalesce(nullif(p_offer ->> 'body_content', ''), body_content),
      updated_at = now()
    where id = p_offer_id;
    perform public.hr_audit('OFFER_MODIFIED', 'OfferLetter', p_offer_id::text, 'Draft offer updated');
    return jsonb_build_object('ok', true, 'offer_id', p_offer_id, 'new_version', v_offer.version);
  elsif v_offer.status in ('issued', 'draft') then
    insert into public.offer_letters (
      candidate_id, job_id, candidate_name, "position", company_name, department, branch,
      employment_type, salary, annual_salary, monthly_salary, mid_month_salary, end_month_salary,
      allowances, benefits, start_date, probation_months, reporting_manager, working_hours,
      leave_entitlement, conditions, other_terms, acceptance_deadline, template_id, template_type,
      candidate_address, remuneration, salary_structure, document_id, digital_file_name, body_content,
      version, generated_by, offer_number, token_hash, status, created_by
    ) values (
      v_offer.candidate_id, v_offer.job_id, v_offer.candidate_name,
      coalesce(nullif(p_offer ->> 'position', ''), v_offer."position"),
      coalesce(nullif(p_offer ->> 'company_name', ''), v_offer.company_name),
      coalesce(nullif(p_offer ->> 'department', ''), v_offer.department),
      coalesce(nullif(p_offer ->> 'branch', ''), v_offer.branch),
      v_offer.employment_type, coalesce((p_offer ->> 'salary')::numeric, v_offer.salary),
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
      v_offer.template_id,
      coalesce(nullif(btrim(coalesce(p_offer ->> 'template_type', '')), ''), v_offer.template_type),
      coalesce(nullif(btrim(coalesce(p_offer ->> 'candidate_address', '')), ''), v_offer.candidate_address),
      coalesce(p_offer -> 'remuneration', v_offer.remuneration),
      coalesce(p_offer -> 'salary_structure', v_offer.salary_structure),
      coalesce(nullif((p_offer ->> 'document_id')::uuid, null), v_offer.document_id),
      coalesce(nullif(btrim(coalesce(p_offer ->> 'digital_file_name', '')), ''), v_offer.digital_file_name),
      coalesce(nullif(p_offer ->> 'body_content', ''), v_offer.body_content),
      v_offer.version + 1, v_offer.generated_by, v_offer.offer_number, md5(v_token), 'draft', auth.uid()
    ) returning id into v_new_id;

    update public.offer_letters
    set superseded_by = v_new_id, status = 'withdrawn', updated_at = now()
    where id = p_offer_id;

    perform public.hr_audit('OFFER_MODIFIED', 'OfferLetter', p_offer_id::text,
      format('Offer %s v%s superseded by v%s', v_offer.offer_number, v_offer.version, v_offer.version + 1));

    return jsonb_build_object('ok', true, 'offer_id', v_new_id,
      'new_version', v_offer.version + 1, 'token', v_token, 'status', 'draft');
  else
    raise exception 'Offer in status %s cannot be modified', v_offer.status;
  end if;
end; $$;
grant execute on function public.hr_modify_offer(uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. RPC: hr_set_offer_document — attach the saved digital copy of an offer
--    (document in the private `documents` bucket).
-- ----------------------------------------------------------------------------
create or replace function public.hr_set_offer_document(p_offer_id uuid, p_document_id uuid, p_file_name text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;
  update public.offer_letters
  set document_id = p_document_id,
      digital_file_name = coalesce(nullif(p_file_name, ''), digital_file_name),
      updated_at = now()
  where id = p_offer_id;
  perform public.hr_audit('OFFER_DOCUMENT_ATTACHED', 'OfferLetter', p_offer_id::text,
    format('Digital copy attached to offer %s', v_offer.offer_number));
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.hr_set_offer_document(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 8. RPC: hr_send_offer — mark the offer as sent (issued + emailed tracking).
--    Reuses the issue semantics: sets status 'issued' and candidate status.
-- ----------------------------------------------------------------------------
create or replace function public.hr_send_offer(p_offer_id uuid, p_emailed_to text default null, p_document_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_offer public.offer_letters;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized';
  end if;
  select * into v_offer from public.offer_letters where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'Offer not found';
  end if;
  if v_offer.status not in ('draft', 'issued') then
    raise exception 'Offer in status %s cannot be sent', v_offer.status;
  end if;

  update public.offer_letters
  set status = 'issued',
      issued_by = auth.uid(),
      issued_at = coalesce(issued_at, now()),
      sent_at = coalesce(sent_at, now()),
      emailed_to = coalesce(nullif(p_emailed_to, ''), emailed_to, v_offer.emailed_to),
      document_id = coalesce(nullif(p_document_id, null), document_id),
      updated_at = now()
  where id = p_offer_id;

  update public.hr_candidates
  set application_status = 'offer', status_change_note = 'Offer issued'
  where id = v_offer.candidate_id and application_status in ('recommended', 'interviewed', 'offer');

  perform public.hr_audit('OFFER_SENT', 'OfferLetter', p_offer_id::text,
    format('Offer %s sent to %s', v_offer.offer_number, coalesce(p_emailed_to, v_offer.candidate_name)));

  return jsonb_build_object('ok', true, 'status', 'issued');
end; $$;
grant execute on function public.hr_send_offer(uuid, text, uuid) to authenticated;
