-- ============================================================================
-- Phase 71 - Employee master from the authoritative IT AUTOMATION list
--
-- THE SHEET IS THE SOURCE OF TRUTH for the employee master and its reference
-- data. This migration builds every STRUCTURE the authoritative import needs
-- and nothing destructive: the destructive replace is a SEPARATE, reviewed
-- file (20261101000008) that a human runs deliberately.
--
-- WHAT THIS ADDS
--   1. employees.staff_id / confirmation_status / gender - the sheet's columns.
--   2. employees.supervisor_1st_id / 2nd / 3rd - three-level reporting FKs.
--   3. public.employee_branches - the multi-branch junction.
--   4. Shared name/staff-id normalisation so every matcher agrees.
--   5. resolve_employee_coverage - the import parser's employee+branch resolver.
--   6. employee_coverage - the profile read model (branch badges + chain).
--
-- DESIGN NOTES
--   * staff_id is SEPARATE from employee_code (an internally generated code used
--     by other subsystems). Merging them would break every employee_code reader.
--   * Uniqueness is enforced on upper(btrim(...)) - the same shape as the
--     profiles email guard (Phase 68) - so 'imfb/07/0004' and 'IMFB/07/0004 '
--     cannot both exist.
--   * employee_branch_assignments already existed with richer provenance
--     (source_sheet, effective dates). It stays the system of record;
--     employee_branches is a VIEW over its ACTIVE rows, so there is exactly ONE
--     coverage concept in the database and the two cannot drift.
--
-- Idempotent and additive. Re-running is a no-op.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. employees - the sheet's own columns
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists staff_id text,
  add column if not exists confirmation_status text,
  add column if not exists gender text;

comment on column public.employees.staff_id is
  'Authoritative staff number from the IT AUTOMATION list, e.g. IMFB/07/0004. Distinct from employee_code, which is an internally generated code.';
comment on column public.employees.confirmation_status is
  'CONFIRMED / UNCONFIRMED from the IT AUTOMATION list. UNCONFIRMED staff are contract or probationary hires.';
comment on column public.employees.gender is
  'M / F from the IT AUTOMATION list. The authoritative value; sex is kept for legacy consumers.';

create unique index if not exists uq_employees_staff_id
  on public.employees (upper(btrim(staff_id)))
  where staff_id is not null and btrim(staff_id) <> '';

