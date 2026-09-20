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