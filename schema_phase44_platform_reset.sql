-- ============================================================
-- schema_phase44_platform_reset.sql
-- ------------------------------------------------------------
-- PURPOSE
--   Super Admin-only "Platform Reset" centre — the safe way to wipe
--   test/reset data before going live.
--
--   * platform_reset_counts(p_areas text[])  — row counts per area and
--     per table, WITHOUT deleting anything. Safe to call anytime.
--   * platform_reset_areas(p_areas text[])   — wipes ONLY the requested
--     areas (transactional data). Returns per-area counts removed.
--   * platform_reset_all()                   — wipes every reset area in
--     one transaction (the "reset the whole platform" action).
--   * platform_delete_record(p_entity, p_id) — delete ONE specific
--     record by entity type + id (the "delete particular data" action).
--
--   What is NEVER touched (master / configuration / identity):
--     users/profiles, employees, branches, departments, designations,
--     areas, roles/permissions, hr_platform_settings, system_config,
--     attendance_config/geofences/devices, offer_letter_templates,
--     payroll_config/periods/salary_components, bankone_column_mappings,
--     hospital_providers, hospital_users, medical_screening_config,
--     kpi_definitions, message_retention_policies,
--     integration_connections / credentials / field mappings, documents.
--
--   Everything runs in a SINGLE transaction — if any step raises, the
--   whole reset is rolled back.
--
--   Who may call:
--     super_admin ONLY. Enforcement is server-side via public.current_role()
--     (SECURITY DEFINER) inside every entry point — never trusted from the
--     client. Execution is revoked from public/anon too.
--
-- ALL ADDITIVE / IDEMPOTENT / OR REPLACE. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. PREREQUISITE — public.current_role() (phase37 / base schema)
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc where proname = 'current_role' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'Prerequisite missing: public.current_role() must exist before phase44.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. AREA DEFINITIONS (table → reset-area mapping)
--    Returns a jsonb object: { <area_key>: [table, ...] }
--    Only tables that exist are included (to_regclass guard).
-- ------------------------------------------------------------
create or replace function public.platform_reset_areas_map()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb := '{}'::jsonb;
begin
  v_out := jsonb_build_object(
    'attendance', jsonb_build_array(
      'attendance_records','attendance_events','attendance_exceptions',
      'attendance_issues','attendance_corrections_audit',
      'employee_biometric_identifiers','webauthn_challenges'),
    'leave', jsonb_build_array('leave_requests','leave_approvals','leave_balances'),
    'onboarding', jsonb_build_array(
      'employee_onboarding_submissions','employee_onboarding_links',
      'onboarding_corrections','onboarding_events',
      'guarantor_verifications','guarantor_corrections','guarantor_documents',
      'fidelity_bond_verifications','fidelity_bond_documents',
      'employee_fidelity_bonds','employee_guarantors','employee_account_invites'),
    'recruitment', jsonb_build_array(
      'hr_jobs','hr_candidates','hr_candidate_notes','hr_candidate_status_history',
      'hr_interviews','interview_questions','interview_reminders','hr_assessments',
      'assessment_templates','assessment_template_questions','assessment_attempts',
      'assessment_attempt_answers','assessment_retake_requests',
      'candidate_screening_results','offer_letters'),
    'performance', jsonb_build_array(
      'appraisal_periods','appraisal_results','employee_appraisals',
      'performance_metrics','performance_results','performance_adjustments'),
    'work', jsonb_build_array(
      'work_tasks','tasks','task_submissions','targets','task_progress_reports',
      'work_plans','kpi_assignments','kpi_submissions','employee_kpis'),
    'chat', jsonb_build_array(
      'chat_messages','chat_threads',
      'message_channels','message_channel_members','message_groups','message_group_members',
      'message_acknowledgements','message_attachments','message_audit_log','message_bookmarks',
      'message_exports','message_holds','message_mentions','message_reads','message_reactions',
      'message_reports','message_revisions','message_tasks'),
    'notifications', jsonb_build_array('notifications'),
    'payroll', jsonb_build_array(
      'payroll','payroll_push_requests','payroll_push_approvals','payroll_push_events',
      'employment_letters','employee_salary_packages','employee_salary_snapshots'),
    'bankone', jsonb_build_array(
      'bankone_transactions','bankone_import_batches','bankone_import_rows',
      'employee_bankone_identifiers'),
    'medical', jsonb_build_array(
      'medical_screenings','medical_referrals','medical_screening_amendments',
      'medical_screening_events','medical_documents'),
    'audit', jsonb_build_array('audit_logs','sara_audit_logs','hr_settings_audit'),
    'support', jsonb_build_array('support_cases'),
    'data', jsonb_build_array(
      'data_import_jobs','data_import_records','staff_import_batches',
      'data_quality_exceptions','hierarchy_exceptions','org_assignment_history',
      'integration_logs','integration_sync_runs','integration_sync_items',
      'integration_outbound_queue','integration_webhook_events',
      'integration_approvals','integration_conflicts','integration_references'),
    'banking', jsonb_build_array(
      'loan_applications','loans','repayments',
      'transaction_relationships','transaction_status_history',
      'reconciliation_cases','reconciliation_case_events')
  );

  -- Drop tables that do not exist (keeps the tool robust on partial deployments)
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_out
  from (
    select k, (
      select coalesce(jsonb_agg(t), '[]'::jsonb)
      from jsonb_array_elements_text(v) t
      where to_regclass(format('public.%I', t)) is not null
    ) as v
    from jsonb_each(v_out) je(k, v)
  ) areas;

  return v_out;
