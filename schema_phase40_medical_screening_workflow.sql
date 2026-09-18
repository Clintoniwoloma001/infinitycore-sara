-- ============================================================
-- INFINITYCORE — MEDICAL SCREENING / HOSPITAL REFERRAL WORKFLOW
-- (Phase 40)
--
-- Adds a complete Medical Screening / Hospital Referral system:
--   * medical_referrals        — QR referral / card (token-hash only, no
--                                raw tokens, no BVN/NIN, no results)
--   * medical_screenings       — IMMUTABLE submitted results, versioned.
--                                Normal users can NEVER edit a submitted
--                                record. Corrections create a new version.
--   * medical_screening_amendments — correction request → authorized
--                                amendment audit trail
--   * medical_documents        — file metadata (files live in the existing
--                                `documents` storage bucket under
--                                medical/<token-hash>/... ; never public)
--   * medical_screening_events — per-referral tracking (opened, started,
--                                submitted, reviewed, revoked, amended)
--   * hospital_providers       — future authenticated hospital accounts
--   * hospital_users           — link auth users to providers
--   * medical_screening_config — HR-configured lab tests / form sections
--
-- Security model
--   * Referral tokens are generated CLIENT-side (256-bit random), and ONLY
--     the md5() hash is stored (same pattern as onboarding/guarantor).
--   * Public RPCs (get_medical_referral_details, submit_medical_screening)
--     are token-scoped and return only the minimum disclosure.
--   * HR roles: super_admin, admin, hr_manager, hr_officer.
--   * Authorized medical providers resolve via hospital_users (no change to
--     the profiles.role check constraint).
--   * audit_logs has NO user_id column — all audit rows use user_name.
--
-- Idempotent — safe to re-run. Run in the Supabase SQL editor.
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 1. HOSPITAL PROVIDERS (future authenticated provider accounts)
-- ============================================================
create table if not exists public.hospital_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  address text,
  contact_name text,
  contact_phone text,
  contact_email text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.hospital_providers enable row level security;

-- ============================================================
-- 2. HOSPITAL USERS (medical provider accounts linked to hospitals)
-- ============================================================
create table if not exists public.hospital_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  hospital_id uuid not null references public.hospital_providers(id) on delete cascade,
  role text not null default 'medical_officer' check (role in ('admin', 'medical_officer', 'nurse', 'reception')),
  active boolean not null default true,
  created_at timestamptz default now(),
  unique (user_id)
);

alter table public.hospital_users enable row level security;

-- ============================================================
-- 3. MEDICAL REFERRALS (the QR card / referral record)
-- ============================================================
create sequence if not exists public.medical_referral_seq;

create table if not exists public.medical_referrals (
  id uuid primary key default gen_random_uuid(),
  reference text unique,
  referral_token_hash text not null unique,
  candidate_id uuid references public.hr_candidates(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  hiring_route text not null default 'candidate' check (hiring_route in ('candidate', 'employee')),
  subject_name text not null,
  subject_identifier text,
  subject_position text,
  subject_department text,
  subject_branch text,
  screening_type text not null default 'pre_employment'
    check (screening_type in ('pre_employment', 'periodic', 'fitness_for_work', 'medical_screening', 'other')),
  other_screening_type text,
  hospital_id uuid references public.hospital_providers(id) on delete set null,
  hospital_name text,
  referring_hr_user_id uuid references auth.users(id) on delete set null,
  referring_hr_name text,
  status text not null default 'draft' check (status in (
    'draft', 'issued', 'qr_opened', 'screening_started', 'submitted',
    'under_review', 'cleared', 'cleared_with_restrictions',
    'further_review', 'not_cleared', 'revoked'
  )),
  issued_at timestamptz default now(),
  issued_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  opened_at timestamptz,
  started_at timestamptz,
  submitted_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoke_reason text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.medical_referrals enable row level security;

create index if not exists idx_medical_referrals_token_hash on public.medical_referrals(referral_token_hash);
create index if not exists idx_medical_referrals_candidate on public.medical_referrals(candidate_id);
create index if not exists idx_medical_referrals_employee on public.medical_referrals(employee_id);
create index if not exists idx_medical_referrals_status on public.medical_referrals(status);

-- Auto reference: MED-YYYY-NNNNNN. Predictable reference is fine — the QR
-- security comes from the 256-bit random token, never the reference alone.
create or replace function public.generate_medical_referral_reference()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.reference is null then
    new.reference := 'MED-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.medical_referral_seq')::text, 6, '0');
  end if;
  return new;