-- The three reporting levels. Nullable FKs to employees.id: an employee whose
-- supervisor is not on the list (e.g. "BOARD OF DIRECTORS") gets NULL, never a
-- dangling reference.
alter table public.employees
  add column if not exists supervisor_1st_id uuid,
  add column if not exists supervisor_2nd_id uuid,
  add column if not exists supervisor_3rd_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employees_supervisor_1st_fkey') then
    alter table public.employees add constraint employees_supervisor_1st_fkey
      foreign key (supervisor_1st_id) references public.employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_supervisor_2nd_fkey') then
    alter table public.employees add constraint employees_supervisor_2nd_fkey
      foreign key (supervisor_2nd_id) references public.employees(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employees_supervisor_3rd_fkey') then
    alter table public.employees add constraint employees_supervisor_3rd_fkey
      foreign key (supervisor_3rd_id) references public.employees(id) on delete set null;
  end if;
end $$;

comment on column public.employees.supervisor_1st_id is
  'Direct reporting line from the IT AUTOMATION list. NULL when the supervisor is not a matched employee.';
comment on column public.employees.supervisor_2nd_id is 'Second reporting level from the IT AUTOMATION list.';
comment on column public.employees.supervisor_3rd_id is 'Third reporting level from the IT AUTOMATION list.';

create index if not exists idx_employees_supervisor_1st on public.employees (supervisor_1st_id);
create index if not exists idx_employees_supervisor_2nd on public.employees (supervisor_2nd_id);
create index if not exists idx_employees_supervisor_3rd on public.employees (supervisor_3rd_id);

-- Hierarchy is self-referencing, so this is what makes the reporting tree
-- traversable from the top down.
create index if not exists idx_employees_hierarchy
  on public.employees (supervisor_1st_id, supervisor_2nd_id, supervisor_3rd_id)
  where supervisor_1st_id is not null;

-- ---------------------------------------------------------------------------
-- 2. employee_branches - the multi-branch junction
--
-- A Compliance Officer can cover Lagos Island ONE, Alaba AND Boundary. Storing
-- that as three employee rows would triple the person, break every attendance /
-- payroll / leave FK and fragment their history. This junction is the
-- Many-to-Many answer.
-- ---------------------------------------------------------------------------
create or replace view public.employee_branches as
select
  eba.id,
  eba.employee_id,
  eba.branch_id,
  coalesce(eba.is_primary, false) as is_primary
from public.employee_branch_assignments eba
where coalesce(eba.is_active, true);

comment on view public.employee_branches is
  'ACTIVE branch coverage per employee. Many-to-many: one employee may cover many branches. Backed by employee_branch_assignments, which keeps provenance (source_sheet, effective dates).';

-- Enforce "at most one primary branch per employee" in the DATABASE, not just in
-- a form. A partial unique index is the only way to say this without a trigger.
create unique index if not exists uq_employee_branch_primary
  on public.employee_branch_assignments (employee_id)
  where coalesce(is_active, true) and coalesce(is_primary, false);

-- Re-importing the same coverage row must upsert, never duplicate.
create unique index if not exists uq_employee_branch_pair
  on public.employee_branch_assignments (employee_id, branch_id);

-- ---------------------------------------------------------------------------
-- 3. Normalisation - ONE definition of "the same name"
--
-- The import parser, the BankOne officer resolver and the hierarchy resolver all
-- match on names. When they disagree about case, whitespace or punctuation, the
-- same person resolves in one path and vanishes in another - which is how an
-- import silently drops rows.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_person_name(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    regexp_replace(
      regexp_replace(upper(btrim(coalesce(p_name, ''))), '[^A-Z0-9 ]', '', 'g'),
      '\s+', ' ', 'g'),
    '');
$$;

comment on function public.normalize_person_name(text) is
  'Canonical matching key for a person name: upper-cased, punctuation stripped, whitespace collapsed. Shared by the import parser, BankOne officer resolution and hierarchy resolution so they can never disagree.';

create or replace function public.normalize_staff_id(p_staff_id text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(regexp_replace(upper(btrim(coalesce(p_staff_id, ''))), '[^A-Z0-9]', '', 'g'), '');
$$;

comment on function public.normalize_staff_id(text) is
  'Canonical matching key for a staff number: upper-cased, separators stripped. IMFB/07/0004 and imfb070004 are the SAME staff number.';

-- A plain index on staff_id cannot serve normalize_staff_id(), so index the
-- normalised expression itself.
create index if not exists idx_employees_staff_id_norm
  on public.employees (normalize_staff_id(staff_id))
  where staff_id is not null;

create or replace function public.employee_matches_name(p_employee_id uuid, p_name text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.employees e
    where e.id = p_employee_id
      and public.normalize_person_name(e.full_name) = public.normalize_person_name(p_name)
  );
$$;

comment on function public.employee_matches_name(uuid, text) is
  'True when the employee''s name matches the supplied name under the shared normalisation rules.';

-- ---------------------------------------------------------------------------
-- 4. resolve_employee_coverage - the import parser's employee/branch resolver
--
-- Each PAR / Portfolio / Transaction row must resolve to BOTH an employee AND
-- the specific branch it was reported for, creating the coverage mapping when
-- it does not exist. That logic lives here, in ONE place, so the CSV path, the
-- Excel path and any future caller cannot drift.
--
-- It NEVER guesses: an ambiguous name (two employees normalise to the same key)
-- returns match_status='ambiguous' with the candidates listed, and the caller
-- must surface that rather than bind the row to an arbitrary person.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_employee_coverage(
  p_staff_identifier text,
  p_branch_name text,
  p_create_coverage boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name_key text := public.normalize_person_name(p_staff_identifier);
  v_staff_key text := public.normalize_staff_id(p_staff_identifier);
  v_branch_key text := public.normalize_person_name(p_branch_name);
  v_candidates jsonb := '[]'::jsonb;
  v_employee uuid;
  v_branch uuid;
begin
  -- 1. Branch first: an unrecognised branch must never silently create one.
  select b.id into v_branch
    from public.branches b
   where public.normalize_person_name(b.branch_name) = v_branch_key
   limit 1;

  -- 2. Employee, by the strongest identifier available.
  if v_staff_key <> '' then
    select e.id into v_employee
      from public.employees e
     where public.normalize_staff_id(e.staff_id) = v_staff_key
     limit 1;
  end if;

  if v_employee is null and v_name_key <> '' then
    select coalesce(jsonb_agg(jsonb_build_object('employee_id', e.id, 'full_name', e.full_name)),
                    '[]'::jsonb)
      into v_candidates
      from public.employees e
     where public.normalize_person_name(e.full_name) = v_name_key;

    if jsonb_array_length(v_candidates) = 1 then
      v_employee := (v_candidates ->> 0 ->> 'employee_id')::uuid;
    elsif jsonb_array_length(v_candidates) > 1 then
      return jsonb_build_object(
        'ok', false,
        'match_status', 'ambiguous',
        'reason', 'More than one employee matches this name; resolve manually.',
        'candidates', v_candidates,
        'employee_id', null,
        'branch_id', v_branch);
    end if;
  end if;

  -- 3. Coverage mapping, created only on an unambiguous hit.
  if v_employee is not null and v_branch is not null and p_create_coverage then
    insert into public.employee_branch_assignments
      (employee_id, branch_id, branch_label, is_primary, is_active, source_sheet)
    values (v_employee, v_branch, p_branch_name, false, true, 'import')
    on conflict (employee_id, branch_id) do nothing;
  end if;

  return jsonb_build_object(
    'ok', (v_employee is not null and v_branch is not null),
    'match_status', case
      when v_employee is null then 'no_employee_match'
      when v_branch is null then 'no_branch_match'
      else 'matched' end,
    'reason', case
      when v_employee is null then 'No employee matches the reported officer name.'
      when v_branch is null then 'No branch matches the reported branch name.'
      else null end,
    'employee_id', v_employee,
    'branch_id', v_branch,
    'candidates', v_candidates);
end;
$$;

comment on function public.resolve_employee_coverage(text, text, boolean) is
  'Resolves one imported report row to BOTH an employee and the specific branch it was reported for, creating the coverage mapping when missing. Returns match_status (matched / no_employee_match / no_branch_match / ambiguous) - it never guesses between multiple name matches.';

revoke all on function public.resolve_employee_coverage(text, text, boolean) from public;
revoke all on function public.resolve_employee_coverage(text, text, boolean) from anon;
grant execute on function public.resolve_employee_coverage(text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. employee_coverage - the read model the profile page renders
--
-- Identity plus branch badges plus the full three-level reporting chain, so
-- EmployeeProfile does not fan out into separate queries and join them itself.
-- ---------------------------------------------------------------------------
create or replace function public.employee_supervisor_card(p_employee_id uuid, p_level integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case p_level
    when 1 then (
      select jsonb_build_object('employee_id', s.id, 'full_name', s.full_name,
                                'email', s.email, 'title', s.position,
                                'staff_id', s.staff_id)
        from public.employees e join public.employees s on s.id = e.supervisor_1st_id
       where e.id = p_employee_id)
    when 2 then (
      select jsonb_build_object('employee_id', s.id, 'full_name', s.full_name,
                                'email', s.email, 'title', s.position,
                                'staff_id', s.staff_id)
        from public.employees e join public.employees s on s.id = e.supervisor_2nd_id
       where e.id = p_employee_id)
    when 3 then (
      select jsonb_build_object('employee_id', s.id, 'full_name', s.full_name,
                                'email', s.email, 'title', s.position,
                                'staff_id', s.staff_id)
        from public.employees e join public.employees s on s.id = e.supervisor_3rd_id
       where e.id = p_employee_id)
    else null end;
$$;

comment on function public.employee_supervisor_card(uuid, integer) is
  'One reporting level (1/2/3) as a display object, or NULL when that level is not populated. Never fabricates a supervisor.';

revoke all on function public.employee_supervisor_card(uuid, integer) from public;
revoke all on function public.employee_supervisor_card(uuid, integer) from anon;
grant execute on function public.employee_supervisor_card(uuid, integer) to authenticated;

create or replace function public.employee_coverage(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_emp jsonb;
begin
  select to_jsonb(x) into v_emp
    from (
      select e.id as employee_id, e.full_name, e.staff_id, e.email,
             e.gender, e.confirmation_status, e.employment_status,
             e.department, e.position, e.branch_id, e.branch
      from public.employees e
      where e.id = p_employee_id
    ) x;

  if v_emp is null then
    return jsonb_build_object('ok', false, 'reason', 'Employee not found.');
  end if;

  return v_emp
    || jsonb_build_object(
      'ok', true,
      'branches', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'branch_id', eba.branch_id,
                 'branch_name', b.branch_name,
                 'is_primary', coalesce(eba.is_primary, false)
               ) order by coalesce(eba.is_primary, false) desc, b.branch_name)
          from public.employee_branch_assignments eba
          join public.branches b on b.id = eba.branch_id
         where eba.employee_id = p_employee_id
           and coalesce(eba.is_active, true)
      ), '[]'::jsonb),
      -- Each level is its own object so the UI renders three cards without
      -- re-deriving the chain, and a broken chain shows as NULL, not a lie.
      'supervisors', jsonb_build_object(
        'first', public.employee_supervisor_card(p_employee_id, 1),
        'second', public.employee_supervisor_card(p_employee_id, 2),
        'third', public.employee_supervisor_card(p_employee_id, 3))
    );
end;
$$;

comment on function public.employee_coverage(uuid) is
  'Employee profile read model: identity plus branch badges plus the three-level reporting chain, so the profile page renders from one call.';

revoke all on function public.employee_coverage(uuid) from public;
revoke all on function public.employee_coverage(uuid) from anon;
grant execute on function public.employee_coverage(uuid) to authenticated;

commit;