end; $$;

-- ------------------------------------------------------------
-- 3. HELPER — resolve p_areas into a distinct, ordered table list
--    Returns text[].
-- ------------------------------------------------------------
create or replace function public.platform_reset_tables_for(p_areas text[])
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_map jsonb := public.platform_reset_areas_map();
  v_area text;
  v_table text;
  v_tables text[] := '{}'::text[];
begin
  if p_areas is null or array_length(p_areas, 1) is null then
    raise exception 'No reset areas supplied.';
  end if;
  foreach v_area in array p_areas loop
    if not v_map ? v_area then
      raise exception 'Unknown reset area "%". Allowed areas: %', v_area,
        (select string_agg(key, ', ' order by key) from jsonb_object_keys(v_map) as key);
    end if;
    for v_table in select jsonb_array_elements_text(v_map -> v_area) loop
      if not (v_table = any(v_tables)) then
        v_tables := array_append(v_tables, v_table);
      end if;
    end loop;
  end loop;
  return v_tables;
end; $$;

-- ------------------------------------------------------------
-- 3b. CLOSURE EXPANSION — folds in every PUBLIC-schema table that
--     references a table already in the set, directly or transitively.
--     This makes TRUNCATE CASCADE fully explicit: it never silently
--     removes rows from a table the caller did not select, and the
--     reported counts are exact. Config/master tables are never pulled
--     in because they do not reference transactional tables.
-- ------------------------------------------------------------
create or replace function public.platform_reset_expand_tables(p_tables text[])
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_set text[] := p_tables;
  v_new text;
  v_added int;
begin
  loop
    v_added := 0;
    for v_new in
      select distinct rc.relname
      from pg_constraint c
      join pg_class rc on rc.oid = c.conrelid
      join pg_namespace rn on rn.oid = rc.relnamespace
      join pg_class fc on fc.oid = c.confrelid
      join pg_namespace fn on fn.oid = fc.relnamespace
      where c.contype = 'f'
        and fn.nspname = 'public'
        and rn.nspname = 'public'
        and fc.relname = any(v_set)
        and rc.relname <> all(v_set)
    loop
      v_set := array_append(v_set, v_new);
      v_added := v_added + 1;
    end loop;
    exit when v_added = 0;
  end loop;
  return v_set;
end; $$;

-- ------------------------------------------------------------
-- 4. ROLE GUARD — super_admin only
-- ------------------------------------------------------------
create or replace function public.platform_reset_guard()
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a Super Admin can reset platform data.';
  end if;
end; $$;

