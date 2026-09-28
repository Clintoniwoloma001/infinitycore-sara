-- ============================================================================
-- BankOne identity/branch mapping - RLS + audit
-- ============================================================================
-- The mapping tables were created in 20260929000001 WITHOUT RLS. That is closed
-- here: these tables hold officer identities and portfolio exposure, so they
-- must never be world-readable, and writes must go through role gates.
--
-- Policy shape (mirrors the rest of this schema):
--   * READ  -> work-review roles, plus a user may read their own mapping
--   * WRITE -> never granted to authenticated directly. Every change goes through
--              the SECURITY DEFINER RPCs below, which are role-gated AND audited.
-- Idempotent + additive.
begin;

alter table public.bankone_employee_mappings  enable row level security;
alter table public.bankone_branch_mappings    enable row level security;
alter table public.bankone_unresolved_officers enable row level security;
alter table public.bankone_created_employees   enable row level security;

-- Reads: the import administrators who must actually do the review.
drop policy if exists bankone_employee_mappings_read on public.bankone_employee_mappings;
create policy bankone_employee_mappings_read on public.bankone_employee_mappings
  for select to authenticated
  using (public.can_review_work_tasks() or created_by = auth.uid());

drop policy if exists bankone_branch_mappings_read on public.bankone_branch_mappings;
create policy bankone_branch_mappings_read on public.bankone_branch_mappings
  for select to authenticated
  using (public.can_review_work_tasks() or created_by = auth.uid());

drop policy if exists bankone_unresolved_officers_read on public.bankone_unresolved_officers;
create policy bankone_unresolved_officers_read on public.bankone_unresolved_officers
  for select to authenticated
  using (public.can_review_work_tasks());

drop policy if exists bankone_created_employees_read on public.bankone_created_employees;
create policy bankone_created_employees_read on public.bankone_created_employees
  for select to authenticated
  using (public.can_review_work_tasks() or created_by = auth.uid());

-- Deliberately NO insert/update/delete policies on any of the four tables.
-- Writes go through the audited RPCs below, so every consequential mapping is
-- attributable to an actor and cannot be silently rewritten.

