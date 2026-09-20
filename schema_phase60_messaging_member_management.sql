-- ============================================================
-- schema_phase60_messaging_member_management.sql
-- ------------------------------------------------------------
-- PURPOSE
--   Member management + automatic employee channel provisioning
--   on top of the Phase 40 corporate communication platform.
--
--   * message_invites      — shareable join links for channels/groups
--     (token stored as SHA-256 hash only; raw token returned once).
--     RPCs: create_message_invite / revoke_message_invite /
--           get_message_invite_context / join_via_message_invite /
--           list_message_invites
--
--   * sync_auto_channel_members (REWRITTEN) — now RE-CONCILES
--     membership for auto channels: inserts everyone who qualifies
--     AND removes stale AUTO memberships (auto_added = true) that no
--     longer qualify. Manual memberships (auto_added = false) and the
--     owner row are never removed.
--
--   * employee -> org-channel provisioning
--     - reconcile_auto_channel_membership_for_employee(employee_id)
--       adds/removes that employee's AUTO memberships across all
--       active auto channels based on branch/area/department/role.
--     - backfill_auto_channel_memberships()  re-syncs every auto channel.
--     - AFTER trigger on employees (user_id/branch/department/position/
--       employment_status/designation/is_archived) -> reconcile.
--     - AFTER trigger on profiles (role/status/user_type) -> reconcile.
--     - handle_new_user (REWRITTEN) links a new auth user to an employee
--       when EXACTLY ONE employee matches by email (ambiguous or none =>
--       no link), mirrors dept/branch onto the pending profile, and
--       provisions auto channel membership at signup.
--
--   * member-management authorization (REWRITTEN RPCs) — super admin /
--     admin / HR (is_communication_admin) may add/remove/change roles /
--     suspend even when they are not themselves a channel/group member,
--     while owner-protection rules are preserved for everyone.
--
--   * Department matching fix — employee.department free text (e.g.
--     'CREDIT & MARKETING') now matches departments.code
--     ('CREDIT_AND_MARKETING') via normalized comparison against the
--     departments master, instead of a naive equals.
--
--   ALL ADDITIVE / IDEMPOTENT / CREATE OR REPLACE. Safe to re-run.
--   Run in Supabase SQL Editor AFTER all prior phase files (Phase 59).
-- ============================================================

-- ------------------------------------------------------------
-- 1. HELPER — normalized label comparer for org matching
-- ------------------------------------------------------------
create or replace function public.normalized_org_label(p_value text)
returns text
language sql immutable set search_path = public as $$
  select regexp_replace(upper(btrim(coalesce(p_value, ''))), '[^A-Z0-9]', '', 'g');
$$;
grant execute on function public.normalized_org_label(text) to authenticated;

