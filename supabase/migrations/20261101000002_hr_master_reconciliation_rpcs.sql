-- Reconciliation + review RPCs for the authoritative HR employee master.
-- Companion to 20261101000001. Additive, idempotent, transaction-safe.
--
-- SECURITY: every function is SECURITY DEFINER with search_path pinned, gated
-- by _org_can_manage() — the same HR-organisation authority the existing
-- supervisor table already uses. anon is revoked everywhere.

begin;

-- The workbook's "CONFIRMED & UNCONFIRMED" column is a CONFIRMATION status
-- (is this person confirmed / contract staff?), NOT an employment lifecycle
-- state. employees.employment_status drives leave, payroll and attendance and
-- only admits onboarding|active|probation|on_leave|terminated|suspended|
-- inactive. Writing CONFIRMED into it would corrupt those workflows, so the
-- workbook value gets its own column with its own vocabulary and the existing
-- lifecycle value is left exactly as HR set it.
alter table public.employees
  add column if not exists confirmation_status text;
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.employees'::regclass
                    and conname = 'employees_confirmation_status_check') then
    alter table public.employees add constraint employees_confirmation_status_check
      check (confirmation_status is null
             or confirmation_status in ('CONFIRMED','UNCONFIRMED','CONTRACT STAFF'));
  end if;
end;
$$;
comment on column public.employees.confirmation_status is
  'Reviewed-workbook confirmation status. Distinct from employment_status, which is the employment lifecycle state.';

-- One active supervisor per level per employee. Without this, re-applying an
-- import could stack a second "level 1" supervisor onto the same person.
create unique index if not exists uq_employee_supervisors_one_per_level
  on public.employee_supervisors (employee_id, level);

-- Staging of branch responsibilities, kept apart from the live table so a
-- preview never mutates real assignments.
create table if not exists public.hr_master_person_branches (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.hr_master_import_sessions(id) on delete cascade,
  person_id     uuid not null references public.hr_master_people(id) on delete cascade,
  branch_label  text not null,
  branch_label_norm text not null,
  source_sheet  text,
  position_ordinal integer not null default 0,
  created_at    timestamptz not null default now(),
  constraint uq_hr_master_person_branch unique (session_id, person_id, branch_label_norm)
);
create index if not exists idx_hr_master_person_branches_person on public.hr_master_person_branches (person_id);

-- ---------------------------------------------------------------------------
-- Normalisation helpers — the SAME rules as src/domains/employeeMaster so the
-- browser and the database can never disagree about what "the same" means.
-- ---------------------------------------------------------------------------
create or replace function public.hr_normalize_name(p text) returns text
language sql immutable strict as $$
  select btrim(regexp_replace(regexp_replace(upper(coalesce(p,'')), '[^A-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g'));
$$;

create or replace function public.hr_normalize_branch(p text) returns text
language sql immutable strict as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           upper(coalesce(p,'')),
           '([A-Z])([0-9])', '\1 \2', 'g'),
           '([0-9])([A-Z])', '\1 \2', 'g'),
           '[^A-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g'));
