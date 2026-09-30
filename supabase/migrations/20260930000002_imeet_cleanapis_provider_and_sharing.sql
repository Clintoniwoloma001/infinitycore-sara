-- ============================================================================
-- Clean APIs as a SARA AI provider (+ I-Meet folder sharing)
-- ============================================================================
-- Run in the Supabase SQL Editor AFTER 20260928000001 and AFTER
-- 20260930000001. Idempotent and additive.
--
-- PART 1 — Clean APIs provider
--   Clean APIs is OpenAI-compatible, so it plugs into the EXISTING shared
--   router as one more row in ai_providers plus one entry in the router's
--   OPENAI_COMPATIBLE map and SECRET_ENV map. It is deliberately NOT a new
--   service: SARA keeps its failover, rate limiting, usage accounting and
--   audit trail, and the Flutter/Web clients stay identical because neither
--   ever holds a key.
--
--   Model identifiers come from the operator's Clean APIs dashboard and are
--   used verbatim:
--     primary : gpt-5.6-luna
--     fallback: deepseek-v4-flash-0731
--
--   The key is a Supabase FUNCTION SECRET, never a column and never a file:
--     node scripts/set-supabase-secret.mjs --name CLEAN_APIS_KEY
--
-- PART 2 — I-Meet folder sharing
--   A folder OWNER can add users, who then see the folder's meetings,
--   summaries, transcripts and can download recordings. The owner can revoke
--   access at any time, and revocation is immediate because every read is
--   authorised through the membership table.
begin;

-- ---------------------------------------------------------------------------
-- 1. Clean APIs provider row.
-- ---------------------------------------------------------------------------
insert into public.ai_providers
  (id, display_name, provider_kind, default_model, models, capabilities,
   enabled, sort_order, doc_url)
values
  ('cleanapis', 'Clean APIs', 'remote', 'gpt-5.6-luna',
   '[
     {"id":"gpt-5.6-luna","label":"GPT-5.6 Luna","capabilities":["chat","json","tools","vision"]},
     {"id":"deepseek-v4-flash-0731","label":"DeepSeek V4 Flash 0731","capabilities":["chat","json","tools"]}
   ]'::jsonb,
   array['chat','json','tools','vision'], true, 35,
   'https://cleanapis.com')
on conflict (id) do update
  set display_name = excluded.display_name,
      provider_kind = excluded.provider_kind,
      models = excluded.models,
      capabilities = excluded.capabilities,
      sort_order = excluded.sort_order,
      doc_url = excluded.doc_url,
      updated_at = now();

