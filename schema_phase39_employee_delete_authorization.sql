-- ============================================================
-- schema_phase39_employee_delete_authorization.sql
-- ------------------------------------------------------------
-- PURPOSE
--   Wire the employee "Delete" action end-to-end in a way that MATCHES
--   InfinityCore's existing personnel-lifecycle authorization model
--   (see schema_phase37_employee_termination_authorization.sql).

--   "Delete" is a DECOMMISSIONING action, not a physical removal:
--     * The repo intentionally has NO physical employee delete:
--       employees has cascade children (guarantors, fidelity bonds,
--       education, work_history, attendance, payroll linkage) and a
--       hard-delete guard trigger (employees_hard_delete_guard) that
--       rejects every non-service-role DELETE. "Delete" therefore maps
--       to the canonical ARCHIVE lifecycle (soft, audited, history-
--       preserving), exactly as the app's Archive/Terminate actions do.
--
--   On top of archiving, Delete COMPLETES the offboarding so the person
--   is gone from payroll and from the platform:
--       1. Cancels the employee's open payroll rows (draft/pending/
--          approved/processed) — they will never be paid again.
--       2. Moves the employee to 'terminated' so they drop out of the
--          active roster and the payroll master (list_payroll_master
--          only returns active/probation/on_leave employees). Past
--          'paid' rows are preserved for reconciliation history.
--       3. Deactivates the linked platform login (profiles.status ->
--          'suspended' + rejected_reason, mirrored in
--          user_approval_audit) so the person can no longer use
--          InfinityCore. History, attendance, and payroll records stay
--          intact and reversible by an admin (activate/restore).

--   Who may delete:
--     super_admin, hr_manager            (only — matches phase37 exactly)
--   Everything else is rejected server-side by the RPC AND by RLS.

--   Protected server-side (and hidden in the UI):
--     * An employee whose linked login is a super_admin account can
--       NEVER be deleted.
--     * A user can never delete their own employee record.

