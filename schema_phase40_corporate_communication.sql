-- ============================================================
-- PHASE 40 — CORPORATE COMMUNICATION RECORDS PLATFORM
--
-- Extends the existing Phase 20 team chat into an official,
-- traceable, secure, searchable and auditable corporate
-- communication system for Infinity Bank.
--
-- DESIGN PRINCIPLES
--   1. Append-only messaging. Message rows are NEVER physically
--      deleted by users. The chat_messages table gains a
--      restricted_status ('active'|'restricted'|'deleted') for
--      soft removal / moderation. Original bodies are preserved.
--   2. Immutable official records. message_type='announcement' or
--      is_official=true rows REJECT update/delete at the trigger
--      level — a malicious direct API call cannot alter them.
--   3. Revision history. Editing an ordinary message NEVER
--      overwrites the original: every old body is captured in
--      message_revisions with editor + timestamp.
--   4. Tamper-evident chain. Every message row stores
--      content_hash, previous_hash and message_seq (sha256 chain
--      per conversation). Unauthorized modification is detectable.
--   5. Identity resolution. A resolve_user_identity() helper
--      resolves auth user ids to real employee records so the UI
--      NEVER shows raw UUIDs.
--   6. Strict RLS. Users only read conversations/groups/channels/
--      announcements they are legitimately part of. Admins do NOT
--      silently gain access to private conversations.
--
-- ALL ADDITIVE. Idempotent (IF NOT EXISTS / DROP POLICY + CREATE).
-- Run in Supabase SQL Editor after all prior phase files.
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 1. AUTHZ HELPERS (security definer so RLS can call them without
--    recursion; stable so they can be used in SELECT policies)
-- ============================================================

create or replace function public.is_communication_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );
$$;
grant execute on function public.is_communication_admin() to authenticated;

create or replace function public.can_author_announcement()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('super_admin', 'admin', 'hr_manager', 'hr_officer',
                   'branch_manager', 'area_manager', 'operations_manager',
                   'head_of_business')
  );
$$;
grant execute on function public.can_author_announcement() to authenticated;

-- NOTE: helper functions intended for RLS are created as plpgsql so their
-- bodies are validated lazily (tables referenced below are created later in
-- this same file). security definer => they bypass RLS when used in policies.
create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (
    select 1 from public.message_group_members
    where group_id = p_group_id and member_id = auth.uid()
  );
end; $$;
grant execute on function public.is_group_member(uuid) to authenticated;

create or replace function public.group_member_role(p_group_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare v_role text;
begin
  select role into v_role from public.message_group_members
  where group_id = p_group_id and member_id = auth.uid()
  limit 1;
  return v_role;
end; $$;
grant execute on function public.group_member_role(uuid) to authenticated;

create or replace function public.is_channel_member(p_channel_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (
    select 1 from public.message_channel_members
    where channel_id = p_channel_id and member_id = auth.uid()
  );
end; $$;
grant execute on function public.is_channel_member(uuid) to authenticated;

create or replace function public.channel_member_role(p_channel_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare v_role text;
begin
  select role into v_role from public.message_channel_members
  where channel_id = p_channel_id and member_id = auth.uid()
  limit 1;
  return v_role;
end; $$;
grant execute on function public.channel_member_role(uuid) to authenticated;

create or replace function public.is_thread_participant(p_thread_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_threads
    where id = p_thread_id
      and (member_a = auth.uid() or member_b = auth.uid())
  );
$$;
grant execute on function public.is_thread_participant(uuid) to authenticated;

-- Announcement helpers (security definer => no RLS recursion between the
-- announcements / announcement_audience policies).
create or replace function public.is_announcement_author(p_announcement_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (
    select 1 from public.announcements where id = p_announcement_id and author_id = auth.uid()
  );
end; $$;
grant execute on function public.is_announcement_author(uuid) to authenticated;

create or replace function public.is_announcement_audience(p_announcement_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (
    select 1 from public.announcement_audience
    where announcement_id = p_announcement_id and member_id = auth.uid()
  );
end; $$;
grant execute on function public.is_announcement_audience(uuid) to authenticated;

-- Can the current user read a given message? Resolves every context.
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
  -- the author can always read what they sent
  if v_msg.sender_id = auth.uid() then
    return true;
  end if;
  if v_msg.message_type = 'channel' then
    return public.is_channel_member(v_msg.channel_id);
  end if;
  if v_msg.message_type = 'group' then
    return public.is_group_member(v_msg.group_id);
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

-- ------------------------------------------------------------
-- resolve_user_identity — auth user id -> real employee identity
-- ------------------------------------------------------------
create or replace function public.resolve_user_identity(p_user_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if p_user_ids is null or array_length(p_user_ids, 1) = 0 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', p.id,
    'employee_id', e.id,
    'full_name', coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(p.full_name), ''), p.email),
    'email', coalesce(nullif(btrim(e.email), ''), p.email),
    'role', p.role,
    'department', coalesce(nullif(btrim(e.department), ''), p.department),
    'position', e."position",
    'designation', e.confirmation_status,
    'staff_id', coalesce(e.staff_id, e.employee_number, e.employee_code),
    'employment_status', e.employment_status,
    'branch_id', e.branch_id,
    'branch', e.branch,
    'is_former_employee', (e.employment_status not in ('active', 'on_leave')),
    'profile_picture_path', coalesce(
      (select d.file_path from public.documents d
        where d.entity_type = 'employee' and d.entity_id = e.id
          and lower(coalesce(d.document_type, '')) = 'profile_picture'
        order by d.created_at desc limit 1)
      , null),
    'profile_status', p.status
  )), '[]'::jsonb) into v_result
  from public.profiles p
  left join lateral (
    select * from public.employees e2
    where e2.user_id = p.id
    order by e2.created_at desc
    limit 1
  ) e on true
  where p.id = any(p_user_ids);

  return coalesce(v_result, '[]'::jsonb);
end; $$;
grant execute on function public.resolve_user_identity(uuid[]) to authenticated;

-- ------------------------------------------------------------
-- get_messaging_directory — staff directory for the chat pickers.
-- SECURITY DEFINER because profiles/employees are RLS-restricted to
-- admins; a plain table query returns only the caller for normal
-- staff, which made the "New Message" / "New Group" people pickers
-- empty. Returns the same shape as resolve_user_identity so the
-- client can reuse one indexer. The authenticated user is always
-- included. Never returns the anon/service roles.
-- ------------------------------------------------------------
create or replace function public.get_messaging_directory(p_search text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_result jsonb;
begin
  if v_me is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', r.user_id,
    'employee_id', r.employee_id,
    'full_name', r.full_name,
    'email', r.email,
    'role', r.role,
    'department', r.department,
    'position', r.position,
    'designation', r.designation,
    'staff_id', r.staff_id,
    'employment_status', r.employment_status,
    'branch_id', r.branch_id,
    'branch', r.branch,
    'is_former_employee', r.is_former_employee,
    'profile_picture_path', r.profile_picture_path,
    'profile_status', r.profile_status
  ) order by r.full_name), '[]'::jsonb) into v_result
  from (
    select
      p.id as user_id,
      e.id as employee_id,
      coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(p.full_name), ''), p.email) as full_name,
      coalesce(nullif(btrim(e.email), ''), p.email) as email,
      p.role as role,
      coalesce(nullif(btrim(e.department), ''), p.department) as department,
      e."position" as position,
      e.confirmation_status as designation,
      coalesce(e.staff_id, e.employee_number, e.employee_code) as staff_id,
      e.employment_status as employment_status,
      e.branch_id as branch_id,
      e.branch as branch,
      (e.employment_status not in ('active', 'on_leave')) as is_former_employee,
      (select d.file_path from public.documents d
        where d.entity_type = 'employee' and d.entity_id = e.id
          and lower(coalesce(d.document_type, '')) = 'profile_picture'
        order by d.created_at desc limit 1) as profile_picture_path,
      p.status as profile_status
    from public.profiles p
    left join lateral (
      select * from public.employees e2
      where e2.user_id = p.id
      order by e2.created_at desc
      limit 1
    ) e on true
    where coalesce(p.role, 'customer') <> 'customer'
      and (btrim(coalesce(p_search, '')) = ''
           or coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(p.full_name), ''), p.email) ilike '%' || btrim(p_search) || '%'
           or p.email ilike '%' || btrim(p_search) || '%'
           or coalesce(nullif(btrim(e.department), ''), p.department) ilike '%' || btrim(p_search) || '%')
    limit 1000
  ) r;

  return coalesce(v_result, '[]'::jsonb);
end; $$;
grant execute on function public.get_messaging_directory(text) to authenticated;

-- ------------------------------------------------------------
-- write_communication_audit — used by RPCs and triggers
-- ------------------------------------------------------------
create or replace function public.write_communication_audit(
  p_entity_type text,
  p_entity_id uuid default null,
  p_action text default 'message_created',
  p_message_id uuid default null,
  p_prev jsonb default null,
  p_new jsonb default null,
  p_reason text default null,
  p_ip text default null,
  p_user_agent text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_event uuid := gen_random_uuid();
  v_msg record;
begin
  select * into v_msg from public.chat_messages where id = p_message_id;
  insert into public.message_audit_log (
    event_id, message_id, entity_type, entity_id, actor_user_id, action,
    timestamp, conversation_id, channel_id, group_id,
    previous_state, new_state, ip_address, user_agent, reason, meta
  ) values (
    v_event, p_message_id, p_entity_type, p_entity_id, auth.uid(), p_action, now(),
    v_msg.thread_id, v_msg.channel_id, v_msg.group_id,
    p_prev, p_new, p_ip, p_user_agent, p_reason, '{}'::jsonb
  );
  return v_event;
end; $$;
grant execute on function public.write_communication_audit(text, uuid, text, uuid, jsonb, jsonb, text, text, text) to authenticated;

-- ============================================================
-- 2. MESSAGE GROUPS (group chats)
-- ============================================================
create table if not exists public.message_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  avatar_url text,
  creator_id uuid references auth.users(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.message_groups enable row level security;

create table if not exists public.message_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.message_groups(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'moderator', 'member')),
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  constraint message_group_members_unique unique (group_id, member_id)
);
alter table public.message_group_members enable row level security;

