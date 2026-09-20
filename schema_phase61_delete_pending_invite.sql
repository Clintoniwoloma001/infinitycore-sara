-- ============================================================
-- PHASE 61: DELETE PENDING INVITE
--
-- Full retract of a pending/invited account so HR can start over:
--   * Deletes the Supabase Auth user + identity (the invite token owner).
--   * Deletes the linked public profile row.
--   * Removes access rows, notifications, and the employee<>account link.
--   * Revokes open invitation history records (audit trail preserved).
--
-- The Employee record is NEVER deleted or modified beyond clearing the
-- account link — the person stays in the Employees module and becomes
-- immediately re-invitable via "Create Users from Employees".
--
-- Super Admin only (the strongest admin-action gate in the app).
-- Only pending / status-less accounts can be deleted; active, inactive,
-- suspended, and rejected accounts are hard-rejected.
--
-- Idempotent: safe to re-run in the Supabase SQL Editor.
-- ============================================================

create or replace function public.delete_pending_invite(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_profile   public.profiles;
  v_email     text;
begin
  if v_actor_role <> 'super_admin' then
    raise exception 'Only super_admin can delete an invitation';
  end if;

  if p_user_id is null then
    raise exception 'User is required';
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  -- Lock the profile row so two admins cannot race on the same invite.
  select * into v_profile
  from public.profiles
  where id = p_user_id
  for update;

  if v_profile.id is null then
    raise exception 'User profile not found. The account may already have been deleted.';
  end if;

  if v_profile.status is not null and v_profile.status <> 'pending' then
    raise exception
      'Only pending invitations can be deleted (current status: %)',
      v_profile.status;
  end if;

  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then
    raise exception 'Auth account not found for this profile';
  end if;

  -- 1. Revoke any open invitation history for this employee/account so no
  --    live link remains while the audit trail is preserved.
  update public.employee_account_invites
  set status = 'revoked', revoked_at = now()
  where employee_id = v_profile.employee_id
     or auth_user_id = p_user_id;

  -- 2. Unlink the employee record (the Employee row itself is untouched).
  update public.employees
  set user_id = null, updated_at = now()
  where user_id = p_user_id;

  -- 3. Drop access rows and any notifications before the auth deletion.
  delete from public.user_access_profiles where user_id = p_user_id;
  delete from public.notifications where user_id = p_user_id;

  -- 4. Delete the profile explicitly (the auth.users delete would cascade it
  --    too, but deleting first surfaces any failure clearly).
  delete from public.profiles where id = p_user_id;

  -- 5. Delete the Supabase Auth identity + user record.
  if to_regclass('auth.identities') is not null then
    delete from auth.identities where user_id = p_user_id;
  end if;
  delete from auth.users where id = p_user_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'USER_INVITE_DELETED', 'User', p_user_id::text,
    coalesce(v_actor_name, auth.uid()::text),
    format(
      'Deleted pending invitation for %s (%s). Employee record %s on file for re-invitation.',
      coalesce(v_profile.full_name, 'unknown'),
      v_email,
      case when v_profile.employee_id is not null
           then format(' remains (id=%)', v_profile.employee_id)
           else 'was not linked' end
    ),
    'warning'
  );

  return jsonb_build_object(
    'ok', true,
    'deleted_user_id', p_user_id,
    'email', v_email,
    'employee_id', v_profile.employee_id
  );
end;
$$;

grant execute on function public.delete_pending_invite(uuid) to authenticated;