--   Audit: every delete writes ONE row to public.audit_logs using the
--   canonical phase6 shape (action, entity_type, entity_id, user_name,
--   details, severity) plus a user_approval_audit row when a platform
--   login is deactivated. The actor is stored as user_name (audit_logs
--   has NO user_id column — do not invent one).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Current-role helper already exists (phase37, public.current_role).
--    Verify before relying on it.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc where proname = 'current_role' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'phase37 prerequisite missing: public.current_role() must exist before phase39. Run schema_phase37_employee_termination_authorization.sql first.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. delete_employee SECURITY DEFINER RPC
--    Actor role re-verified server-side; NEVER trusts a client role.
--    Decommissions the employee end-to-end:
--      archive (history-preserving) + cancel open payroll +
--      drop from active roster + deactivate the linked platform login.
-- ------------------------------------------------------------
create or replace function public.delete_employee(
  p_employee_id uuid,
  p_reason text default ''
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_emp record;
  v_target_role text;
  v_prev_status text;
  v_payroll_cancelled int := 0;
  v_platform_deactivated boolean := false;
begin
  if v_actor_id is null then
    raise exception 'Not authenticated';
  end if;

  if v_actor_role not in ('super_admin', 'hr_manager') then
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'employee_delete_denied', 'Employee', p_employee_id::text,
      coalesce((select full_name from public.profiles where id = v_actor_id), 'user'),
      format('Delete attempt blocked: role %s is not authorized to delete employees.', v_actor_role),
      'high'
    );
    raise exception 'Your role is not authorized to delete employees.';
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    raise exception 'Employee not found.';
  end if;
  if coalesce(v_emp.is_archived, false) then
    raise exception 'Employee is already deleted (archived).';
  end if;

  -- Self-delete guard: an HR manager/super_admin must never be able to
  -- decommission their own employee record (self-lockout).
  if v_emp.user_id is not null and v_emp.user_id = v_actor_id then
    raise exception 'You cannot delete your own employee record.';
  end if;

  -- Super Admin protection: an employee whose linked login is a
  -- super_admin account can NEVER be deleted (server-enforced).
  if v_emp.user_id is not null then
    select role into v_target_role from public.profiles where id = v_emp.user_id;
    if v_target_role = 'super_admin' then
      insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
      values (
        'employee_delete_superadmin_blocked', 'Employee', v_emp.id::text,
        coalesce((select full_name from public.profiles where id = v_actor_id), 'user'),
        format('Delete of %s blocked: the linked account is a Super Admin and is protected.', v_emp.full_name),
        'high'
      );
      raise exception 'Super Admin accounts are protected and cannot be deleted.';
    end if;
  end if;

  select full_name into v_actor_name from public.profiles where id = v_actor_id;

  -- 1. REMOVE FROM PAYROLL — cancel any not-yet-paid rows. 'paid' rows
  --    stay for reconciliation history.
  if to_regclass('public.payroll') is not null then
    update public.payroll set
      status = 'cancelled',
      updated_at = now()
    where employee_id = v_emp.id
      and status in ('draft', 'pending', 'approved', 'processed');
    get diagnostics v_payroll_cancelled = row_count;
  end if;

  -- 2. History transition + drop from the active roster / payroll master.
  insert into public.employee_employment_history (
    employee_id, previous_status, new_status, changed_by, actor_role, reason, source
  ) values (
    v_emp.id, v_emp.employment_status, 'terminated', v_actor_id, v_actor_role,
    coalesce(nullif(p_reason, ''), 'Deleted via employee action menu'), 'delete'
  );

  update public.employees set
    employment_status = 'terminated',
    previous_employment_status = v_emp.employment_status,
    terminated_at = now(),
    termination_effective_date = current_date,
    termination_reason = coalesce(nullif(p_reason, ''), 'Deleted via employee action menu'),
    termination_hr_notes = null,
    is_archived = true,
    archived_at = now(),
    archive_reason = coalesce(nullif(p_reason, ''), 'Deleted via employee action menu'),
    archive_actor = v_actor_id,
    updated_at = now()
  where id = v_emp.id;

  -- 3. REMOVE FROM THE PLATFORM — deactivate the linked login so the
  --    person can no longer access InfinityCore. Reversible by an admin
  --    (activate_user / restore). Skipped when no login is linked.
  if v_emp.user_id is not null then
    select status into v_prev_status from public.profiles where id = v_emp.user_id;
    if v_prev_status is not null and v_prev_status <> 'suspended' then
      update public.profiles set
        status = 'suspended',
        rejected_reason = format('Employee deleted from the platform (%s)', coalesce(nullif(p_reason, ''), 'no reason'))
      where id = v_emp.user_id;
      v_platform_deactivated := true;

      if to_regclass('public.user_approval_audit') is not null then
        insert into public.user_approval_audit (
          user_id, action, previous_status, new_status,
          approver_id, approver_name, reason
        ) values (
          v_emp.user_id, 'USER_SUSPENDED', v_prev_status, 'suspended',
          v_actor_id, v_actor_name,
          format('Employee deleted from the platform (%s)', coalesce(nullif(p_reason, ''), 'no reason'))
        );
      end if;
    end if;
  end if;

  -- 4. Immutable audit record. Actor selection is handled here, never by
  --    the caller, so the actor role is always trustworthy.
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'employee_deleted', 'Employee', v_emp.id::text, v_actor_name,
    jsonb_build_object(
      'actor_user_id', v_actor_id,
      'actor_role', v_actor_role,
      'actor_name', v_actor_name,
      'employee_id', v_emp.id,
      'employee_name', v_emp.full_name,
      'previous_employment_status', v_emp.employment_status,
      'new_employment_status', 'terminated',
      'is_archived', true,
      'payroll_rows_cancelled', v_payroll_cancelled,
      'platform_access_deactivated', v_platform_deactivated,
      'reason', coalesce(nullif(p_reason, ''), 'not provided'),
      'source', 'ui'
    )::text,
    'high'
  );

  return jsonb_build_object(
    'ok', true,
    'employee_id', v_emp.id,
    'employee_name', v_emp.full_name,
    'deleted', true,
    'archived', true,
    'last_employment_status', v_emp.employment_status,
    'payroll_rows_cancelled', v_payroll_cancelled,
    'platform_access_deactivated', v_platform_deactivated,
    'actor_role', v_actor_role
  );
end; $$;

grant execute on function public.delete_employee(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3. RLS: DELETE disabled at row level — physical deletion is a
--    hard-delete-guard violation. The RPC is the only deletion path;
--    its SECURITY DEFINER body re-verified roles. Explicitly revoke
--    table-level DELETE from authenticated so no client can bypass via
--    supabase .delete() on employees.
-- ------------------------------------------------------------
revoke delete on public.employees from anon;
revoke delete on public.employees from authenticated;
revoke delete on public.employees from service_role;