create index if not exists idx_message_groups_creator on public.message_groups(creator_id);
create index if not exists idx_group_members_group on public.message_group_members(group_id);
create index if not exists idx_group_members_member on public.message_group_members(member_id);

drop policy if exists "msg_groups read_member" on public.message_groups;
create policy "msg_groups read_member" on public.message_groups
  for select using (
    public.is_group_member(id)
    or creator_id = auth.uid()
    or public.is_communication_admin()
  );

drop policy if exists "msg_group_members read_member" on public.message_group_members;
create policy "msg_group_members read_member" on public.message_group_members
  for select using (public.is_group_member(group_id));

-- ============================================================
-- 3. MESSAGE CHANNELS (official persistent spaces)
-- ============================================================
create table if not exists public.message_channels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  display_name text not null,
  description text,
  avatar_url text,
  channel_type text not null default 'team' check (channel_type in (
    'organization', 'department', 'branch', 'area', 'team', 'private', 'announcement'
  )),
  creator_id uuid references auth.users(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'archived', 'disabled')),
  -- auto channel wiring (organizational hierarchy)
  is_auto boolean not null default false,
  auto_source text check (auto_source in ('branch', 'area', 'department', 'role')),
  auto_source_id uuid,
  auto_source_role text,
  -- moderation / governance defaults
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.message_channels enable row level security;

create table if not exists public.message_channel_members (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.message_channels(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'moderator', 'member')),
  added_by uuid references auth.users(id) on delete set null,
  auto_added boolean not null default false,
  added_at timestamptz not null default now(),
  constraint message_channel_members_unique unique (channel_id, member_id)
);
alter table public.message_channel_members enable row level security;

create index if not exists idx_message_channels_type on public.message_channels(channel_type);
create index if not exists idx_channel_members_channel on public.message_channel_members(channel_id);
create index if not exists idx_channel_members_member on public.message_channel_members(member_id);

drop policy if exists "msg_channels read_member" on public.message_channels;
create policy "msg_channels read_member" on public.message_channels
  for select using (
    public.is_channel_member(id)
    or creator_id = auth.uid()
    or public.is_communication_admin()
  );

drop policy if exists "msg_channel_members read_member" on public.message_channel_members;
create policy "msg_channel_members read_member" on public.message_channel_members
  for select using (public.is_channel_member(channel_id) or public.is_communication_admin());

-- ============================================================
-- 4. ANNOUNCEMENTS
-- ============================================================
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  title text not null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  target_type text not null default 'organization' check (target_type in (
    'organization', 'department', 'branch', 'area', 'role', 'employees', 'channel'
  )),
  target_value text,
  author_id uuid not null references auth.users(id) on delete set null,
  effective_date timestamptz not null default now(),
  expiry_date timestamptz,
  requires_ack boolean not null default false,
  status text not null default 'published' check (status in ('draft', 'published', 'expired', 'cancelled')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.announcements enable row level security;

create table if not exists public.announcement_audience (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint announcement_audience_unique unique (announcement_id, member_id)
);
alter table public.announcement_audience enable row level security;

create table if not exists public.message_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'acknowledged', 'declined')),
  acknowledged_at timestamptz,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_acknowledgements_unique unique (announcement_id, user_id)
);
alter table public.message_acknowledgements enable row level security;

create index if not exists idx_announcements_message on public.announcements(message_id);
create index if not exists idx_announcements_status on public.announcements(status);
create index if not exists idx_announcement_audience_ann on public.announcement_audience(announcement_id);
create index if not exists idx_announcement_audience_member on public.announcement_audience(member_id);
create index if not exists idx_ack_ann on public.message_acknowledgements(announcement_id);
create index if not exists idx_ack_user on public.message_acknowledgements(user_id);

drop policy if exists "announcements read_visible" on public.announcements;
create policy "announcements read_visible" on public.announcements
  for select using (
    author_id = auth.uid()
    or public.is_communication_admin()
    or public.is_announcement_audience(id)
  );

drop policy if exists "announcement_audience read_" on public.announcement_audience;
create policy "announcement_audience read_" on public.announcement_audience
  for select using (
    member_id = auth.uid()
    or public.is_announcement_author(announcement_id)
    or public.is_communication_admin()
  );

drop policy if exists "ack read_own_or_admin" on public.message_acknowledgements;
create policy "ack read_own_or_admin" on public.message_acknowledgements
  for select using (
    user_id = auth.uid()
    or public.is_communication_admin()
    or exists (
      select 1 from public.announcements au
      where au.id = announcement_id and au.author_id = auth.uid()
    )
  );

-- ============================================================
-- 5. MESSAGE EXTENSIONS: revisions, attachments, reactions,
--    reads, mentions, bookmarks, tasks
-- ============================================================
create table if not exists public.message_revisions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  previous_body text not null,
  new_body text,
  edited_by uuid references auth.users(id) on delete set null,
  edited_at timestamptz not null default now()
);
alter table public.message_revisions enable row level security;

create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  file_name text not null,
  file_type text,
  file_size bigint default 0,
  file_path text,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.message_attachments enable row level security;

create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  constraint message_reactions_unique unique (message_id, user_id, emoji)
);
alter table public.message_reactions enable row level security;

create table if not exists public.message_reads (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  constraint message_reads_unique unique (message_id, user_id)
);
alter table public.message_reads enable row level security;

create table if not exists public.message_mentions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mention_type text not null default 'employee' check (mention_type in ('employee', 'department', 'branch', 'area', 'channel', 'all')),
  created_at timestamptz not null default now(),
  constraint message_mentions_unique unique (message_id, user_id, mention_type)
);
alter table public.message_mentions enable row level security;

create table if not exists public.message_bookmarks (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint message_bookmarks_unique unique (message_id, user_id)
);
alter table public.message_bookmarks enable row level security;

create table if not exists public.message_tasks (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  title text not null,
  description text,
  assigned_to uuid references auth.users(id) on delete set null,
  due_date date,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  created_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.message_tasks enable row level security;

create index if not exists idx_msg_attachments_message on public.message_attachments(message_id);
create index if not exists idx_msg_reactions_message on public.message_reactions(message_id);
create index if not exists idx_msg_mentions_message on public.message_mentions(message_id);
create index if not exists idx_msg_bookmarks_user on public.message_bookmarks(user_id);
create index if not exists idx_msg_reads_message on public.message_reads(message_id);
create index if not exists idx_msg_tasks_message on public.message_tasks(message_id);
create index if not exists idx_msg_tasks_assigned on public.message_tasks(assigned_to);
create index if not exists idx_msg_revisions_message on public.message_revisions(message_id);

drop policy if exists "revisions read" on public.message_revisions;
create policy "revisions read" on public.message_revisions
  for select using (public.can_read_message(message_id));

drop policy if exists "attachments read" on public.message_attachments;
create policy "attachments read" on public.message_attachments
  for select using (public.can_read_message(message_id));

drop policy if exists "reactions read" on public.message_reactions;
create policy "reactions read" on public.message_reactions
  for select using (public.can_read_message(message_id));

drop policy if exists "reactions insert" on public.message_reactions;
create policy "reactions insert" on public.message_reactions
  for insert with check (
    user_id = auth.uid() and public.can_read_message(message_id)
  );

drop policy if exists "reactions delete" on public.message_reactions;
create policy "reactions delete" on public.message_reactions
  for delete using (user_id = auth.uid());

drop policy if exists "reads insert" on public.message_reads;
create policy "reads insert" on public.message_reads
  for insert with check (
    user_id = auth.uid() and public.can_read_message(message_id)
  );

drop policy if exists "reads read" on public.message_reads;
create policy "reads read" on public.message_reads
  for select using (user_id = auth.uid() or public.is_communication_admin());

drop policy if exists "mentions read" on public.message_mentions;
create policy "mentions read" on public.message_mentions
  for select using (user_id = auth.uid() or public.can_read_message(message_id));

drop policy if exists "bookmarks read" on public.message_bookmarks;
create policy "bookmarks read" on public.message_bookmarks
  for select using (user_id = auth.uid());

drop policy if exists "bookmarks insert" on public.message_bookmarks;
create policy "bookmarks insert" on public.message_bookmarks
  for insert with check (
    user_id = auth.uid() and public.can_read_message(message_id)
  );

drop policy if exists "bookmarks delete" on public.message_bookmarks;
create policy "bookmarks delete" on public.message_bookmarks
  for delete using (user_id = auth.uid());

drop policy if exists "tasks read" on public.message_tasks;
create policy "tasks read" on public.message_tasks
  for select using (
    public.can_read_message(message_id)
    or assigned_to = auth.uid()
    or created_by = auth.uid()
  );

-- ============================================================
-- 6. AUDIT, REPORTS, HOLDS, RETENTION, EXPORTS
-- ============================================================
create table if not exists public.message_audit_log (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid(),
  message_id uuid,
  entity_type text not null,
  entity_id uuid,
  actor_user_id uuid,
  action text not null,
  timestamp timestamptz not null default now(),
  conversation_id uuid,
  channel_id uuid,
  group_id uuid,
  previous_state jsonb,
  new_state jsonb,
  ip_address text,
  user_agent text,
  reason text,
  meta jsonb
);
alter table public.message_audit_log enable row level security;

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  reporter_id uuid references auth.users(id) on delete set null,
  reason text not null check (reason in (
    'inappropriate_content', 'confidential_information', 'harassment',
    'misinformation', 'security_concern', 'wrong_recipient', 'other'
  )),
  details text,
  status text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'dismissed')),
  resolution_note text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.message_reports enable row level security;

create table if not exists public.message_holds (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('conversation', 'channel', 'group', 'message')),
  scope_id uuid not null,
  created_by uuid references auth.users(id) on delete set null,
  reason text not null,
  start_date timestamptz not null default now(),
  end_date timestamptz,
  status text not null default 'active' check (status in ('active', 'released')),
  released_by uuid references auth.users(id) on delete set null,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.message_holds enable row level security;

create table if not exists public.message_retention_policies (
  id uuid primary key default gen_random_uuid(),
  policy_key text not null unique,
  label text not null,
  retention_days int,
  is_forever boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  notes text
);
alter table public.message_retention_policies enable row level security;

create table if not exists public.message_exports (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  actor_name text,
  format text not null check (format in ('pdf', 'csv', 'json')),
  scope text not null,
  scope_id uuid,
  reason text,
  row_count int not null default 0,
  data_summary jsonb,
  file_path text,
  created_at timestamptz not null default now()
);
alter table public.message_exports enable row level security;

