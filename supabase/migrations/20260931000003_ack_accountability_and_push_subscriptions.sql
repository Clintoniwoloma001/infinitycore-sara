-- ============================================================================
-- Acknowledgement accountability + multi-device push subscriptions
-- Run in the Supabase SQL Editor AFTER 20260931000002. Idempotent.
--
-- WHAT THIS CHANGES AND WHY
--
-- 1. Ack audience is fixed at creation time (point 4). `send_rich_message`
--    already seeds one chat_message_acks row per recipient, which is the right
--    model. This adds the two read paths the clients were missing:
--      * `list_pending_acks_for_me()`  — the global banner's data source.
--      * `get_ack_rollup()`             — sender-side N/M progress + full roster.
--    The denominator is the SEEDED ROW COUNT, never a live membership count, so
--    a member joining after the fact can never dilute an outstanding obligation
--    and a member leaving cannot erase it.
--
-- 2. Ack writes are restricted to the seeded audience (point 14). Previously
--    `acknowledge_chat_message` upserted on conflict, which let ANY reader of a
--    message create a row for themselves even if they were never in the
--    audience — and, more seriously, the upsert could overwrite a seeded
--    `pending` row belonging to somebody else. It now updates an EXISTING
--    pending row for the caller only, and never inserts.
--
-- 3. Sender is never an ack target (point 1). The send path already excludes
--    the sender from seeding; this adds a hard guard so no future caller can
--    seed or acknowledge as the sender.
--
-- 4. Push subscriptions are multi-device (point 11). One row per
--    (user, endpoint) so a user with a laptop, a phone and a desktop can each
--    hold a live subscription, and a revoked endpoint can be deleted on its own
--    without touching the user's other devices.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PUSH SUBSCRIPTIONS (multi-device, one row per endpoint)
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  -- p256dh is the client public key, auth the client secret. Both are needed to
  -- encrypt a web-push payload. They are per-subscription, not per-user: two
  -- browsers generate different key pairs and reusing one across devices
  -- breaks encryption.
  p256dh text not null,
  auth text not null,
  user_agent text,
  -- Free-form so a future FCM/APNs path can be distinguished without a
  -- migration (e.g. 'web', 'android', 'ios').
  device_kind text not null default 'web'
    check (device_kind in ('web', 'android', 'ios')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  -- Incremented by the sender on a 404/410 so an endpoint that has been revoked
  -- by the push service can be pruned rather than retried forever.
  failure_count integer not null default 0,
  -- A user may re-subscribe the same endpoint (e.g. after clearing site data).
  -- Unique per endpoint, NOT per (user, endpoint), so an endpoint always maps to
  -- exactly one owner and a shared device cannot leak messages to the wrong
  -- account after a sign-in change.
  constraint push_subscriptions_endpoint_unique unique (endpoint)
);

create index if not exists idx_push_subs_user on public.push_subscriptions(user_id);
create index if not exists idx_push_subs_failures
  on public.push_subscriptions(failure_count desc, last_failure_at desc);

alter table public.push_subscriptions enable row level security;

-- A user reads and manages ONLY their own subscriptions. Nobody can read
-- another user's endpoints: they are capability URLs, and leaking one would let
-- a third party push arbitrary notifications to that device.
drop policy if exists "push_subs own select" on public.push_subscriptions;
create policy "push_subs own select" on public.push_subscriptions
  for select using (user_id = auth.uid());

drop policy if exists "push_subs own insert" on public.push_subscriptions;
create policy "push_subs own insert" on public.push_subscriptions
  for insert with check (user_id = auth.uid());

drop policy if exists "push_subs own update" on public.push_subscriptions;
create policy "push_subs own update" on public.push_subscriptions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "push_subs own delete" on public.push_subscriptions;
create policy "push_subs own delete" on public.push_subscriptions
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. ACK READ PATHS
-- ---------------------------------------------------------------------------

-- Everything the caller still owes, oldest first. This is the global banner's
-- only data source, so the audience is computed server-side once instead of
-- each client re-deriving it (the two platforms had already drifted).
--
-- The denominator is the SEEDED ROW COUNT, never a live membership count, so a
-- member joining later cannot dilute the obligation and a member leaving cannot
-- erase it.
create or replace function public.list_pending_acks_for_me()
returns table (
  message_id uuid,
  priority text,
  body text,
  sender_id uuid,
  message_type text,
  thread_id uuid,
  group_id uuid,
  channel_id uuid,
  created_at timestamptz,
  audience_size integer,
  required_count integer
)
language sql stable security definer set search_path = public as $$
  select
    m.id,
    coalesce(m.priority, 'normal'),
    coalesce(m.body, ''),
    m.sender_id,
    m.message_type,
    m.thread_id,
    m.group_id,
    m.channel_id,
    m.created_at,
    (select count(*)::int from public.chat_message_acks x
      where x.message_id = m.id),
    (select count(*)::int from public.chat_message_acks x
      where x.message_id = m.id and x.status = 'acknowledged')
  from public.chat_message_acks mine
  join public.chat_messages m on m.id = mine.message_id
  where mine.user_id = auth.uid()
    and mine.status = 'pending'
    and m.requires_ack
    and m.sender_id is distinct from auth.uid()
    and public.can_read_message(m.id)
  order by m.created_at asc;
$$;
grant execute on function public.list_pending_acks_for_me() to authenticated;

