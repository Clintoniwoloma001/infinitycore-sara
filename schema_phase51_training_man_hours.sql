-- ============================================================
-- PHASE 51 - TRAINING, KSS, CERTIFICATION & MAN-HOUR INTELLIGENCE
--
-- Additive and idempotent. Run after the existing HR, attendance,
-- organisation, storage and workforce migrations.
--
-- Attendance remains the source of truth for attendance hours. Training
-- participation is deliberately recorded in separate tables and is only
-- joined by the man-hour read models below.
-- ============================================================

-- ------------------------------------------------------------
-- 1. TRAINING MASTER DATA
-- ------------------------------------------------------------
-- Phase 37 owns this employee lifecycle flag. Keep the additive migration
-- safe when a deployment has not yet replayed that phase.
alter table public.employees add column if not exists is_archived boolean not null default false;
create index if not exists idx_training_employees_archived on public.employees(is_archived);

create table if not exists public.training_programmes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  description text,
  training_type text not null check (training_type in (
    'internal', 'external', 'compliance', 'induction', 'refresher',
    'workshop', 'seminar', 'technical', 'management', 'kss'
  )),
  is_mandatory boolean not null default false,
  default_duration_minutes integer check (default_duration_minutes is null or default_duration_minutes > 0),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  programme_id uuid references public.training_programmes(id) on delete set null,
  title text not null,
  training_type text not null check (training_type in (
    'internal', 'external', 'compliance', 'induction', 'refresher',
    'workshop', 'seminar', 'technical', 'management', 'kss'
  )),
  description text,
  facilitator text not null,
  training_date date not null,
  start_time time,
  end_time time,
  duration_minutes integer not null check (duration_minutes > 0),
  location text,
  virtual_link text,
  department text,
  area text,
  branch_id uuid references public.branches(id) on delete set null,
  assessment_required boolean not null default false,
  assessment_pass_mark numeric(6, 2) not null default 60 check (assessment_pass_mark between 0 and 100),
  certificate_enabled boolean not null default false,
  is_mandatory boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time is null or start_time is null or end_time > start_time),
  check (training_type <> 'kss' or assessment_required)
);

create table if not exists public.training_question_sets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  set_number integer not null check (set_number between 1 and 3),
  set_label text not null,
  created_at timestamptz not null default now(),
  unique (session_id, set_number)
);

create table if not exists public.training_questions (
  id uuid primary key default gen_random_uuid(),
  question_set_id uuid not null references public.training_question_sets(id) on delete cascade,
  prompt text not null,
  question_type text not null default 'multiple_choice' check (question_type in ('multiple_choice', 'multiple_select', 'true_false', 'short_text', 'numerical')),
  options jsonb not null default '[]'::jsonb,
  correct_answer jsonb not null,
  marks numeric(8, 2) not null default 1 check (marks > 0),
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.training_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  question_set_id uuid references public.training_question_sets(id) on delete set null,
  status text not null default 'assigned' check (status in ('assigned', 'in_progress', 'completed', 'failed', 'absent', 'withdrawn')),
  assigned_at timestamptz not null default now(),
  opened_at timestamptz,
  submitted_at timestamptz,
  completed_at timestamptz,
  unique (session_id, employee_id)
);

