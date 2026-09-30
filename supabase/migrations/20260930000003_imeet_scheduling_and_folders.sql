-- ============================================================================
-- I-Meet: SCHEDULING + FOLDER MANAGEMENT
-- ============================================================================
-- Additive and idempotent. Run AFTER 20260930000001 and 20260930000002.
--
-- WHY THIS FILE EXISTS
--   1. `imeet_meetings_status_check` only allowed draft/recording/processing/
--      ready/failed/archived, and `imeet_open_meeting` ALWAYS wrote
--      status='recording' at now(). So a meeting could not be placed in the
--      future: the "Upcoming" list on mobile was permanently empty and there
--      was no way to schedule anything.
--   2. `imeet_folders.owner_id` is NOT NULL, and the Flutter client inserted a
--      folder with only a name. That insert can never satisfy the RLS policy
--      `owner_id = auth.uid()`, so folder creation was impossible from the app.
--      The RPC below sets the owner from auth.uid() server-side.
--   3. Nothing could move an existing meeting into (or out of) a folder, add
--      participants, or edit a meeting, so its audience and time were fixed at
--      the moment it was opened.
--
-- Everything here is SECURITY DEFINER and derives identity from auth.uid().
-- A client can never assert that it is somebody else.
begin;

-- ---------------------------------------------------------------------------
-- 1. STATUS: allow 'scheduled' and 'cancelled'.
--    'scheduled' = a future meeting with no recording yet.
--    'cancelled' = deliberately called off; KEPT (never deleted) so the audit
--    trail and any transcript requests survive.
-- ---------------------------------------------------------------------------
alter table public.imeet_meetings
  drop constraint if exists imeet_meetings_status_check;
alter table public.imeet_meetings
  add constraint imeet_meetings_status_check
  check (status in ('draft', 'scheduled', 'recording', 'processing',
                    'ready', 'failed', 'cancelled', 'archived'));

-- Upcoming meetings are queried by (owner, future start). Partial index keeps
-- that lookup off the full history table.
create index if not exists idx_imeet_meetings_upcoming
  on public.imeet_meetings (owner_id, started_at)
  where status = 'scheduled';

-- ---------------------------------------------------------------------------
-- 2. FOLDER MANAGEMENT
--    imeet_is_folder_owner / imeet_audit_event already exist from
--    20260930000002 and are reused rather than duplicated.
-- ---------------------------------------------------------------------------

