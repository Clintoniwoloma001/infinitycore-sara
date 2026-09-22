-- ============================================================================
-- Phase 4b — Per-recipient urgency acknowledgments for DIRECT messages
-- Run in Supabase SQL Editor after 20260922000002. Idempotent (create or replace).
--
-- Problem: `send_rich_message` (latest def in schema_phase49) raised
-- "Acknowledgment is only supported for group and channel messages" for the
-- `direct` message type, so DM composers silently disabled the Require
-- acknowledgment control (DirectTab sent requiresAck:false). The rest of the
-- ack pipeline (can_read_message, acknowledge_chat_message,
-- get_chat_message_ack_status, chat_message_acks RLS) already supports direct
-- threads, so only this one gate + ack seeding need to change.
--
-- Changes vs the phase49 definition:
--  1. direct messages may now carry requires_ack (no moderator role concept in
--     a 1:1 thread — either participant can flag a message urgent).
--  2. When a direct message requires an ack, a pending chat_message_acks row is
--     pre-seeded for the OTHER participant (group/channel seeding unchanged).
--  Thread replies still reject requires_ack functionality unchanged.
-- ============================================================================

create or replace function public.send_rich_message(
  p_message_type text,
  p_context_id uuid,
  p_body text default null,
  p_priority text default null,
  p_requires_ack boolean default false,
  p_files jsonb default null,
  p_mention_ids uuid[] default null,
  p_parent_message_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_thread_id uuid;
  v_group_id uuid;
  v_channel_id uuid;
  v_priority text;
  v_body text;
  v_file record;
  v_attachment public.message_attachments%rowtype;
  v_mention uuid;
  v_role text;
  v_attachment_count int := 0;
  v_other uuid;
  v_member uuid;
  v_file_type text;
  v_attachment_type text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_message_type not in ('direct', 'group', 'channel', 'thread') then raise exception 'Invalid message type'; end if;
  if p_priority is not null and p_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'Invalid priority'; end if;
  if p_files is not null and jsonb_typeof(p_files) <> 'array' then raise exception 'Attachments must be an array'; end if;
  if p_files is not null and jsonb_array_length(p_files) > 6 then raise exception 'A message may contain at most six attachments'; end if;

  if p_message_type = 'direct' then
    if not exists (
      select 1 from public.chat_threads
      where id = p_context_id and (member_a = v_me or member_b = v_me)
    ) then raise exception 'You are not a member of this conversation'; end if;
    v_thread_id := p_context_id;
  elsif p_message_type = 'group' then
    if not public.is_group_member(p_context_id) then raise exception 'You are not a member of this group'; end if;
    v_group_id := p_context_id;
  elsif p_message_type = 'channel' then
    if not public.is_channel_member(p_context_id) then raise exception 'You are not a member of this channel'; end if;
    v_channel_id := p_context_id;
  else
    if p_parent_message_id is null or not public.can_read_message(p_parent_message_id) then
      raise exception 'Not authorized to reply in this thread';
    end if;
    select thread_id, group_id, channel_id into v_thread_id, v_group_id, v_channel_id
    from public.chat_messages where id = p_parent_message_id;
  end if;

  v_priority := coalesce(p_priority, 'normal');
  if p_requires_ack and v_priority not in ('high', 'urgent') then v_priority := 'high'; end if;
  if p_requires_ack then
    if p_message_type = 'thread' then
      raise exception 'Acknowledgment is only supported for direct, group and channel messages';
    elsif p_message_type = 'direct' then
      -- 1:1 threads have no moderator concept; either participant may flag
      -- their message as requiring acknowledgment.
      null;
    else
      if p_message_type = 'group' then v_role := public.group_member_role(p_context_id);
      else v_role := public.channel_member_role(p_context_id); end if;
      if v_role is null or v_role not in ('owner', 'admin', 'moderator') then
        raise exception 'Only moderators can send messages that require acknowledgment';
      end if;
    end if;
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' and p_files is not null and jsonb_array_length(p_files) > 0 then
    v_body := coalesce(p_files -> 0 ->> 'file_name', 'Attachment');
  end if;
  if v_body = '' then raise exception 'Message body required'; end if;

  if p_files is not null then
    for v_file in select * from jsonb_array_elements(p_files) loop
      v_file_type := lower(coalesce(v_file.value ->> 'file_type', 'application/octet-stream'));
      v_attachment_type := coalesce(v_file.value ->> 'attachment_type', 'file');
      if nullif(v_file.value ->> 'file_path', '') is null
         or position('chat/' in coalesce(v_file.value ->> 'file_path', '')) <> 1
         or position('..' in coalesce(v_file.value ->> 'file_path', '')) > 0 then
        raise exception 'Invalid chat attachment path';
      end if;
      if coalesce(nullif(v_file.value ->> 'file_size', '')::bigint, 0) > 25 * 1024 * 1024 then
        raise exception 'Chat attachment exceeds the 25MB limit';
      end if;
      if v_attachment_type not in ('file', 'image', 'document', 'pdf', 'spreadsheet', 'presentation', 'archive', 'voice_note', 'audio', 'video') then
        raise exception 'Unsupported chat attachment type';
      end if;
      if v_attachment_type = 'voice_note' and v_file_type not like 'audio/%' then
        raise exception 'Voice note attachment must be audio';
      end if;
    end loop;
  end if;

  insert into public.chat_messages (
    message_type, thread_id, group_id, channel_id, sender_id, body,
    parent_message_id, root_message_id, status, priority, requires_ack
  ) values (
    p_message_type, v_thread_id, v_group_id, v_channel_id, v_me, v_body,
    p_parent_message_id,
    case when p_parent_message_id is null then null else coalesce((select root_message_id from public.chat_messages where id = p_parent_message_id), p_parent_message_id) end,
    'sent', v_priority, p_requires_ack
  ) returning * into v_msg;

  if p_files is not null then
    for v_file in select * from jsonb_array_elements(p_files) loop
      insert into public.message_attachments (
        message_id, file_name, file_type, attachment_type, file_size, file_path,
        checksum, security_status, uploaded_by
      ) values (
        v_msg.id,
        coalesce(v_file.value ->> 'file_name', 'attachment'),
        coalesce(v_file.value ->> 'file_type', 'application/octet-stream'),
        coalesce(v_file.value ->> 'attachment_type', 'file'),
        nullif(v_file.value ->> 'file_size', '')::bigint,
        v_file.value ->> 'file_path',
        v_file.value ->> 'checksum', 'accepted', v_me
      ) returning * into v_attachment;
      v_attachment_count := v_attachment_count + 1;
      perform public.write_communication_audit(
        'message_attachment', v_attachment.id, 'message_attachment_uploaded', v_msg.id,
        null, jsonb_build_object('message_id', v_msg.id, 'attachment_type', v_attachment.attachment_type,
                                 'file_name', v_attachment.file_name, 'file_size', v_attachment.file_size), null
      );
    end loop;
  end if;

  if v_attachment_count > 0 and exists (
    select 1 from public.message_attachments where message_id = v_msg.id and attachment_type = 'voice_note'
  ) then
    perform public.write_communication_audit('message', v_msg.id, 'voice_note_sent', v_msg.id, null,
      jsonb_build_object('attachment_count', v_attachment_count), null);
  end if;

  -- Mandatory acknowledgment: pre-seed pending acks for every recipient except
  -- the sender (the other participant for direct threads, every member for
  -- groups/channels).
  if p_requires_ack and p_message_type in ('direct', 'group', 'channel') then
    if p_message_type = 'direct' then
      select case when member_a = v_me then member_b else member_a end into v_other
      from public.chat_threads where id = v_thread_id;
      insert into public.chat_message_acks (message_id, user_id)
      values (v_msg.id, v_other)
      on conflict (message_id, user_id) do nothing;
    elsif p_message_type = 'group' then
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

  if p_mention_ids is not null then
    foreach v_mention in array p_mention_ids loop
      if v_mention is distinct from v_me and (
        (p_message_type = 'direct' and exists (select 1 from public.chat_threads t where t.id = v_thread_id and v_mention in (t.member_a, t.member_b)))
        or (p_message_type in ('group', 'thread') and exists (select 1 from public.message_group_members m where m.group_id = coalesce(v_group_id, (select group_id from public.chat_messages where id = p_parent_message_id)) and m.member_id = v_mention))
        or (p_message_type in ('channel', 'thread') and exists (select 1 from public.message_channel_members m where m.channel_id = coalesce(v_channel_id, (select channel_id from public.chat_messages where id = p_parent_message_id)) and m.member_id = v_mention))
      ) then
        insert into public.message_mentions (message_id, user_id, mention_type)
        values (v_msg.id, v_mention, 'employee')
        on conflict (message_id, user_id, mention_type) do nothing;
        insert into public.notifications (user_id, title, message, type, link)
        values (v_mention, 'You were mentioned', left(v_body, 120), 'chat', '/chat');
      end if;
    end loop;
  end if;

  -- One in-app notification per recipient, with mute respected for direct
  -- chats. The message itself remains available in the conversation history.
  if p_message_type = 'direct' then
    select case when member_a = v_me then member_b else member_a end into v_other
    from public.chat_threads where id = v_thread_id;
    if not exists (select 1 from public.chat_thread_user_settings where thread_id = v_thread_id and user_id = v_other and is_muted) then
      insert into public.notifications (user_id, title, message, type, link)
      values (v_other, 'New Message', left(v_body, 120), 'chat', '/chat');
    end if;
  elsif p_message_type = 'group' then
    for v_member in select member_id from public.message_group_members where group_id = v_group_id and member_id <> v_me loop
      insert into public.notifications (user_id, title, message, type, link)
      values (v_member, 'New group message', left(v_body, 120), 'chat', '/chat?tab=groups');
    end loop;
  elsif p_message_type = 'channel' then
    for v_member in select member_id from public.message_channel_members where channel_id = v_channel_id and member_id <> v_me loop
      insert into public.notifications (user_id, title, message, type, link)
      values (v_member, 'New channel message', left(v_body, 120), 'chat', '/chat?tab=channels');
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true, 'id', v_msg.id, 'message_type', v_msg.message_type, 'body', v_msg.body,
    'priority', v_msg.priority, 'requires_ack', v_msg.requires_ack, 'created_at', v_msg.created_at,
    'thread_id', v_msg.thread_id, 'group_id', v_msg.group_id, 'channel_id', v_msg.channel_id,
    'parent_message_id', v_msg.parent_message_id, 'content_hash', v_msg.content_hash,
    'message_seq', v_msg.message_seq, 'attachment_count', v_attachment_count
  );
end; $$;

grant execute on function public.send_rich_message(text, uuid, text, text, boolean, jsonb, uuid[], uuid) to authenticated;

-- ============================================================================
-- Direct messages with requires_ack now reachable from the UI. The composer
-- already exposes the "Require acknowledgment" control for DMs once
-- allowRequireAck is enabled (src/components/messages/DirectTab.jsx).
-- ============================================================================