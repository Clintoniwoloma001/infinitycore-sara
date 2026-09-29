-- ============================================================================
-- "Mark all as read" — recipients must be able to clear their read receipts
--
-- Why this file exists
--
-- The requirement is a "Mark all as read" action on the Notifications panel,
-- available from the bell AND from the menu, that clears ordinary unread state
-- on both web and mobile.
--
-- It could not be done from the client. The only UPDATE policy on
-- `chat_messages` is:
--     create policy "chat_messages update own"
--       for update using (sender_id = auth.uid());
-- so a RECIPIENT is not permitted to update their own `read_at` on somebody
-- else's message. A client-side
-- `.update({read_at}).neq('sender_id', me)` therefore matches zero rows and
-- silently does nothing — which looks exactly like a working button.
--
-- This RPC performs the update under SECURITY DEFINER, scoped to messages the
-- caller can genuinely read, so the read state is fixed by the same
-- authorization rule as everything else rather than by a hidden filter.
--
-- THE ACKNOWLEDGEMENT EXCEPTION
-- This function touches `chat_messages.read_at` ONLY. It deliberately does not
-- read, write or reference `chat_message_acks`. An Important/Urgent message
-- therefore stays OUTSTANDING after "mark all as read" and continues to
-- require an explicit acknowledgment, exactly as the compliance requirement
-- demands. Read state and compliance state are different things and must not be
-- allowed to alias.
-- ============================================================================

create or replace function public.mark_all_chat_messages_read()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_updated integer := 0;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  -- Only messages the caller is actually entitled to read, only those they did
  -- not send, and only those still unread. `can_read_message` is the same
  -- predicate the read policy uses, so this cannot widen anyone's visibility.
  update public.chat_messages m
     set read_at = now()
   where m.read_at is null
     and m.sender_id is distinct from v_me
     and (
       (m.message_type = 'channel' and public.is_channel_member(m.channel_id))
       or (m.message_type = 'group' and public.is_group_member(m.group_id))
       or (m.message_type = 'direct' and exists (
             select 1 from public.chat_threads t
              where t.id = m.thread_id and (t.member_a = v_me or t.member_b = v_me)
           ))
       or (m.message_type = 'thread' and m.root_message_id is not null
           and public.can_read_message(m.root_message_id))
       or (m.message_type = 'announcement' and public.can_read_message(m.id))
     );

  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'ok', true,
    'updated', v_updated,
    -- Reported so the client can explain the outcome honestly: the read state
    -- is now clear, but any acknowledgment-required message is still owed.
    'acknowledgements_outstanding', (
      select count(*)::int
        from public.chat_message_acks ac
        join public.chat_messages cm on cm.id = ac.message_id
       where ac.user_id = v_me
         and ac.status = 'pending'
         and cm.requires_ack
    )
  );
end; $$;
grant execute on function public.mark_all_chat_messages_read() to authenticated;