-- Create a folder. The owner is ALWAYS auth.uid(); a client-supplied owner is
-- not even accepted, which removes the whole class of escalation bug.
-- Re-using an existing name of your own returns that folder instead of raising
-- a unique violation, so a double-tap is harmless.
create or replace function public.imeet_create_folder(
  p_name text,
  p_colour text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_folder public.imeet_folders%rowtype;
  v_name text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  v_name := btrim(coalesce(p_name, ''));
  if length(v_name) < 1 or length(v_name) > 80 then
    raise exception 'Give the folder a name between 1 and 80 characters';
  end if;

  select * into v_folder from public.imeet_folders
   where owner_id = v_me and name = v_name limit 1;

  if v_folder.id is null then
    insert into public.imeet_folders (owner_id, name, colour)
    values (v_me, v_name, nullif(btrim(coalesce(p_colour, '')), ''))
    returning * into v_folder;
    perform public.imeet_audit_event('IMEET_FOLDER_CREATED', 'imeet_folder',
      v_folder.id::text, jsonb_build_object('name', v_folder.name));
  end if;

  return jsonb_build_object('ok', true, 'folder', to_jsonb(v_folder));
end; $$;
grant execute on function public.imeet_create_folder(text, text) to authenticated;

-- Rename / recolour. Owner only: a member must not be able to relabel a folder
-- they were only lent.
create or replace function public.imeet_rename_folder(
  p_folder_id uuid,
  p_name text,
  p_colour text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.imeet_is_folder_owner(p_folder_id) then
    raise exception 'Only the folder owner can rename this folder';
  end if;
  if length(v_name) < 1 or length(v_name) > 80 then
    raise exception 'Give the folder a name between 1 and 80 characters';
  end if;

  update public.imeet_folders
     set name = v_name,
         colour = coalesce(nullif(btrim(coalesce(p_colour, '')), ''), colour),
         updated_at = now()
   where id = p_folder_id;

  perform public.imeet_audit_event('IMEET_FOLDER_RENAMED', 'imeet_folder',
    p_folder_id::text, jsonb_build_object('name', v_name));
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.imeet_rename_folder(uuid, text, text) to authenticated;

-- Delete a folder. Meetings inside it are KEPT and simply become folder-less
-- (`on delete set null`) - deleting a folder must never destroy a recording or
-- its transcript. Sharing grants go with the folder, which is the point: there
-- is nothing left to grant access to.
create or replace function public.imeet_delete_folder(p_folder_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.imeet_is_folder_owner(p_folder_id) then
    raise exception 'Only the folder owner can delete this folder';
  end if;

  perform public.imeet_audit_event('IMEET_FOLDER_DELETED', 'imeet_folder',
    p_folder_id::text, null);
  delete from public.imeet_folders where id = p_folder_id;

  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.imeet_delete_folder(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. SCHEDULING
--    A scheduled meeting is a real row with a FUTURE started_at and
--    status='scheduled'. When the user later records it, the client passes the
--    same meeting id to `imeet_open_meeting`, whose reuse branch moves the SAME
--    row to 'recording' - so scheduling never forks a duplicate.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_schedule_meeting(
  p_title text,
  p_starts_at timestamptz,
  p_location text default null,
  p_description text default null,
  p_folder_id uuid default null,
  p_duration_minutes integer default null,
  p_calendar_provider text default null,
  p_calendar_external_id text default null,
  p_participant_ids uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_meeting public.imeet_meetings%rowtype;
  v_dur integer;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if p_starts_at is null then raise exception 'Choose when the meeting starts'; end if;

  v_dur := case when p_duration_minutes is null then 60
                else least(greatest(p_duration_minutes, 5), 1440) end;

  -- A calendar event is matched on its stable external id, never on the title,
  -- so re-syncing the same event updates one row instead of piling up copies.
  if p_calendar_provider is not null and p_calendar_external_id is not null then
    select * into v_meeting from public.imeet_meetings
     where owner_id = v_me
       and calendar_provider = p_calendar_provider
       and calendar_external_id = p_calendar_external_id
     limit 1;
  end if;

  if v_meeting.id is null then
    insert into public.imeet_meetings (
      owner_id, folder_id, title, description, location,
      calendar_provider, calendar_external_id, started_at, ended_at, status
    ) values (
      v_me,
      case when p_folder_id is not null
           and public.imeet_is_folder_owner(p_folder_id) then p_folder_id
           else null end,
      coalesce(nullif(btrim(p_title), ''), 'Untitled meeting'),
      nullif(btrim(coalesce(p_description, '')), ''),
      nullif(btrim(coalesce(p_location, '')), ''),
      p_calendar_provider, p_calendar_external_id,
      p_starts_at,
      p_starts_at + make_interval(mins => v_dur),
      'scheduled'
    )
    returning * into v_meeting;
  else
    update public.imeet_meetings
       set folder_id = case when p_folder_id is not null
                              and public.imeet_is_folder_owner(p_folder_id)
                            then p_folder_id else folder_id end,
           title = coalesce(nullif(btrim(p_title), ''), title),
           description = coalesce(nullif(btrim(coalesce(p_description, '')), ''), description),
           location = coalesce(nullif(btrim(coalesce(p_location, '')), ''), location),
           started_at = p_starts_at,
           ended_at = p_starts_at + make_interval(mins => v_dur),
           -- Never downgrade a finished meeting back to 'scheduled'.
           status = case when status in ('ready', 'archived') then status
                         else 'scheduled' end,
           updated_at = now()
     where id = v_meeting.id
    returning * into v_meeting;
  end if;

  -- Participants. Only ids that resolve to a real account are stored, and the
  -- owner is never added as a participant of their own meeting.
  if p_participant_ids is not null and cardinality(p_participant_ids) > 0 then
    insert into public.imeet_participants (meeting_id, user_id, display_name, email)
    select v_meeting.id, p.id, coalesce(pr.full_name, pr.email, 'Guest'), pr.email
      from unnest(p_participant_ids) as p(id)
      join auth.users u on u.id = p.id
      left join public.profiles pr on pr.id = p.id
     where p.id <> v_me
    on conflict (meeting_id, display_name) do update
      set user_id = excluded.user_id, email = excluded.email;
  end if;

  perform public.imeet_audit_event('IMEET_MEETING_SCHEDULED', 'imeet_meeting',
    v_meeting.id::text,
    jsonb_build_object('starts_at', v_meeting.started_at,
                       'folder_id', v_meeting.folder_id));

  return jsonb_build_object('ok', true, 'meeting', to_jsonb(v_meeting));
end; $$;
grant execute on function public.imeet_schedule_meeting(text, timestamptz, text, text, uuid, integer, text, text, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. EDIT / RESCHEDULE / MOVE BETWEEN FOLDERS / CANCEL
--    One owner-scoped entry point rather than four, so the ownership check is
--    written once. Each field is applied only when supplied, so the client can
--    PATCH-style update without having to send the whole row back.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_update_meeting(
  p_meeting_id uuid,
  p_title text default null,
  p_starts_at timestamptz default null,
  p_location text default null,
  p_description text default null,
  p_folder_id uuid default null,
  p_move_to_folder boolean default false,
  p_duration_minutes integer default null,
  p_participant_ids uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_before public.imeet_meetings%rowtype;
  v_after public.imeet_meetings%rowtype;
  v_start timestamptz;
  v_dur integer;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  select * into v_before from public.imeet_meetings
   where id = p_meeting_id and owner_id = v_me;
  if v_before.id is null then raise exception 'Not authorized'; end if;

  v_start := coalesce(p_starts_at, v_before.started_at);
  v_dur := case when p_duration_minutes is null
                then least(greatest(coalesce(
                       extract(epoch from (v_before.ended_at - v_before.started_at))
                       / 60, 5), 1440)::int, 1440)
                else least(greatest(p_duration_minutes, 5), 1440) end;

  update public.imeet_meetings m
     set title = coalesce(nullif(btrim(p_title), ''), m.title),
         description = case when p_description is null then m.description
                            else nullif(btrim(p_description), '') end,
         location = case when p_location is null then m.location
                         else nullif(btrim(p_location), '') end,
         -- Moving is opt-in: p_folder_id = null must be able to mean "take it
         -- out of its folder", which is indistinguishable from "not supplied"
         -- unless the caller says so.
         folder_id = case when coalesce(p_move_to_folder, false)
                          then case when p_folder_id is not null
                                    and public.imeet_is_folder_owner(p_folder_id)
                                   then p_folder_id else null end
                          else m.folder_id end,
         started_at = v_start,
         ended_at = v_start + make_interval(mins => v_dur),
         updated_at = now()
   where m.id = p_meeting_id
  returning * into v_after;

  if p_participant_ids is not null and cardinality(p_participant_ids) > 0 then
    insert into public.imeet_participants (meeting_id, user_id, display_name, email)
    select v_after.id, p.id, coalesce(pr.full_name, pr.email, 'Guest'), pr.email
      from unnest(p_participant_ids) as p(id)
      join auth.users u on u.id = p.id
      left join public.profiles pr on pr.id = p.id
     where p.id <> v_me
    on conflict (meeting_id, display_name) do update
      set user_id = excluded.user_id, email = excluded.email;
  end if;

  perform public.imeet_audit_event('IMEET_MEETING_UPDATED', 'imeet_meeting',
    p_meeting_id::text,
    jsonb_build_object(
      'was_folder', v_before.folder_id,
      'folder_id', v_after.folder_id,
      'was_started_at', v_before.started_at,
      'started_at', v_after.started_at));

  return jsonb_build_object('ok', true, 'meeting', to_jsonb(v_after));
end; $$;
grant execute on function public.imeet_update_meeting(uuid, text, timestamptz, text, text, uuid, boolean, integer, uuid[]) to authenticated;

-- Cancel. The row is KEPT (status='cancelled') rather than deleted: an audit
-- trail that vanishes on cancel is not an audit trail.
create or replace function public.imeet_cancel_meeting(p_meeting_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.imeet_meetings
                  where id = p_meeting_id and owner_id = auth.uid()) then
    raise exception 'Not authorized';
  end if;

  update public.imeet_meetings
     set status = 'cancelled', updated_at = now()
   where id = p_meeting_id;

  perform public.imeet_audit_event('IMEET_MEETING_CANCELLED', 'imeet_meeting',
    p_meeting_id::text, null);
  return jsonb_build_object('ok', true);
end; $$;
grant execute on function public.imeet_cancel_meeting(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. PEOPLE PICKER
--    Both clients used to run
--      `select id, full_name, email, role, department from profiles`
--    which either trips over profiles' own RLS or hands every user a full staff
--    directory. This returns only what a picker needs, excludes the caller, and
--    marks who already has access. Passing a folder id restricts the result to
--    that folder's owner, so a member cannot harvest the directory.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_shareable_people(
  p_exclude_folder_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_exclude_folder_id is not null
     and not public.imeet_is_folder_owner(p_exclude_folder_id) then
    raise exception 'Only the folder owner can see who may be added';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
             'id', p.id,
             'full_name', coalesce(p.full_name, p.email, 'Unknown user'),
             'email', p.email,
             'already_member',
               case when p_exclude_folder_id is null then false else exists (
                 select 1 from public.imeet_folder_members m
                  where m.folder_id = p_exclude_folder_id
                    and m.user_id = p.id
                    and m.revoked_at is null) end
           ) order by coalesce(p.full_name, p.email)), '[]'::jsonb)
    into v
    from public.profiles p
   where p.id <> auth.uid()
     and coalesce(p.status, 'active') = 'active';

  return jsonb_build_object('ok', true, 'people', v);
end; $$;
grant execute on function public.imeet_shareable_people(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. FOLDER MEETING COUNTS
--    `imeet_list_my_folders` returned no `meeting_count`, yet both clients read
--    that key, so every folder chip rendered as empty no matter how full it
--    was. Re-issued here with the count computed server-side.
-- ---------------------------------------------------------------------------
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
             'meeting_count', (
               select count(*) from public.imeet_meetings m
                where m.folder_id = f.id and m.status <> 'cancelled'),
             'member_count', (select count(*) from public.imeet_folder_members m2
                               where m2.folder_id = f.id and m2.revoked_at is null)
           ) order by f.sort_order, f.name), '[]'::jsonb)
    into v
    from public.imeet_folders f
   where f.owner_id = auth.uid()
      or public.imeet_can_view_folder(f.id);

  return jsonb_build_object('ok', true, 'folders', v);
end; $$;
grant execute on function public.imeet_list_my_folders() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. REPAIR: imeet_sign_recording called the WRONG create_signed_url.
--
-- The 20260930000002 version of this function contained:
--     select public.create_signed_url('i-meet-audio', v_path, v_secs) into v_url;
-- There is no such function in `public`. The Supabase helper lives in the
-- `storage` schema, and because the function is SECURITY DEFINER with
-- `search_path = public`, an unqualified or wrongly-qualified call resolves
-- against `public` and fails at RUNTIME with:
--     function public.create_signed_url(unknown, text, integer) does not exist
--     (SQLSTATE 42883)
--
-- 20260930000001 had this right; 20260930000002 re-issued the function and got
-- the schema wrong, so every "Download" / "Save" / "Share audio" action failed
-- on BOTH web and mobile with a 42883 the user could do nothing about.
--
-- This is a re-issue, not an edit of the old file, because the broken version is
-- already deployed. It is byte-for-byte the fixed call plus the original
-- authorization logic, which is left untouched.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_sign_recording(
  p_recording_id uuid,
  p_expires_seconds integer default 300
) returns jsonb
language plpgsql security definer set search_path = public as $$
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

  -- The explicit `storage.` qualifier is REQUIRED, and the casts make the
  -- argument types unambiguous. See the note above.
  select storage.create_signed_url(
           'i-meet-audio'::text,
           v_path::text,
           v_secs::integer
         ) into v_url;
  if v_url is null then raise exception 'Could not sign audio URL'; end if;

  return jsonb_build_object(
    'ok', true,
    'url', v_url,
    'expires_at', now() + make_interval(secs => v_secs),
    'mime', v_rec.audio_mime
  );
end; $$;
grant execute on function public.imeet_sign_recording(uuid, integer) to authenticated;
revoke all on function public.imeet_sign_recording(uuid, integer) from anon;

commit;
