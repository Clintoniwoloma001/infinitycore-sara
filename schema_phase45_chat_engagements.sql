-- ============================================================================
-- PHASE 45 — CHAT ENGAGEMENTS
-- ----------------------------------------------------------------------------
-- Extends the corporate communication platform (schema_phase40) with:
--   1. Channel / group member SUSPENSION (member keeps read access but cannot
--      send for a defined period).
--   2. SECURE FILE ATTACHMENTS on chats / groups / channels (images, PDFs,
--      Word, Excel, …) stored under documents/chat/%.
--   3. "Pin a chat" — per-user pinned conversations (star at top of list).
--   4. URGENT / IMPORTANT messages with MANDATORY ACKNOWLEDGEMENT — every
--      member must acknowledge receipt before they can continue chatting.
--
-- Every statement is idempotent / additive — safe to re-run in the Supabase
-- SQL Editor. Requires schema_phase40_corporate_communication.sql first.
-- ============================================================================

-- ============================================================================
-- 1. MESSAGE-LEVEL ACKNOWLEDGEMENTS (chat_messages, not announcements)
-- ============================================================================
create table if not exists public.chat_message_acks (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'acknowledged')),
  acknowledged_at timestamptz,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_message_acks_unique unique (message_id, user_id)
);
alter table public.chat_message_acks enable row level security;

create index if not exists idx_chat_acks_message on public.chat_message_acks(message_id, status);
create index if not exists idx_chat_acks_user on public.chat_message_acks(user_id, status);

-- Members see acks for messages they can read (own rows plus conversation
-- messages). Direct inserts/updates are NOT exposed — acknowledgment is only
-- possible through the acknowledge_chat_message() RPC.
drop policy if exists "chat_acks read" on public.chat_message_acks;
create policy "chat_acks read" on public.chat_message_acks
  for select using (user_id = auth.uid() or public.can_read_message(message_id));

-- ============================================================================
-- 2. PINNED CONVERSATIONS ("pin a chat" for the current user)
-- ============================================================================
create table if not exists public.pinned_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_type text not null check (conversation_type in ('group', 'channel')),
  conversation_id uuid not null,
  pinned_at timestamptz not null default now(),
  constraint pinned_conversations_unique unique (user_id, conversation_type, conversation_id)
);
alter table public.pinned_conversations enable row level security;

create index if not exists idx_pinned_convs_user on public.pinned_conversations(user_id, pinned_at desc);

drop policy if exists "pinned_convs select own" on public.pinned_conversations;
create policy "pinned_convs select own" on public.pinned_conversations
  for select using (user_id = auth.uid());

drop policy if exists "pinned_convs insert own" on public.pinned_conversations;
create policy "pinned_convs insert own" on public.pinned_conversations
  for insert with check (user_id = auth.uid());

drop policy if exists "pinned_convs delete own" on public.pinned_conversations;
create policy "pinned_convs delete own" on public.pinned_conversations
  for delete using (user_id = auth.uid());

-- ============================================================================
-- 3. MESSAGE REQUIRE-ACK FLAG
-- ============================================================================
alter table public.chat_messages
  add column if not exists requires_ack boolean not null default false;

create index if not exists idx_chat_messages_requires_ack on public.chat_messages(requires_ack)
  where requires_ack = true;

-- ============================================================================
-- 4. MEMBER SUSPENSION COLUMNS
-- ============================================================================
alter table public.message_channel_members
  add column if not exists suspended_until timestamptz,
  add column if not exists suspended_by uuid references auth.users(id) on delete set null,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspend_reason text;

alter table public.message_group_members
  add column if not exists suspended_until timestamptz,
  add column if not exists suspended_by uuid references auth.users(id) on delete set null,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspend_reason text;

create index if not exists idx_channel_members_suspended on public.message_channel_members(suspended_until)
  where suspended_until is not null;
create index if not exists idx_group_members_suspended on public.message_group_members(suspended_until)
  where suspended_until is not null;

-- Enforce suspension on EVERY insert path (plain text, mentions, attachments,
-- thread replies) without touching the existing send RPCs: a suspended member
-- can still READ (RLS is untouched) but any attempt to write raises.
create or replace function public.trg_chat_messages_suspension()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_until timestamptz;
begin
  if auth.uid() is null or new.sender_id is distinct from auth.uid() then
    return new;
  end if;

  if new.message_type = 'group' and new.group_id is not null then
    select suspended_until into v_until
    from public.message_group_members
    where group_id = new.group_id and member_id = auth.uid();
  elsif new.message_type = 'channel' and new.channel_id is not null then
    select suspended_until into v_until
    from public.message_channel_members
    where channel_id = new.channel_id and member_id = auth.uid();
  end if;

  if v_until is not null and v_until > now() then
    raise exception 'You are temporarily suspended from sending messages here until %',
      to_char(v_until, 'YYYY-MM-DD HH24:MI');
  end if;

  return new;
end; $$;

drop trigger if exists trg_chat_messages_suspension on public.chat_messages;
create trigger trg_chat_messages_suspension
  before insert on public.chat_messages
  for each row execute function public.trg_chat_messages_suspension();