-- ---------------------------------------------------------------------------
-- Audit helper
-- ---------------------------------------------------------------------------
create or replace function public.bankone_audit(
  p_action   text,
  p_entity   text,
  p_entity_id text,
  p_details  jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (p_action, p_entity, p_entity_id,
          (select full_name from public.profiles where id = auth.uid()),
          p_details::text,
          case when p_action in ('BANKONE_EMPLOYEE_MAPPING_CREATED','BANKONE_BRANCH_SPLIT')
               then 'warning' else 'info' end);
end;
$$;

comment on function public.bankone_audit is
  'Writes a BankOne audit row with the acting user, the entity and a JSON detail payload.';

-- ---------------------------------------------------------------------------
-- Confirm an officer mapping. This is the step that makes the NEXT import of
-- the same BankOne name resolve automatically with no second question.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_bankone_employee_mapping(
  p_normalized_source_name text,
  p_bankone_source_name     text,
  p_employee_id             uuid,
  p_match_type              text default 'manual',
  p_confidence              numeric default 1,
  p_reason                  text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.can_review_work_tasks() then
    raise exception 'You are not allowed to change BankOne officer mappings.';
  end if;
  if p_employee_id is null then
    raise exception 'Choose the employee this BankOne name refers to.';
  end if;
  if not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'That employee does not exist.';
  end if;

  insert into public.bankone_employee_mappings
    (bankone_source_name, normalized_source_name, employee_id, match_type,
     confidence, status, source, created_by)
  values (p_bankone_source_name, p_normalized_source_name, p_employee_id,
          p_match_type, p_confidence, 'active', 'admin', auth.uid())
  on conflict (normalized_source_name) do update
    set employee_id = excluded.employee_id,
        match_type  = excluded.match_type,
        confidence  = excluded.confidence,
        status      = 'active',
        source      = 'admin',
        created_by  = auth.uid(),
        updated_at  = now()
  returning id into v_id;

  -- Rows in an import that were waiting on this officer become resolved.
  update public.bankone_import_rows r
     set officer_employee_id = p_employee_id,
         match_status = 'auto_resolved',
         match_confidence = p_confidence
    from public.bankone_unresolved_officers u
   where u.normalized_source_name = p_normalized_source_name
     and u.batch_id = r.batch_id
     and r.officer_employee_id is null;

  update public.bankone_unresolved_officers
     set status = 'mapped', updated_at = now()
   where normalized_source_name = p_normalized_source_name;

  perform public.bankone_audit('BANKONE_EMPLOYEE_MAPPING_CREATED', 'bankone_employee_mapping', v_id::text,
    jsonb_build_object('source_name', p_bankone_source_name, 'employee_id', p_employee_id,
                       'match_type', p_match_type, 'confidence', p_confidence, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Explicitly keep an officer UNRESOLVED. The portfolio stays attributable to
-- "unresolved officer", never to a person.
-- ---------------------------------------------------------------------------
create or replace function public.mark_bankone_officer_unresolved(
  p_normalized_source_name text,
  p_bankone_source_name     text,
  p_reason                  text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.can_review_work_tasks() then
    raise exception 'You are not allowed to change BankOne officer mappings.';
  end if;

  insert into public.bankone_employee_mappings
    (bankone_source_name, normalized_source_name, employee_id, match_type, status, source, created_by)
  values (p_bankone_source_name, p_normalized_source_name, null, 'manual', 'unresolved', 'admin', auth.uid())
  on conflict (normalized_source_name) do update
    set status = 'unresolved', employee_id = null, updated_at = now()
  returning id into v_id;

  perform public.bankone_audit('BANKONE_OFFICER_LEFT_UNRESOLVED', 'bankone_employee_mapping', v_id::text,
    jsonb_build_object('source_name', p_bankone_source_name, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Map a BankOne branch to an existing InfinityCore branch.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_bankone_branch_mapping(
  p_normalized_bankone_branch_name text,
  p_bankone_branch_name            text,
  p_canonical_branch_id            uuid,
  p_mapping_type                   text default 'manual',
  p_split_from_branch_id           uuid default null,
  p_reason                         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.can_review_work_tasks() then
    raise exception 'You are not allowed to change BankOne branch mappings.';
  end if;
  if p_canonical_branch_id is null then
    raise exception 'Choose the InfinityCore branch this BankOne branch maps to.';
  end if;
  if not exists (select 1 from public.branches where id = p_canonical_branch_id) then
    raise exception 'That InfinityCore branch does not exist.';
  end if;

  insert into public.bankone_branch_mappings
    (bankone_branch_name, normalized_bankone_branch_name, canonical_branch_id,
     mapping_type, status, source, split_from_branch_id, created_by)
  values (p_bankone_branch_name, p_normalized_bankone_branch_name, p_canonical_branch_id,
          p_mapping_type, 'active', 'admin', p_split_from_branch_id, auth.uid())
  on conflict (normalized_bankone_branch_name) do update
    set canonical_branch_id  = excluded.canonical_branch_id,
        mapping_type         = excluded.mapping_type,
        status               = 'active',
        source               = 'admin',
        split_from_branch_id = excluded.split_from_branch_id,
        created_by           = auth.uid(),
        updated_at           = now()
  returning id into v_id;

  -- Resolve rows in past imports that were waiting on this branch.
  update public.bankone_import_rows
     set resolved_branch_id = p_canonical_branch_id,
         match_status = case when match_status = 'unresolved' then 'auto_resolved' else match_status end
   where branch_name_raw is not null
     and upper(replace(btrim(branch_name_raw), '-', ' ')) = p_normalized_bankone_branch_name;

  perform public.bankone_audit('BANKONE_BRANCH_MAPPING_CREATED', 'bankone_branch_mapping', v_id::text,
    jsonb_build_object('bankone_branch', p_bankone_branch_name,
                       'canonical_branch_id', p_canonical_branch_id,
                       'mapping_type', p_mapping_type, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- §12 Add-as-employee. Creates a PENDING employee from BankOne facts ONLY.
-- Nothing is invented: no email, no salary, no department, no designation, no
-- auth account. HR completes the record later.
-- ---------------------------------------------------------------------------
create or replace function public.add_employee_from_bankone(
  p_bankone_source_name    text,
  p_normalized_source_name text,
  p_branch_name_raw        text default null,
  p_source_import_id       uuid default null,
  p_branch_id              uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee uuid;
  v_mapping  uuid;
begin
  if not public.can_review_work_tasks() then
    raise exception 'You are not allowed to add employees from a BankOne import.';
  end if;
  if btrim(coalesce(p_bankone_source_name,'')) = '' then
    raise exception 'A BankOne officer name is required.';
  end if;

  insert into public.employees
    (full_name, source, import_source, confirmation_status, employment_status, branch, branch_id)
  values (p_bankone_source_name, 'bankone_import', 'bankone_import',
          'pending_verification', 'pending_verification', p_branch_name_raw, p_branch_id)
  returning id into v_employee;

  insert into public.bankone_created_employees
    (employee_id, source_import_id, bankone_source_name, branch_name_raw, created_by)
  values (v_employee, p_source_import_id, p_bankone_source_name, p_branch_name_raw, auth.uid());

  -- The permanent mapping is created immediately so the NEXT import of this
  -- name resolves to the employee we just created.
  insert into public.bankone_employee_mappings
    (bankone_source_name, normalized_source_name, employee_id, match_type,
     confidence, status, source, branch_name_raw, first_seen_import_id, created_by)
  values (p_bankone_source_name, p_normalized_source_name, v_employee,
          'created_employee', 1, 'active', 'admin', p_branch_name_raw, p_source_import_id, auth.uid())
  on conflict (normalized_source_name) do update
    set employee_id = excluded.employee_id,
        match_type  = 'created_employee',
        status      = 'active',
        updated_at  = now()
  returning id into v_mapping;

  update public.bankone_unresolved_officers
     set status = 'created_employee', updated_at = now()
   where normalized_source_name = p_normalized_source_name
     and (p_source_import_id is null or first_seen_import_id = p_source_import_id);

  perform public.bankone_audit('BANKONE_EMPLOYEE_CREATED', 'employee', v_employee::text,
    jsonb_build_object('source_name', p_bankone_source_name, 'branch', p_branch_name_raw,
                       'mapping_id', v_mapping, 'note',
                       'Created pending verification from BankOne; no account, email or compensation invented'));

  return jsonb_build_object('ok', true, 'employee_id', v_employee, 'mapping_id', v_mapping);
end;
$$;

-- ---------------------------------------------------------------------------
-- §15 Split a merged InfinityCore branch into its real BankOne branches.
--
-- SAFETY: the existing branch is DEACTIVATED, never deleted. Every employee,
-- attendance record, loan and historical import keeps its old branch_id, so no
-- history is rewritten or orphaned. Only NEW BankOne rows are re-pointed at the
-- newly created canonical branches, and the parent link is recorded on each
-- mapping so the split is reversible and auditable.
-- ---------------------------------------------------------------------------
create or replace function public.split_bankone_branch(
  p_parent_branch_id     uuid,
  p_new_branch_names     text[],
  p_source_import_id     uuid default null,
  p_reason               text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent     public.branches%rowtype;
  v_new_id     uuid;
  v_name       text;
  v_norm       text;
  v_created    uuid[] := '{}';
begin
  if not public.can_review_work_tasks() then
    raise exception 'You are not allowed to split branches.';
  end if;
  if p_new_branch_names is null or array_length(p_new_branch_names, 1) < 2 then
    raise exception 'A split needs at least two real branch names.';
  end if;

  select * into v_parent from public.branches where id = p_parent_branch_id for update;
  if v_parent.id is null then
    raise exception 'The branch being split does not exist.';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to split a branch.';
  end if;

  foreach v_name in array p_new_branch_names loop
    v_norm := upper(replace(btrim(v_name), '-', ' '));
    if v_norm = '' then continue; end if;

    -- Re-use an existing canonical branch if one already carries this name,
    -- so a split can be run twice without creating duplicates.
    select id into v_new_id from public.branches
     where upper(replace(btrim(branch_name), '-', ' ')) = v_norm
     order by (branch_name = v_name) desc nulls last
     limit 1;

    if v_new_id is null then
      insert into public.branches (branch_name, branch_code, status)
      values (btrim(v_name), upper(left(regexp_replace(btrim(v_name), '[^A-Za-z0-9]', '', 'g'), 6)),
              'active')
      returning id into v_new_id;
      v_created := v_created || v_new_id;
    end if;

    -- Record the mapping, tagged as a split and linked to its parent.
    insert into public.bankone_branch_mappings
      (bankone_branch_name, normalized_bankone_branch_name, canonical_branch_id,
       mapping_type, status, source, split_from_branch_id, created_by)
    values (btrim(v_name), v_norm, v_new_id, 'split', 'active', 'admin', p_parent_branch_id, auth.uid())
    on conflict (normalized_bankone_branch_name) do update
      set canonical_branch_id  = excluded.canonical_branch_id,
          mapping_type         = 'split',
          status               = 'active',
          split_from_branch_id = excluded.split_from_branch_id,
          updated_at           = now();
  end loop;

  -- Retire, never delete, the combined branch.
  update public.branches set status = 'inactive', updated_at = now() where id = p_parent_branch_id;

  -- Re-point only the BankOne import rows, and only those that actually carry
  -- one of the new names. Historical employees/attendance/loans are untouched.
  update public.bankone_import_rows r
     set resolved_branch_id = m.canonical_branch_id,
         match_status = 'auto_resolved'
    from public.bankone_branch_mappings m
   where m.split_from_branch_id = p_parent_branch_id
     and r.branch_name_raw is not null
     and upper(replace(btrim(r.branch_name_raw), '-', ' ')) = m.normalized_bankone_branch_name;

  perform public.bankone_audit('BANKONE_BRANCH_SPLIT', 'branch', p_parent_branch_id::text,
    jsonb_build_object('parent_branch', v_parent.branch_name,
                       'new_branches', to_jsonb(p_new_branch_names),
                       'created_branch_ids', to_jsonb(v_created),
                       'reason', p_reason,
                       'note', 'Parent branch deactivated, not deleted; existing history keeps its original branch'));

  return jsonb_build_object('ok', true, 'parent_branch_id', p_parent_branch_id,
                            'created_branch_ids', to_jsonb(v_created));
end;
$$;

commit;
