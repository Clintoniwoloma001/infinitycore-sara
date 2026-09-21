-- ============================================================
-- Phase 63 — Dynamic KSS Announcements channel + training invites
-- ------------------------------------------------------------
-- Run in Supabase SQL Editor after Phase 62. Idempotent / additive.
--
-- Adds:
--   1. A persistent, auto-membered KSS announcements channel
--      (`kss-announcements`, channel_type 'announcement'). Membership =
--      all active staff profiles (mirrors the existing 'role'/'all' auto
--      channel wiring), so it back-fills on bootstrap and re-syncs on
--      request.
--   2. `ensure_kss_channel()`        — create-if-missing + sync members.
--   3. `kss_channel_add_member(uuid)` — idempotent single-member add.
--   4. A trigger on profiles.status → 'active' that auto-adds every newly
--      activated account to the channel as part of the approval flow.
--
-- The channel post itself is created server-side by the
-- `send-training-invites` edge function (which emails participants via
-- Resend too). No table changes — reuses message_channels,
-- message_channel_members and send_mention_message from Phase 40.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Ensure the KSS announcements channel exists + sync members
-- ------------------------------------------------------------
-- Relax the Phase 49 channel-creation guard for SYSTEM auto channels.
-- The original trigger blocks any non-team channel insert unless the
-- SESSION resolves to a communication admin via auth.uid(). That broke:
--   (a) this migration's bootstrap (SQL Editor runs as the postgres role,
--       auth.uid() is NULL, so ensure_kss_channel() raised), and
--   (b) ensure_kss_channel() when invoked by a non-admin staff member.
-- Auto channels (is_auto = true) are platform/system artifacts created
-- through SECURITY DEFINER channels bootstrap / ensure_kss_channel —
-- regular members still cannot create official channels via
-- create_message_channel because it inserts with is_auto = false.
create or replace function public.trg_channel_creation_authorization()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_auto then
    return new;
  end if;
  if new.channel_type <> 'team' and not public.is_communication_admin() then
    raise exception 'Only authorized communication administrators can create official channels.';
  end if;
  return new;
end; $$;

-- Override of the Phase 60 sync with the same behaviour EXCEPT it no longer
-- hard-requires a live auth session. Membership is derived purely from org
-- data, and added_by already falls back to the channel creator, so the
-- old "Not authenticated" guard only blocked legitimate system/bootstrap
-- contexts (this migration's `select ensure_kss_channel()` under the
-- postgres role, and server-side provisioning). For authenticated callers
-- nothing changes — it is still SECURITY DEFINER and granted to authenticated only.
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
  select * into v_channel from public.message_channels where id = p_channel_id;
  if v_channel.id is null then raise exception 'Channel not found'; end if;
  if not v_channel.is_auto then raise exception 'Channel is not an auto channel'; end if;
  v_me := coalesce(v_me, v_channel.creator_id);

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

create or replace function public.ensure_kss_channel()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_channel_id uuid;
  v_me uuid := auth.uid();
begin
  select id into v_channel_id
  from public.message_channels
  where name = 'kss-announcements'
  for update;

  if v_channel_id is null then
    insert into public.message_channels (
      name, display_name, description, channel_type, creator_id,
      is_auto, auto_source, auto_source_role
    ) values (
      'kss-announcements',
      'KSS Announcements',
      'Official announcements for KSS (Knowledge, Skills & Safety) training sessions',
      'announcement', v_me,
      true, 'role', 'all'
    )
    returning id into v_channel_id;
  end if;

  perform public.sync_auto_channel_members(v_channel_id);

  -- Guarantee the caller is a member so posting to the channel always works,
  -- even if their profile predates the status='active' norm.
  if v_me is not null then
    insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
    values (v_channel_id, v_me, 'member', v_me, true)
    on conflict (channel_id, member_id) do nothing;
  end if;

  return jsonb_build_object('ok', true, 'channel_id', v_channel_id);
end; $$;
grant execute on function public.ensure_kss_channel() to authenticated;

-- ------------------------------------------------------------
-- 2. Idempotent single-member add (used by the activation trigger)
-- ------------------------------------------------------------
create or replace function public.kss_channel_add_member(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_channel_id uuid;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;

  v_channel_id := (public.ensure_kss_channel() ->> 'channel_id')::uuid;

  insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
  values (v_channel_id, p_user_id, 'member', auth.uid(), true)
  on conflict (channel_id, member_id) do nothing;

  return jsonb_build_object('ok', true, 'channel_id', v_channel_id, 'member_id', p_user_id);
end; $$;
grant execute on function public.kss_channel_add_member(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. Activation trigger — every account that becomes active is added
-- ------------------------------------------------------------
create or replace function public.trg_profiles_active_kss_member()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.kss_channel_add_member(new.id);
  return new;
end; $$;

drop trigger if exists trg_profiles_active_kss_member on public.profiles;
create trigger trg_profiles_active_kss_member
  after insert or update of status on public.profiles
  for each row when (new.status = 'active')
  execute function public.trg_profiles_active_kss_member();

-- ------------------------------------------------------------
-- 4. Bootstrap: create the channel now (creator stays null; the
--    organisational-automation label applies). Idempotent re-run.
-- ------------------------------------------------------------
select public.ensure_kss_channel();