-- Resolution RPCs for the HR employee master review queue.
-- Companion to 20261101000001/2. Additive, idempotent.
--
-- A resolution here is a real decision about who supervises whom, so it is
-- audited, and stored PERMANENTLY as a label mapping so the same workbook does
-- not have to be reviewed twice.

begin;

-- ---------------------------------------------------------------------------
-- 1. Resolve an identity conflict: point a staged person at a real employee.
-- ---------------------------------------------------------------------------
create or replace function public.hr_resolve_identity(
  p_person_id uuid, p_employee_id uuid, p_reason text, p_keep_unresolved boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_person public.hr_master_people%rowtype;
begin
  if not public._org_can_manage() then raise exception 'hr_master: not authorised'; end if;
  select * into v_person from public.hr_master_people where id = p_person_id;
  if not found then raise exception 'hr_master: unknown person %', p_person_id; end if;

  if p_keep_unresolved or p_employee_id is null then
    update public.hr_master_people
       set needs_review = true,
           conflict_reason = coalesce(nullif(btrim(p_reason),''), 'Left unresolved by HR review')
     where id = p_person_id;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('HR_MASTER_IDENTITY_UNRESOLVED','hr_master_people',p_person_id::text,
            public.current_role(), coalesce(p_reason,''), 'warning');
    return jsonb_build_object('ok', true, 'status', 'unresolved');
  end if;

  if not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'hr_master: unknown employee %', p_employee_id;
  end if;

  -- Refuse to bind two staged people to the same employee: that is how one
  -- person silently loses their record during a contested import.
  if exists (select 1 from public.hr_master_people
              where session_id = v_person.session_id
                and employee_id = p_employee_id and id <> p_person_id) then
    raise exception 'hr_master: employee % is already bound to another workbook row in this session', p_employee_id;
  end if;

  update public.hr_master_people
     set employee_id = p_employee_id, needs_review = false,
         identity_kind = 'match_existing', match_key = 'hr_review',
         conflict_reason = null
   where id = p_person_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('HR_MASTER_IDENTITY_RESOLVED','hr_master_people',p_person_id::text,
          public.current_role(),
          format('employee=%s reason=%s', p_employee_id, coalesce(p_reason,'')), 'info');
  return jsonb_build_object('ok', true, 'status', 'resolved', 'employee_id', p_employee_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Resolve a supervisor link + remember the answer for future imports.
-- ---------------------------------------------------------------------------
create or replace function public.hr_resolve_supervisor_link(
  p_link_id uuid, p_employee_id uuid, p_reason text, p_keep_unresolved boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_link public.hr_master_supervisor_links%rowtype;
  v_person_emp uuid;
  v_label text;
begin
  if not public._org_can_manage() then raise exception 'hr_master: not authorised'; end if;
  select * into v_link from public.hr_master_supervisor_links where id = p_link_id;
  if not found then raise exception 'hr_master: unknown supervisor link %', p_link_id; end if;

  select p.employee_id into v_person_emp from public.hr_master_people p where p.id = v_link.person_id;
  v_label := public.hr_normalize_name(coalesce(v_link.source_label,''));

  if p_keep_unresolved or p_employee_id is null then
    update public.hr_master_supervisor_links
       set status = 'unresolved', supervisor_employee_id = null,
           resolved_by = auth.uid(), resolved_at = now()
     where id = p_link_id;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('HR_MASTER_SUPERVISOR_UNRESOLVED','hr_master_supervisor_link',p_link_id::text,
            public.current_role(), coalesce(p_reason,''), 'warning');
    return jsonb_build_object('ok', true, 'status', 'unresolved');
  end if;

  if not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'hr_master: unknown employee %', p_employee_id;
  end if;
  -- Self-supervision would deadlock any approval cascade that walks the
  -- hierarchy, so refuse it at the point of the decision.
  if v_person_emp is not null and p_employee_id = v_person_emp then
    raise exception 'hr_master: an employee cannot be their own supervisor';
  end if;

  update public.hr_master_supervisor_links
     set status = 'applied', supervisor_employee_id = p_employee_id,
         match_tier = 'manually_confirmed', resolved_by = auth.uid(), resolved_at = now()
   where id = p_link_id;

  -- Persist the decision so the same label resolves automatically next import.
  if v_label <> '' then
    insert into public.hr_supervisor_label_mappings
      (normalized_label, raw_label, employee_id, mapping_type, confidence, status, source, created_by)
    values (v_label, v_link.source_label, p_employee_id, 'manually_confirmed', 1.0000, 'active', 'hr_review', auth.uid())
    on conflict (normalized_label) where status = 'active'
    do update set employee_id = excluded.employee_id,
                  mapping_type  = excluded.mapping_type,
                  raw_label     = excluded.raw_label,
                  updated_at    = now();
  end if;

  -- Write it through to the live hierarchy now, so the decision takes effect.
  if v_person_emp is not null then
    insert into public.employee_supervisors
      (employee_id, supervisor_employee_id, level, supervisor_title, effective_from, source)
    values (v_person_emp, p_employee_id, v_link.level, v_link.source_label, current_date, 'bank_master')
    on conflict (employee_id, level) do update
      set supervisor_employee_id = excluded.supervisor_employee_id,
          supervisor_title = excluded.supervisor_title,
          effective_from = excluded.effective_from;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('HR_MASTER_SUPERVISOR_RESOLVED','hr_master_supervisor_link',p_link_id::text,
          public.current_role(),
          format('level=%s supervisor=%s reason=%s', v_link.level, p_employee_id, coalesce(p_reason,'')), 'info');
  return jsonb_build_object('ok', true, 'status', 'applied', 'supervisor_employee_id', p_employee_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Resolve a branch label to a canonical branch (and remember it).
-- ---------------------------------------------------------------------------
create or replace function public.hr_resolve_branch_link(
  p_link_id uuid, p_branch_id uuid, p_reason text, p_create_missing boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_link public.hr_master_branch_links%rowtype;
  v_norm text;
begin
  if not public._org_can_manage() then raise exception 'hr_master: not authorised'; end if;
  select * into v_link from public.hr_master_branch_links where id = p_link_id;
  if not found then raise exception 'hr_master: unknown branch link %', p_link_id; end if;
  v_norm := public.hr_normalize_branch(v_link.branch_label);

  if p_branch_id is null and not p_create_missing then
    update public.hr_master_branch_links
       set status = 'unresolved', resolved_by = auth.uid(), resolved_at = now()
     where id = p_link_id;
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('HR_MASTER_BRANCH_UNRESOLVED','hr_master_branch_link',p_link_id::text,
            public.current_role(), coalesce(p_reason,''), 'warning');
    return jsonb_build_object('ok', true, 'status', 'unresolved');
  end if;

  if p_branch_id is null then
    -- Create the canonical branch. branch_name has no unique constraint, so this
    -- lookup is what stops a repeated import creating a duplicate.
    select b.id into p_branch_id from public.branches b
     where public.hr_normalize_branch(b.branch_name) = v_norm
     order by b.created_at limit 1;
    if p_branch_id is null then
      insert into public.branches (branch_name, branch_code, status)
      values (v_link.branch_label, 'HR-' || substr(replace(v_norm,' ','-'),1,16), 'active')
      returning id into p_branch_id;
      insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
      values ('HR_MASTER_BRANCH_CREATED','branches',p_branch_id::text,
              public.current_role(), v_link.branch_label, 'warning');
    end if;
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id) then
    raise exception 'hr_master: unknown branch %', p_branch_id;
  end if;

  insert into public.hr_branch_label_mappings
    (normalized_label, raw_label, canonical_branch_id, mapping_method, status, created_by)
  values (v_norm, v_link.branch_label, p_branch_id, 'hr_review', 'active', auth.uid())
  on conflict (normalized_label) where status = 'active'
  do update set canonical_branch_id = excluded.canonical_branch_id,
                raw_label = excluded.raw_label,
                updated_at = now();

  update public.hr_master_branch_links
     set status = 'mapped', canonical_branch_id = p_branch_id, mapping_method = 'hr_review',
         resolved_by = auth.uid(), resolved_at = now()
   where id = p_link_id;

  -- Backfill any assignment stored with the label but no branch id.
  update public.employee_branch_assignments a
     set branch_id = p_branch_id, updated_at = now()
   where a.branch_label_norm = v_norm and a.branch_id is null and a.is_active;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('HR_MASTER_BRANCH_RESOLVED','hr_master_branch_link',p_link_id::text,
          public.current_role(),
          format('label=%s branch=%s reason=%s', v_link.branch_label, p_branch_id, coalesce(p_reason,'')), 'info');
  return jsonb_build_object('ok', true, 'status', 'mapped', 'branch_id', p_branch_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read-only: the review queue, shaped for the UI.
-- ---------------------------------------------------------------------------
create or replace function public.hr_master_review_queue(p_session uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not public._org_can_manage() then raise exception 'hr_master: not authorised'; end if;
  return jsonb_build_object(
    'identity', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'staff_id', p.staff_id, 'full_name', p.full_name_raw,
        'designation', p.designation, 'department', p.department, 'email', p.email,
        'identity_kind', p.identity_kind, 'reason', p.conflict_reason,
        'sheets', p.source_sheets, 'employee_id', p.employee_id) order by p.staff_id), '[]'::jsonb)
      from public.hr_master_people p
      where p.session_id = p_session and p.needs_review),
    'supervisors', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', l.id, 'level', l.level, 'label', l.source_label, 'tier', l.match_tier,
        'person_id', l.person_id, 'person_name', pp.full_name_raw, 'person_staff_id', pp.staff_id,
        'candidates', l.candidates) order by pp.staff_id, l.level), '[]'::jsonb)
      from public.hr_master_supervisor_links l
      join public.hr_master_people pp on pp.id = l.person_id
      where l.session_id = p_session and l.status = 'pending'),
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id, 'label', b.branch_label, 'is_combined', b.is_combined,
        'parts', b.combined_parts, 'branch_id', b.canonical_branch_id) order by b.branch_label), '[]'::jsonb)
      from public.hr_master_branch_links b
      where b.session_id = p_session and b.status = 'pending')
  );
end;
$$;

commit;

notify pgrst, 'reload schema';