end; $$;

drop trigger if exists medical_referral_reference_trigger on public.medical_referrals;
create trigger medical_referral_reference_trigger
  before insert on public.medical_referrals
  for each row execute function public.generate_medical_referral_reference();

create or replace function public.touch_medical_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists medical_referrals_touch on public.medical_referrals;
create trigger medical_referrals_touch
  before update on public.medical_referrals
  for each row execute function public.touch_medical_updated_at();

-- ============================================================
-- 4. MEDICAL SCREENINGS (IMMUTABLE submitted results — versioned)
--    Writes happen ONLY through SECURITY DEFINER RPCs. There are NO
--    direct INSERT/UPDATE/DELETE policies, so a submitted medical record
--    can never be silently overwritten. Amendments create version 2+.
-- ============================================================
create table if not exists public.medical_screenings (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references public.medical_referrals(id) on delete cascade,
  candidate_id uuid references public.hr_candidates(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  screening_type text not null,
  other_screening_type text,
  hospital_name text,
  hospital_id uuid references public.hospital_providers(id) on delete set null,
  medical_officer text,
  medical_officer_id uuid references auth.users(id) on delete set null,
  screening_date date,
  results jsonb not null default '{}'::jsonb,
  outcome text check (outcome in ('fit_for_work', 'fit_with_restrictions', 'further_review', 'not_cleared', 'pending')),
  outcome_notes text,
  signature_data text,
  signature_date timestamptz,
  version int not null default 1,
  amends_screening_id uuid references public.medical_screenings(id) on delete set null,
  amendment_reason text,
  amended_by uuid references auth.users(id) on delete set null,
  amended_at timestamptz,
  submitted_by_actor text,
  submitted_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.medical_screenings enable row level security;

create index if not exists idx_medical_screenings_referral on public.medical_screenings(referral_id);
create index if not exists idx_medical_screenings_candidate on public.medical_screenings(candidate_id);
create index if not exists idx_medical_screenings_employee on public.medical_screenings(employee_id);
create index if not exists idx_medical_screenings_version on public.medical_screenings(version);

drop trigger if exists medical_screenings_touch on public.medical_screenings;
create trigger medical_screenings_touch
  before update on public.medical_screenings
  for each row execute function public.touch_medical_updated_at();

-- ============================================================
-- 5. MEDICAL SCREENING AMENDMENTS (audited correction workflow)
-- ============================================================
create table if not exists public.medical_screening_amendments (
  id uuid primary key default gen_random_uuid(),
  screening_id uuid not null references public.medical_screenings(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  requested_by_name text,
  requested_at timestamptz default now(),
  reason text not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_notes text
);

alter table public.medical_screening_amendments enable row level security;

create index if not exists idx_medical_amendments_screening on public.medical_screening_amendments(screening_id);

-- ============================================================
-- 6. MEDICAL DOCUMENTS (metadata; blobs live in `documents` bucket)
-- ============================================================
create table if not exists public.medical_documents (
  id uuid primary key default gen_random_uuid(),
  screening_id uuid references public.medical_screenings(id) on delete cascade,
  referral_id uuid not null references public.medical_referrals(id) on delete cascade,
  document_type text not null default 'other',
  file_name text,
  file_path text,
  file_size int,
  mime_type text,
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  created_at timestamptz default now()
);

alter table public.medical_documents enable row level security;

create index if not exists idx_medical_documents_referral on public.medical_documents(referral_id);
create index if not exists idx_medical_documents_screening on public.medical_documents(screening_id);

-- ============================================================
-- 7. MEDICAL SCREENING EVENTS (per-referral status tracking)
-- ============================================================
create table if not exists public.medical_screening_events (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid references public.medical_referrals(id) on delete cascade,
  screening_id uuid references public.medical_screenings(id) on delete set null,
  event_type text not null,
  details text,
  actor text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

alter table public.medical_screening_events enable row level security;

create index if not exists idx_medical_events_referral on public.medical_screening_events(referral_id);

-- ============================================================
-- 8. MEDICAL SCREENING CONFIG (HR-configured lab tests / form settings)
-- ============================================================
create table if not exists public.medical_screening_config (
  id uuid primary key default gen_random_uuid(),
  config_key text unique not null,
  config_value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz default now()
);

alter table public.medical_screening_config enable row level security;

-- Default config. NO sensitive tests are mandatory unless HR configures them.
-- Defaults are generic, non-sensitive routine checks.
insert into public.medical_screening_config (config_key, config_value)
values
  ('form_config', '{"sections": ["general", "vision", "hearing", "laboratory", "radiology", "history", "fitness"]}'),
  ('lab_tests', '["Urinalysis", "Full Blood Count", "Blood Glucose", "Malaria Screening"]')
on conflict (config_key) do nothing;

-- ============================================================
-- 9. ACCESS HELPERS
-- ============================================================
create or replace function public.is_medical_hr()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer');
$$;

create or replace function public.is_hospital_user(p_hospital_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.hospital_users h
    where h.user_id = auth.uid()
      and h.active
      and (p_hospital_id is null or h.hospital_id = p_hospital_id)
  );
$$;

-- ============================================================
-- 10. ROW LEVEL SECURITY POLICIES
-- ============================================================

-- ---- hospital_providers ----
drop policy if exists "hospital_providers_read" on public.hospital_providers;
create policy "hospital_providers_read" on public.hospital_providers
  for select using (public.is_medical_hr() or public.is_hospital_user(null));

drop policy if exists "hospital_providers_write" on public.hospital_providers;
create policy "hospital_providers_write" on public.hospital_providers
  for insert with check (public.is_medical_hr());
drop policy if exists "hospital_providers_update" on public.hospital_providers;
create policy "hospital_providers_update" on public.hospital_providers
  for update using (public.is_medical_hr());
drop policy if exists "hospital_providers_delete" on public.hospital_providers;
create policy "hospital_providers_delete" on public.hospital_providers
  for delete using (public.is_medical_hr());

-- ---- hospital_users ----
drop policy if exists "hospital_users_read" on public.hospital_users;
create policy "hospital_users_read" on public.hospital_users
  for select using (public.is_medical_hr());

drop policy if exists "hospital_users_write" on public.hospital_users;
create policy "hospital_users_write" on public.hospital_users
  for insert with check (public.is_medical_hr());
drop policy if exists "hospital_users_update" on public.hospital_users;
create policy "hospital_users_update" on public.hospital_users
  for update using (public.is_medical_hr());

-- ---- medical_referrals ----
-- HR, linked hospital provider, or the employee themselves (own data).
drop policy if exists "medical_referrals_read" on public.medical_referrals;
create policy "medical_referrals_read" on public.medical_referrals
  for select using (
    public.is_medical_hr()
    or public.is_hospital_user(hospital_id)
    or (employee_id is not null and employee_id in (select id from public.employees where user_id = auth.uid()))
  );

drop policy if exists "medical_referrals_write" on public.medical_referrals;
create policy "medical_referrals_write" on public.medical_referrals
  for insert with check (public.is_medical_hr());
drop policy if exists "medical_referrals_update" on public.medical_referrals;
create policy "medical_referrals_update" on public.medical_referrals
  for update using (public.is_medical_hr());
-- No delete policy: referrals cannot be destroyed.

-- ---- medical_screenings (immutable) ----
drop policy if exists "medical_screenings_read" on public.medical_screenings;
create policy "medical_screenings_read" on public.medical_screenings
  for select using (
    public.is_medical_hr()
    or public.is_hospital_user((select hospital_id from public.medical_referrals where id = referral_id))
    or (employee_id is not null and employee_id in (select id from public.employees where user_id = auth.uid()))
  );
-- No INSERT/UPDATE/DELETE policies: writes only via SECURITY DEFINER RPCs.

-- ---- medical_screening_amendments ----
drop policy if exists "medical_amendments_read" on public.medical_screening_amendments;
create policy "medical_amendments_read" on public.medical_screening_amendments
  for select using (public.is_medical_hr());
-- No direct writes: RPCs only.

-- ---- medical_documents ----
drop policy if exists "medical_documents_read" on public.medical_documents;
create policy "medical_documents_read" on public.medical_documents
  for select using (
    public.is_medical_hr()
    or public.is_hospital_user((select hospital_id from public.medical_referrals where id = referral_id))
  );
-- INSERT only via submit RPC.

-- ---- medical_screening_events ----
drop policy if exists "medical_events_read" on public.medical_screening_events;
create policy "medical_events_read" on public.medical_screening_events
  for select using (public.is_medical_hr());
-- INSERT via RPCs only.

-- ---- medical_screening_config ----
drop policy if exists "medical_config_read" on public.medical_screening_config;
create policy "medical_config_read" on public.medical_screening_config
  for select using (public.is_medical_hr());
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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.create_medical_referral(text, uuid, uuid, text, text, text, text, text, text, text, uuid, text, timestamptz, text, text) to authenticated;

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
      from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer');
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

grant execute on function public.get_medical_referral_details(text) to anon, authenticated;

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

  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  loop
    insert into public.notifications (user_id, title, message, type, link)
    values (v_hr_id, 'Medical screening submitted',
      format('A medical screening result for %s (%s) has been submitted and requires review.', v_ref.subject_name, v_ref.reference),
      'medical', '/medical-management');
  end loop;

  return jsonb_build_object('ok', true, 'screening_id', v_screening_id,
    'reference', v_ref.reference, 'documents', v_count);
end; $$;

grant execute on function public.submit_medical_screening(text, jsonb) to anon, authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.get_medical_screening_result(uuid) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.set_medical_referral_status(uuid, text, text) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.extend_medical_referral_expiry(uuid, timestamptz) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.request_medical_amendment(uuid, text) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.approve_medical_amendment(uuid, jsonb) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.reject_medical_amendment(uuid, text) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.upsert_medical_config(text, jsonb) to authenticated;

create or replace function public.get_medical_config(p_config_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_value jsonb;
  v_actor_role text := public.current_role();
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;
  select config_value into v_value from public.medical_screening_config where config_key = p_config_key;
  return coalesce(v_value, '{}'::jsonb);
end; $$;

grant execute on function public.get_medical_config(text) to authenticated;

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
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
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

grant execute on function public.backfill_medical_screening_links(uuid) to authenticated;

-- ============================================================
-- 21. STORAGE POLICIES — medical documents
--     Files live under medical/<token-hash>/... in the existing
--     `documents` bucket. NO anonymous READ (signed URLs only for
--     authorized users). Anonymous upload mirrors the guarantor
--     pattern; the submit RPC validates each path's token namespace.
-- ============================================================
drop policy if exists "medical_docs_anon_upload" on storage.objects;
create policy "medical_docs_anon_upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'documents' and name like 'medical/%');

drop policy if exists "medical_docs_hr_read" on storage.objects;
create policy "medical_docs_hr_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and name like 'medical/%' and public.is_medical_hr());

drop policy if exists "medical_docs_provider_read" on storage.objects;
create policy "medical_docs_provider_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and name like 'medical/%' and public.is_hospital_user(null));

-- ============================================================
-- 22. GRANTS — allow RLS-scoped direct reads via PostgREST
-- ============================================================
grant select on public.medical_referrals to authenticated;
grant select on public.medical_screenings to authenticated;
grant select on public.medical_documents to authenticated;
grant select on public.medical_screening_events to authenticated;
grant select on public.medical_screening_amendments to authenticated;
grant select on public.hospital_providers to authenticated;
grant select on public.hospital_users to authenticated;
grant select on public.medical_screening_config to authenticated;