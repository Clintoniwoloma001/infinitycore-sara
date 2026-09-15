-- ============================================================
-- PHASE 20 — OFFLINE-FIRST TEAM CHAT
--
-- Lightweight 1:1 internal messaging with an offline queue.
--   - chat_threads: one row per participant pair (member_a <
--     member_b enforced by the RPC so each pair is unique).
--   - chat_messages: body + delivery metadata per message.
--   - RLS is strictly owner-scoped (you only ever see threads and
--     messages you are part of).
--   - Realtime publication so updates appear live.
--   - Helper RPC get_or_create_chat_thread keeps the pair unique
--     and inserts a notification for the recipient.
--
-- ALL ADDITIVE. Idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================

create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  member_a uuid not null references auth.users(id) on delete cascade,
  member_b uuid not null references auth.users(id) on delete cascade,
  last_message text,
  last_sender_id uuid references auth.users(id) on delete set null,
  last_message_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- No duplicate thread between the same two members.
  constraint chat_threads_pair_unique unique (member_a, member_b)
);
alter table public.chat_threads enable row level security;
create index if not exists idx_chat_threads_member_a on public.chat_threads(member_a, last_message_at desc);
create index if not exists idx_chat_threads_member_b on public.chat_threads(member_b, last_message_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(btrim(body)) > 0),
  -- offline-first: client queues before sending; status flips to 'sent'
  -- once persisted; 'failed' recorded on unrecoverable errors.
  status text default 'queued' check (status in ('queued', 'sent', 'failed')),
  read_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.chat_messages enable row level security;
create index if not exists idx_chat_messages_thread on public.chat_messages(thread_id, created_at asc);
create index if not exists idx_chat_messages_sender on public.chat_messages(sender_id);

-- Realtime publication (idempotent). New messages + thread updates
-- flow down to open clients.
do $$
begin
  begin
    alter publication supabase_realtime add table public.chat_threads;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.chat_messages;
  exception when duplicate_object then null;
  end;
end $$;

-- RLS: you only see what you are part of.
drop policy if exists "chat_threads read own" on public.chat_threads;
create policy "chat_threads read own" on public.chat_threads
  for select using (member_a = auth.uid() or member_b = auth.uid());

drop policy if exists "chat_threads insert own" on public.chat_threads;
create policy "chat_threads insert own" on public.chat_threads
  for insert with check (member_a = auth.uid() or member_b = auth.uid());

drop policy if exists "chat_threads update own" on public.chat_threads;
create policy "chat_threads update own" on public.chat_threads
  for update using (member_a = auth.uid() or member_b = auth.uid());

drop policy if exists "chat_messages read own" on public.chat_messages;
create policy "chat_messages read own" on public.chat_messages
  for select using (
    exists (
      select 1 from public.chat_threads t
      where t.id = thread_id and (t.member_a = auth.uid() or t.member_b = auth.uid())
    )
  );

drop policy if exists "chat_messages insert own" on public.chat_messages;
create policy "chat_messages insert own" on public.chat_messages
  for insert with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.chat_threads t
      where t.id = thread_id and (t.member_a = auth.uid() or t.member_b = auth.uid())
    )
  );

drop policy if exists "chat_messages update own" on public.chat_messages;
create policy "chat_messages update own" on public.chat_messages
  for update using (
    -- a sender may flip queued -> sent / failed
    (sender_id = auth.uid())
    -- a recipient may mark a message read
    or exists (
      select 1 from public.chat_threads t
      where t.id = thread_id
        and (t.member_a = auth.uid() or t.member_b = auth.uid())
    )
  );

-- ------------------------------------------------------------
-- RPC: get_or_create_chat_thread
-- Returns (or creates) the thread between the caller and a target
-- user. Normalises member order so the unique pair constraint holds.
-- ------------------------------------------------------------
create or replace function public.get_or_create_chat_thread(p_other_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_a uuid;
  v_b uuid;
  v_thread record;
begin
  if v_me is null then
    raise exception 'Not authenticated';
  end if;
  if p_other_user is null or p_other_user = v_me then
    raise exception 'Invalid chat partner';
  end if;

  -- Deterministic ordering: smaller uuid first.
  if v_me < p_other_user then
    v_a := v_me; v_b := p_other_user;
  else
    v_a := p_other_user; v_b := v_me;
  end if;

  select * into v_thread from public.chat_threads
  where member_a = v_a and member_b = v_b limit 1;

  if v_thread.id is null then
    insert into public.chat_threads (member_a, member_b)
    values (v_a, v_b)
    on conflict (member_a, member_b) do nothing
    returning * into v_thread;
  end if;

  if v_thread.id is null then
    select * into v_thread from public.chat_threads
    where member_a = v_a and member_b = v_b limit 1;
  end if;

  return jsonb_build_object(
    'id', v_thread.id,
    'member_a', v_thread.member_a,
    'member_b', v_thread.member_b,
    'other_user', case when v_thread.member_a = v_me then v_thread.member_b else v_thread.member_a end,
    'last_message', v_thread.last_message,
    'last_message_at', v_thread.last_message_at
  );
end; $$;
grant execute on function public.get_or_create_chat_thread(uuid) to authenticated;

-- ------------------------------------------------------------
-- RPC: send_chat_message
-- Persists a message, updates thread preview, and drops an
-- in-app notification for the recipient. Idempotency not needed
-- (client generates one message per send); the offline queue
-- re-sends a fresh message on reconnect, which is the accepted
-- at-least-once behaviour for this internal tool.
-- ------------------------------------------------------------
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
  if v_me is null then
    raise exception 'Not authenticated';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'Message body required';
  end if;

  -- Must be a member of the thread.
  if not exists (
    select 1 from public.chat_threads t
    where t.id = p_thread_id and (t.member_a = v_me or t.member_b = v_me)
  ) then
    raise exception 'Not authorized in this thread';
  end if;

  select case when member_a = v_me then member_b else member_a end into v_other
  from public.chat_threads where id = p_thread_id;

  insert into public.chat_messages (thread_id, sender_id, body, status)
  values (p_thread_id, v_me, btrim(p_body), 'sent')
  returning * into v_msg;

  update public.chat_threads
    set last_message = btrim(p_body), last_sender_id = v_me, last_message_at = now(), updated_at = now()
    where id = p_thread_id;

  -- In-app notification to the recipient.
  insert into public.notifications (user_id, title, message, type, link)
  values (v_other, 'New Message',
          left(btrim(p_body), 120),
          'chat', '/chat');

  return jsonb_build_object(
    'ok', true,
    'id', v_msg.id,
    'thread_id', p_thread_id,
    'body', v_msg.body,
    'created_at', v_msg.created_at
  );
end; $$;
grant execute on function public.send_chat_message(uuid, text) to authenticated;

-- ============================================================
-- DONE. All changes are additive and idempotent.
-- ============================================================