-- ------------------------------------------------------------
-- 5. COUNTS — never mutates. Returns per-area and per-table rows.
--    p_areas: null/empty => all areas.
-- ------------------------------------------------------------
create or replace function public.platform_reset_counts(p_areas text[] default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_map jsonb := public.platform_reset_areas_map();
  v_mapped text[] := coalesce(p_areas, '{}'::text[]);
  v_area text;
  v_tables text[];
  v_table text;
  v_row_count bigint;
  v_area_rows jsonb := '[]'::jsonb;
  v_count bigint := 0;
  v_grand bigint := 0;
  v_out jsonb;
  v_seen text[] := '{}'::text[];
begin
  if array_length(v_mapped, 1) is null then
    select array_agg(key) into v_mapped from jsonb_object_keys(v_map) as key;
  end if;
  foreach v_area in array v_mapped loop
    if not v_map ? v_area then
      continue;
    end if;
    v_tables := public.platform_reset_expand_tables(public.platform_reset_tables_for(array[v_area]));
    v_area_rows := '[]'::jsonb;
    v_count := 0;
    foreach v_table in array v_tables loop
      if v_table = any(v_seen) then
        continue;
      end if;
      v_seen := array_append(v_seen, v_table);
      execute format('select count(*) from public.%I', v_table) into v_row_count;
      v_count := v_count + coalesce(v_row_count, 0);
      v_area_rows := v_area_rows || jsonb_build_object(
        'table', v_table,
        'count', coalesce(v_row_count, 0)
      );
    end loop;
    v_grand := v_grand + v_count;
    v_out := coalesce(v_out, '{}'::jsonb) || jsonb_build_object(
      v_area, jsonb_build_object('tables', v_area_rows, 'count', v_count)
    );
  end loop;
  return jsonb_build_object('areas', coalesce(v_out, '{}'::jsonb), 'total', v_grand);
end; $$;

-- ------------------------------------------------------------
-- 6. AREA RESET — truncate the requested areas in one transaction.
-- ------------------------------------------------------------
create or replace function public.platform_reset_areas(p_areas text[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_base text[] := public.platform_reset_tables_for(coalesce(p_areas, array[]::text[]));
  v_ident text[] := '{}'::text[];
  v_table text;
  v_row_count bigint;
  v_total bigint := 0;
  v_actor text;
  v_stmt text := '';
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a Super Admin can reset platform data.';
  end if;
  v_ident := public.platform_reset_expand_tables(v_base);
  if array_length(v_ident, 1) is null then
    return jsonb_build_object('ok', true, 'removed', 0, 'areas', coalesce(p_areas, '{}'::text[]), 'message', 'No reset tables matched existing schemas.');
  end if;

  select full_name into v_actor from public.profiles where id = auth.uid();

  foreach v_table in array v_ident loop
    execute format('select count(*) from public.%I', v_table) into v_row_count;
    v_total := v_total + coalesce(v_row_count, 0);
  end loop;

  v_stmt := 'truncate table ' ||
    (select string_agg(format('public.%I', t), ', ' order by t) from unnest(v_ident) t) ||
    ' restart identity cascade';

  execute v_stmt;

  -- Immutable audit trail AFTER truncation (a full reset clears audit_logs,
  -- so this single row is the only remaining evidence of the wipe).
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'PLATFORM_RESET', 'Platform', coalesce(array_to_string(p_areas, ','), ''),
    coalesce(v_actor, auth.uid()::text),
    jsonb_build_object(
      'action', 'area_reset',
      'areas', coalesce(p_areas, '{}'::text[]),
      'tables', v_ident,
      'rows_removed', v_total,
      'actor_user_id', auth.uid(),
      'actor_role', public.current_role()
    )::text,
    'high'
  );

  return jsonb_build_object(
    'ok', true,
    'removed', v_total,
    'areas', coalesce(p_areas, '{}'::text[]),
    'tables', v_ident
  );
end; $$;

-- ------------------------------------------------------------
-- 7. FULL RESET — every reset area in one transaction.
-- ------------------------------------------------------------
create or replace function public.platform_reset_all()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_map jsonb := public.platform_reset_areas_map();
  v_all text[] := '{}'::text[];
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a Super Admin can reset the entire platform.';
  end if;
  select array_agg(key order by key) into v_all from jsonb_object_keys(v_map) as key;
  return public.platform_reset_areas(v_all);
end; $$;

-- ------------------------------------------------------------
-- 8. DELETE ONE RECORD — targeted "delete particular data" by
--    entity type + id. Only the listed entities are accepted.
-- ------------------------------------------------------------
create or replace function public.platform_delete_record(p_entity text, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_table text;
  v_rows int;
  v_actor text;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a Super Admin can delete records.';
  end if;
  if p_id is null then
    raise exception 'A record ID is required.';
  end if;

  v_table := case p_entity
    when 'attendance_record'          then 'attendance_records'
    when 'attendance_event'           then 'attendance_events'
    when 'attendance_exception'       then 'attendance_exceptions'
    when 'attendance_issue'           then 'attendance_issues'
    when 'leave_request'              then 'leave_requests'
    when 'onboarding_submission'      then 'employee_onboarding_submissions'
    when 'onboarding_correction'      then 'onboarding_corrections'
    when 'guarantor_verification'     then 'guarantor_verifications'
    when 'fidelity_verification'      then 'fidelity_bond_verifications'
    when 'chat_message'               then 'chat_messages'
    when 'notification'               then 'notifications'
    when 'kpi_submission'             then 'kpi_submissions'
    when 'task_report'                then 'task_progress_reports'
    when 'work_plan'                  then 'work_plans'
    when 'payroll_row'                then 'payroll'
    when 'employment_letter'          then 'employment_letters'
    when 'medical_screening'          then 'medical_screenings'
    when 'audit_log'                  then 'audit_logs'
    when 'bankone_transaction'        then 'bankone_transactions'
    when 'loan_application'           then 'loan_applications'
    when 'loan'                       then 'loans'
    when 'repayment'                  then 'repayments'
    when 'support_case'               then 'support_cases'
    when 'customer'                   then 'customers'
    else null
  end;

  if v_table is null then
    raise exception 'Unknown entity type "%". See the entity list in the reset centre.', p_entity;
  end if;
  if to_regclass(format('public.%I', v_table)) is null then
    raise exception 'Table "%" does not exist on this deployment.', v_table;
  end if;

  select full_name into v_actor from public.profiles where id = auth.uid();

  execute format('delete from public.%I where id = $1', v_table) using p_id;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'entity', p_entity, 'id', p_id, 'deleted', 0, 'message', 'No record found with that ID.');
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'PLATFORM_RECORD_DELETE', v_table, p_id::text,
    coalesce(v_actor, auth.uid()::text),
    jsonb_build_object(
      'entity', p_entity,
      'table', v_table,
      'id', p_id,
      'deleted', v_rows,
      'actor_user_id', auth.uid(),
      'actor_role', public.current_role()
    )::text,
    'high'
  );

  return jsonb_build_object('ok', true, 'entity', p_entity, 'id', p_id, 'deleted', v_rows);
end; $$;

-- ------------------------------------------------------------
-- 9. EXECUTION PERMISSIONS
--    Revoke from public/anon; grant only to authenticated.
--    The SECURITY DEFINER bodies still re-check super_admin.
-- ------------------------------------------------------------
revoke all on function public.platform_reset_areas_map() from public;
grant execute on function public.platform_reset_areas_map() to authenticated;

revoke all on function public.platform_reset_tables_for(text[]) from public;
grant execute on function public.platform_reset_tables_for(text[]) to authenticated;

revoke all on function public.platform_reset_expand_tables(text[]) from public;
grant execute on function public.platform_reset_expand_tables(text[]) to authenticated;

revoke all on function public.platform_reset_guard() from public;
grant execute on function public.platform_reset_guard() to authenticated;

revoke all on function public.platform_reset_counts(text[]) from public;
grant execute on function public.platform_reset_counts(text[]) to authenticated;

revoke all on function public.platform_reset_areas(text[]) from public;
grant execute on function public.platform_reset_areas(text[]) to authenticated;

revoke all on function public.platform_reset_all() from public;
grant execute on function public.platform_reset_all() to authenticated;

revoke all on function public.platform_delete_record(text, uuid) from public;
grant execute on function public.platform_delete_record(text, uuid) to authenticated;

-- ============================================================
-- END PHASE 44
-- ============================================================