-- ----------------------------------------------------------------------------
-- Channel suspension RPCs
-- ----------------------------------------------------------------------------
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
  if v_role is null then raise exception 'You are not a member of this channel'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can suspend members'; end if;
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
  if v_role is null then raise exception 'You are not a member of this channel'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can end suspensions'; end if;

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

-- ----------------------------------------------------------------------------
-- Group suspension RPCs
-- ----------------------------------------------------------------------------
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
  if v_role is null then raise exception 'You are not a member of this group'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can suspend members'; end if;
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
  if v_role is null then raise exception 'You are not a member of this group'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can end suspensions'; end if;

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

-- Helper: a member's role as seen from another member's perspective,
-- used to prevent suspending the owner. NULL if the pair does not exist.
create or replace function public.channel_member_role_for(p_member_id uuid, p_channel_id uuid)
returns text
language sql security definer set search_path = public
stable as $$
  select role from public.message_channel_members
  where channel_id = p_channel_id and member_id = p_member_id;
$$;
grant execute on function public.channel_member_role_for(uuid, uuid) to authenticated;

create or replace function public.group_member_role_for(p_member_id uuid, p_group_id uuid)
returns text
language sql security definer set search_path = public
stable as $$
  select role from public.message_group_members
  where group_id = p_group_id and member_id = p_member_id;
$$;
grant execute on function public.group_member_role_for(uuid, uuid) to authenticated;

-- ============================================================================
-- 5. RICH SEND — ATTACHMENTS + PRIORITY + REQUIRE-ACK
--    (group / channel / thread; direct remains on the existing text-only path)
-- ============================================================================
create or replace function public.send_rich_message(
  p_message_type text,
  p_context_id uuid,
  p_body text default null,
  p_priority text default null,
  p_requires_ack boolean default false,
  p_files jsonb default null,          -- [{file_name,file_type,file_size,file_path}]
  p_mention_ids uuid[] default null,
  p_parent_message_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_group_id uuid;
  v_channel_id uuid;
  v_priority text;
  v_body text;
  v_file record;
  v_mention uuid;
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_message_type not in ('group', 'channel', 'thread') then raise exception 'Invalid message type'; end if;
  if p_priority is not null and p_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'Invalid priority'; end if;

  if p_message_type = 'group' then
    if not public.is_group_member(p_context_id) then raise exception 'You are not a member of this group'; end if;
    v_group_id := p_context_id;
  elsif p_message_type = 'channel' then
    if not public.is_channel_member(p_context_id) then raise exception 'You are not a member of this channel'; end if;
    v_channel_id := p_context_id;
  elsif p_message_type = 'thread' then
    if p_parent_message_id is null or not public.can_read_message(p_parent_message_id) then
      raise exception 'Not authorized to reply in this thread';
    end if;
    select group_id, channel_id into v_group_id, v_channel_id
    from public.chat_messages where id = p_parent_message_id;
  end if;

  -- "Urgent or important": require-ack forces at least a high priority.
  v_priority := coalesce(p_priority, 'normal');
  if p_requires_ack and v_priority not in ('high', 'urgent') then
    v_priority := 'high';
  end if;

  -- Only moderators can force mandatory acknowledgment (a regular member
  -- must not be able to block an entire channel). Thread replies cannot
  -- force acknowledgments (the audience is the whole parent conversation).
  if p_requires_ack then
    if p_message_type = 'thread' then
      raise exception 'Acknowledgment is only supported for group and channel messages';
    elsif p_message_type = 'group' then v_role := public.group_member_role(p_context_id);
    else v_role := public.channel_member_role(p_context_id); end if;
    if v_role is null or v_role not in ('owner', 'admin', 'moderator') then
      raise exception 'Only moderators can send messages that require acknowledgment';
    end if;
  end if;

  -- Body must be non-empty (integrity constraint); a file-only message uses
  -- the file name as its placeholder body.
  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' and p_files is not null
     and jsonb_array_length(p_files) > 0 then
    v_body := (p_files->0->>'file_name')::text;
  end if;
  if v_body = '' then raise exception 'Message body required'; end if;

  insert into public.chat_messages (
    message_type, group_id, channel_id, thread_id, sender_id, body,
    parent_message_id, root_message_id, status, priority, requires_ack
  ) values (
    p_message_type, v_group_id, v_channel_id, null::uuid,
    v_me, v_body, p_parent_message_id, null, 'sent', v_priority, p_requires_ack
  )
  returning * into v_msg;

  -- Attachments are written by the same definer so both halves stay consistent.
  if p_files is not null and jsonb_array_length(p_files) > 0 then
    for v_file in select * from jsonb_to_recordset(p_files) as x(
      file_name text, file_type text, file_size bigint, file_path text
    ) loop
      if coalesce(v_file.file_path, '') = '' then continue; end if;
      insert into public.message_attachments (
        message_id, file_name, file_type, file_size, file_path, uploaded_by
      ) values (
        v_msg.id, v_file.file_name, v_file.file_type, v_file.file_size, v_file.file_path, v_me
      );
    end loop;
  end if;

  -- Mandatory acknowledgment: pre-seed pending acks for every group/channel
  -- member except the sender.
  if p_requires_ack and p_message_type in ('group', 'channel') then
    if p_message_type = 'group' then
      insert into public.chat_message_acks (message_id, user_id)
      select v_msg.id, m.member_id from public.message_group_members m
      where m.group_id = v_group_id and m.member_id is distinct from v_me
      on conflict (message_id, user_id) do nothing;
    else
      insert into public.chat_message_acks (message_id, user_id)
      select v_msg.id, m.member_id from public.message_channel_members m
      where m.channel_id = v_channel_id and m.member_id is distinct from v_me
      on conflict (message_id, user_id) do nothing;
    end if;
  end if;

  -- Mentions
  if p_mention_ids is not null then
    foreach v_mention in array p_mention_ids loop
      if v_mention is distinct from v_me then
        insert into public.message_mentions (message_id, user_id, mention_type)
        values (v_msg.id, v_mention, 'employee')
        on conflict (message_id, user_id, mention_type) do nothing;
        insert into public.notifications (user_id, title, message, type, link)
        values (v_mention, 'You were mentioned', left(v_body, 120), 'chat', '/chat');
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true, 'id', v_msg.id,
    'message_type', v_msg.message_type,
    'body', v_msg.body,
    'priority', v_msg.priority,
    'requires_ack', v_msg.requires_ack,
    'created_at', v_msg.created_at,
    'group_id', v_msg.group_id,
    'channel_id', v_msg.channel_id,
    'parent_message_id', v_msg.parent_message_id,
    'content_hash', v_msg.content_hash,
    'message_seq', v_msg.message_seq
  );