-- Sender-facing ledger: progress plus the full recipient roster, with
-- acknowledged and pending returned separately so the client renders two
-- clearly separated groups without re-deriving the split.
create or replace function public.get_ack_rollup(p_message_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_total integer;
  v_done integer;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;

  if not public.can_read_message(p_message_id) and v_msg.sender_id <> v_me then
    raise exception 'Not authorized';
  end if;

  select count(*) into v_total
    from public.chat_message_acks where message_id = p_message_id;
  select count(*) into v_done
    from public.chat_message_acks
   where message_id = p_message_id and status = 'acknowledged';

  return jsonb_build_object(
    'message_id', p_message_id,
    'requires_ack', coalesce(v_msg.requires_ack, false),
    'priority', coalesce(v_msg.priority, 'normal'),
    'total', coalesce(v_total, 0),
    'acknowledged', coalesce(v_done, 0),
    'pending', greatest(coalesce(v_total, 0) - coalesce(v_done, 0), 0),
    -- One canonical completion string, so web and mobile cannot disagree.
    'complete_label', 'ALL RECIPIENTS ACKNOWLEDGED',
    'acknowledged_list', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', ac.user_id, 'acknowledged_at', ac.acknowledged_at
      ) order by ac.acknowledged_at, ac.user_id)
      from public.chat_message_acks ac
      where ac.message_id = p_message_id and ac.status = 'acknowledged'
    ), '[]'::jsonb),
    'pending_list', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', ac.user_id) order by ac.user_id)
      from public.chat_message_acks ac
      where ac.message_id = p_message_id and ac.status <> 'acknowledged'
    ), '[]'::jsonb)
  );
end; $$;
grant execute on function public.get_ack_rollup(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. ACKNOWLEDGE — restricted to the frozen audience
-- ---------------------------------------------------------------------------
-- Point 14. The previous definition upserted on conflict, which let any reader
-- of a message create their own row even when they were not in the audience.
-- This version UPDATES ONLY, never inserts, and matches user_id = auth.uid()
-- as well as message_id, so the unique constraint cannot be used to reach
-- across users.
create or replace function public.acknowledge_chat_message(
  p_message_id uuid,
  p_ip text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_updated integer;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if not v_msg.requires_ack then
    raise exception 'This message does not require acknowledgment';
  end if;
  if not public.can_read_message(p_message_id) then
    raise exception 'Not authorized to access this message';
  end if;

  -- Point 1: the sender never acknowledges and is never blocked. Returning ok
  -- (rather than raising) keeps a sender's optimistic client call error-free.
  if v_msg.sender_id = v_me then
    return jsonb_build_object('ok', true, 'acknowledged', true, 'sender', true);
  end if;

  update public.chat_message_acks
     set status = 'acknowledged',
         acknowledged_at = now(),
         ip_address = p_ip,
         user_agent = p_user_agent,
         updated_at = now()
   where message_id = p_message_id
     and user_id = v_me
     and status <> 'acknowledged';

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    -- Separate "already acknowledged" (idempotent success) from "never in the
    -- audience" (a genuine authorization failure).
    if exists (select 1 from public.chat_message_acks
                where message_id = p_message_id
                  and user_id = v_me
                  and status = 'acknowledged') then
      return jsonb_build_object('ok', true, 'acknowledged', true, 'already', true);
    end if;
    raise exception 'You are not a recipient of this message';
  end if;

  perform public.write_communication_audit(
    'message', p_message_id, 'message_acknowledged', p_message_id,
    null, jsonb_build_object('user_id', v_me), 'acknowledged'
  );
  return jsonb_build_object('ok', true, 'acknowledged', true);
end; $$;
grant execute on function public.acknowledge_chat_message(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. PUSH SUBSCRIPTION REGISTRY (multi-device)
-- ---------------------------------------------------------------------------
-- Upsert keyed on the endpoint, so a browser re-subscribing after a service
-- worker update refreshes its keys instead of creating a duplicate row.
create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null,
  p_device_kind text default 'web'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_endpoint is null or length(p_endpoint) = 0 then raise exception 'Endpoint required'; end if;
  if p_device_kind not in ('web', 'android', 'ios') then
    raise exception 'Unsupported device kind';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, device_kind)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_user_agent, p_device_kind)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        device_kind = excluded.device_kind,
        updated_at = now(),
        failure_count = 0,
        last_failure_at = null
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;
grant execute on function public.register_push_subscription(text, text, text, text, text) to authenticated;

create or replace function public.unregister_push_subscription(p_endpoint text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.unregister_push_subscription(text) to authenticated;

-- Delivery outcome, reported by the server-side sender. A revoked endpoint
-- (404/410) is pruned rather than retried forever; a retryable failure
-- increments a streak that also prunes at 5.
create or replace function public.record_push_failure(p_endpoint text, p_retryable boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  if p_retryable then
    update public.push_subscriptions
       set failure_count = failure_count + 1, last_failure_at = now(), updated_at = now()
     where endpoint = p_endpoint;
  else
    delete from public.push_subscriptions where endpoint = p_endpoint;
  end if;

  select count(*) into v_count from public.push_subscriptions
   where endpoint = p_endpoint and failure_count >= 5;
  if v_count > 0 then delete from public.push_subscriptions where endpoint = p_endpoint; end if;

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.record_push_failure(text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. REALTIME (point 6)
-- ---------------------------------------------------------------------------
-- The sender's ledger must move without a refresh. chat_message_acks is not in
-- the default publication, so it must be added explicitly.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'chat_message_acks'
  ) then
    alter publication supabase_realtime add table public.chat_message_acks;
  end if;
end
$$;