create table if not exists public.training_assessments (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null unique references public.training_participants(id) on delete cascade,
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  question_set_id uuid references public.training_question_sets(id) on delete set null,
  status text not null default 'assigned' check (status in ('assigned', 'in_progress', 'submitted', 'graded')),
  score numeric(10, 2) not null default 0,
  max_score numeric(10, 2) not null default 0,
  percentage numeric(6, 2),
  passed boolean,
  submitted_at timestamptz,
  graded_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.training_answers (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.training_assessments(id) on delete cascade,
  question_id uuid not null references public.training_questions(id) on delete cascade,
  answer jsonb,
  is_correct boolean not null default false,
  awarded_marks numeric(10, 2) not null default 0,
  submitted_at timestamptz not null default now(),
  unique (assessment_id, question_id)
);

create table if not exists public.training_signatures (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null unique references public.training_participants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  storage_path text not null,
  declaration_accepted boolean not null default false,
  declaration_text text not null,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.training_attendance (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  participant_id uuid not null unique references public.training_participants(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  attended boolean not null default false,
  duration_minutes integer not null default 0 check (duration_minutes >= 0),
  attendance_status text not null default 'assigned' check (attendance_status in ('assigned', 'attended', 'absent', 'completed')),
  recorded_by uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default now()
);

create table if not exists public.employee_training_records (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null unique references public.training_participants(id) on delete restrict,
  session_id uuid not null references public.training_sessions(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  training_title text not null,
  training_type text not null,
  training_date date not null,
  duration_minutes integer not null check (duration_minutes > 0),
  facilitator text not null,
  completion_status text not null default 'completed' check (completion_status in ('completed', 'failed')),
  assessment_score numeric(10, 2),
  assessment_max_score numeric(10, 2),
  assessment_percentage numeric(6, 2),
  assessment_passed boolean,
  question_set_number integer check (question_set_number is null or question_set_number between 1 and 3),
  signature_id uuid references public.training_signatures(id) on delete restrict,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.training_certificate_sequences (
  certificate_year integer not null,
  certificate_type text not null check (certificate_type in ('training', 'kss')),
  next_number bigint not null default 1 check (next_number > 0),
  primary key (certificate_year, certificate_type)
);

create table if not exists public.training_certificates (
  id uuid primary key default gen_random_uuid(),
  employee_training_record_id uuid not null unique references public.employee_training_records(id) on delete restrict,
  session_id uuid not null references public.training_sessions(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  employee_identifier text,
  certificate_number text not null unique,
  certificate_type text not null check (certificate_type in ('training', 'kss')),
  training_title text not null,
  training_type text not null,
  training_date date not null,
  duration_minutes integer not null check (duration_minutes > 0),
  facilitator text not null,
  verification_status text not null default 'valid' check (verification_status in ('valid', 'revoked')),
  pdf_path text,
  pdf_generated_at timestamptz,
  issued_at timestamptz not null default now(),
  issued_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.training_materials (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  title text not null,
  storage_path text not null,
  mime_type text,
  file_size integer,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_training_sessions_date on public.training_sessions(training_date);
create index if not exists idx_training_sessions_type on public.training_sessions(training_type);
create index if not exists idx_training_sessions_branch on public.training_sessions(branch_id);
create index if not exists idx_training_participants_employee on public.training_participants(employee_id);
create index if not exists idx_training_participants_session on public.training_participants(session_id);
create index if not exists idx_training_records_employee_date on public.employee_training_records(employee_id, training_date);
create index if not exists idx_training_certificates_employee on public.training_certificates(employee_id);
create index if not exists idx_training_certificates_number on public.training_certificates(certificate_number);

-- Additive self-healing for environments where a table was created by an
-- earlier preview of this module.
alter table public.training_sessions add column if not exists is_mandatory boolean not null default false;
alter table public.training_sessions add column if not exists virtual_link text;
alter table public.training_sessions add column if not exists area text;
alter table public.training_sessions add column if not exists branch_id uuid references public.branches(id) on delete set null;
alter table public.training_sessions add column if not exists assessment_pass_mark numeric(6, 2) not null default 60;
alter table public.training_certificates add column if not exists pdf_path text;
alter table public.training_certificates add column if not exists pdf_generated_at timestamptz;
alter table public.training_certificates add column if not exists employee_identifier text;

-- ------------------------------------------------------------
-- 2. RLS AND IMMUTABILITY
-- ------------------------------------------------------------
alter table public.training_programmes enable row level security;
alter table public.training_sessions enable row level security;
alter table public.training_question_sets enable row level security;
alter table public.training_questions enable row level security;
alter table public.training_participants enable row level security;
alter table public.training_assessments enable row level security;
alter table public.training_answers enable row level security;
alter table public.training_signatures enable row level security;
alter table public.training_attendance enable row level security;
alter table public.employee_training_records enable row level security;
alter table public.training_certificate_sequences enable row level security;
alter table public.training_certificates enable row level security;
alter table public.training_materials enable row level security;

create or replace function public.training_is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in (
    'super_admin', 'admin', 'hr_manager', 'hr_officer',
    'head_of_business', 'area_manager', 'branch_manager', 'operations_manager'
  );
$$;
revoke all on function public.training_is_manager() from public;
grant execute on function public.training_is_manager() to authenticated;

create or replace function public.training_is_hr()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer');
$$;
revoke all on function public.training_is_hr() from public;
grant execute on function public.training_is_hr() to authenticated;

drop policy if exists training_programmes_read on public.training_programmes;
create policy training_programmes_read on public.training_programmes for select to authenticated using (
  public.training_is_manager() or is_active
);
drop policy if exists training_programmes_manage on public.training_programmes;
create policy training_programmes_manage on public.training_programmes for all to authenticated using (public.training_is_hr()) with check (public.training_is_hr());

drop policy if exists training_sessions_read on public.training_sessions;
create policy training_sessions_read on public.training_sessions for select to authenticated using (
  public.training_is_manager()
  or exists (
    select 1 from public.training_participants tp
    join public.employees e on e.id = tp.employee_id
    where tp.session_id = training_sessions.id and e.user_id = auth.uid()
  )
);
drop policy if exists training_sessions_manage on public.training_sessions;
create policy training_sessions_manage on public.training_sessions for all to authenticated using (public.training_is_hr()) with check (public.training_is_hr());

drop policy if exists training_question_sets_read on public.training_question_sets;
create policy training_question_sets_read on public.training_question_sets for select to authenticated using (public.training_is_manager());
drop policy if exists training_question_sets_manage on public.training_question_sets;
create policy training_question_sets_manage on public.training_question_sets for all to authenticated using (public.training_is_hr()) with check (public.training_is_hr());

drop policy if exists training_questions_read on public.training_questions;
create policy training_questions_read on public.training_questions for select to authenticated using (public.training_is_manager());
drop policy if exists training_questions_manage on public.training_questions;
create policy training_questions_manage on public.training_questions for all to authenticated using (public.training_is_hr()) with check (public.training_is_hr());

drop policy if exists training_participants_read on public.training_participants;
create policy training_participants_read on public.training_participants for select to authenticated using (
  public.training_is_manager()
  or employee_id in (select e.id from public.employees e where e.user_id = auth.uid())
);
drop policy if exists training_participants_manage on public.training_participants;
create policy training_participants_manage on public.training_participants for all to authenticated using (public.training_is_hr()) with check (public.training_is_hr());

drop policy if exists training_assessments_read on public.training_assessments;
create policy training_assessments_read on public.training_assessments for select to authenticated using (
  public.training_is_manager()
  or participant_id in (
    select tp.id from public.training_participants tp
    join public.employees e on e.id = tp.employee_id where e.user_id = auth.uid()
  )
);
drop policy if exists training_assessments_manage on public.training_assessments;
create policy training_assessments_manage on public.training_assessments for all to authenticated using (public.training_is_hr()) with check (public.training_is_hr());

drop policy if exists training_answers_read on public.training_answers;
create policy training_answers_read on public.training_answers for select to authenticated using (
  public.training_is_manager()
  or assessment_id in (
    select ta.id from public.training_assessments ta
    join public.training_participants tp on tp.id = ta.participant_id
    join public.employees e on e.id = tp.employee_id where e.user_id = auth.uid()
  )
);

drop policy if exists training_signatures_read on public.training_signatures;
create policy training_signatures_read on public.training_signatures for select to authenticated using (public.training_is_hr());

drop policy if exists training_attendance_read on public.training_attendance;
create policy training_attendance_read on public.training_attendance for select to authenticated using (
  public.training_is_manager()
  or employee_id in (select e.id from public.employees e where e.user_id = auth.uid())
);
drop policy if exists training_attendance_manage on public.training_attendance;
create policy training_attendance_manage on public.training_attendance for all to authenticated using (public.training_is_hr()) with check (public.training_is_hr());

drop policy if exists employee_training_records_read on public.employee_training_records;
create policy employee_training_records_read on public.employee_training_records for select to authenticated using (
  public.training_is_manager()
  or employee_id in (select e.id from public.employees e where e.user_id = auth.uid())
);

drop policy if exists training_certificates_read on public.training_certificates;
create policy training_certificates_read on public.training_certificates for select to authenticated using (
  public.training_is_manager()
  or employee_id in (select e.id from public.employees e where e.user_id = auth.uid())
);

drop policy if exists training_materials_read on public.training_materials;
create policy training_materials_read on public.training_materials for select to authenticated using (
  public.training_is_manager()
  or exists (
    select 1 from public.training_participants tp
    join public.employees e on e.id = tp.employee_id
    where tp.session_id = training_materials.session_id and e.user_id = auth.uid()
  )
);
drop policy if exists training_materials_manage on public.training_materials;
create policy training_materials_manage on public.training_materials for all to authenticated using (public.training_is_hr()) with check (public.training_is_hr());

create or replace function public.prevent_training_record_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Completed training records and certificates are immutable.';
end;
$$;

create or replace function public.prevent_training_certificate_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'DELETE' then raise exception 'Training certificates are immutable.'; end if;
  if new.employee_training_record_id is distinct from old.employee_training_record_id
     or new.session_id is distinct from old.session_id
     or new.employee_id is distinct from old.employee_id
     or new.employee_identifier is distinct from old.employee_identifier
     or new.certificate_number is distinct from old.certificate_number
     or new.certificate_type is distinct from old.certificate_type
     or new.training_title is distinct from old.training_title
     or new.training_type is distinct from old.training_type
     or new.training_date is distinct from old.training_date
     or new.duration_minutes is distinct from old.duration_minutes
     or new.facilitator is distinct from old.facilitator
     or new.verification_status is distinct from old.verification_status
     or new.issued_at is distinct from old.issued_at
     or new.issued_by is distinct from old.issued_by then
    raise exception 'Certificate identity and validity fields are immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists employee_training_records_immutable on public.employee_training_records;
create trigger employee_training_records_immutable
before update or delete on public.employee_training_records
for each row execute function public.prevent_training_record_mutation();
drop trigger if exists training_certificates_immutable on public.training_certificates;
create trigger training_certificates_immutable
before update or delete on public.training_certificates
for each row execute function public.prevent_training_certificate_mutation();

-- ------------------------------------------------------------
-- 3. SCOPED STORAGE POLICIES (existing documents bucket)
-- ------------------------------------------------------------
drop policy if exists training_signature_upload on storage.objects;
create policy training_signature_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'documents' and name like 'training-signatures/%'
  and (
    public.training_is_hr()
    or exists (
      select 1 from public.training_participants tp
      join public.employees e on e.id = tp.employee_id
      where tp.id::text = split_part(name, '/', 2) and e.user_id = auth.uid()
    )
  )
);
drop policy if exists training_signature_hr_read on storage.objects;
create policy training_signature_hr_read on storage.objects for select to authenticated using (
  bucket_id = 'documents' and name like 'training-signatures/%' and public.training_is_hr()
);

drop policy if exists training_certificate_upload on storage.objects;
create policy training_certificate_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'documents' and name like 'training-certificates/%'
  and (
    public.training_is_hr()
    or exists (
      select 1 from public.training_certificates c
      join public.employees e on e.id = c.employee_id
      where c.id::text = split_part(name, '/', 2) and e.user_id = auth.uid()
    )
  )
);
drop policy if exists training_certificate_read on storage.objects;
create policy training_certificate_read on storage.objects for select to authenticated using (
  bucket_id = 'documents' and name like 'training-certificates/%'
  and (
    public.training_is_manager()
    or exists (
      select 1 from public.training_certificates c
      join public.employees e on e.id = c.employee_id
      where c.id::text = split_part(name, '/', 2) and e.user_id = auth.uid()
    )
  )
);

-- ------------------------------------------------------------
-- 4. AUDIT TRIGGER
-- ------------------------------------------------------------
create or replace function public.audit_training_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_id text;
  v_action text;
  v_details text;
begin
  v_id := coalesce((case when TG_OP = 'DELETE' then OLD.id else NEW.id end)::text, 'unknown');
  v_action := 'TRAINING_' || upper(TG_OP) || '_' || upper(replace(TG_TABLE_NAME, 'training_', ''));
  v_details := jsonb_build_object(
    'operation', TG_OP,
    'table', TG_TABLE_NAME,
    'new', case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end,
    'old', case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end
  )::text;
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    v_action, TG_TABLE_NAME, v_id,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text, 'system'),
    v_details, case when TG_OP = 'DELETE' then 'warning' else 'info' end
  );
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists training_sessions_audit on public.training_sessions;
create trigger training_sessions_audit after insert or update or delete on public.training_sessions for each row execute function public.audit_training_change();
drop trigger if exists training_participants_audit on public.training_participants;
create trigger training_participants_audit after insert or update on public.training_participants for each row execute function public.audit_training_change();
drop trigger if exists training_assessments_audit on public.training_assessments;
create trigger training_assessments_audit after insert or update on public.training_assessments for each row execute function public.audit_training_change();
drop trigger if exists training_signatures_audit on public.training_signatures;
create trigger training_signatures_audit after insert on public.training_signatures for each row execute function public.audit_training_change();
drop trigger if exists training_certificates_audit on public.training_certificates;
create trigger training_certificates_audit after insert on public.training_certificates for each row execute function public.audit_training_change();

-- ------------------------------------------------------------
-- 5. PERMISSIONS
-- ------------------------------------------------------------
insert into public.permissions (permission_key, description, category) values
  ('hr.training.read', 'Read training, KSS and certificate records', 'hr'),
  ('hr.training.manage', 'Create training sessions, assessments and assignments', 'hr'),
  ('workforce.manhour.read', 'Read scoped workforce and training man-hour intelligence', 'hr')
on conflict (permission_key) do nothing;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['super_admin', 'admin'] loop
    perform public.assign_permission_to_role(v_role, 'hr.training.read');
    perform public.assign_permission_to_role(v_role, 'hr.training.manage');
    perform public.assign_permission_to_role(v_role, 'workforce.manhour.read');
  end loop;
  perform public.assign_permission_to_role('hr_manager', 'hr.training.read');
  perform public.assign_permission_to_role('hr_manager', 'hr.training.manage');
  perform public.assign_permission_to_role('hr_manager', 'workforce.manhour.read');
  perform public.assign_permission_to_role('hr_officer', 'hr.training.read');
  perform public.assign_permission_to_role('head_of_business', 'hr.training.read');
  perform public.assign_permission_to_role('head_of_business', 'workforce.manhour.read');
  perform public.assign_permission_to_role('area_manager', 'hr.training.read');
  perform public.assign_permission_to_role('area_manager', 'workforce.manhour.read');
  perform public.assign_permission_to_role('branch_manager', 'hr.training.read');
  perform public.assign_permission_to_role('branch_manager', 'workforce.manhour.read');
  perform public.assign_permission_to_role('operations_manager', 'workforce.manhour.read');
end $$;

-- ------------------------------------------------------------
-- 6. KSS SET CREATION AND ASSIGNMENT RPCs
-- ------------------------------------------------------------
create or replace function public.generate_kss_question_sets(
  p_session_id uuid,
  p_sets jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
  v_set jsonb;
  v_question jsonb;
  v_set_number integer := 0;
  v_set_id uuid;
  v_count integer := 0;
begin
  if not public.training_is_hr() then raise exception 'Not authorized to generate training assessments.'; end if;
  select * into v_session from public.training_sessions where id = p_session_id;
  if not found then raise exception 'Training session not found.'; end if;
  if jsonb_typeof(p_sets) <> 'array'
     or (v_session.training_type = 'kss' and jsonb_array_length(p_sets) <> 3)
     or (v_session.training_type <> 'kss' and jsonb_array_length(p_sets) not in (1, 3)) then
    raise exception 'KSS sessions require exactly three question sets; other assessed training requires one or three.';
  end if;
  if exists (select 1 from public.training_participants where session_id = p_session_id and status not in ('assigned')) then
    raise exception 'Question sets cannot be changed after a participant has started.';
  end if;

  delete from public.training_question_sets where session_id = p_session_id;
  for v_set in select value from jsonb_array_elements(p_sets) loop
    v_set_number := v_set_number + 1;
    if jsonb_typeof(v_set) <> 'array' or jsonb_array_length(v_set) = 0 then
      raise exception 'Each question set must contain at least one question.';
    end if;
    insert into public.training_question_sets (session_id, set_number, set_label)
    values (p_session_id, v_set_number, 'Set ' || chr(64 + v_set_number))
    returning id into v_set_id;
    for v_question in select value from jsonb_array_elements(v_set) loop
      if nullif(trim(v_question ->> 'prompt'), '') is null then raise exception 'Question text is required.'; end if;
      insert into public.training_questions (
        question_set_id, prompt, question_type, options, correct_answer,
        marks, display_order
      ) values (
        v_set_id,
        trim(v_question ->> 'prompt'),
        coalesce(nullif(v_question ->> 'question_type', ''), 'multiple_choice'),
        coalesce(v_question -> 'options', '[]'::jsonb),
        coalesce(v_question -> 'correct_answer', to_jsonb(v_question ->> 'correct_answer')),
        greatest(coalesce((v_question ->> 'marks')::numeric, 1), 0.01),
        v_count
      );
      v_count := v_count + 1;
    end loop;
  end loop;
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_ASSESSMENT_GENERATED', 'TrainingSession', p_session_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    'Three KSS question sets generated and stored server-side.', 'info');
  return jsonb_build_object('ok', true, 'sets', 3, 'questions', v_count);
end;
$$;
grant execute on function public.generate_kss_question_sets(uuid, jsonb) to authenticated;

create or replace function public.assign_training_participants(
  p_session_id uuid,
  p_employee_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session public.training_sessions%rowtype;
  v_employee_id uuid;
  v_participant_id uuid;
  v_set_id uuid;
  v_index integer := 0;
  v_assigned integer := 0;
begin
  if not public.training_is_hr() then raise exception 'Not authorized to assign training.'; end if;
  select * into v_session from public.training_sessions where id = p_session_id;
  if not found then raise exception 'Training session not found.'; end if;
  if v_session.assessment_required and ((v_session.training_type = 'kss' and (select count(*) from public.training_question_sets where session_id = p_session_id) <> 3) or (v_session.training_type <> 'kss' and (select count(*) from public.training_question_sets where session_id = p_session_id) not in (1, 3))) then
    raise exception 'Generate the assessment question set before assigning participants.';
  end if;
  if p_employee_ids is null or cardinality(p_employee_ids) = 0 then raise exception 'At least one participant is required.'; end if;

  foreach v_employee_id in array p_employee_ids loop
    v_index := v_index + 1;
    if not exists (select 1 from public.employees where id = v_employee_id and coalesce(is_archived, false) = false) then
      continue;
    end if;
    v_set_id := null;
    if v_session.assessment_required then
      if v_session.training_type = 'kss' then
        select id into v_set_id from public.training_question_sets
        where session_id = p_session_id order by set_number offset ((v_index - 1) % 3) limit 1;
      else
        select id into v_set_id from public.training_question_sets
        where session_id = p_session_id order by set_number limit 1;
      end if;
    end if;
    insert into public.training_participants (session_id, employee_id, question_set_id)
    values (p_session_id, v_employee_id, v_set_id)
    on conflict (session_id, employee_id) do nothing
    returning id into v_participant_id;
    if v_participant_id is null then
      select id into v_participant_id from public.training_participants where session_id = p_session_id and employee_id = v_employee_id;
    else
      v_assigned := v_assigned + 1;
      insert into public.notifications (user_id, title, message, type, link)
      select e.user_id, 'New training assigned',
        format('You have been assigned "%s". Open My Training to review the session.', v_session.title),
        'training', '/my-training'
      from public.employees e
      where e.id = v_employee_id and e.user_id is not null;
    end if;
    if v_session.assessment_required then
      insert into public.training_assessments (participant_id, session_id, question_set_id, max_score)
      select v_participant_id, p_session_id, v_set_id, coalesce(sum(q.marks), 0)
      from public.training_questions q where q.question_set_id = v_set_id
      on conflict (participant_id) do nothing;
    end if;
  end loop;
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_ASSIGNMENT_CREATED', 'TrainingSession', p_session_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    format('%s participant assignment(s) created.', v_assigned), 'info');
  return jsonb_build_object('ok', true, 'assigned', v_assigned);
end;
$$;
grant execute on function public.assign_training_participants(uuid, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- 7. EMPLOYEE ASSIGNMENT / SUBMISSION RPCs
-- ------------------------------------------------------------
create or replace function public.get_my_training_assignment(p_participant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_employee_id uuid;
  v_result jsonb;
begin
  select e.id into v_employee_id from public.employees e where e.user_id = auth.uid() order by e.created_at desc limit 1;
  if v_employee_id is null then raise exception 'Employee profile not found.'; end if;
  select jsonb_build_object(
    'participant', jsonb_build_object(
      'id', tp.id, 'status', tp.status, 'assigned_at', tp.assigned_at,
      'question_set_number', qs.set_number
    ),
    'session', jsonb_build_object(
      'id', s.id, 'title', s.title, 'training_type', s.training_type,
      'description', s.description, 'facilitator', s.facilitator,
      'training_date', s.training_date, 'start_time', s.start_time,
      'end_time', s.end_time, 'duration_minutes', s.duration_minutes,
      'location', s.location, 'virtual_link', s.virtual_link,
      'assessment_required', s.assessment_required,
      'assessment_pass_mark', s.assessment_pass_mark,
      'certificate_enabled', s.certificate_enabled
    ),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'prompt', q.prompt, 'question_type', q.question_type,
        'options', q.options, 'marks', q.marks, 'display_order', q.display_order
      ) order by q.display_order, q.id)
      from public.training_questions q where q.question_set_id = tp.question_set_id
    ), '[]'::jsonb)
  ) into v_result
  from public.training_participants tp
  join public.training_sessions s on s.id = tp.session_id
  left join public.training_question_sets qs on qs.id = tp.question_set_id
  where tp.id = p_participant_id and tp.employee_id = v_employee_id;
  if v_result is null then raise exception 'Training assignment not found.'; end if;
  update public.training_participants set status = case when status = 'assigned' then 'in_progress' else status end, opened_at = coalesce(opened_at, now()) where id = p_participant_id;
  return v_result;
end;
$$;
grant execute on function public.get_my_training_assignment(uuid) to authenticated;

create or replace function public.next_training_certificate_number(p_training_type text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_year integer := extract(year from now())::integer;
  v_type text := case when lower(p_training_type) = 'kss' then 'kss' else 'training' end;
  v_number bigint;
begin
  insert into public.training_certificate_sequences (certificate_year, certificate_type, next_number)
  values (v_year, v_type, 1)
  on conflict (certificate_year, certificate_type) do nothing;
  select next_number into v_number from public.training_certificate_sequences
  where certificate_year = v_year and certificate_type = v_type for update;
  update public.training_certificate_sequences set next_number = v_number + 1 where certificate_year = v_year and certificate_type = v_type;
  return 'INF-' || case when v_type = 'kss' then 'KSS' else 'TRN' end || '-' || v_year::text || '-' || lpad(v_number::text, 6, '0');
end;
$$;
revoke all on function public.next_training_certificate_number(text) from public;

create or replace function public.submit_training_assessment(
  p_participant_id uuid,
  p_answers jsonb default '[]'::jsonb,
  p_signature_path text default null,
  p_declaration_accepted boolean default false,
  p_declaration_text text default 'I declare that I completed this training and submitted these answers myself.'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_employee_id uuid;
  v_participant public.training_participants%rowtype;
  v_session public.training_sessions%rowtype;
  v_assessment public.training_assessments%rowtype;
  v_question public.training_questions%rowtype;
  v_item jsonb;
  v_answer jsonb;
  v_correct boolean;
  v_score numeric := 0;
  v_max numeric := 0;
  v_percentage numeric;
  v_passed boolean := true;
  v_signature_id uuid;
  v_record_id uuid;
  v_certificate_id uuid;
  v_certificate_number text;
  v_employee_identifier text;
  v_set_number integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated.'; end if;
  if not coalesce(p_declaration_accepted, false) then raise exception 'The declaration is required before submission.'; end if;
  if nullif(trim(coalesce(p_signature_path, '')), '') is null then raise exception 'A signature is required before submission.'; end if;
  if p_signature_path not like 'training-signatures/' || p_participant_id::text || '/%' then raise exception 'Invalid signature storage path.'; end if;

  select e.id into v_employee_id from public.employees e where e.user_id = auth.uid() order by e.created_at desc limit 1;
  select * into v_participant from public.training_participants where id = p_participant_id and employee_id = v_employee_id for update;
  if not found then raise exception 'Training assignment not found.'; end if;
  if v_participant.status in ('completed', 'failed', 'withdrawn') then raise exception 'This training record has already been submitted and cannot be edited.'; end if;
  select * into v_session from public.training_sessions where id = v_participant.session_id;
  if not found then raise exception 'Training session not found.'; end if;
  select * into v_assessment from public.training_assessments where participant_id = p_participant_id for update;

  if v_session.assessment_required then
    if v_assessment.id is null then raise exception 'Assessment was not assigned.'; end if;
    for v_question in select q.* from public.training_questions q where q.question_set_id = v_participant.question_set_id order by q.display_order, q.id loop
      v_max := v_max + v_question.marks;
      select item into v_item from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) item where item ->> 'question_id' = v_question.id::text limit 1;
      v_answer := case when v_item is null then null else v_item -> 'answer' end;
      v_correct := case
        when v_answer is null then false
        when v_question.question_type in ('short_text', 'numerical') then lower(trim(coalesce(v_answer #>> '{}', ''))) = lower(trim(coalesce(v_question.correct_answer #>> '{}', '')))
        else v_answer = v_question.correct_answer
      end;
      if v_correct then v_score := v_score + v_question.marks; end if;
      insert into public.training_answers (assessment_id, question_id, answer, is_correct, awarded_marks)
      values (v_assessment.id, v_question.id, v_answer, v_correct, case when v_correct then v_question.marks else 0 end)
      on conflict (assessment_id, question_id) do update set answer = excluded.answer, is_correct = excluded.is_correct, awarded_marks = excluded.awarded_marks, submitted_at = now();
    end loop;
    v_percentage := case when v_max > 0 then round((v_score / v_max) * 100, 2) else 0 end;
    v_passed := v_percentage >= v_session.assessment_pass_mark;
    update public.training_assessments set status = 'graded', score = v_score, max_score = v_max, percentage = v_percentage, passed = v_passed, submitted_at = now(), graded_at = now() where id = v_assessment.id;
  else
    v_score := null;
    v_max := null;
    v_percentage := null;
    v_passed := true;
  end if;

  insert into public.training_signatures (participant_id, employee_id, storage_path, declaration_accepted, declaration_text)
  values (p_participant_id, v_employee_id, p_signature_path, true, coalesce(nullif(trim(p_declaration_text), ''), 'I declare that I completed this training and submitted these answers myself.'))
  returning id into v_signature_id;

  insert into public.training_attendance (session_id, participant_id, employee_id, attended, duration_minutes, attendance_status, recorded_by)
  values (v_session.id, p_participant_id, v_employee_id, true, v_session.duration_minutes, 'completed', auth.uid())
  on conflict (participant_id) do update set attended = true, duration_minutes = excluded.duration_minutes, attendance_status = 'completed', recorded_at = now();

  select set_number into v_set_number from public.training_question_sets where id = v_participant.question_set_id;
  select coalesce(employee_number, staff_id, employee_code) into v_employee_identifier from public.employees where id = v_employee_id;
  insert into public.employee_training_records (
    participant_id, session_id, employee_id, training_title, training_type,
    training_date, duration_minutes, facilitator, completion_status,
    assessment_score, assessment_max_score, assessment_percentage,
    assessment_passed, question_set_number, signature_id
  ) values (
    p_participant_id, v_session.id, v_employee_id, v_session.title, v_session.training_type,
    v_session.training_date, v_session.duration_minutes, v_session.facilitator,
    case when v_passed then 'completed' else 'failed' end,
    v_score, v_max, v_percentage, v_passed, v_set_number, v_signature_id
  ) returning id into v_record_id;

  update public.training_participants set status = case when v_passed then 'completed' else 'failed' end, submitted_at = now(), completed_at = now() where id = p_participant_id;

  if v_passed and v_session.certificate_enabled then
    v_certificate_number := public.next_training_certificate_number(v_session.training_type);
    insert into public.training_certificates (
      employee_training_record_id, session_id, employee_id, employee_identifier, certificate_number,
      certificate_type, training_title, training_type, training_date,
      duration_minutes, facilitator, issued_by
    ) values (
      v_record_id, v_session.id, v_employee_id, v_employee_identifier, v_certificate_number,
      case when v_session.training_type = 'kss' then 'kss' else 'training' end,
      v_session.title, v_session.training_type, v_session.training_date,
      v_session.duration_minutes, v_session.facilitator, auth.uid()
    ) returning id into v_certificate_id;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_ASSESSMENT_SUBMITTED', 'TrainingParticipant', p_participant_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    jsonb_build_object('score', v_score, 'max_score', v_max, 'percentage', v_percentage, 'passed', v_passed)::text, 'info');
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_SIGNATURE_SUBMITTED', 'TrainingSignature', v_signature_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    'Training declaration signature stored in scoped storage.', 'info');
  if v_certificate_id is not null then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('TRAINING_CERTIFICATE_GENERATED', 'TrainingCertificate', v_certificate_id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      v_certificate_number, 'info');
  end if;

  return jsonb_build_object(
    'ok', true, 'record_id', v_record_id, 'participant_id', p_participant_id,
    'score', v_score, 'max_score', v_max, 'percentage', v_percentage,
    'passed', v_passed,
    'certificate', case when v_certificate_id is null then null else jsonb_build_object(
      'id', v_certificate_id, 'certificate_number', v_certificate_number,
      'employee_identifier', v_employee_identifier,
      'training_title', v_session.title, 'training_type', v_session.training_type,
      'training_date', v_session.training_date, 'duration_minutes', v_session.duration_minutes,
      'facilitator', v_session.facilitator
    ) end
  );
end;
$$;
grant execute on function public.submit_training_assessment(uuid, jsonb, text, boolean, text) to authenticated;

create or replace function public.set_training_certificate_pdf(
  p_certificate_id uuid,
  p_pdf_path text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_employee_id uuid;
begin
  if p_pdf_path is null or p_pdf_path not like 'training-certificates/' || p_certificate_id::text || '/%' then raise exception 'Invalid certificate file path.'; end if;
  select employee_id into v_employee_id from public.training_certificates where id = p_certificate_id;
  if v_employee_id is null then raise exception 'Certificate not found.'; end if;
  if not public.training_is_manager() and not exists (select 1 from public.employees where id = v_employee_id and user_id = auth.uid()) then raise exception 'Not authorized to store this certificate.'; end if;
  update public.training_certificates set pdf_path = p_pdf_path, pdf_generated_at = now() where id = p_certificate_id;
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('TRAINING_CERTIFICATE_PDF_STORED', 'TrainingCertificate', p_certificate_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text), p_pdf_path, 'info');
  return jsonb_build_object('ok', true, 'certificate_id', p_certificate_id, 'pdf_path', p_pdf_path);
end;
$$;
grant execute on function public.set_training_certificate_pdf(uuid, text) to authenticated;

create or replace function public.verify_training_certificate(p_certificate_number text)
returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_certificate record;
begin
  select c.certificate_number, c.id, c.verification_status, c.training_title,
         c.training_type, c.training_date, c.duration_minutes, c.facilitator,
         c.issued_at, e.full_name
    into v_certificate
    from public.training_certificates c
    join public.employees e on e.id = c.employee_id
   where upper(c.certificate_number) = upper(trim(p_certificate_number));
  if not found or v_certificate.verification_status <> 'valid' then
    return jsonb_build_object('valid', false);
  end if;
  return jsonb_build_object(
    'valid', true,
    'certificate_id', v_certificate.id,
    'certificate_number', v_certificate.certificate_number,
    'employee_name', v_certificate.full_name,
    'training_title', v_certificate.training_title,
    'training_type', v_certificate.training_type,
    'training_date', v_certificate.training_date,
    'duration_minutes', v_certificate.duration_minutes,
    'facilitator', v_certificate.facilitator,
    'issued_at', v_certificate.issued_at
  );
end;
$$;
grant execute on function public.verify_training_certificate(text) to anon, authenticated;

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
  elsif v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_business') then
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
grant execute on function public.get_training_dashboard(date, date, text, uuid, text, uuid) to authenticated;

-- ------------------------------------------------------------
-- 9. MAN-HOUR INTELLIGENCE READ MODEL
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
  elsif v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'head_of_business', 'operations_manager') then v_ids := array[v_me.id]; end if;
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
grant execute on function public.get_man_hour_intelligence(date, date, text, uuid, text, uuid) to authenticated;

create or replace function public.get_employee_man_hour_detail(
  p_employee_id uuid,
  p_start_date date default null,
  p_end_date date default null
) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_start date := coalesce(p_start_date, date_trunc('month', current_date)::date);
  v_end date := coalesce(p_end_date, current_date);
  v_is_owner boolean;
begin
  select exists (select 1 from public.employees where id = p_employee_id and user_id = auth.uid()) into v_is_owner;
  if not v_is_owner and not public.training_is_manager() then raise exception 'Not authorized for this employee.'; end if;
  return jsonb_build_object(
    'attendance', coalesce((select jsonb_agg(jsonb_build_object('attendance_date', ar.attendance_date, 'clock_in', ar.clock_in, 'clock_out', ar.clock_out, 'work_hours', ar.work_hours, 'late_minutes', ar.late_minutes, 'early_departure_minutes', ar.early_departure_minutes, 'status', ar.status) order by ar.attendance_date desc) from public.attendance_records ar where ar.employee_id = p_employee_id and ar.attendance_date between v_start and v_end), '[]'::jsonb),
    'training', coalesce((select jsonb_agg(jsonb_build_object('training_title', r.training_title, 'training_type', r.training_type, 'training_date', r.training_date, 'duration_minutes', r.duration_minutes, 'assessment_percentage', r.assessment_percentage, 'assessment_passed', r.assessment_passed) order by r.training_date desc) from public.employee_training_records r where r.employee_id = p_employee_id and r.training_date between v_start and v_end), '[]'::jsonb),
    'start_date', v_start, 'end_date', v_end
  );
end;
$$;
grant execute on function public.get_employee_man_hour_detail(uuid, date, date) to authenticated;

-- ------------------------------------------------------------
-- END PHASE 51
-- ------------------------------------------------------------