insert into public.provider_health (provider_id)
select 'cleanapis'
on conflict (provider_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. FOLDER SHARING
--   One membership row per (folder, user). The membership IS the access grant,
--   so revoking it takes effect on the very next read - there is no cached
--   permission and no copy of the recording anywhere else.
--
--   can_download is separate from can_view on purpose: an owner may let
--   someone read a summary while withholding the audio (e.g. a sensitive
--   disciplinary or HR meeting).
-- ---------------------------------------------------------------------------
create table if not exists public.imeet_folder_members (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.imeet_folders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Granted by the folder owner, revoked by the folder owner.
  can_view boolean not null default true,
  can_download boolean not null default true,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint imeet_folder_members_unique unique (folder_id, user_id)
);

create index if not exists idx_imeet_folder_members_user
  on public.imeet_folder_members (user_id) where revoked_at is null;

-- A person may not be added to their own folder, and a revoked membership can
-- be re-granted, so the uniqueness is on (folder_id, user_id) not on history.
create or replace function public.imeet_is_folder_owner(p_folder_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.imeet_folders f
     where f.id = p_folder_id and f.owner_id = auth.uid()
  );
$$;

create or replace function public.imeet_can_view_folder(p_folder_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.imeet_is_folder_owner(p_folder_id)
      or exists (
        select 1 from public.imeet_folder_members m
         where m.folder_id = p_folder_id
           and m.user_id = auth.uid()
           and m.revoked_at is null
           and m.can_view
      );
$$;

create or replace function public.imeet_can_download_folder(p_folder_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  -- Download implies view. The owner always has both.
  select public.imeet_is_folder_owner(p_folder_id)
      or exists (
        select 1 from public.imeet_folder_members m
         where m.folder_id = p_folder_id
           and m.user_id = auth.uid()
           and m.revoked_at is null
           and m.can_download
      );
$$;

-- ---------------------------------------------------------------------------
-- 3. OWNER-CONTROLLED SHARING RPCs
--   Every one of these verifies ownership from auth.uid() - never from a
--   client-supplied owner id - so a shared member can never escalate to sharing
--   or re-grant themselves.
-- ---------------------------------------------------------------------------

-- Audit helper. I-Meet had no audit trail of its own, so a failed share/revoke
-- would have been invisible. This writes to the EXISTING audit_logs table
-- (action, entity_type, entity_id, details, severity) so folder access changes
-- appear in the same trail as the rest of the platform.
create or replace function public.imeet_audit_event(
  p_action text,
  p_entity text,
  p_entity_id text,
  p_details jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_logs (action, entity_type, entity_id, details, severity)
  values (p_action, p_entity, p_entity_id,
          coalesce(p_details, '{}'::jsonb) || jsonb_build_object('actor', auth.uid()),
          'info');
exception when others then
  -- Auditing must never be the reason a legitimate share fails.
  raise warning 'imeet audit write failed: %', sqlerrm;
end;
$$;

-- Add (or re-grant) a user to a folder.
create or replace function public.imeet_share_folder(
  p_folder_id uuid,
  p_user_id uuid,
  p_can_view boolean default true,
  p_can_download boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not public.imeet_is_folder_owner(p_folder_id) then
    raise exception 'Only the folder owner can share this folder';
  end if;
  if p_user_id is null then raise exception 'Choose a user to share with'; end if;
  if p_user_id = v_me then raise exception 'You already own this folder'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'That user does not exist';
  end if;

  -- Re-granting revives the existing row, so the unique (folder, user) key
  -- holds and the folder never accumulates duplicate grants.
  insert into public.imeet_folder_members
    (folder_id, user_id, can_view, can_download, added_by, revoked_at)
  values (p_folder_id, p_user_id, coalesce(p_can_view, true),
          coalesce(p_can_download, true), v_me, null)
  on conflict (folder_id, user_id) do update
    set can_view = excluded.can_view,
        can_download = excluded.can_download,
        added_by = v_me,
        revoked_at = null;

  perform public.imeet_audit_event('IMEET_FOLDER_SHARED', 'imeet_folder', p_folder_id::text,
    jsonb_build_object('user_id', p_user_id,
                       'can_view', coalesce(p_can_view, true),
                       'can_download', coalesce(p_can_download, true)));

  return jsonb_build_object('ok', true, 'folder_id', p_folder_id, 'user_id', p_user_id);
end;
$$;

-- The OWNER can remove a user at any time. This is a soft revoke so the audit
-- history survives, and because every read re-checks revoked_at, the effect is
-- immediate: the next request already fails.
create or replace function public.imeet_unshare_folder(
  p_folder_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.imeet_is_folder_owner(p_folder_id) then
    raise exception 'Only the folder owner can remove access';
  end if;

  update public.imeet_folder_members
     set revoked_at = now()
   where folder_id = p_folder_id and user_id = p_user_id and revoked_at is null;

  if not found then
    -- Idempotent: removing someone who was never added is a no-op, not an error,
    -- so a double-click cannot produce a confusing failure.
    return jsonb_build_object('ok', true, 'changed', false, 'already_revoked', true);
  end if;

  perform public.imeet_audit_event('IMEET_FOLDER_UNSHARED', 'imeet_folder', p_folder_id::text,
    jsonb_build_object('user_id', p_user_id));

  return jsonb_build_object('ok', true, 'changed', true, 'user_id', p_user_id);
end;
$$;

-- The folders the caller owns PLUS the folders shared with them, each flagged
-- so the UI can show who owns it and who may remove people.
create or replace function public.imeet_list_my_folders()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', f.id,
             'name', f.name,
             'colour', f.colour,
             'sort_order', f.sort_order,
             'is_owner', f.owner_id = auth.uid(),
             'can_view', true,
             'can_download',
               case when f.owner_id = auth.uid() then true
                    else public.imeet_can_download_folder(f.id) end,
             'member_count', (select count(*) from public.imeet_folder_members m
                               where m.folder_id = f.id and m.revoked_at is null)
           ) order by f.sort_order, f.name), '[]'::jsonb)
    into v
    from public.imeet_folders f
   where f.owner_id = auth.uid()
      or public.imeet_can_view_folder(f.id);

  return jsonb_build_object('ok', true, 'folders', v);
end;
$$;

-- Who currently has access. OWNER ONLY: a member has no business enumerating
-- the other people in a folder.
create or replace function public.imeet_list_folder_members(p_folder_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.imeet_is_folder_owner(p_folder_id) then
    raise exception 'Only the folder owner can see who it is shared with';
  end if;
  return jsonb_build_object('ok', true, 'members', coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id,
             'full_name', coalesce(p.full_name, p.email, 'Unknown user'),
             'email', p.email,
             'can_view', m.can_view,
             'can_download', m.can_download,
             'added_at', m.created_at)
           order by coalesce(p.full_name, p.email))
      from public.imeet_folder_members m
      left join public.profiles p on p.id = m.user_id
     where m.folder_id = p_folder_id and m.revoked_at is null), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. DOWNLOAD GATE
--   imeet_sign_recording previously allowed the owner and meeting PARTICIPANTS
--   only. A folder member who is not a participant could see the summary but
--   not download the audio, which did not match the requirement. This re-issues
--   it to also honour folder-level download rights, and it distinguishes the
--   two refusals so the UI can explain WHY access was denied.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_sign_recording(
  p_recording_id uuid,
  p_expires_seconds integer default 300
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_rec public.imeet_recordings%rowtype;
  v_folder uuid;
  v_path text;
  v_secs integer;
  v_url text;
  v_can_download boolean;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  select * into v_rec from public.imeet_recordings where id = p_recording_id;
  if v_rec.id is null then raise exception 'Recording not found'; end if;

  -- Reading the meeting at all still requires participant/owner rights or an
  -- active folder grant.
  if not public.imeet_can_access_meeting(v_rec.meeting_id)
     and not exists (
       select 1 from public.imeet_meetings m
        where m.id = v_rec.meeting_id
          and public.imeet_can_view_folder(m.folder_id)
     ) then
    raise exception 'Not authorized to access this recording';
  end if;

  if v_rec.audio_path is null then raise exception 'This recording has no audio'; end if;

  -- Download is a SEPARATE grant: the owner and participants may always
  -- download, but a folder member needs can_download, and a revoked membership
  -- has been erased here because revoked_at is re-checked on every call.
  select m.folder_id into v_folder
    from public.imeet_meetings m where m.id = v_rec.meeting_id;

  v_can_download := public.imeet_is_folder_owner(v_folder)
    or public.imeet_can_access_meeting(v_rec.meeting_id)
    or public.imeet_can_download_folder(v_folder);

  if not v_can_download then
    raise exception 'You can view this recording but the owner has not allowed downloads';
  end if;

  v_path := v_rec.audio_path;
  v_secs := least(greatest(coalesce(p_expires_seconds, 300), 30), 900);

  -- `storage.` is the correct schema: there is NO public.create_signed_url, and
  -- because this function is SECURITY DEFINER with search_path = public, an
  -- unqualified call fails at RUNTIME with SQLSTATE 42883 ("function
  -- public.create_signed_url(unknown, text, integer) does not exist"), breaking
  -- every Download / Save / Share audio action. Migration 20260930000001 called
  -- it correctly; this re-issue regressed it. Migration 20260930000003 re-issues
  -- the function again with the fix, for databases where 20260930000002 has
  -- already been applied.
  select storage.create_signed_url(
           'i-meet-audio'::text,
           v_path::text,
           v_secs::integer
         ) into v_url;
  if v_url is null then raise exception 'Could not sign audio URL'; end if;

  return jsonb_build_object(
    'ok', true, 'url', v_url,
    'expires_at', now() + make_interval(secs => v_secs),
    'mime', v_rec.audio_mime
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS
--   Membership is readable by the owner and by the member themselves, so a
--   user can always see WHY they have access. All writes go through the
--   SECURITY DEFINER RPCs, which re-check ownership from auth.uid().
-- ---------------------------------------------------------------------------
alter table public.imeet_folder_members enable row level security;

drop policy if exists "imeet_folder_members read" on public.imeet_folder_members;
create policy "imeet_folder_members read" on public.imeet_folder_members
  for select to authenticated
  using (user_id = auth.uid() or public.imeet_is_folder_owner(folder_id));

revoke all on public.imeet_folder_members from anon;
revoke insert, update, delete on public.imeet_folder_members from authenticated;
grant select on public.imeet_folder_members to authenticated;

-- Folders: a member can read the folder row (so the name shows in their list),
-- but only the owner may write it.
drop policy if exists "imeet_folders read shared" on public.imeet_folders;
create policy "imeet_folders read shared" on public.imeet_folders
  for select to authenticated
  using (owner_id = auth.uid() or public.imeet_can_view_folder(id));

-- Meetings: a folder member may READ the meetings inside a folder shared with
-- them, which is what makes the summaries visible. Writes stay owner-only, so a
-- member can never edit or delete somebody else's meeting.
drop policy if exists "imeet_meetings read shared" on public.imeet_meetings;
create policy "imeet_meetings read shared" on public.imeet_meetings
  for select to authenticated
  using (public.imeet_can_view_folder(folder_id));

drop policy if exists "imeet_recordings read shared" on public.imeet_recordings;
create policy "imeet_recordings read shared" on public.imeet_recordings
  for select to authenticated
  using (exists (
    select 1 from public.imeet_meetings m
     where m.id = meeting_id and public.imeet_can_view_folder(m.folder_id)
  ));

-- ---------------------------------------------------------------------------
-- 6. GRANTS
--   The CLEAN_APIS_KEY is a function SECRET and is deliberately NOT granted or
--   referenced here: no database role or table ever holds it. Only the edge
--   function reads it, via the router.
-- ---------------------------------------------------------------------------
grant execute on function public.imeet_is_folder_owner(uuid)          to authenticated;
grant execute on function public.imeet_can_view_folder(uuid)          to authenticated;
grant execute on function public.imeet_can_download_folder(uuid)      to authenticated;
grant execute on function public.imeet_share_folder(uuid, uuid, boolean, boolean) to authenticated;
grant execute on function public.imeet_unshare_folder(uuid, uuid)     to authenticated;
grant execute on function public.imeet_list_my_folders()              to authenticated;
grant execute on function public.imeet_list_folder_members(uuid)      to authenticated;
grant execute on function public.imeet_sign_recording(uuid, integer)   to authenticated;
grant execute on function public.imeet_audit_event(text, text, text, jsonb) to authenticated;

revoke all on function public.imeet_share_folder(uuid, uuid, boolean, boolean) from anon;
revoke all on function public.imeet_unshare_folder(uuid, uuid)     from anon;
revoke all on function public.imeet_list_my_folders()              from anon;
revoke all on function public.imeet_list_folder_members(uuid)      from anon;
revoke all on function public.imeet_sign_recording(uuid, integer)   from anon;

-- Make the newly created function visible to PostgREST immediately, so the
-- client does not need a manual dashboard reload.
notify pgrst, 'reload schema';

commit;