$$;
-- ---------------------------------------------------------------------------
-- Staging — idempotent: re-staging the same session upserts, never duplicates
-- ---------------------------------------------------------------------------
create or replace function public.hr_master_stage_session(
  p_filename text, p_file_hash text, p_as_at date, p_totals jsonb, p_mapping_version text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public._org_can_manage() then
    raise exception 'hr_master: not authorised to import the employee master';
  end if;

  -- Same file already imported: reuse its session so a re-run is a no-op
  -- instead of a second set of employees.
  if p_file_hash is not null then
    select id into v_id from public.hr_master_import_sessions
     where source_file_hash = p_file_hash and status <> 'rejected'
     order by created_at desc limit 1;
    if v_id is not null then
      update public.hr_master_import_sessions
         set totals = coalesce(p_totals, totals), as_at_date = coalesce(p_as_at, as_at_date)
       where id = v_id;
      return v_id;
    end if;
  end if;

  insert into public.hr_master_import_sessions
    (source_filename, source_file_hash, as_at_date, totals, mapping_version, created_by)
  values (p_filename, p_file_hash, coalesce(p_as_at, current_date),
          coalesce(p_totals, '{}'::jsonb), p_mapping_version, auth.uid())
  returning id into v_id;

  -- current_role is also a reserved SQL keyword returning the session role, so
  -- the schema-qualified form is required here.
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('HR_MASTER_IMPORT_CREATED', 'hr_master_import_session', v_id::text,
          public.current_role(), p_filename, 'info');
  return v_id;
end;
$$;

create or replace function public.hr_master_stage_people(p_session uuid, p_people jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_count int := 0;
begin
  if not public._org_can_manage() then raise exception 'hr_master: not authorised'; end if;
  if not exists (select 1 from public.hr_master_import_sessions where id = p_session) then
    raise exception 'hr_master: unknown session %', p_session;
  end if;

  insert into public.hr_master_people
    (session_id, staff_id, staff_id_norm, full_name_raw, full_name_norm, confirmed_status,
     designation, department, email, source_sheets, identity_kind, match_key,
     employee_id, conflict_reason, needs_review)
  select p_session,
         nullif(x->>'staff_id',''),
         nullif(upper(btrim(coalesce(x->>'staff_id',''))),''),
         coalesce(x->>'full_name',''),
         public.hr_normalize_name(x->>'full_name'),
         nullif(x->>'confirmed',''),
         nullif(x->>'designation',''),
         nullif(x->>'department',''),
         nullif(x->>'email',''),
         coalesce(array(select jsonb_array_elements_text(coalesce(x->'sheets','[]'::jsonb))), '{}'),
         x->>'identity_kind',
         nullif(x->>'match_key',''),
         nullif(x->>'employee_id','')::uuid,
         nullif(x->>'reason',''),
         coalesce((x->>'needs_review')::boolean, true)
    from jsonb_array_elements(coalesce(p_people,'[]'::jsonb)) x
  on conflict do nothing;

  select count(*) into v_count from public.hr_master_people where session_id = p_session;
  return v_count;
end;
$$;
create or replace function public.hr_master_stage_person_branches(p_session uuid, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_count int := 0;
begin
  if not public._org_can_manage() then raise exception 'hr_master: not authorised'; end if;

  insert into public.hr_master_person_branches
    (session_id, person_id, branch_label, branch_label_norm, source_sheet, position_ordinal)
  select p_session, (x->>'person_id')::uuid, x->>'branch_label',
         public.hr_normalize_branch(x->>'branch_label'),
         nullif(x->>'source_sheet',''),
         coalesce((x->>'ordinal')::int, 0)
    from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) x
   where exists (select 1 from public.hr_master_people p
                  where p.id = (x->>'person_id')::uuid and p.session_id = p_session)
  on conflict (session_id, person_id, branch_label_norm)
  do update set branch_label = excluded.branch_label,
                source_sheet  = excluded.source_sheet,
                position_ordinal = excluded.position_ordinal;

  select count(*) into v_count from public.hr_master_person_branches where session_id = p_session;
  return v_count;
end;
$$;

create or replace function public.hr_master_stage_supervisor_links(p_session uuid, p_links jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_count int := 0;
begin
  if not public._org_can_manage() then raise exception 'hr_master: not authorised'; end if;

  insert into public.hr_master_supervisor_links
    (session_id, person_id, level, source_label, source_label_norm, match_tier,
     supervisor_employee_id, candidates, status)
  select p_session, (x->>'person_id')::uuid, (x->>'level')::int,
         nullif(x->>'label',''),
         public.hr_normalize_name(x->>'label'),
         coalesce(x->>'tier','unresolved'),
         nullif(x->>'supervisor_employee_id','')::uuid,
         coalesce(x->'candidates','[]'::jsonb),
         coalesce(x->>'status','pending')
    from jsonb_array_elements(coalesce(p_links,'[]'::jsonb)) x
   where exists (select 1 from public.hr_master_people p
                  where p.id = (x->>'person_id')::uuid and p.session_id = p_session)
  on conflict (person_id, level) do update
    set source_label = excluded.source_label,
        source_label_norm = excluded.source_label_norm,
        match_tier = excluded.match_tier,
        supervisor_employee_id = excluded.supervisor_employee_id,
        candidates = excluded.candidates,
        status = excluded.status;

  select count(*) into v_count from public.hr_master_supervisor_links where session_id = p_session;
  return v_count;
end;
$$;

create or replace function public.hr_master_stage_branch_links(p_session uuid, p_links jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_count int := 0;
begin
  if not public._org_can_manage() then raise exception 'hr_master: not authorised'; end if;

  insert into public.hr_master_branch_links
    (session_id, branch_label, branch_label_norm, is_combined, combined_parts,
     canonical_branch_id, mapping_method, status)
  select p_session, x->>'branch_label',
         public.hr_normalize_branch(x->>'branch_label'),
         coalesce((x->>'is_combined')::boolean, false),
         coalesce(array(select jsonb_array_elements_text(coalesce(x->'parts','[]'::jsonb))), '{}'),
         nullif(x->>'canonical_branch_id','')::uuid,
         nullif(x->>'method',''),
         coalesce(x->>'status','pending')
    from jsonb_array_elements(coalesce(p_links,'[]'::jsonb)) x
  on conflict (session_id, branch_label_norm) do update
    set branch_label = excluded.branch_label,
        is_combined = excluded.is_combined,
        combined_parts = excluded.combined_parts,
        canonical_branch_id = excluded.canonical_branch_id,
        mapping_method = excluded.mapping_method,
        status = excluded.status;

  select count(*) into v_count from public.hr_master_branch_links where session_id = p_session;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- APPLY — the only function that writes to live HR tables.
--
-- Hard guarantees:
--   * auth.users / profiles are NEVER touched: there is no auth statement in
--     this function at all, by design.
--   * An existing employee is UPDATED IN PLACE (same id), never deleted or
--     recreated, so payroll / attendance / leave / appraisal history stays
--     attached to the same employee row.
--   * Only rows the reconciliation marked SAFE are applied; conflicts stay in
--     the review queue.
--   * Re-running is safe: assignments and supervisor links upsert on a unique
--     key, and employee updates are value-only.
-- ---------------------------------------------------------------------------
create or replace function public.hr_master_apply_session(p_session uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_people int := 0; v_created int := 0; v_updated int := 0;
  v_assignments int := 0; v_supervisors int := 0; v_skipped int := 0;
  v_as_of date;
begin
  if not public._org_can_manage() then
    raise exception 'hr_master: not authorised to apply the employee master';
  end if;
  if not exists (select 1 from public.hr_master_import_sessions where id = p_session) then
    raise exception 'hr_master: unknown session %', p_session;
  end if;

  select as_at_date into v_as_of from public.hr_master_import_sessions where id = p_session;

  -- 1. UPDATE matched employees in place. Only non-blank workbook values win,
  --    so a blank cell can never wipe an existing attribute.
  update public.employees e
     set full_name   = coalesce(nullif(p.full_name_raw,''), e.full_name),
         employee_code = coalesce(e.employee_code, p.staff_id),
         email        = case when p.email is not null
                              and lower(p.email) <> 'n/a'
                              and coalesce(e.email,'') not similar to '%@%.__'
                             then p.email else e.email end,
         department   = coalesce(nullif(p.department,''), e.department),
         position     = coalesce(nullif(p.designation,''), e.position),
         -- confirmation_status only; employment_status is the lifecycle state and
         -- is deliberately NOT overwritten by the workbook.
         confirmation_status = coalesce(nullif(p.confirmed_status,''), e.confirmation_status),
         source       = coalesce(nullif(e.source,''), 'bank_master_import'),
         updated_at   = now()
    from public.hr_master_people p
   where p.session_id = p_session
     and p.employee_id = e.id
     and p.identity_kind = 'match_existing';

  get diagnostics v_updated = row_count;

  -- 2. CREATE master rows for workbook-only people. An employee record is NOT
  --    an account: no auth user, no role, no password, nothing privileged.
  insert into public.employees
    (full_name, employee_code, email, department, position, confirmation_status,
     source, hire_date, created_at, updated_at)
  select p.full_name_raw, p.staff_id,
         case when p.email is not null and lower(p.email) <> 'n/a' then p.email end,
         nullif(p.department,''), nullif(p.designation,''),
         coalesce(nullif(p.confirmed_status,''), 'UNCONFIRMED'),
         'bank_master_import', v_as_of, now(), now()
    from public.hr_master_people p
   where p.session_id = p_session
     and p.identity_kind = 'new_employee'
     and p.staff_id is not null
     and not exists (select 1 from public.employees x
                      where x.employee_code is not null
                        and upper(x.employee_code) = upper(p.staff_id))
  on conflict do nothing;

  get diagnostics v_created = row_count;

  -- Link the staged people back to the rows we just created.
  update public.hr_master_people p
     set employee_id = e.id, needs_review = false
    from public.employees e
   where p.session_id = p_session
     and p.employee_id is null
     and p.identity_kind = 'new_employee'
     and p.staff_id is not null
     and upper(e.employee_code) = upper(p.staff_id);

  -- 3. Branch responsibilities. The first assignment in workbook order becomes
  --    primary; the rest are additional responsibilities. ONE employee row,
  --    MANY assignments — never one employee per branch.
  insert into public.employee_branch_assignments
    (employee_id, branch_id, branch_label, branch_label_norm, assignment_type,
     is_primary, is_active, source_sheet, effective_from)
  select p.employee_id,
         bl.canonical_branch_id,
         pb.branch_label, pb.branch_label_norm,
         case when pb.position_ordinal = 0 then 'primary' else 'responsibility' end,
         pb.position_ordinal = 0, true, pb.source_sheet, v_as_of
    from public.hr_master_person_branches pb
    join public.hr_master_people p on p.id = pb.person_id
    left join public.hr_branch_label_mappings bl
           on bl.normalized_label = pb.branch_label_norm and bl.status = 'active'
   where p.session_id = p_session and p.employee_id is not null
  on conflict (employee_id, branch_label_norm) where is_active
  do update set branch_label = excluded.branch_label,
                branch_id = coalesce(excluded.branch_id, employee_branch_assignments.branch_id),
                source_sheet = excluded.source_sheet,
                updated_at = now();

  get diagnostics v_assignments = row_count;

  -- 4. Supervisor hierarchy. Only links the reconciliation marked 'applied'
  --    (a deterministic, unique match) are written; pending ones stay in the
  --    review queue so a wrong approver is never installed.
  insert into public.employee_supervisors
    (employee_id, supervisor_employee_id, level, supervisor_title, effective_from, source)
  select p.employee_id, l.supervisor_employee_id, l.level, l.source_label, v_as_of, 'bank_master'
    from public.hr_master_supervisor_links l
    join public.hr_master_people p on p.id = l.person_id
   where l.session_id = p_session
     and l.status = 'applied'
     and l.supervisor_employee_id is not null
     and p.employee_id is not null
     -- Never let an employee supervise themselves: that would deadlock any
     -- approval cascade that walks the hierarchy.
     and l.supervisor_employee_id <> p.employee_id
  on conflict (employee_id, level) do update
    set supervisor_employee_id = excluded.supervisor_employee_id,
        supervisor_title = excluded.supervisor_title,
        effective_from = excluded.effective_from;

  get diagnostics v_supervisors = row_count;

  select count(*) into v_people from public.hr_master_people where session_id = p_session;
  select count(*) into v_skipped
    from public.hr_master_people
   where session_id = p_session and (employee_id is null or needs_review);

  update public.hr_master_import_sessions
     set status = 'applied', applied_at = now()
   where id = p_session;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('HR_MASTER_IMPORT_APPLIED', 'hr_master_import_session', p_session::text,
          public.current_role(),
          format('people=%s created=%s updated=%s assignments=%s supervisors=%s review=%s',
                 v_people, v_created, v_updated, v_assignments, v_supervisors, v_skipped),
          'info');

  return jsonb_build_object(
    'ok', true,
    'session_id', p_session,
    'people', v_people,
    'employees_created', v_created,
    'employees_updated', v_updated,
    'branch_assignments', v_assignments,
    'supervisor_links', v_supervisors,
    'awaiting_review', v_skipped);
end;
$$;

commit;

notify pgrst, 'reload schema';