create index if not exists idx_msg_audit_message on public.message_audit_log(message_id);
create index if not exists idx_msg_audit_timestamp on public.message_audit_log(timestamp);
create index if not exists idx_msg_audit_entity on public.message_audit_log(entity_type, entity_id);
create index if not exists idx_msg_reports_message on public.message_reports(message_id);
create index if not exists idx_msg_reports_status on public.message_reports(status);
create index if not exists idx_msg_holds_scope on public.message_holds(scope, scope_id);
create index if not exists idx_msg_holds_status on public.message_holds(status);
create index if not exists idx_msg_exports_actor on public.message_exports(actor_id);

drop policy if exists "audit read_admin" on public.message_audit_log;
create policy "audit read_admin" on public.message_audit_log
  for select using (public.is_communication_admin());

drop policy if exists "reports read" on public.message_reports;
create policy "reports read" on public.message_reports
  for select using (reporter_id = auth.uid() or public.is_communication_admin());

drop policy if exists "reports insert" on public.message_reports;
create policy "reports insert" on public.message_reports
  for insert with check (reporter_id = auth.uid() and public.can_read_message(message_id));

drop policy if exists "holds read" on public.message_holds;
create policy "holds read" on public.message_holds
  for select using (public.is_communication_admin());

drop policy if exists "retention read" on public.message_retention_policies;
create policy "retention read" on public.message_retention_policies
  for select using (true);

drop policy if exists "exports read" on public.message_exports;
create policy "exports read" on public.message_exports
  for select using (actor_id = auth.uid() or public.is_communication_admin());

-- ============================================================
-- 7. CHAT_MESSAGES EXTENSION
-- ============================================================
-- thread_id is NOT NULL today; group/channel/announcement/thread
-- messages carry their own context, so the constraint is relaxed.
alter table public.chat_messages alter column thread_id drop not null;

alter table public.chat_messages
  add column if not exists message_type text not null default 'direct'
    check (message_type in ('direct', 'group', 'channel', 'announcement', 'thread', 'system')),
  add column if not exists group_id uuid references public.message_groups(id) on delete cascade,
  add column if not exists channel_id uuid references public.message_channels(id) on delete cascade,
  add column if not exists parent_message_id uuid references public.chat_messages(id) on delete set null,
  add column if not exists root_message_id uuid references public.chat_messages(id) on delete set null,
  add column if not exists title text,
  add column if not exists priority text check (priority in ('low', 'normal', 'high', 'urgent')),
  add column if not exists is_official boolean not null default false,
  add column if not exists is_pinned boolean not null default false,
  add column if not exists pinned_by uuid references auth.users(id) on delete set null,
  add column if not exists pinned_at timestamptz,
  add column if not exists restricted_status text not null default 'active'
    check (restricted_status in ('active', 'restricted', 'deleted')),
  add column if not exists restricted_by uuid references auth.users(id) on delete set null,
  add column if not exists restricted_reason text,
  add column if not exists restricted_at timestamptz,
  add column if not exists edited boolean not null default false,
  add column if not exists edited_at timestamptz,
  add column if not exists edit_count int not null default 0,
  add column if not exists content_hash text,
  add column if not exists previous_hash text,
  add column if not exists message_seq bigint;

create index if not exists idx_chat_messages_group on public.chat_messages(group_id, created_at asc);
create index if not exists idx_chat_messages_channel on public.chat_messages(channel_id, created_at asc);
create index if not exists idx_chat_messages_parent on public.chat_messages(parent_message_id);
create index if not exists idx_chat_messages_root on public.chat_messages(root_message_id);
create index if not exists idx_chat_messages_type on public.chat_messages(message_type);
create index if not exists idx_chat_messages_official on public.chat_messages(is_official)
  where is_official = true;
create index if not exists idx_chat_messages_restricted on public.chat_messages(restricted_status)
  where restricted_status <> 'active';
create index if not exists idx_chat_messages_pinned on public.chat_messages(is_pinned)
  where is_pinned = true;

-- Replace the original Chat RLS with context-aware policies.
drop policy if exists "chat_messages read own" on public.chat_messages;
create policy "chat_messages read own" on public.chat_messages
  for select using (public.can_read_message(id));

-- Direct inserts are only allowed for contexts the sender is a member of.
-- Announcements and system messages are exclusively created by SECURITY
-- DEFINER RPCs, so they are blocked at the RLS level here.
drop policy if exists "chat_messages insert own" on public.chat_messages;
create policy "chat_messages insert own" on public.chat_messages
  for insert with check (
    sender_id = auth.uid()
    and message_type not in ('announcement', 'system')
    and (
      (message_type in ('direct', 'thread') and public.is_thread_participant(thread_id))
      or (message_type = 'group' and public.is_group_member(group_id))
      or (message_type = 'channel' and public.is_channel_member(channel_id))
    )
  );

drop policy if exists "chat_messages update own" on public.chat_messages;
create policy "chat_messages update own" on public.chat_messages
  for update using (sender_id = auth.uid());

-- NO DELETE policy — users can never physically delete messages.

-- ============================================================
-- 8. INTEGRITY + IMMUTABILITY TRIGGERS
-- ============================================================
-- Tamper-evident chain: content_hash = sha256( sender | body | seq | prev_hash )
-- message_seq is a monotonic per-conversation sequence.
create or replace function public.trg_chat_messages_hash()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_context text;
  v_prev record;
  v_seq bigint;
begin
  new.created_at := coalesce(new.created_at, now());
  if new.message_type is null then
    new.message_type := 'direct';
  end if;

  v_context := coalesce(new.thread_id::text, new.group_id::text, new.channel_id::text, 'node');
  select content_hash, message_seq into v_prev
  from public.chat_messages
  where coalesce(thread_id::text, group_id::text, channel_id::text, 'node') = v_context
  order by created_at desc, id desc
  limit 1;

  v_seq := coalesce(v_prev.message_seq, 0) + 1;
  new.message_seq := v_seq;
  new.previous_hash := v_prev.content_hash;
  new.content_hash := encode(
    digest(
      new.sender_id::text || '|' || coalesce(new.body, '') || '|' || v_seq::text || '|' || coalesce(v_prev.content_hash, 'root'),
      'sha256'
    ), 'hex'
  );

  return new;
end; $$;

drop trigger if exists trg_chat_messages_hash on public.chat_messages;
create trigger trg_chat_messages_hash
  before insert on public.chat_messages
  for each row execute function public.trg_chat_messages_hash();

-- IMMUTABILITY: official / announcement records reject ANY update or delete.
-- Ordinary messages may be edited by their sender; the original body is
-- preserved in message_revisions BEFORE the row is written.
create or replace function public.trg_chat_messages_immutable()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_new_body text;
begin
  if tg_op = 'DELETE' then
    if old.is_official or old.message_type = 'announcement' then
      raise exception 'Official communication records are immutable and cannot be deleted';
    end if;
    raise exception 'Communication records are append-only. Use soft removal instead';
  end if;

  if tg_op = 'UPDATE' then
    if old.is_official or old.message_type = 'announcement' then
      if new.body is distinct from old.body
         or new.message_type is distinct from old.message_type
         or new.sender_id is distinct from old.sender_id
         or new.is_official is distinct from old.is_official
         or new.is_pinned is distinct from old.is_pinned
         or new.restricted_status is distinct from old.restricted_status then
        raise exception 'Official communication records are immutable';
      end if;
      return new;
    end if;

    -- Defensive: integrity/identity columns can never be changed by a
    -- direct table UPDATE (only security-definer RPCs may touch the row).
    -- is_official is a one-way door: false -> true (mark official) is the
    -- only permitted change and is done exclusively by mark_message_official(),
    -- which is a SECURITY DEFINER RPC guarded by is_communication_admin().
    -- A raw UPDATE attempt is rejected unless the caller is verified here.
    if new.sender_id is distinct from old.sender_id
       or new.message_type is distinct from old.message_type
       or (new.is_official is distinct from old.is_official
           and not (old.is_official is false and new.is_official is true
                    and public.is_communication_admin()))
       or new.content_hash is distinct from old.content_hash
       or new.previous_hash is distinct from old.previous_hash
       or new.message_seq is distinct from old.message_seq
       or new.thread_id is distinct from old.thread_id
       or new.group_id is distinct from old.group_id
       or new.channel_id is distinct from old.channel_id
       or new.parent_message_id is distinct from old.parent_message_id
       or new.root_message_id is distinct from old.root_message_id then
      raise exception 'Protected column cannot be modified';
    end if;

    -- Preserve the original body before any edit is allowed to land.
    if new.body is distinct from old.body then
      insert into public.message_revisions (message_id, previous_body, new_body, edited_by, edited_at)
      values (old.id, old.body, new.body, old.sender_id, now());
      new.edited := true;
      new.edited_at := now();
      new.edit_count := coalesce(old.edit_count, 0) + 1;
      -- recompute the hash chain for the edited row
      new.content_hash := encode(
        digest(
          old.sender_id::text || '|' || coalesce(new.body, '') || '|' || old.message_seq::text || '|' || old.previous_hash,
          'sha256'
        ), 'hex'
      );
    end if;
    return new;
  end if;

  return new;
end; $$;

drop trigger if exists trg_chat_messages_immutable on public.chat_messages;
create trigger trg_chat_messages_immutable
  before update or delete on public.chat_messages
  for each row execute function public.trg_chat_messages_immutable();

-- AUDIT on create/restrict of messages (automated, never trusts the client).
create or replace function public.trg_chat_messages_audit()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_communication_audit(
      'message', new.id, 'message_created', new.id,
      null, jsonb_build_object('body', new.body, 'message_type', new.message_type),
      null
    );
  elsif tg_op = 'UPDATE' then
    if new.body is distinct from old.body then
      perform public.write_communication_audit(
        'message', new.id, 'message_edited', new.id,
        jsonb_build_object('body', old.body),
        jsonb_build_object('body', new.body),
        null
      );
    end if;
    if new.is_pinned and not old.is_pinned then
      perform public.write_communication_audit(
        'message', new.id, 'message_pinned', new.id,
        jsonb_build_object('is_pinned', old.is_pinned),
        jsonb_build_object('is_pinned', new.is_pinned),
        null
      );
    elsif not new.is_pinned and old.is_pinned then
      perform public.write_communication_audit(
        'message', new.id, 'message_unpinned', new.id,
        jsonb_build_object('is_pinned', old.is_pinned),
        jsonb_build_object('is_pinned', new.is_pinned),
        null
      );
    end if;
    if new.restricted_status is distinct from old.restricted_status then
      perform public.write_communication_audit(
        'message', new.id, 'message_restricted', new.id,
        jsonb_build_object('restricted_status', old.restricted_status),
        jsonb_build_object('restricted_status', new.restricted_status,
                           'reason', new.restricted_reason),
        new.restricted_reason
      );
    end if;
  end if;
  return coalesce(new, old);
