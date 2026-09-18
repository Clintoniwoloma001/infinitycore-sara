-- ==========================================================================
-- PHASE 47 — PER-USER CHAT PREFERENCES
-- --------------------------------------------------------------------------
-- Adds user-scoped direct-chat actions without changing the shared thread or
-- message history:
--   * direct conversation pins
--   * direct conversation mute state
--   * delete-for-me markers (the other participant keeps the chat)
--
-- Requires schema_phase20_chat_offline.sql, schema_phase40_corporate_communication.sql
-- and schema_phase45_chat_engagements.sql. Safe to re-run.
-- ==========================================================================

-- The existing pin table was originally limited to groups and channels.
create table if not exists public.pinned_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_type text not null check (conversation_type in ('direct', 'group', 'channel')),
  conversation_id uuid not null,
  pinned_at timestamptz not null default now(),
  constraint pinned_conversations_unique unique (user_id, conversation_type, conversation_id)
);
alter table public.pinned_conversations enable row level security;

create index if not exists idx_pinned_convs_user
  on public.pinned_conversations(user_id, pinned_at desc);

do $$
begin
  if to_regclass('public.pinned_conversations') is not null then
    alter table public.pinned_conversations
      drop constraint if exists pinned_conversations_conversation_type_check;

    begin
      alter table public.pinned_conversations
        add constraint pinned_conversations_conversation_type_check
        check (conversation_type in ('direct', 'group', 'channel'));
    exception when duplicate_object then null;
    end;
  end if;
end $$;

drop policy if exists "pinned_convs select own" on public.pinned_conversations;
create policy "pinned_convs select own" on public.pinned_conversations
  for select using (user_id = auth.uid());

-- Recreate the pin insert policy with a membership check. Pins are still
-- private to the current user, but a user cannot pin an unrelated conversation.
drop policy if exists "pinned_convs insert own" on public.pinned_conversations;
create policy "pinned_convs insert own" on public.pinned_conversations
  for insert with check (
    user_id = auth.uid()
    and (
      (conversation_type = 'direct' and exists (
        select 1 from public.chat_threads t
        where t.id = conversation_id
          and (t.member_a = auth.uid() or t.member_b = auth.uid())
      ))
      or (conversation_type = 'group' and public.is_group_member(conversation_id))
      or (conversation_type = 'channel' and public.is_channel_member(conversation_id))
    )
  );

drop policy if exists "pinned_convs delete own" on public.pinned_conversations;
create policy "pinned_convs delete own" on public.pinned_conversations
  for delete using (user_id = auth.uid());

-- Direct-chat preferences are not part of the shared chat thread. A row is
-- created only when this user mutes or deletes a conversation.
create table if not exists public.chat_thread_user_settings (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  is_muted boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_thread_user_settings_unique unique (thread_id, user_id)
);
alter table public.chat_thread_user_settings enable row level security;

create index if not exists idx_chat_thread_settings_user
  on public.chat_thread_user_settings(user_id, updated_at desc);
create index if not exists idx_chat_thread_settings_thread
  on public.chat_thread_user_settings(thread_id);

drop policy if exists "chat_thread_settings select own" on public.chat_thread_user_settings;
create policy "chat_thread_settings select own" on public.chat_thread_user_settings
  for select using (user_id = auth.uid());

drop policy if exists "chat_thread_settings insert own" on public.chat_thread_user_settings;
create policy "chat_thread_settings insert own" on public.chat_thread_user_settings
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.chat_threads t
      where t.id = thread_id
        and (t.member_a = auth.uid() or t.member_b = auth.uid())
    )
  );

drop policy if exists "chat_thread_settings update own" on public.chat_thread_user_settings;
create policy "chat_thread_settings update own" on public.chat_thread_user_settings
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "chat_thread_settings delete own" on public.chat_thread_user_settings;
create policy "chat_thread_settings delete own" on public.chat_thread_user_settings
  for delete using (user_id = auth.uid());

-- Keep updated_at correct for any future direct table update.
create or replace function public.trg_chat_thread_settings_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end; $$;

drop trigger if exists trg_chat_thread_settings_updated_at on public.chat_thread_user_settings;
create trigger trg_chat_thread_settings_updated_at
  before update on public.chat_thread_user_settings
  for each row execute function public.trg_chat_thread_settings_updated_at();