-- ------------------------------------------------------------
-- 2. HELPER — does an employee belong to a department channel?
--    Matches employees.department (free text) against
--    departments.code `p_dept_code` (name or code, normalized).
-- ------------------------------------------------------------
create or replace function public.employee_matches_department_channel(p_employee_id uuid, p_dept_code text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_dept text;
begin
  if p_employee_id is null or p_dept_code is null then
    return false;
  end if;
  select coalesce(nullif(btrim(e.department), ''), '') into v_dept
  from public.employees e where e.id = p_employee_id;
  if v_dept = '' then
    return false;
  end if;
  return public.normalized_org_label(v_dept) = public.normalized_org_label(p_dept_code)
      or exists (
        select 1 from public.departments d
        where d.code = p_dept_code
          and (
            public.normalized_org_label(v_dept) = public.normalized_org_label(d.name)
            or public.normalized_org_label(v_dept) = public.normalized_org_label(d.code)
          )
      );
end; $$;
grant execute on function public.employee_matches_department_channel(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3. INVITATIONS
-- ------------------------------------------------------------
create table if not exists public.message_invites (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('channel', 'group')),
  context_id uuid not null,
  token_hash text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  max_uses int check (max_uses is null or max_uses > 0),
  used_count int not null default 0,
  status text not null default 'active' check (status in ('active', 'revoked'))
);
alter table public.message_invites enable row level security;

create index if not exists idx_message_invites_context on public.message_invites(scope, context_id);
create index if not exists idx_message_invites_status on public.message_invites(status);

drop policy if exists "msg_invites read_owner_admin" on public.message_invites;
create policy "msg_invites read_owner_admin" on public.message_invites
  for select using (created_by = auth.uid() or public.is_communication_admin());

-- Can the current user manage membership (and invites) for a conversation?
create or replace function public.can_manage_conversation_members(p_scope text, p_context_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text;
begin
  if public.is_communication_admin() then return true; end if;
  if p_scope = 'channel' then
    v_role := public.channel_member_role(p_context_id);
  elsif p_scope = 'group' then
    v_role := public.group_member_role(p_context_id);
  else
    return false;
  end if;
  return v_role in ('owner', 'admin');
end; $$;
grant execute on function public.can_manage_conversation_members(text, uuid) to authenticated;

-- Generate a fresh invite link. Only the raw token is returned once; the
-- database stores the SHA-256 hash, so a leaked table dump leaks nothing.
create or replace function public.create_message_invite(
  p_scope text,
  p_context_id uuid,
  p_expires_at timestamptz default null,
  p_max_uses int default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_invite_id uuid;
  v_token text;
  v_context_name text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_scope not in ('channel', 'group') then raise exception 'Invalid scope'; end if;
  if not public.can_manage_conversation_members(p_scope, p_context_id) then
    raise exception 'Only the owner, an admin, or a communication administrator can create invite links';
  end if;
  if p_max_uses is not null and p_max_uses < 1 then raise exception 'max_uses must be positive'; end if;

  if p_scope = 'channel' then
    select display_name into v_context_name from public.message_channels where id = p_context_id;
    if v_context_name is null then raise exception 'Channel not found'; end if;
  else
    select name into v_context_name from public.message_groups where id = p_context_id;
    if v_context_name is null then raise exception 'Group not found'; end if;
  end if;

  -- 18 random bytes -> 24 URL-safe characters, encoded once
  v_token := translate(encode(gen_random_bytes(18), 'base64'), '+/=', 'ab_');

  insert into public.message_invites (scope, context_id, token_hash, created_by, expires_at, max_uses)
  values (p_scope, p_context_id, encode(digest(v_token, 'sha256'), 'hex'), v_me, p_expires_at, p_max_uses)
  returning id into v_invite_id;

  perform public.write_communication_audit(
    'invite', v_invite_id, 'invite_created', null, null,
    jsonb_build_object('scope', p_scope, 'context_id', p_context_id,
                       'context_name', v_context_name, 'expires_at', p_expires_at, 'max_uses', p_max_uses),
    'invite link created'
  );

  return jsonb_build_object(
    'ok', true, 'id', v_invite_id, 'token', v_token,
    'scope', p_scope, 'context_id', p_context_id, 'context_name', v_context_name,
    'expires_at', p_expires_at, 'max_uses', p_max_uses
  );
end; $$;
grant execute on function public.create_message_invite(text, uuid, timestamptz, int) to authenticated;

create or replace function public.revoke_message_invite(p_invite_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_invite record;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  select * into v_invite from public.message_invites where id = p_invite_id;
  if v_invite.id is null then raise exception 'Invite not found'; end if;
  if v_invite.created_by <> v_me and not public.is_communication_admin() then
    raise exception 'Only the creator or a communication administrator can revoke an invite';
  end if;

  update public.message_invites set status = 'revoked' where id = p_invite_id;

  perform public.write_communication_audit(
    'invite', p_invite_id, 'invite_revoked', null, null,
    jsonb_build_object('scope', v_invite.scope, 'context_id', v_invite.context_id), 'invite link revoked'
  );
  return jsonb_build_object('ok', true, 'id', p_invite_id);
end; $$;
grant execute on function public.revoke_message_invite(uuid) to authenticated;

-- Resolve an invite token into the conversation it opens (public preview).
create or replace function public.get_message_invite_context(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_invite record;
  v_context_name text;
  v_member_count int;
  v_is_member boolean;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if btrim(coalesce(p_token, '')) = '' then raise exception 'Missing invite token'; end if;

  select * into v_invite from public.message_invites
  where token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex');
  if v_invite.id is null or v_invite.status <> 'active'
     or (v_invite.expires_at is not null and v_invite.expires_at <= now())
     or (v_invite.max_uses is not null and v_invite.used_count >= v_invite.max_uses) then
    raise exception 'This invite link has expired or been revoked';
  end if;

  if v_invite.scope = 'channel' then
    select display_name into v_context_name from public.message_channels where id = v_invite.context_id;
    select count(*) into v_member_count from public.message_channel_members where channel_id = v_invite.context_id;
    select exists (select 1 from public.message_channel_members where channel_id = v_invite.context_id and member_id = v_me) into v_is_member;
  else
    select name into v_context_name from public.message_groups where id = v_invite.context_id;
    select count(*) into v_member_count from public.message_group_members where group_id = v_invite.context_id;
    select exists (select 1 from public.message_group_members where group_id = v_invite.context_id and member_id = v_me) into v_is_member;
  end if;

  if v_context_name is null then raise exception 'This invite no longer points to a valid conversation'; end if;

  return jsonb_build_object(
    'ok', true, 'scope', v_invite.scope, 'context_id', v_invite.context_id,
    'context_name', v_context_name, 'member_count', v_member_count,
    'already_member', coalesce(v_is_member, false),
    'expires_at', v_invite.expires_at
  );
end; $$;
grant execute on function public.get_message_invite_context(text) to authenticated;

-- Accept an invite link: joins the caller as a plain member.
create or replace function public.join_via_message_invite(p_token text, p_role text default 'member')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_invite record;
  v_already boolean := false;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_role not in ('member') then raise exception 'Only member role can be granted via an invite link'; end if;
  if btrim(coalesce(p_token, '')) = '' then raise exception 'Missing invite token'; end if;

  select * into v_invite from public.message_invites
  where token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex');
  if v_invite.id is null or v_invite.status <> 'active'
     or (v_invite.expires_at is not null and v_invite.expires_at <= now())
     or (v_invite.max_uses is not null and v_invite.used_count >= v_invite.max_uses) then
    raise exception 'This invite link has expired or been revoked';
  end if;

  if v_invite.scope = 'channel' then
    insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
    values (v_invite.context_id, v_me, p_role, coalesce(v_invite.created_by, v_me), false)
    on conflict (channel_id, member_id) do nothing;
    if exists (select 1 from public.message_channel_members where channel_id = v_invite.context_id and member_id = v_me) then
      v_already := true;
    end if;
  else
    insert into public.message_group_members (group_id, member_id, role, added_by)
    values (v_invite.context_id, v_me, p_role, coalesce(v_invite.created_by, v_me))
    on conflict (group_id, member_id) do nothing;
    if exists (select 1 from public.message_group_members where group_id = v_invite.context_id and member_id = v_me) then
      v_already := true;
    end if;
  end if;

  update public.message_invites set used_count = used_count + 1 where id = v_invite.id;

  perform public.write_communication_audit(
    'invite', v_invite.id, 'invite_accepted', null, null,
    jsonb_build_object('scope', v_invite.scope, 'context_id', v_invite.context_id, 'member_id', v_me), 'invite link accepted'
  );

  return jsonb_build_object('ok', true, 'scope', v_invite.scope, 'context_id', v_invite.context_id, 'already_member', v_already);
end; $$;
grant execute on function public.join_via_message_invite(text, text) to authenticated;

-- List invites for a conversation (management view, no raw tokens).
create or replace function public.list_message_invites(p_scope text, p_context_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_result jsonb;
begin
  if v_me is null then return '[]'::jsonb; end if;
  if not public.can_manage_conversation_members(p_scope, p_context_id) then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'scope', i.scope, 'context_id', i.context_id,
    'created_by', i.created_by, 'created_at', i.created_at,
    'expires_at', i.expires_at, 'max_uses', i.max_uses,
    'used_count', i.used_count, 'status', i.status
  ) order by i.created_at desc), '[]'::jsonb) into v_result
  from public.message_invites i
  where i.scope = p_scope and i.context_id = p_context_id;

  return v_result;
end; $$;
grant execute on function public.list_message_invites(text, uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. AUTO CHANNEL MEMBERSHIP — REWRITTEN SYNC (add + remove stale)
-- ------------------------------------------------------------
create or replace function public.sync_auto_channel_members(p_channel_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_channel record;
  v_qualifying uuid[] := '{}';
  v_added int := 0;
  v_removed int := 0;
  v_total int := 0;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  select * into v_channel from public.message_channels where id = p_channel_id;
  if v_channel.id is null then raise exception 'Channel not found'; end if;
  if not v_channel.is_auto then raise exception 'Channel is not an auto channel'; end if;

  -- Recompute the set of user ids that currently qualify for this channel.
  if v_channel.auto_source = 'branch' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    where e.branch_id = v_channel.auto_source_id
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'area' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    join public.branch_area_assignments ba
      on ba.branch_id = e.branch_id and ba.is_current
    where ba.area_id = v_channel.auto_source_id
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'department' then
    select coalesce(array_agg(e.user_id), '{}') into v_qualifying
    from public.employees e
    where public.employee_matches_department_channel(e.id, v_channel.auto_source_role)
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
      and coalesce(e.is_archived, false) = false;

  elsif v_channel.auto_source = 'role' then
    if v_channel.auto_source_role = 'all' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.status = 'active' and p.role <> 'customer';
    elsif v_channel.auto_source_role = 'management' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('super_admin', 'admin', 'head_of_business', 'operations_manager', 'branch_manager', 'area_manager')
        and p.status = 'active';
    elsif v_channel.auto_source_role = 'executive' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('super_admin', 'admin', 'head_of_business')
        and p.status = 'active';
    elsif v_channel.auto_source_role = 'hr' then
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role in ('hr_manager', 'hr_officer', 'super_admin', 'admin')
        and p.status = 'active';
    else
      select coalesce(array_agg(p.id), '{}') into v_qualifying
      from public.profiles p
      where p.role = v_channel.auto_source_role and p.status = 'active';
    end if;
  end if;

  -- Insert everyone who qualifies (as automatic members).
  insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
  select p_channel_id, q.uid, 'member', coalesce(v_me, v_channel.creator_id), true
  from unnest(v_qualifying) as q(uid)
  where not exists (
    select 1 from public.message_channel_members cm
    where cm.channel_id = p_channel_id and cm.member_id = q.uid
  );
  get diagnostics v_added = row_count;

  -- Remove memberships that no longer qualify — ONLY automatic ones
  -- (auto_added = true). Manual memberships and the owner row survive.
  delete from public.message_channel_members cm
  where cm.channel_id = p_channel_id
    and cm.auto_added = true
    and cm.member_id <> all(v_qualifying);
  get diagnostics v_removed = row_count;

  select count(*) into v_total
  from public.message_channel_members where channel_id = p_channel_id;

  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_members_synced', null,
    null, jsonb_build_object('member_count', v_total, 'added', v_added, 'removed', v_removed),
    'auto membership sync'
  );

  return jsonb_build_object(
    'ok', true, 'channel_id', p_channel_id,
    'member_count', v_total, 'added', v_added, 'removed', v_removed
  );
end; $$;
grant execute on function public.sync_auto_channel_members(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. PER-EMPLOYEE PROVISIONING + TRIGGERS
-- ------------------------------------------------------------
create or replace function public.reconcile_auto_channel_membership_for_employee(p_employee_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_e record;
  v_eligible boolean;
  v_added int := 0;
  v_removed int := 0;
  v_matches boolean;
  v_role_matches boolean;
  v_chan record;
  v_p record;
begin
  if auth.uid() is not null
     and not public.is_communication_admin()
     and not exists (select 1 from public.employees where id = p_employee_id and user_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  select * into v_e from public.employees where id = p_employee_id;
  if v_e.id is null then return jsonb_build_object('ok', true, 'skipped', 'not_found'); end if;
  if v_e.user_id is null then return jsonb_build_object('ok', true, 'skipped', 'not_linked'); end if;

  v_eligible := v_e.employment_status in ('active', 'on_leave') and coalesce(v_e.is_archived, false) = false;

  select role, status into v_p from public.profiles where id = v_e.user_id;
  if v_p.role is null then v_p.role := 'customer'; v_p.status := coalesce(v_p.status, 'pending'); end if;

  for v_chan in
    select * from public.message_channels
    where is_auto and status = 'active'
  loop
    v_matches := false;
    if v_chan.auto_source = 'branch' then
      v_matches := v_e.branch_id is not null and v_e.branch_id = v_chan.auto_source_id;
    elsif v_chan.auto_source = 'area' then
      v_matches := v_e.branch_id is not null and exists (
        select 1 from public.branch_area_assignments ba
        where ba.branch_id = v_e.branch_id and ba.area_id = v_chan.auto_source_id and ba.is_current
      );
    elsif v_chan.auto_source = 'department' then
      v_matches := public.employee_matches_department_channel(v_e.id, v_chan.auto_source_role);
    elsif v_chan.auto_source = 'role' then
      v_role_matches := false;
      if v_chan.auto_source_role = 'all' then
        v_role_matches := v_p.role <> 'customer' and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'management' then
        v_role_matches := v_p.role in ('super_admin', 'admin', 'head_of_business', 'operations_manager', 'branch_manager', 'area_manager') and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'executive' then
        v_role_matches := v_p.role in ('super_admin', 'admin', 'head_of_business') and v_p.status = 'active';
      elsif v_chan.auto_source_role = 'hr' then
        v_role_matches := v_p.role in ('hr_manager', 'hr_officer', 'super_admin', 'admin') and v_p.status = 'active';
      else
        v_role_matches := v_p.role = v_chan.auto_source_role and v_p.status = 'active';
      end if;
      v_matches := v_role_matches;
    end if;

    if v_matches and v_eligible then
      if not exists (
        select 1 from public.message_channel_members
        where channel_id = v_chan.id and member_id = v_e.user_id
      ) then
        insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
        values (v_chan.id, v_e.user_id, 'member', v_chan.creator_id, true)
        on conflict (channel_id, member_id) do nothing;
        v_added := v_added + 1;
      end if;
    else
      delete from public.message_channel_members
      where channel_id = v_chan.id and member_id = v_e.user_id and auto_added = true;
      if found then v_removed := v_removed + 1; end if;
    end if;
  end loop;

  perform public.write_communication_audit(
    'channel', null, 'employee_auto_membership_reconciled', null, null,
    jsonb_build_object('employee_id', p_employee_id, 'user_id', v_e.user_id, 'added', v_added, 'removed', v_removed),
    'employee org provisioning'
  );

  return jsonb_build_object('ok', true, 'employee_id', p_employee_id, 'added', v_added, 'removed', v_removed);
end; $$;
grant execute on function public.reconcile_auto_channel_membership_for_employee(uuid) to authenticated;

create or replace function public.backfill_auto_channel_memberships()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_result jsonb;
  v_total_added int := 0;
  v_total_removed int := 0;
  v_synced int := 0;
  v_r record;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not public.is_communication_admin() then raise exception 'Not authorized'; end if;

  for v_r in select id from public.message_channels where is_auto and status = 'active' loop
    select public.sync_auto_channel_members(v_r.id) into v_result;
    v_total_added := v_total_added + coalesce((v_result->>'added')::int, 0);
    v_total_removed := v_total_removed + coalesce((v_result->>'removed')::int, 0);
    v_synced := v_synced + 1;
  end loop;

  perform public.write_communication_audit(
    'channel', null, 'auto_channel_memberships_backfilled', null, null,
    jsonb_build_object('synced', v_synced, 'added', v_total_added, 'removed', v_total_removed), 'auto channel backfill'
  );

  return jsonb_build_object('ok', true, 'synced', v_synced, 'added', v_total_added, 'removed', v_total_removed);
end; $$;
grant execute on function public.backfill_auto_channel_memberships() to authenticated;

-- Employee lifecycle -> auto channel membership.
create or replace function public.trg_employee_auto_channel_sync()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.reconcile_auto_channel_membership_for_employee(new.id);
  return new;
end; $$;

drop trigger if exists trg_employee_auto_channel_sync on public.employees;
create trigger trg_employee_auto_channel_sync
  after insert or update of user_id, branch_id, branch, department, "position", employment_status, designation_id, is_archived on public.employees
  for each row execute function public.trg_employee_auto_channel_sync();

-- Profile role / status changes (approvals, suspensions, role grants) ->
-- re-provision role-based auto channels for the linked employee.
create or replace function public.trg_profile_auto_channel_sync()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_eid uuid;
begin
  select e.id into v_eid
  from public.employees e
  where e.user_id = new.id
  order by e.created_at desc
  limit 1;
  if v_eid is not null then
    perform public.reconcile_auto_channel_membership_for_employee(v_eid);
  end if;
  return new;
end; $$;

drop trigger if exists trg_profile_auto_channel_sync on public.profiles;
create trigger trg_profile_auto_channel_sync
  after insert or update of role, status, user_type on public.profiles
  for each row execute function public.trg_profile_auto_channel_sync();

-- ------------------------------------------------------------
-- 6. SIGNUP LINKING (REWRITTEN handle_new_user)
--    Preserves the Phase 10 behaviour (pending profile) and adds
--    employee linking + auto channel provisioning at signup.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_eid uuid;
  v_count int;
begin
  insert into public.profiles (id, email, full_name, role, status)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''), 'customer', 'pending')
  on conflict (id) do nothing;

  -- Link the new account to an employee only when EXACTLY one employee
  -- matches (same email and not already linked to a different account).
  -- No match or an ambiguous match leaves the profile unlinked.
  select count(*) into v_count
  from public.employees e
  where (e.user_id = new.id)
     or (e.user_id is null and lower(btrim(coalesce(e.email, ''))) = lower(btrim(coalesce(new.email, ''))));

  if v_count = 1 then
    select e.id into v_eid
    from public.employees e
    where (e.user_id = new.id)
       or (e.user_id is null and lower(btrim(coalesce(e.email, ''))) = lower(btrim(coalesce(new.email, ''))))
    limit 1;

    if v_eid is not null then
      update public.employees
      set user_id = coalesce(user_id, new.id)
      where id = v_eid and (user_id is null or user_id = new.id);

      update public.profiles p
      set department = coalesce(p.department, (select e.department from public.employees e where e.id = v_eid)),
          branch = coalesce(p.branch, (select e.branch from public.employees e where e.id = v_eid))
      where p.id = new.id;

      -- auto provision this employee's org-channel memberships
      perform public.reconcile_auto_channel_membership_for_employee(v_eid);
    end if;
  end if;

  return new;
exception when others then
  -- never break signup because of linking / provisioning issues
  null;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 7. MEMBER-MANAGEMENT AUTHORIZATION OVERRIDES
--    is_communication_admin() may manage members even when they are
--    not themselves members of the conversation. Owner protections are
--    preserved for everyone (no removing / role-changing / suspending
--    another owner).
-- ------------------------------------------------------------
create or replace function public.add_channel_member(p_channel_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this channel'; end if;
  if v_role not in ('owner', 'admin', 'moderator') and not public.is_communication_admin() then raise exception 'Not authorized to add members'; end if;

  insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
  values (p_channel_id, p_member_id, 'member', v_me, false)
  on conflict (channel_id, member_id) do nothing;

  insert into public.notifications (user_id, title, message, type, link)
  values (p_member_id, 'You were added to a channel',
          (select display_name from public.message_channels where id = p_channel_id), 'chat', '/chat');

  perform public.write_communication_audit('channel', p_channel_id, 'channel_member_added', null, null, jsonb_build_object('member_id', p_member_id), 'member added');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.add_channel_member(uuid, uuid) to authenticated;

create or replace function public.remove_channel_member(p_channel_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this channel'; end if;

  if p_member_id = v_me then
    delete from public.message_channel_members where channel_id = p_channel_id and member_id = v_me;
    perform public.write_communication_audit('channel', p_channel_id, 'channel_member_left', null, null, jsonb_build_object('member_id', v_me), 'member left');
    return jsonb_build_object('ok', true);
  end if;

  if v_role not in ('owner', 'admin') and not public.is_communication_admin() then raise exception 'Only the owner or an admin can remove members'; end if;
  if (select role from public.message_channel_members where channel_id = p_channel_id and member_id = p_member_id) = 'owner' then
    raise exception 'The channel owner cannot be removed';
  end if;

  delete from public.message_channel_members where channel_id = p_channel_id and member_id = p_member_id;
  perform public.write_communication_audit('channel', p_channel_id, 'channel_member_removed', null, null, jsonb_build_object('member_id', p_member_id), 'member removed');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.remove_channel_member(uuid, uuid) to authenticated;

create or replace function public.update_channel_member_role(p_channel_id uuid, p_member_id uuid, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_prev text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_role not in ('owner', 'admin', 'moderator', 'member') then raise exception 'Invalid role'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this channel'; end if;
  if v_role <> 'owner' and not public.is_communication_admin() then raise exception 'Only the channel owner can change member roles'; end if;

  select role into v_prev from public.message_channel_members where channel_id = p_channel_id and member_id = p_member_id;
  if v_prev is null then raise exception 'Member not found in channel'; end if;
  if v_prev = 'owner' then raise exception 'The channel owner role cannot be changed'; end if;

  update public.message_channel_members set role = p_role where channel_id = p_channel_id and member_id = p_member_id;
  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_member_role_changed', null,
    jsonb_build_object('member_id', p_member_id, 'role', v_prev),
    jsonb_build_object('member_id', p_member_id, 'role', p_role), 'member role changed'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.update_channel_member_role(uuid, uuid, text) to authenticated;

create or replace function public.add_group_member(p_group_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this group'; end if;
  if v_role not in ('owner', 'admin', 'moderator') and not public.is_communication_admin() then raise exception 'Not authorized to add members'; end if;

  insert into public.message_group_members (group_id, member_id, role, added_by)
  values (p_group_id, p_member_id, 'member', v_me)
  on conflict (group_id, member_id) do nothing;

  insert into public.notifications (user_id, title, message, type, link)
  values (p_member_id, 'You were added to a group',
          (select name from public.message_groups where id = p_group_id), 'chat', '/chat');

  perform public.write_communication_audit(
    'group', p_group_id, 'group_member_added', null,
    null, jsonb_build_object('member_id', p_member_id), 'member added'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.add_group_member(uuid, uuid) to authenticated;

create or replace function public.remove_group_member(p_group_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this group'; end if;

  if p_member_id = v_me then
    delete from public.message_group_members where group_id = p_group_id and member_id = v_me;
    perform public.write_communication_audit('group', p_group_id, 'group_member_left', null, null, jsonb_build_object('member_id', v_me), 'member left');
    return jsonb_build_object('ok', true);
  end if;

  if v_role not in ('owner', 'admin') and not public.is_communication_admin() then raise exception 'Only the owner or an admin can remove members'; end if;
  if (select role from public.message_group_members where group_id = p_group_id and member_id = p_member_id) = 'owner' then
    raise exception 'The group owner cannot be removed';
  end if;

  delete from public.message_group_members where group_id = p_group_id and member_id = p_member_id;
  perform public.write_communication_audit('group', p_group_id, 'group_member_removed', null, null, jsonb_build_object('member_id', p_member_id), 'member removed');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;

create or replace function public.update_group_member_role(p_group_id uuid, p_member_id uuid, p_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_prev text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_role not in ('owner', 'admin', 'moderator', 'member') then raise exception 'Invalid role'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this group'; end if;
  if v_role <> 'owner' and not public.is_communication_admin() then raise exception 'Only the group owner can change member roles'; end if;

  select role into v_prev from public.message_group_members where group_id = p_group_id and member_id = p_member_id;
  if v_prev is null then raise exception 'Member not found in group'; end if;
  if v_prev = 'owner' then raise exception 'The group owner role cannot be changed'; end if;

  update public.message_group_members set role = p_role where group_id = p_group_id and member_id = p_member_id;
  perform public.write_communication_audit(
    'group', p_group_id, 'group_member_role_changed', null,
    jsonb_build_object('member_id', p_member_id, 'role', v_prev),
    jsonb_build_object('member_id', p_member_id, 'role', p_role), 'member role changed'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.update_group_member_role(uuid, uuid, text) to authenticated;

create or replace function public.suspend_channel_member(
  p_channel_id uuid,
  p_member_id uuid,
  p_until timestamptz,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_chan_name text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_until is null or p_until <= now() then raise exception 'Suspension must end in the future'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this channel'; end if;
  if v_role not in ('owner', 'admin') and not public.is_communication_admin() then raise exception 'Only the owner or an admin can suspend members'; end if;
  if p_member_id = v_me then raise exception 'You cannot suspend yourself'; end if;
  if public.channel_member_role_for(p_member_id, p_channel_id) = 'owner' then
    raise exception 'The channel owner cannot be suspended';
  end if;

  update public.message_channel_members
  set suspended_until = p_until, suspended_by = v_me, suspended_at = now(), suspend_reason = nullif(p_reason, '')
  where channel_id = p_channel_id and member_id = p_member_id;
  if not found then raise exception 'Member not found in channel'; end if;

  select display_name into v_chan_name from public.message_channels where id = p_channel_id;
  insert into public.notifications (user_id, title, message, type, link)
  values (p_member_id, 'You were suspended from a channel',
          v_chan_name || ' · until ' || to_char(p_until, 'YYYY-MM-DD HH24:MI'), 'chat', '/chat');

  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_member_suspended', null,
    null, jsonb_build_object('member_id', p_member_id, 'suspended_until', p_until, 'reason', nullif(p_reason, '')),
    'member suspended'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.suspend_channel_member(uuid, uuid, timestamptz, text) to authenticated;

create or replace function public.unsuspend_channel_member(p_channel_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this channel'; end if;
  if v_role not in ('owner', 'admin') and not public.is_communication_admin() then raise exception 'Only the owner or an admin can end suspensions'; end if;

  update public.message_channel_members
  set suspended_until = null, suspended_by = null, suspended_at = null, suspend_reason = null
  where channel_id = p_channel_id and member_id = p_member_id;
  if not found then raise exception 'Member not found in channel'; end if;

  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_member_unsuspended', null,
    null, jsonb_build_object('member_id', p_member_id), 'member unsuspended'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.unsuspend_channel_member(uuid, uuid) to authenticated;

create or replace function public.suspend_group_member(
  p_group_id uuid,
  p_member_id uuid,
  p_until timestamptz,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_group_name text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_until is null or p_until <= now() then raise exception 'Suspension must end in the future'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this group'; end if;
  if v_role not in ('owner', 'admin') and not public.is_communication_admin() then raise exception 'Only the owner or an admin can suspend members'; end if;
  if p_member_id = v_me then raise exception 'You cannot suspend yourself'; end if;
  if public.group_member_role_for(p_member_id, p_group_id) = 'owner' then
    raise exception 'The group owner cannot be suspended';
  end if;

  update public.message_group_members
  set suspended_until = p_until, suspended_by = v_me, suspended_at = now(), suspend_reason = nullif(p_reason, '')
  where group_id = p_group_id and member_id = p_member_id;
  if not found then raise exception 'Member not found in group'; end if;

  select name into v_group_name from public.message_groups where id = p_group_id;
  insert into public.notifications (user_id, title, message, type, link)
  values (p_member_id, 'You were suspended from a group',
          v_group_name || ' · until ' || to_char(p_until, 'YYYY-MM-DD HH24:MI'), 'chat', '/chat');

  perform public.write_communication_audit(
    'group', p_group_id, 'group_member_suspended', null,
    null, jsonb_build_object('member_id', p_member_id, 'suspended_until', p_until, 'reason', nullif(p_reason, '')),
    'member suspended'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.suspend_group_member(uuid, uuid, timestamptz, text) to authenticated;

create or replace function public.unsuspend_group_member(p_group_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role is null and not public.is_communication_admin() then raise exception 'You are not a member of this group'; end if;
  if v_role not in ('owner', 'admin') and not public.is_communication_admin() then raise exception 'Only the owner or an admin can end suspensions'; end if;

  update public.message_group_members
  set suspended_until = null, suspended_by = null, suspended_at = null, suspend_reason = null
  where group_id = p_group_id and member_id = p_member_id;
  if not found then raise exception 'Member not found in group'; end if;

  perform public.write_communication_audit(
    'group', p_group_id, 'group_member_unsuspended', null,
    null, jsonb_build_object('member_id', p_member_id), 'member unsuspended'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.unsuspend_group_member(uuid, uuid) to authenticated;