end; $$;

drop trigger if exists trg_chat_messages_audit on public.chat_messages;
create trigger trg_chat_messages_audit
  after insert or update on public.chat_messages
  for each row execute function public.trg_chat_messages_audit();

-- ============================================================
-- 9. REALTIME PUBLICATION
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'message_groups', 'message_group_members',
    'message_channels', 'message_channel_members',
    'announcements', 'announcement_audience', 'message_acknowledgements',
    'message_revisions', 'message_reactions', 'message_reads',
    'message_mentions', 'message_bookmarks', 'message_tasks'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ============================================================
-- 10. GROUP RPCs
-- ============================================================

create or replace function public.create_message_group(
  p_name text,
  p_description text default null,
  p_member_ids uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_group_id uuid;
  v_name text := btrim(p_name);
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if v_name = '' then raise exception 'Group name is required'; end if;

  insert into public.message_groups (name, description, creator_id)
  values (v_name, nullif(p_description, ''), v_me)
  returning id into v_group_id;

  insert into public.message_group_members (group_id, member_id, role, added_by)
  values (v_group_id, v_me, 'owner', v_me);

  if p_member_ids is not null then
    insert into public.message_group_members (group_id, member_id, role, added_by)
    select v_group_id, u.id, 'member', v_me
    from unnest(p_member_ids) as u(id)
    where u.id is distinct from v_me
    on conflict (group_id, member_id) do nothing;
  end if;

  insert into public.notifications (user_id, title, message, type, link)
  select m.member_id, 'Group Created',
         format('You were added to the group %s', v_name), 'chat', '/chat'
  from public.message_group_members m
  where m.group_id = v_group_id and m.member_id <> v_me;

  perform public.write_communication_audit(
    'group', v_group_id, 'group_created', null,
    null, jsonb_build_object('name', v_name, 'creator', v_me), null
  );

  return jsonb_build_object('ok', true, 'id', v_group_id, 'name', v_name);
end; $$;
grant execute on function public.create_message_group(text, text, uuid[]) to authenticated;

create or replace function public.update_message_group(
  p_group_id uuid,
  p_name text default null,
  p_description text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_current record;
  v_updates text[] := '{}';
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role is null then raise exception 'You are not a member of this group'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Only the group owner or an admin can update the group'; end if;

  select * into v_current from public.message_groups where id = p_group_id;
  if v_current.id is null then raise exception 'Group not found'; end if;

  if p_name is distinct from null and btrim(p_name) <> '' and btrim(p_name) <> v_current.name then
    update public.message_groups set name = btrim(p_name), updated_at = now() where id = p_group_id;
    v_updates := v_updates || 'name';
  end if;
  if p_description is distinct from null and nullif(p_description, '') is distinct from v_current.description then
    update public.message_groups set description = nullif(p_description, ''), updated_at = now() where id = p_group_id;
    v_updates := v_updates || 'description';
  end if;

  perform public.write_communication_audit(
    'group', p_group_id, 'group_updated', null,
    jsonb_build_object('name', v_current.name, 'description', v_current.description),
    jsonb_build_object('name', p_name, 'description', p_description), 'group settings changed'
  );

  return jsonb_build_object('ok', true, 'updated', v_updates);
end; $$;
grant execute on function public.update_message_group(uuid, text, text) to authenticated;

create or replace function public.set_group_avatar(p_group_id uuid, p_avatar_url text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role is null then raise exception 'Not a member'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Not authorized'; end if;
  update public.message_groups set avatar_url = p_avatar_url, updated_at = now() where id = p_group_id;
  perform public.write_communication_audit('group', p_group_id, 'group_avatar_changed', null, null, jsonb_build_object('avatar_url', p_avatar_url), 'avatar updated');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.set_group_avatar(uuid, text) to authenticated;

create or replace function public.add_group_member(p_group_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.group_member_role(p_group_id);
  if v_role is null then raise exception 'You are not a member of this group'; end if;
  if v_role not in ('owner', 'admin', 'moderator') then raise exception 'Not authorized to add members'; end if;

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
  if v_role is null then raise exception 'You are not a member of this group'; end if;

  if p_member_id = v_me then
    -- self-leave (owner can leave too; the group remains)
    delete from public.message_group_members where group_id = p_group_id and member_id = v_me;
    perform public.write_communication_audit('group', p_group_id, 'group_member_left', null, null, jsonb_build_object('member_id', v_me), 'member left');
    return jsonb_build_object('ok', true);
  end if;

  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can remove members'; end if;
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
  if v_role is null then raise exception 'You are not a member of this group'; end if;
  if v_role not in ('owner') then raise exception 'Only the group owner can change member roles'; end if;

  select role into v_prev from public.message_group_members where group_id = p_group_id and member_id = p_member_id;
  if v_prev is null then raise exception 'Member not found in group'; end if;

  update public.message_group_members set role = p_role where group_id = p_group_id and member_id = p_member_id;
  perform public.write_communication_audit(
    'group', p_group_id, 'group_member_role_changed', null,
    jsonb_build_object('member_id', p_member_id, 'role', v_prev),
    jsonb_build_object('member_id', p_member_id, 'role', p_role), 'member role changed'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.update_group_member_role(uuid, uuid, text) to authenticated;

-- ============================================================
-- 11. CHANNEL RPCs
-- ============================================================

create or replace function public.create_message_channel(
  p_name text,
  p_display_name text default null,
  p_description text default null,
  p_channel_type text default 'team',
  p_is_auto boolean default false,
  p_auto_source text default null,
  p_auto_source_id uuid default null,
  p_auto_source_role text default null,
  p_member_ids uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_channel_id uuid;
  v_slug text := lower(regexp_replace(btrim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if btrim(p_name) = '' then raise exception 'Channel name is required'; end if;
  if p_channel_type not in ('organization','department','branch','area','team','private','announcement') then
    raise exception 'Invalid channel type';
  end if;

  insert into public.message_channels (
    name, display_name, description, channel_type, creator_id,
    is_auto, auto_source, auto_source_id, auto_source_role
  ) values (
    v_slug, coalesce(nullif(p_display_name, ''), btrim(p_name)), nullif(p_description, ''),
    p_channel_type, v_me, p_is_auto, p_auto_source, p_auto_source_id, p_auto_source_role
  )
  returning id into v_channel_id;

  insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
  values (v_channel_id, v_me, 'owner', v_me, false);

  -- auto channels: sync membership from the org hierarchy now
  if p_is_auto then
    perform public.sync_auto_channel_members(v_channel_id);
  elsif p_member_ids is not null then
    insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
    select v_channel_id, u.id, 'member', v_me, false
    from unnest(p_member_ids) as u(id)
    where u.id is distinct from v_me
    on conflict (channel_id, member_id) do nothing;
  end if;

  perform public.write_communication_audit(
    'channel', v_channel_id, 'channel_created', null,
    null, jsonb_build_object('name', v_slug, 'type', p_channel_type,
                             'is_auto', p_is_auto, 'auto_source', p_auto_source), 'channel created'
  );

  return jsonb_build_object('ok', true, 'id', v_channel_id, 'name', v_slug);
end; $$;
grant execute on function public.create_message_channel(text, text, text, text, boolean, text, uuid, text, uuid[]) to authenticated;

-- Sync membership of an auto channel from the organizational hierarchy.
create or replace function public.sync_auto_channel_members(p_channel_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_channel record;
  v_added int := 0;
begin
  select * into v_channel from public.message_channels where id = p_channel_id;
  if v_channel.id is null then raise exception 'Channel not found'; end if;
  if not v_channel.is_auto then raise exception 'Channel is not an auto channel'; end if;

  if v_channel.auto_source = 'branch' then
    insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
    select p_channel_id, e.user_id, 'member', auth.uid(), true
    from public.employees e
    where e.branch_id = v_channel.auto_source_id
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
    on conflict (channel_id, member_id) do nothing;

  elsif v_channel.auto_source = 'area' then
    insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
    select p_channel_id, e.user_id, 'member', auth.uid(), true
    from public.employees e
    join public.branch_area_assignments ba
      on ba.branch_id = e.branch_id and ba.is_current
    where ba.area_id = v_channel.auto_source_id
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
    on conflict (channel_id, member_id) do nothing;

  elsif v_channel.auto_source = 'department' then
    insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
    select p_channel_id, e.user_id, 'member', auth.uid(), true
    from public.employees e
    where upper(btrim(coalesce(e.department, ''))) = upper(btrim(coalesce(v_channel.auto_source_role, '')))
      and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
    on conflict (channel_id, member_id) do nothing;

  elsif v_channel.auto_source = 'role' then
    if v_channel.auto_source_role = 'all' then
      insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
      select p_channel_id, p.id, 'member', auth.uid(), true
      from public.profiles p
      where p.status = 'active' and p.role <> 'customer'
      on conflict (channel_id, member_id) do nothing;
    elsif v_channel.auto_source_role = 'management' then
      insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
      select p_channel_id, p.id, 'member', auth.uid(), true
      from public.profiles p
      where p.role in ('super_admin', 'admin', 'head_of_business', 'operations_manager', 'branch_manager', 'area_manager')
        and p.status = 'active'
      on conflict (channel_id, member_id) do nothing;
    elsif v_channel.auto_source_role = 'executive' then
      insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
      select p_channel_id, p.id, 'member', auth.uid(), true
      from public.profiles p
      where p.role in ('super_admin', 'admin', 'head_of_business')
        and p.status = 'active'
      on conflict (channel_id, member_id) do nothing;
    elsif v_channel.auto_source_role = 'hr' then
      insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
      select p_channel_id, p.id, 'member', auth.uid(), true
      from public.profiles p
      where p.role in ('hr_manager', 'hr_officer', 'super_admin', 'admin')
        and p.status = 'active'
      on conflict (channel_id, member_id) do nothing;
    else
      insert into public.message_channel_members (channel_id, member_id, role, added_by, auto_added)
      select p_channel_id, p.id, 'member', auth.uid(), true
      from public.profiles p
      where p.role = v_channel.auto_source_role and p.status = 'active'
      on conflict (channel_id, member_id) do nothing;
    end if;
  end if;

  select count(*) into v_added
  from public.message_channel_members where channel_id = p_channel_id;

  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_members_synced', null,
    null, jsonb_build_object('member_count', v_added), 'auto membership sync'
  );

  return jsonb_build_object('ok', true, 'channel_id', p_channel_id, 'member_count', v_added);
end; $$;
grant execute on function public.sync_auto_channel_members(uuid) to authenticated;

-- ensure_organizational_channels: create (if missing) + sync all channels
-- derived from the existing branch/area/department/role hierarchy.
create or replace function public.ensure_organizational_channels()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_created int := 0;
  v_total int := 0;
  v_slug text;
  v_id uuid;
  v_channel record;
  v_named record;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not public.is_communication_admin() then raise exception 'Not authorized'; end if;

  -- branches
  for v_channel in select * from public.branches where status = 'active' loop
    v_slug := 'branch-' || lower(regexp_replace(coalesce(v_channel.branch_name, ''), '[^a-zA-Z0-9]+', '-', 'g'));
    select id into v_id from public.message_channels where name = v_slug;
    if v_id is null then
      insert into public.message_channels (name, display_name, description, channel_type, creator_id, is_auto, auto_source, auto_source_id)
      values (v_slug, v_channel.branch_name, format('Official channel for %s', v_channel.branch_name), 'branch', v_me, true, 'branch', v_channel.id)
      returning id into v_id;
      v_created := v_created + 1;
    end if;
    perform public.sync_auto_channel_members(v_id);
    v_total := v_total + 1;
  end loop;

  -- areas
  for v_channel in select * from public.areas where is_active loop
    v_slug := 'area-' || lower(regexp_replace(coalesce(v_channel.area_code, ''), '[^a-zA-Z0-9]+', '-', 'g'));
    select id into v_id from public.message_channels where name = v_slug;
    if v_id is null then
      insert into public.message_channels (name, display_name, description, channel_type, creator_id, is_auto, auto_source, auto_source_id)
      values (v_slug, v_channel.area_code, format('Official channel for %s', v_channel.area_code), 'area', v_me, true, 'area', v_channel.id)
      returning id into v_id;
      v_created := v_created + 1;
    end if;
    perform public.sync_auto_channel_members(v_id);
    v_total := v_total + 1;
  end loop;

  -- departments
  for v_channel in select * from public.departments where is_active loop
    v_slug := 'dept-' || lower(regexp_replace(coalesce(v_channel.code, ''), '[^a-zA-Z0-9]+', '-', 'g'));
    select id into v_id from public.message_channels where name = v_slug;
    if v_id is null then
      insert into public.message_channels (name, display_name, description, channel_type, creator_id, is_auto, auto_source, auto_source_id, auto_source_role)
      values (v_slug, v_channel.name, format('Official channel for %s', v_channel.name), 'department', v_me, true, 'department', null, v_channel.code)
      returning id into v_id;
      v_created := v_created + 1;
    end if;
    perform public.sync_auto_channel_members(v_id);
    v_total := v_total + 1;
  end loop;

  -- named role/org channels
  for v_named in select * from (values
    ('general', 'General', 'Company-wide general communication', 'organization', 'all'),
    ('hr-announcements', 'HR Announcements', 'Official human resources announcements', 'announcement', 'hr'),
    ('management', 'Management', 'Management coordination channel', 'organization', 'management'),
    ('branch-managers', 'Branch Managers', 'All branch managers', 'team', 'branch_manager'),
    ('area-managers', 'Area Managers', 'All area managers', 'team', 'area_manager'),
    ('executive-management', 'Executive Management', 'Executive management channel', 'organization', 'executive')
  ) as t(name, display, descr, ctype, role) loop
    select id into v_id from public.message_channels where name = v_named.name;
    if v_id is null then
      insert into public.message_channels (name, display_name, description, channel_type, creator_id, is_auto, auto_source, auto_source_role)
      values (v_named.name, v_named.display, v_named.descr, v_named.ctype, v_me, true, 'role', v_named.role)
      returning id into v_id;
      v_created := v_created + 1;
    end if;
    perform public.sync_auto_channel_members(v_id);
    v_total := v_total + 1;
  end loop;

  perform public.write_communication_audit(
    'channel', null, 'organizational_channels_ensured', null,
    null, jsonb_build_object('created', v_created, 'synced', v_total), 'auto channel bootstrap'
  );

  return jsonb_build_object('ok', true, 'created', v_created, 'synced_channels', v_total);
end; $$;
grant execute on function public.ensure_organizational_channels() to authenticated;

-- Add / remove / role-change channel members.
create or replace function public.add_channel_member(p_channel_id uuid, p_member_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role is null then raise exception 'You are not a member of this channel'; end if;
  if v_role not in ('owner', 'admin', 'moderator') then raise exception 'Not authorized to add members'; end if;

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
  if v_role is null then raise exception 'You are not a member of this channel'; end if;

  if p_member_id = v_me then
    delete from public.message_channel_members where channel_id = p_channel_id and member_id = v_me;
    perform public.write_communication_audit('channel', p_channel_id, 'channel_member_left', null, null, jsonb_build_object('member_id', v_me), 'member left');
    return jsonb_build_object('ok', true);
  end if;

  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can remove members'; end if;
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
  if v_role is null then raise exception 'You are not a member of this channel'; end if;
  if v_role <> 'owner' then raise exception 'Only the channel owner can change member roles'; end if;

  select role into v_prev from public.message_channel_members where channel_id = p_channel_id and member_id = p_member_id;
  if v_prev is null then raise exception 'Member not found in channel'; end if;

  update public.message_channel_members set role = p_role where channel_id = p_channel_id and member_id = p_member_id;
  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_member_role_changed', null,
    jsonb_build_object('member_id', p_member_id, 'role', v_prev),
    jsonb_build_object('member_id', p_member_id, 'role', p_role), 'member role changed'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.update_channel_member_role(uuid, uuid, text) to authenticated;

create or replace function public.update_message_channel(
  p_channel_id uuid,
  p_display_name text default null,
  p_description text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_role text;
  v_cur record;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role is null then raise exception 'You are not a member of this channel'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Only the owner or an admin can update this channel'; end if;

  select * into v_cur from public.message_channels where id = p_channel_id;
  update public.message_channels
  set display_name = coalesce(nullif(p_display_name, ''), display_name),
      description = coalesce(p_description, description),
      updated_at = now()
  where id = p_channel_id;

  perform public.write_communication_audit(
    'channel', p_channel_id, 'channel_updated', null,
    jsonb_build_object('display_name', v_cur.display_name, 'description', v_cur.description),
    jsonb_build_object('display_name', p_display_name, 'description', p_description), 'channel updated'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.update_message_channel(uuid, text, text) to authenticated;

create or replace function public.set_channel_avatar(p_channel_id uuid, p_avatar_url text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  v_role := public.channel_member_role(p_channel_id);
  if v_role is null then raise exception 'Not a member'; end if;
  if v_role not in ('owner', 'admin') then raise exception 'Not authorized'; end if;
  update public.message_channels set avatar_url = p_avatar_url, updated_at = now() where id = p_channel_id;
  perform public.write_communication_audit('channel', p_channel_id, 'channel_avatar_changed', null, null, jsonb_build_object('avatar_url', p_avatar_url), 'avatar updated');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.set_channel_avatar(uuid, text) to authenticated;

-- ============================================================
-- 12. MESSAGE RPCs (group / channel / threads)
-- ============================================================

-- Generic send for group + channel + thread replies.
create or replace function public.send_group_channel_message(
  p_message_type text,
  p_context_id uuid,
  p_body text,
  p_parent_message_id uuid default null,
  p_root_message_id uuid default null,
  p_title text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_parent public.chat_messages%rowtype;
  v_group_id uuid;
  v_channel_id uuid;
  v_root uuid;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if btrim(coalesce(p_body, '')) = '' then raise exception 'Message body required'; end if;
  if p_message_type not in ('group', 'channel', 'thread') then raise exception 'Invalid message type'; end if;

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
    select * into v_parent from public.chat_messages where id = p_parent_message_id;
    v_group_id := v_parent.group_id;
    v_channel_id := v_parent.channel_id;
    v_root := coalesce(p_root_message_id, v_parent.root_message_id, p_parent_message_id);
  end if;

  insert into public.chat_messages (
    message_type, group_id, channel_id, thread_id, sender_id, body,
    parent_message_id, root_message_id, status, title
  ) values (
    p_message_type, v_group_id, v_channel_id,
    null::uuid,
    v_me, btrim(p_body),
    p_parent_message_id, v_root,
    'sent', nullif(p_title, '')
  )
  returning * into v_msg;

  return jsonb_build_object(
    'ok', true, 'id', v_msg.id,
    'message_type', v_msg.message_type,
    'body', v_msg.body,
    'created_at', v_msg.created_at,
    'group_id', v_msg.group_id,
    'channel_id', v_msg.channel_id,
    'parent_message_id', v_msg.parent_message_id,
    'root_message_id', v_msg.root_message_id,
    'content_hash', v_msg.content_hash,
    'message_seq', v_msg.message_seq
  );
end; $$;
grant execute on function public.send_group_channel_message(text, uuid, text, uuid, uuid, text) to authenticated;

-- Direct sends keep using the existing send_chat_message(); here we add an
-- overload that also returns the hash fields.
create or replace function public.send_chat_message_v2(p_thread_id uuid, p_body text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if btrim(coalesce(p_body, '')) = '' then raise exception 'Message body required'; end if;

  if not exists (
    select 1 from public.chat_threads t
    where t.id = p_thread_id and (t.member_a = v_me or t.member_b = v_me)
  ) then
    raise exception 'Not authorized in this thread';
  end if;

  insert into public.chat_messages (thread_id, sender_id, body, status, message_type)
  values (p_thread_id, v_me, btrim(p_body), 'sent', 'direct')
  returning * into v_msg;

  update public.chat_threads
    set last_message = btrim(p_body), last_sender_id = v_me, last_message_at = now(), updated_at = now()
    where id = p_thread_id;

  insert into public.notifications (user_id, title, message, type, link)
  select case when member_a = v_me then member_b else member_a end,
         'New Message', left(btrim(p_body), 120), 'chat', '/chat'
  from public.chat_threads where id = p_thread_id;

  return jsonb_build_object(
    'ok', true, 'id', v_msg.id,
    'message_type', v_msg.message_type,
    'body', v_msg.body,
    'created_at', v_msg.created_at,
    'thread_id', v_msg.thread_id,
    'content_hash', v_msg.content_hash,
    'message_seq', v_msg.message_seq
  );
end; $$;
grant execute on function public.send_chat_message_v2(uuid, text) to authenticated;

-- Send a message with mention notification support.
create or replace function public.send_mention_message(
  p_message_type text,
  p_context_id uuid,
  p_body text,
  p_mention_ids uuid[] default null,
  p_parent_message_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_res jsonb;
  v_msg_id uuid;
  v_mention uuid;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  v_res := public.send_group_channel_message(p_message_type, p_context_id, p_body, p_parent_message_id);
  v_msg_id := (v_res ->> 'id')::uuid;

  if p_mention_ids is not null then
    foreach v_mention in array p_mention_ids loop
      if v_mention is distinct from v_me then
        insert into public.message_mentions (message_id, user_id, mention_type)
        values (v_msg_id, v_mention, 'employee')
        on conflict (message_id, user_id, mention_type) do nothing;

        insert into public.notifications (user_id, title, message, type, link)
        values (v_mention, 'You were mentioned', left(p_body, 120), 'chat', '/chat');
      end if;
    end loop;
  end if;

  return v_res;
end; $$;
grant execute on function public.send_mention_message(text, uuid, text, uuid[], uuid) to authenticated;

-- Edit an ordinary message (sender only, never official, revisions preserved).
create or replace function public.edit_my_message(p_message_id uuid, p_new_body text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if btrim(coalesce(p_new_body, '')) = '' then raise exception 'New body required'; end if;

  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if v_msg.sender_id <> v_me then raise exception 'You can only edit your own messages'; end if;
  if v_msg.message_type = 'announcement' or v_msg.is_official then
    raise exception 'Official communication records are immutable';
  end if;

  update public.chat_messages set body = btrim(p_new_body) where id = p_message_id;

  return jsonb_build_object('ok', true, 'id', p_message_id, 'edited', true);
end; $$;
grant execute on function public.edit_my_message(uuid, text) to authenticated;

-- Pin / unpin in group or channel contexts (owner/admin/moderator).
create or replace function public.pin_message(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;

  if v_msg.message_type = 'group' then
    v_role := public.group_member_role(v_msg.group_id);
  elsif v_msg.message_type = 'channel' then
    v_role := public.channel_member_role(v_msg.channel_id);
  end if;
  if v_msg.message_type not in ('group', 'channel') then raise exception 'Only group and channel messages can be pinned'; end if;
  if v_role is null or v_role not in ('owner', 'admin', 'moderator') then raise exception 'Not authorized to pin messages'; end if;

  update public.chat_messages set is_pinned = true, pinned_by = v_me, pinned_at = now() where id = p_message_id;
  return jsonb_build_object('ok', true, 'pinned', true);
end; $$;
grant execute on function public.pin_message(uuid) to authenticated;

create or replace function public.unpin_message(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if v_msg.message_type = 'group' then v_role := public.group_member_role(v_msg.group_id);
  elsif v_msg.message_type = 'channel' then v_role := public.channel_member_role(v_msg.channel_id);
  end if;
  if v_msg.message_type not in ('group', 'channel') then raise exception 'Only group and channel messages can be unpinned'; end if;
  if v_role is null or v_role not in ('owner', 'admin', 'moderator') then raise exception 'Not authorized to unpin messages'; end if;

  update public.chat_messages set is_pinned = false, pinned_by = null, pinned_at = null where id = p_message_id;
  return jsonb_build_object('ok', true, 'pinned', false);
end; $$;
grant execute on function public.unpin_message(uuid) to authenticated;

-- Bookmark (save) a message for the current user.
create or replace function public.toggle_bookmark(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not public.can_read_message(p_message_id) then raise exception 'Not authorized to access this message'; end if;

  if exists (select 1 from public.message_bookmarks where message_id = p_message_id and user_id = v_me) then
    delete from public.message_bookmarks where message_id = p_message_id and user_id = v_me;
    perform public.write_communication_audit('message', p_message_id, 'message_unbookmarked', p_message_id, null, jsonb_build_object('bookmarked', false), 'unbookmarked');
    return jsonb_build_object('ok', true, 'bookmarked', false);
  else
    insert into public.message_bookmarks (message_id, user_id) values (p_message_id, v_me);
    perform public.write_communication_audit('message', p_message_id, 'message_bookmarked', p_message_id, null, jsonb_build_object('bookmarked', true), 'bookmarked');
    return jsonb_build_object('ok', true, 'bookmarked', true);
  end if;
end; $$;
grant execute on function public.toggle_bookmark(uuid) to authenticated;

-- Mark message as read (insert read receipt).
create or replace function public.mark_message_read(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not public.can_read_message(p_message_id) then raise exception 'Not authorized to access this message'; end if;

  insert into public.message_reads (message_id, user_id)
  values (p_message_id, v_me)
  on conflict (message_id, user_id) do nothing;

  if p_message_id is not null then
    update public.chat_messages set read_at = now() where id = p_message_id
      and message_type = 'direct' and sender_id is distinct from v_me;
  end if;
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.mark_message_read(uuid) to authenticated;

-- Mark as OFFICIAL (authorized admin/HR only). Makes the record immutable.
create or replace function public.mark_message_official(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not public.is_communication_admin() then raise exception 'Only authorized administrators can mark official records'; end if;

  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if v_msg.message_type = 'announcement' then raise exception 'Announcements are already official records'; end if;

  update public.chat_messages set is_official = true where id = p_message_id;
  perform public.write_communication_audit('message', p_message_id, 'message_marked_official', p_message_id, null, jsonb_build_object('is_official', true), 'marked official');
  return jsonb_build_object('ok', true, 'official', true);
end; $$;
grant execute on function public.mark_message_official(uuid) to authenticated;

-- Soft removal (moderation). Body preserved in the record; UI shows restricted.
create or replace function public.restrict_message(p_message_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
  v_role text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'A reason is required'; end if;

  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if v_msg.message_type = 'announcement' or v_msg.is_official then raise exception 'Official records cannot be restricted'; end if;

  -- moderators: communication admins, group/channel moderators
  if public.is_communication_admin() then
    null;
  elsif v_msg.message_type = 'group' then
    v_role := public.group_member_role(v_msg.group_id);
    if v_role is null or v_role not in ('owner', 'admin', 'moderator') then raise exception 'Not authorized to restrict this message'; end if;
  elsif v_msg.message_type = 'channel' then
    v_role := public.channel_member_role(v_msg.channel_id);
    if v_role is null or v_role not in ('owner', 'admin', 'moderator') then raise exception 'Not authorized to restrict this message'; end if;
  else
    if v_msg.sender_id <> v_me then raise exception 'Not authorized to restrict this message'; end if;
  end if;

  update public.chat_messages set restricted_status = 'restricted', restricted_by = v_me, restricted_reason = p_reason, restricted_at = now() where id = p_message_id;
  return jsonb_build_object('ok', true, 'restricted', true);
end; $$;
grant execute on function public.restrict_message(uuid, text) to authenticated;

-- Sender soft-deletes their own ordinary message (still never physical).
create or replace function public.soft_delete_my_message(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg public.chat_messages%rowtype;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  select * into v_msg from public.chat_messages where id = p_message_id;
  if v_msg.id is null then raise exception 'Message not found'; end if;
  if v_msg.sender_id <> v_me then raise exception 'You can only remove your own messages'; end if;
  if v_msg.message_type = 'announcement' or v_msg.is_official then raise exception 'Official records cannot be removed'; end if;

  update public.chat_messages set restricted_status = 'deleted', restricted_by = v_me, restricted_reason = 'deleted by sender', restricted_at = now() where id = p_message_id;
  return jsonb_build_object('ok', true, 'deleted', true);
end; $$;
grant execute on function public.soft_delete_my_message(uuid) to authenticated;

-- Report a message.
create or replace function public.report_message(p_message_id uuid, p_reason text, p_details text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_reason not in ('inappropriate_content','confidential_information','harassment','misinformation','security_concern','wrong_recipient','other') then
    raise exception 'Invalid report reason';
  end if;
  if not public.can_read_message(p_message_id) then raise exception 'Not authorized to access this message'; end if;

  insert into public.message_reports (message_id, reporter_id, reason, details)
  values (p_message_id, v_me, p_reason, nullif(p_details, ''));

  perform public.write_communication_audit('message', p_message_id, 'message_reported', p_message_id, null, jsonb_build_object('reason', p_reason), 'message reported');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.report_message(uuid, text, text) to authenticated;

-- Task / action item created from a message.
create or replace function public.create_message_task(
  p_message_id uuid,
  p_title text,
  p_description text default null,
  p_assigned_to uuid default null,
  p_due_date date default null,
  p_priority text default 'normal'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_task_id uuid;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if btrim(coalesce(p_title, '')) = '' then raise exception 'Task title required'; end if;
  if not public.can_read_message(p_message_id) then raise exception 'Not authorized to access the message'; end if;

  insert into public.message_tasks (message_id, title, description, assigned_to, due_date, priority, created_by)
  values (p_message_id, btrim(p_title), nullif(p_description, ''), p_assigned_to, p_due_date, p_priority, v_me)
  returning id into v_task_id;

  if p_assigned_to is not null then
    insert into public.notifications (user_id, title, message, type, link)
    values (p_assigned_to, 'New action item', p_title, 'task', '/my-work');
  end if;

  perform public.write_communication_audit(
    'message', p_message_id, 'message_task_created', p_message_id,
    null, jsonb_build_object('task_id', v_task_id, 'title', p_title), 'action item created from message'
  );
  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end; $$;
grant execute on function public.create_message_task(uuid, text, text, uuid, date, text) to authenticated;

create or replace function public.update_message_task(p_task_id uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_status not in ('pending', 'in_progress', 'completed', 'cancelled') then raise exception 'Invalid status'; end if;
  update public.message_tasks set status = p_status, updated_at = now(),
    completed_at = case when p_status = 'completed' then now() else completed_at end
  where id = p_task_id and (assigned_to = auth.uid() or created_by = auth.uid());
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.update_message_task(uuid, text, text) to authenticated;

-- ============================================================
-- 13. ANNOUNCEMENT RPCs
-- ============================================================

create or replace function public.publish_announcement(
  p_title text,
  p_body text,
  p_priority text default 'normal',
  p_target_type text default 'organization',
  p_target_value text default null,
  p_requires_ack boolean default false,
  p_effective_date timestamptz default now(),
  p_expiry_date timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg_id uuid;
  v_ann_id uuid;
  v_emp record;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not public.can_author_announcement() then raise exception 'Your role is not authorized to publish announcements'; end if;
  if btrim(p_title) = '' then raise exception 'Announcement title required'; end if;
  if btrim(p_body) = '' then raise exception 'Announcement body required'; end if;
  if p_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'Invalid priority'; end if;

  -- official immutable message record
  insert into public.chat_messages (message_type, sender_id, body, status, title, priority, is_official)
  values ('announcement', v_me, btrim(p_body), 'sent', btrim(p_title), p_priority, true)
  returning id into v_msg_id;

  insert into public.announcements (
    message_id, title, priority, target_type, target_value, author_id,
    effective_date, expiry_date, requires_ack, status, published_at
  ) values (
    v_msg_id, btrim(p_title), p_priority, p_target_type, nullif(p_target_value, ''), v_me,
    p_effective_date, p_expiry_date, p_requires_ack, 'published', now()
  )
  returning id into v_ann_id;

  -- resolve the audience from the org hierarchy (never duplicates employee data)
  if p_target_type = 'organization' then
    insert into public.announcement_audience (announcement_id, member_id)
    select v_ann_id, p.id from public.profiles p where p.status = 'active' and p.role <> 'customer'
    on conflict (announcement_id, member_id) do nothing;

  elsif p_target_type = 'branch' then
    insert into public.announcement_audience (announcement_id, member_id)
    select v_ann_id, e.user_id from public.employees e
    where e.branch_id::text = p_target_value and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
    on conflict (announcement_id, member_id) do nothing;

  elsif p_target_type = 'area' then
    insert into public.announcement_audience (announcement_id, member_id)
    select v_ann_id, e.user_id from public.employees e
    join public.branch_area_assignments ba on ba.branch_id = e.branch_id and ba.is_current
    where ba.area_id::text = p_target_value and e.user_id is not null
      and e.employment_status in ('active', 'on_leave')
    on conflict (announcement_id, member_id) do nothing;

  elsif p_target_type = 'department' then
    insert into public.announcement_audience (announcement_id, member_id)
    select v_ann_id, e.user_id from public.employees e
    where upper(btrim(coalesce(e.department, ''))) = upper(btrim(p_target_value))
      and e.user_id is not null and e.employment_status in ('active', 'on_leave')
    on conflict (announcement_id, member_id) do nothing;

  elsif p_target_type = 'role' then
    insert into public.announcement_audience (announcement_id, member_id)
    select v_ann_id, p.id from public.profiles p where p.role = p_target_value and p.status = 'active'
    on conflict (announcement_id, member_id) do nothing;

  elsif p_target_type = 'employees' then
    insert into public.announcement_audience (announcement_id, member_id)
    select v_ann_id, x::uuid
    from unnest(string_to_array(nullif(p_target_value, ''), ',')) as u(x)
    on conflict (announcement_id, member_id) do nothing;

  elsif p_target_type = 'channel' then
    insert into public.announcement_audience (announcement_id, member_id)
    select v_ann_id, m.member_id from public.message_channel_members m
    where m.channel_id::text = p_target_value
    on conflict (announcement_id, member_id) do nothing;
  end if;

  -- pre-create acknowledgement rows when acknowledgement is required
  if p_requires_ack then
    insert into public.message_acknowledgements (announcement_id, user_id)
    select v_ann_id, a.member_id from public.announcement_audience a where a.announcement_id = v_ann_id
    on conflict (announcement_id, user_id) do nothing;
  end if;

  -- notify the audience
  insert into public.notifications (user_id, title, message, type, link)
  select a.member_id, 'Announcement: ' || btrim(p_title), left(btrim(p_body), 140), 'announcement', '/chat?tab=announcements'
  from public.announcement_audience a where a.announcement_id = v_ann_id;

  perform public.write_communication_audit(
    'announcement', v_ann_id, 'announcement_published', v_msg_id,
    null, jsonb_build_object('title', p_title, 'priority', p_priority,
                             'target_type', p_target_type, 'target_value', p_target_value,
                             'requires_ack', p_requires_ack), 'announcement published'
  );

  return jsonb_build_object('ok', true, 'announcement_id', v_ann_id, 'message_id', v_msg_id);
end; $$;
grant execute on function public.publish_announcement(text, text, text, text, text, boolean, timestamptz, timestamptz) to authenticated;

-- Acknowledge an announcement (the ONLY way — direct insert is not possible).
create or replace function public.acknowledge_announcement(p_announcement_id uuid, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_count int;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  select count(*) into v_count from public.announcement_audience
  where announcement_id = p_announcement_id and member_id = v_me;

  if v_count = 0 then raise exception 'This announcement was not addressed to you'; end if;

  insert into public.message_acknowledgements (announcement_id, user_id, status, acknowledged_at, ip_address, user_agent)
  values (p_announcement_id, v_me, 'acknowledged', now(), p_ip, p_user_agent)
  on conflict (announcement_id, user_id)
  do update set status = 'acknowledged', acknowledged_at = now(), ip_address = p_ip, user_agent = p_user_agent, updated_at = now();

  perform public.write_communication_audit(
    'announcement', p_announcement_id, 'announcement_acknowledged', null,
    null, jsonb_build_object('announcement_id', p_announcement_id), 'acknowledged'
  );
  return jsonb_build_object('ok', true, 'acknowledged', true);
end; $$;
grant execute on function public.acknowledge_announcement(uuid, text, text) to authenticated;

-- Admin: acknowledgement status rollup for an announcement.
create or replace function public.get_announcement_ack_status(p_announcement_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_total int;
  v_ack int;
  v_me uuid := auth.uid();
  v_authorized boolean;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  select (author_id = v_me or public.is_communication_admin()) into v_authorized
  from public.announcements where id = p_announcement_id;
  if not coalesce(v_authorized, false) then raise exception 'Not authorized'; end if;

  select count(*) into v_total from public.announcement_audience where announcement_id = p_announcement_id;
  select count(*) into v_ack from public.message_acknowledgements
  where announcement_id = p_announcement_id and status = 'acknowledged';

  return jsonb_build_object(
    'total', v_total, 'acknowledged', v_ack, 'pending', v_total - v_ack,
    'pending_list', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', a.member_id))
      from public.announcement_audience a
      left join public.message_acknowledgements ac
        on ac.announcement_id = a.announcement_id and ac.user_id = a.member_id and ac.status = 'acknowledged'
      where a.announcement_id = p_announcement_id and ac.id is null
    ), '[]'::jsonb),
    'acknowledged_list', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', ac.user_id,
        'acknowledged_at', ac.acknowledged_at,
        'ip_address', ac.ip_address,
        'user_agent', ac.user_agent
      ) order by ac.acknowledged_at)
      from public.message_acknowledgements ac
      where ac.announcement_id = p_announcement_id and ac.status = 'acknowledged'
    ), '[]'::jsonb)
  );
end; $$;
grant execute on function public.get_announcement_ack_status(uuid) to authenticated;

-- ============================================================
-- 14. SEARCH (RLS-respecting, organization-wide)
-- ============================================================

create or replace function public.search_messages(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_limit int := 100;
  v_rows jsonb;
begin
  if v_me is null then return '[]'::jsonb; end if;

  with accessible as (
    select cm.id
    from public.chat_messages cm
    where
      cm.sender_id = v_me
      or (cm.message_type = 'direct' and exists (
            select 1 from public.chat_threads t
            where t.id = cm.thread_id and (t.member_a = v_me or t.member_b = v_me)))
      or (cm.message_type = 'group' and exists (
            select 1 from public.message_group_members gm
            where gm.group_id = cm.group_id and gm.member_id = v_me))
      or (cm.message_type = 'channel' and exists (
            select 1 from public.message_channel_members chm
            where chm.channel_id = cm.channel_id and chm.member_id = v_me))
      or (cm.message_type = 'announcement' and exists (
            select 1 from public.announcements an2
            join public.announcement_audience aud on aud.announcement_id = an2.id
            where an2.message_id = cm.id and (aud.member_id = v_me or an2.author_id = v_me)))
  ),
  matches as (
    select cm.*
    from public.chat_messages cm
    join accessible a on a.id = cm.id
    where 1 = 1
      -- restricted/deleted messages are hidden from org search
      and cm.restricted_status = 'active'
      and (p_query is null or p_query = ''
           or cm.body ilike '%' || p_query || '%'
           or coalesce(cm.title, '') ilike '%' || p_query || '%')
      and (p_filters->>'message_type' is null or cm.message_type = (p_filters->>'message_type'))
      and (p_filters->>'sender' is null or cm.sender_id::text = (p_filters->>'sender'))
      and (p_filters->>'group' is null or cm.group_id::text = (p_filters->>'group'))
      and (p_filters->>'channel' is null or cm.channel_id::text = (p_filters->>'channel'))
      and (p_filters->>'date_from' is null or cm.created_at >= (p_filters->>'date_from')::timestamptz)
      and (p_filters->>'date_to' is null or cm.created_at <= (p_filters->>'date_to')::timestamptz)
      and (p_filters->>'hashtag' is null or cm.body ilike '%#' || (p_filters->>'hashtag') || '%')
      and ((p_filters->>'announcement') is null
           or ((p_filters->>'announcement') = 'true' and cm.message_type = 'announcement')
           or ((p_filters->>'announcement') = 'false' and cm.message_type <> 'announcement'))
      and ((p_filters->>'official') is null
           or ((p_filters->>'official') = 'true' and cm.is_official)
           or ((p_filters->>'official') = 'false' and not cm.is_official))
    order by cm.created_at desc
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'message_type', m.message_type,
    'body', m.body,
    'title', m.title,
    'sender_id', m.sender_id,
    'created_at', m.created_at,
    'thread_id', m.thread_id,
    'group_id', m.group_id,
    'channel_id', m.channel_id,
    'parent_message_id', m.parent_message_id,
    'is_official', m.is_official,
    'is_pinned', m.is_pinned,
    'priority', m.priority,
    'restricted_status', m.restricted_status
  )), '[]'::jsonb) into v_rows
  from matches m;

  return coalesce(v_rows, '[]'::jsonb);
end; $$;
grant execute on function public.search_messages(text, jsonb) to authenticated;

-- ============================================================
-- 15. RETENTION / HOLDS / EXPORTS / STATS (authorized only)
-- ============================================================

create or replace function public.set_retention_policy(p_key text, p_label text, p_retention_days int, p_is_forever boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_communication_admin() then raise exception 'Not authorized'; end if;

  insert into public.message_retention_policies (policy_key, label, retention_days, is_forever, updated_by, updated_at, notes)
  values (p_key, p_label, p_retention_days, p_is_forever, auth.uid(), now(),
          'updated via platform settings')
  on conflict (policy_key) do update set
    label = excluded.label,
    retention_days = excluded.retention_days,
    is_forever = excluded.is_forever,
    updated_by = auth.uid(),
    updated_at = now();

  perform public.write_communication_audit(
    'retention', null, 'retention_policy_changed', null,
    null, jsonb_build_object('policy_key', p_key, 'days', p_retention_days, 'forever', p_is_forever), 'retention policy updated'
  );
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.set_retention_policy(text, text, int, boolean) to authenticated;

create or replace function public.create_message_hold(p_scope text, p_scope_id uuid, p_reason text, p_end_date timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_hold_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_communication_admin() then raise exception 'Not authorized'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'A reason is required for a retention hold'; end if;
  if p_scope not in ('conversation', 'channel', 'group', 'message') then raise exception 'Invalid scope'; end if;

  insert into public.message_holds (scope, scope_id, created_by, reason, end_date)
  values (p_scope, p_scope_id, auth.uid(), btrim(p_reason), p_end_date)
  returning id into v_hold_id;

  perform public.write_communication_audit(
    'hold', v_hold_id, 'hold_created', null,
    null, jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'reason', p_reason, 'end_date', p_end_date), 'retention hold placed'
  );
  return jsonb_build_object('ok', true, 'hold_id', v_hold_id);
end; $$;
grant execute on function public.create_message_hold(text, uuid, text, timestamptz) to authenticated;

create or replace function public.release_message_hold(p_hold_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_communication_admin() then raise exception 'Not authorized'; end if;

  update public.message_holds set status = 'released', released_by = auth.uid(), released_at = now(), release_reason = coalesce(p_reason, ''), updated_at = now()
  where id = p_hold_id;
  perform public.write_communication_audit('hold', p_hold_id, 'hold_released', null, null, jsonb_build_object('reason', p_reason), 'retention hold released');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.release_message_hold(uuid, text) to authenticated;

-- Export communication records (authorized roles only; every export is audited).
create or replace function public.create_message_export(
  p_format text,
  p_scope text,
  p_scope_id uuid default null,
  p_reason text default null,
  p_query text default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_rows jsonb;
  v_count int;
  v_export_id uuid;
  v_authorized boolean := false;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_format not in ('pdf', 'csv', 'json') then raise exception 'Invalid format'; end if;
  if not public.is_communication_admin() then raise exception 'Your role is not authorized to export communication records'; end if;

  -- Only export scopes the caller legitimately administers (or official records).
  if p_scope = 'channel' and p_scope_id is not null then
    select exists (
      select 1 from public.message_channels c
      where c.id = p_scope_id and (c.creator_id = v_me or public.is_communication_admin())
    ) into v_authorized;
  elsif p_scope = 'group' and p_scope_id is not null then
    v_authorized := public.is_group_member(p_scope_id) and public.is_communication_admin();
  elsif p_scope = 'announcement' and p_scope_id is not null then
    select exists (
      select 1 from public.announcements a where a.id = p_scope_id
        and (a.author_id = v_me or public.is_communication_admin())
    ) into v_authorized;
  elsif p_scope = 'search' then
    v_authorized := true;
  end if;

  if not coalesce(v_authorized, false) then
    raise exception 'Not authorized to export this communication scope';
  end if;

  -- gather the exported rows (respects the caller's own access rules)
  v_rows := public.search_messages(p_query, p_filters);
  select jsonb_array_length(v_rows) into v_count;

  insert into public.message_exports (actor_id, actor_name, format, scope, scope_id, reason, row_count, data_summary, created_at)
  values (v_me, (select full_name from public.profiles where id = v_me), p_format, p_scope, p_scope_id, p_reason, v_count,
          jsonb_build_object('filters', p_filters, 'query', p_query), now())
  returning id into v_export_id;

  perform public.write_communication_audit(
    'export', v_export_id, 'export_created', null,
    null, jsonb_build_object('format', p_format, 'scope', p_scope, 'scope_id', p_scope_id,
                             'reason', p_reason, 'row_count', v_count), 'communication export'
  );

  return jsonb_build_object('ok', true, 'export_id', v_export_id, 'format', p_format,
                            'row_count', v_count, 'data', v_rows);
end; $$;
grant execute on function public.create_message_export(text, text, uuid, text, text, jsonb) to authenticated;

-- Resolve a report (authorized only).
create or replace function public.resolve_message_report(p_report_id uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_communication_admin() then raise exception 'Not authorized'; end if;
  if p_status not in ('open', 'investigating', 'resolved', 'dismissed') then raise exception 'Invalid status'; end if;

  update public.message_reports set status = p_status, resolution_note = coalesce(p_note, resolution_note), resolved_by = auth.uid(), resolved_at = now()
  where id = p_report_id;
  perform public.write_communication_audit('report', p_report_id, 'report_resolved', null, null,
    jsonb_build_object('status', p_status, 'note', p_note), 'report resolved');
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.resolve_message_report(uuid, text, text) to authenticated;

-- Communication analytics. Organization-wide counts are authorized roles
-- only; non-admins receive a personal view and never see org totals.
create or replace function public.get_communication_stats()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_messages int;
  v_groups int;
  v_channels int;
  v_announcements int;
  v_ack_total int;
  v_ack_done int;
  v_reports int;
  v_official int;
  v_bookmarks int := 0;
begin
  if v_me is null then return null; end if;

  if public.is_communication_admin() then
    select count(*) into v_messages from public.chat_messages;
    select count(*) into v_groups from public.message_groups where status = 'active';
    select count(*) into v_channels from public.message_channels where status = 'active';
    select count(*) into v_announcements from public.announcements where status = 'published';
    select count(*) into v_ack_total from public.message_acknowledgements;
    select count(*) into v_ack_done from public.message_acknowledgements where status = 'acknowledged';
    select count(*) into v_reports from public.message_reports where status in ('open', 'investigating');
    select count(*) into v_official from public.chat_messages where is_official = true;
    select count(*) into v_bookmarks from public.message_bookmarks where user_id = v_me;

    return jsonb_build_object(
      'messages_sent', v_messages,
      'active_groups', v_groups,
      'active_channels', v_channels,
      'published_announcements', v_announcements,
      'ack_total', v_ack_total,
      'acknowledged', v_ack_done,
      'acknowledgement_rate', case when v_ack_total > 0 then round(100.0 * v_ack_done / v_ack_total, 1) else 0 end,
      'open_reports', v_reports,
      'official_records', v_official,
      'my_bookmarks', v_bookmarks,
      'unread_mandatory_announcements', (
        select count(distinct a.id) from public.announcements a
        join public.announcement_audience aud on aud.announcement_id = a.id
        left join public.message_acknowledgements ac
          on ac.announcement_id = a.id and ac.user_id = v_me and ac.status = 'acknowledged'
        where a.requires_ack and a.status = 'published' and aud.member_id = v_me and ac.id is null
      )
    );
  end if;

  -- Personal view (no org-wide totals).
  select count(*) into v_messages from public.chat_messages where sender_id = v_me;
  select count(*) into v_groups
  from public.message_group_members gm join public.message_groups g on g.id = gm.group_id
  where gm.member_id = v_me and g.status = 'active';
  select count(*) into v_channels
  from public.message_channel_members chm join public.message_channels ch on ch.id = chm.channel_id
  where chm.member_id = v_me and ch.status = 'active';
  select count(*) into v_ack_done from public.message_acknowledgements where user_id = v_me and status = 'acknowledged';
  select count(*) into v_bookmarks from public.message_bookmarks where user_id = v_me;

  return jsonb_build_object(
    'messages_sent', v_messages,
    'my_groups', v_groups,
    'my_channels', v_channels,
    'my_acknowledgements', v_ack_done,
    'my_bookmarks', v_bookmarks,
    'unread_mandatory_announcements', (
      select count(distinct a.id) from public.announcements a
      join public.announcement_audience aud on aud.announcement_id = a.id
      left join public.message_acknowledgements ac
        on ac.announcement_id = a.id and ac.user_id = v_me and ac.status = 'acknowledged'
      where a.requires_ack and a.status = 'published' and aud.member_id = v_me and ac.id is null
    )
  );
end; $$;
grant execute on function public.get_communication_stats() to authenticated;

-- ============================================================
-- 16. PROFILE PHOTO STORAGE FOR GROUP / CHANNEL AVATARS
--     (scoped inserts under documents/avatars/(group|channel)/...)
-- ============================================================
drop policy if exists "comm_avatar_upload" on storage.objects;
create policy "comm_avatar_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (
      name like 'avatars/groups/%'
      or name like 'avatars/channels/%'
    )
  );

drop policy if exists "comm_avatar_read" on storage.objects;
create policy "comm_avatar_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (name like 'avatars/%' or name like 'profile-photo/%')
  );

-- ============================================================
-- DONE. Run schema.sql + all prior phase files first.
-- ============================================================