create or replace function public.restore_chat_thread_for_me(p_thread_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not exists (
    select 1 from public.chat_threads
    where id = p_thread_id and (member_a = v_me or member_b = v_me)
  ) then raise exception 'Not authorized in this thread'; end if;

  insert into public.chat_thread_user_settings (thread_id, user_id, deleted_at)
  values (p_thread_id, v_me, null)
  on conflict (thread_id, user_id)
  do update set deleted_at = null, updated_at = now();

  return jsonb_build_object('ok', true, 'deleted', false);
end; $$;
grant execute on function public.restore_chat_thread_for_me(uuid) to authenticated;

create or replace function public.set_chat_thread_muted(p_thread_id uuid, p_muted boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not exists (
    select 1 from public.chat_threads
    where id = p_thread_id and (member_a = v_me or member_b = v_me)
  ) then raise exception 'Not authorized in this thread'; end if;

  insert into public.chat_thread_user_settings (thread_id, user_id, is_muted)
  values (p_thread_id, v_me, coalesce(p_muted, false))
  on conflict (thread_id, user_id)
  do update set is_muted = coalesce(p_muted, false), updated_at = now();

  return jsonb_build_object('ok', true, 'muted', coalesce(p_muted, false));
end; $$;
grant execute on function public.set_chat_thread_muted(uuid, boolean) to authenticated;

create or replace function public.delete_chat_thread_for_me(p_thread_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not exists (
    select 1 from public.chat_threads
    where id = p_thread_id and (member_a = v_me or member_b = v_me)
  ) then raise exception 'Not authorized in this thread'; end if;

  insert into public.chat_thread_user_settings (thread_id, user_id, deleted_at)
  values (p_thread_id, v_me, now())
  on conflict (thread_id, user_id)
  do update set deleted_at = now(), updated_at = now();

  delete from public.pinned_conversations
  where user_id = v_me and conversation_type = 'direct' and conversation_id = p_thread_id;

  return jsonb_build_object('ok', true, 'deleted_for_me', true);
end; $$;
grant execute on function public.delete_chat_thread_for_me(uuid) to authenticated;

-- Mute only suppresses the in-app notification for the muted recipient. The
-- message remains in the shared thread and is still available when opened.
create or replace function public.send_chat_message(
  p_thread_id uuid,
  p_body text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_other uuid;
  v_msg record;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_body is null or length(btrim(p_body)) = 0 then raise exception 'Message body required'; end if;
  if not exists (
    select 1 from public.chat_threads t
    where t.id = p_thread_id and (t.member_a = v_me or t.member_b = v_me)
  ) then raise exception 'Not authorized in this thread'; end if;

  select case when member_a = v_me then member_b else member_a end into v_other
  from public.chat_threads where id = p_thread_id;

  insert into public.chat_messages (thread_id, sender_id, body, status, message_type)
  values (p_thread_id, v_me, btrim(p_body), 'sent', 'direct')
  returning * into v_msg;

  update public.chat_threads
    set last_message = btrim(p_body), last_sender_id = v_me, last_message_at = now(), updated_at = now()
    where id = p_thread_id;

  if not exists (
    select 1 from public.chat_thread_user_settings
    where thread_id = p_thread_id and user_id = v_other and is_muted
  ) then
    insert into public.notifications (user_id, title, message, type, link)
    values (v_other, 'New Message', left(btrim(p_body), 120), 'chat', '/chat');
  end if;

  return jsonb_build_object('ok', true, 'id', v_msg.id, 'thread_id', p_thread_id,
    'body', v_msg.body, 'created_at', v_msg.created_at);
end; $$;
grant execute on function public.send_chat_message(uuid, text) to authenticated;

create or replace function public.send_chat_message_v2(p_thread_id uuid, p_body text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_other uuid;
  v_msg public.chat_messages%rowtype;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if btrim(coalesce(p_body, '')) = '' then raise exception 'Message body required'; end if;
  if not exists (
    select 1 from public.chat_threads t
    where t.id = p_thread_id and (t.member_a = v_me or t.member_b = v_me)
  ) then raise exception 'Not authorized in this thread'; end if;

  select case when member_a = v_me then member_b else member_a end into v_other
  from public.chat_threads where id = p_thread_id;

  insert into public.chat_messages (thread_id, sender_id, body, status, message_type)
  values (p_thread_id, v_me, btrim(p_body), 'sent', 'direct')
  returning * into v_msg;

  update public.chat_threads
    set last_message = btrim(p_body), last_sender_id = v_me, last_message_at = now(), updated_at = now()
    where id = p_thread_id;

  if not exists (
    select 1 from public.chat_thread_user_settings
    where thread_id = p_thread_id and user_id = v_other and is_muted
  ) then
    insert into public.notifications (user_id, title, message, type, link)
    values (v_other, 'New Message', left(btrim(p_body), 120), 'chat', '/chat');
  end if;

  return jsonb_build_object('ok', true, 'id', v_msg.id, 'message_type', v_msg.message_type,
    'body', v_msg.body, 'created_at', v_msg.created_at, 'thread_id', v_msg.thread_id,
    'content_hash', v_msg.content_hash, 'message_seq', v_msg.message_seq);
end; $$;
grant execute on function public.send_chat_message_v2(uuid, text) to authenticated;

-- ==========================================================================
-- DONE
-- ==========================================================================