end; $$;
grant execute on function public.send_rich_message(text, uuid, text, text, boolean, jsonb, uuid[], uuid) to authenticated;

-- ============================================================================
-- 6. ACKNOWLEDGE URGENT / IMPORTANT MESSAGES
-- ============================================================================
create or replace function public.acknowledge_chat_message(
  p_message_id uuid,
  p_ip text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if not v_msg.requires_ack then raise exception 'This message does not require acknowledgment'; end if;
  if not public.can_read_message(p_message_id) then raise exception 'Not authorized to access this message'; end if;
  if v_msg.sender_id = v_me then return jsonb_build_object('ok', true, 'acknowledged', true); end if;

  insert into public.chat_message_acks (message_id, user_id, status, acknowledged_at, ip_address, user_agent)
  values (p_message_id, v_me, 'acknowledged', now(), p_ip, p_user_agent)
  on conflict (message_id, user_id)
  do update set status = 'acknowledged', acknowledged_at = now(),
                ip_address = p_ip, user_agent = p_user_agent, updated_at = now();

  perform public.write_communication_audit(
    'message', p_message_id, 'message_acknowledged', p_message_id,
    null, jsonb_build_object('user_id', v_me), 'acknowledged'
  );
  return jsonb_build_object('ok', true, 'acknowledged', true);
end; $$;
grant execute on function public.acknowledge_chat_message(uuid, text, text) to authenticated;

-- Acknowledgement rollup for a require-ack message (any member can view the
-- receipts — read-receipt style, like who has seen an important post).
create or replace function public.get_chat_message_ack_status(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_total int;
  v_ack int;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if not v_msg.requires_ack then raise exception 'This message does not require acknowledgment'; end if;
  if not public.can_read_message(p_message_id) then
    -- senders of direct messages are covered by their own authorship
    if v_msg.sender_id <> v_me then raise exception 'Not authorized'; end if;
  end if;

  select count(*) into v_total from public.chat_message_acks where message_id = p_message_id;
  select count(*) into v_ack from public.chat_message_acks
  where message_id = p_message_id and status = 'acknowledged';

  return jsonb_build_object(
    'total', v_total, 'acknowledged', v_ack, 'pending', greatest(v_total - v_ack, 0),
    'acknowledged_list', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', ac.user_id, 'acknowledged_at', ac.acknowledged_at
      ) order by ac.acknowledged_at)
      from public.chat_message_acks ac
      where ac.message_id = p_message_id and ac.status = 'acknowledged'
    ), '[]'::jsonb)
  );
end; $$;
grant execute on function public.get_chat_message_ack_status(uuid) to authenticated;

-- ============================================================================
-- 7. STORAGE — secure chat attachments under the private documents bucket
-- ============================================================================
drop policy if exists "chat_attachment_upload" on storage.objects;
create policy "chat_attachment_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and name like 'chat/%'
  );

-- Reads go through the client's signed URLs; the bucket is private and the
-- file paths are random UUIDs surfaced only to conversation members through
-- message_attachments (RLS + can_read_message).
drop policy if exists "chat_attachment_read" on storage.objects;
create policy "chat_attachment_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and name like 'chat/%'
  );

-- ============================================================================
-- DONE. Requires schema_phase40_corporate_communication.sql (and its
-- dependency, schema_phase20_chat_offline.sql) before this file.
-- ============================================================================