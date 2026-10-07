-- ============================================================================
-- 20261108000005_messaging_group_channel_privacy.sql
-- ----------------------------------------------------------------------------
-- MESSAGING GROUP & CHANNEL PRIVACY CONTROLS — PART 3: Database + RLS
-- ----------------------------------------------------------------------------
-- Run in the Supabase SQL Editor AFTER the corporate-communication schema
-- (schema_phase40_corporate_communication.sql) and the role migrations.
-- Idempotent + transaction-wrapped, safe to re-run.
--
-- REAL SCHEMA (this repo — not the spec's generic names):
--   message_groups / message_group_members   (groups; member col = member_id,
--                                             owner col = creator_id,
--                                             roles: owner|admin|moderator|member)
--   message_channels / message_channel_members
--   chat_messages  (message_type: direct|group|channel|announcement|thread;
--                   group_id / channel_id / thread_id; NO recipient_id —
--                   direct messages are scoped via chat_threads.member_a/b)
--   chat_threads   (the two DM participants)
--
-- ROLE SOURCE: profiles.role, lowercase from src/constants/roles.js.
--   Global transparency (read ANY message, incl. DMs) is reserved to
--   'super_admin' ONLY, enforced by the new public.is_super_admin() helper.
--
-- WHAT THIS DELTA DOES (minimal + correct):
--   1. Adds is_public to groups + channels (public visibility flag).
--   2. Adds is_super_admin() helper (super_admin-only, for global transparency).
--   3. Widens the 4 SELECT policies so public groups/channels are visible.
--   4. Re-issues can_read_message(): super_admin global read + public
--      group/channel message read.
--
-- WHAT IT DELIBERATELY DOES NOT DO:
--   - No INSERT/UPDATE/DELETE policies on membership tables. Membership writes
--     already go through SECURITY DEFINER RPCs (add/remove/update_*_member)
--     that enforce authorization and bypass RLS; a direct INSERT policy would
--     bypass those checks and WEAKEN security. Non-members are already denied
--     direct access to private rows by the existing SELECT-only RLS.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Super Admin helper — global transparency (spec Part 2: super_admin only)
-- ----------------------------------------------------------------------------
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'super_admin'
  );
$$;
grant execute on function public.is_super_admin() to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Privacy columns (idempotent)
-- ----------------------------------------------------------------------------
alter table public.message_groups
  add column if not exists is_public boolean not null default false;

alter table public.message_channels
  add column if not exists is_public boolean not null default false;

comment on column public.message_groups.is_public is
  'True = visible to every authenticated user (public visibility). False = only members/owner/admins.';
comment on column public.message_channels.is_public is
  'True = visible to every authenticated user (public visibility). False = only members/creator/admins.';

-- ----------------------------------------------------------------------------
-- 3. Group / Channel VISIBILITY — widened SELECT policies (spec Part 1)
--    Original policies (schema_phase40) already allow: members, creator, and
--    is_communication_admin(). We ADD public visibility for non-members.
--    NOTE: adding a second SELECT policy is OR'd with the first in Postgres
--    RLS, so this only ever WIDENS read access (never narrows existing).
--    We drop+recreate by the ORIGINAL name so there is exactly one policy.
-- ----------------------------------------------------------------------------
drop policy if exists "msg_groups read_member" on public.message_groups;
create policy "msg_groups read_member" on public.message_groups
  for select using (
    public.is_group_member(id)
    or creator_id = auth.uid()
    or public.is_communication_admin()
    or public.is_super_admin()
    or is_public = true
  );

drop policy if exists "msg_channels read_member" on public.message_channels;
create policy "msg_channels read_member" on public.message_channels
  for select using (
    public.is_channel_member(id)
    or creator_id = auth.uid()
    or public.is_communication_admin()
    or public.is_super_admin()
    or is_public = true
  );

-- Membership rosters: members can read; admins/super_admin can read (needed
-- for the management UI). Public groups/channels also expose their roster.
drop policy if exists "msg_group_members read_member" on public.message_group_members;
create policy "msg_group_members read_member" on public.message_group_members
  for select using (
    public.is_group_member(group_id)
    or public.is_communication_admin()
    or public.is_super_admin()
    or exists (
      select 1 from public.message_groups g
      where g.id = message_group_members.group_id
        and g.is_public = true
    )
  );

drop policy if exists "msg_channel_members read_member" on public.message_channel_members;
create policy "msg_channel_members read_member" on public.message_channel_members
  for select using (
    public.is_channel_member(channel_id)
    or public.is_communication_admin()
    or public.is_super_admin()
    or exists (
      select 1 from public.message_channels c
      where c.id = message_channel_members.channel_id
        and c.is_public = true
    )
  );


-- ----------------------------------------------------------------------------
-- 4. can_read_message() — super-admin global transparency + public message read
--    Re-issued from the schema_phase40 definition with two additive changes:
--      a) super_admin reads ANY message (global transparency / DM inspection).
--      b) a public group/channel exposes its messages to all authenticated.
--    All other branches (sender, thread recursion, announcement audience) are
--    preserved verbatim.
-- ----------------------------------------------------------------------------
create or replace function public.can_read_message(p_message_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_msg public.chat_messages%rowtype;
  v_ann record;
begin
  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then
    return false;
  end if;
  -- Super Admin: global transparency across all messaging, including the
  -- direct-message inspection required by Part 2 (super_admin ONLY).
  if public.is_super_admin() then
    return true;
  end if;
  -- the author can always read what they sent
  if v_msg.sender_id = auth.uid() then
    return true;
  end if;
  if v_msg.message_type = 'channel' then
    return public.is_channel_member(v_msg.channel_id)
      or exists (
        select 1 from public.message_channels c
        where c.id = v_msg.channel_id and c.is_public = true
      );
  end if;
  if v_msg.message_type = 'group' then
    return public.is_group_member(v_msg.group_id)
      or exists (
        select 1 from public.message_groups g
        where g.id = v_msg.group_id and g.is_public = true
      );
  end if;
  if v_msg.message_type = 'thread' then
    -- thread replies inherit access from the parent context
    if v_msg.root_message_id is not null and v_msg.root_message_id <> v_msg.id then
      return public.can_read_message(v_msg.root_message_id);
    end if;
    return false;
  end if;
  if v_msg.message_type = 'direct' then
    return public.is_thread_participant(v_msg.thread_id);
  end if;
  if v_msg.message_type = 'announcement' then
    -- author or explicit audience or authorized roles
    if v_msg.sender_id = auth.uid() or public.is_communication_admin() then
      return true;
    end if;
    select * into v_ann from public.announcements where message_id = v_msg.id limit 1;
    if v_ann.id is not null then
      return exists (
        select 1 from public.announcement_audience
        where announcement_id = v_ann.id and member_id = auth.uid()
      );
    end if;
    return false;
  end if;
  return false;
end; $$;
grant execute on function public.can_read_message(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Super Admin READS any DM thread (DM inspection needs the thread list).
--    The existing "chat_threads read own" policy only exposes threads the
--    caller participates in. Super Admin global transparency requires listing
--    ANY thread, so we widen that SELECT policy (additive OR clause).
-- ----------------------------------------------------------------------------
drop policy if exists "chat_threads read own" on public.chat_threads;
create policy "chat_threads read own" on public.chat_threads
  for select using (
    member_a = auth.uid()
    or member_b = auth.uid()
    or public.is_super_admin()
  );

-- Note: the message_audit_log "audit read_admin" policy already covers
-- is_communication_admin() (super_admin is inside that set), and exports go
-- through create_message_export (SECURITY DEFINER) — no change required there.

commit;

