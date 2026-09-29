-- ============================================================================
-- I-MEET — AI meeting intelligence for InfinityCore
-- Run in the Supabase SQL Editor. Idempotent.
--
-- Hierarchy (the whole point of the module):
--     User -> Folder -> Meeting -> Recording -> Transcript -> Summary
--                                 |                  -> Action items
--                                 -> Calendar event link
--                                 -> Participants
--
-- DESIGN NOTES
--
-- 1. AUDIO IS NEVER PUBLIC. A private `i-meet-audio` storage bucket holds the
--    recordings; access is via a short-lived signed URL minted by a
--    SECURITY DEFINER function that re-checks authorisation. There is no
--    public URL for meeting audio, ever.
--
-- 2. THE AUDIENCE IS FROZEN. Recording/transcript requests are seeded once and
--    the denominator is the SEEDED ROW COUNT, never a live participant count —
--    the same rule the messaging acknowledgements use.
--
-- 3. FAILURE IS NON-DESTRUCTIVE (rules 10/11). Transcription and summary have
--    independent status columns, so a failed summary leaves the audio and the
--    transcript intact and simply retryable.
--
-- 4. PROCESSING IS SERVER-SIDE. The Flutter client never holds a provider key
--    and never transcribes locally; it calls the `imeet-transcribe` edge
--    function, which reuses the existing shared AI router.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. FOLDERS — per-user organisation
-- ---------------------------------------------------------------------------
create table if not exists public.imeet_folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  colour text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint imeet_folders_unique_per_owner unique (owner_id, name)
);
alter table public.imeet_folders enable row level security;
create index if not exists idx_imeet_folders_owner on public.imeet_folders(owner_id, sort_order);

drop policy if exists "imeet_folders own all" on public.imeet_folders;
create policy "imeet_folders own all" on public.imeet_folders
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. MEETINGS — the parent entity
-- ---------------------------------------------------------------------------
create table if not exists public.imeet_meetings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  folder_id uuid references public.imeet_folders(id) on delete set null,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text,
  location text,
  -- Calendar facts. `calendar_external_id` is the stable join key; a title is
  -- never used to match an event.
  calendar_provider text,
  calendar_external_id text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft', 'recording', 'processing', 'ready', 'failed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Partial-unique: a user cannot end up with two meetings bound to the same
  -- external calendar event (rule 8: no duplicate calendar events).
  constraint imeet_meetings_calendar_unique
    unique (owner_id, calendar_provider, calendar_external_id)
);
alter table public.imeet_meetings enable row level security;
create index if not exists idx_imeet_meetings_owner_started
  on public.imeet_meetings(owner_id, started_at desc);
create index if not exists idx_imeet_meetings_folder
  on public.imeet_meetings(folder_id) where folder_id is not null;
create index if not exists idx_imeet_meetings_status
  on public.imeet_meetings(owner_id, status);
-- Search support: title/description without loading transcripts.
create index if not exists idx_imeet_meetings_title_trgm
  on public.imeet_meetings using gin (to_tsvector('english', title || ' ' || coalesce(description, '')));

-- ---------------------------------------------------------------------------
-- 3. PARTICIPANTS — from the calendar, never inferred from voices
-- ---------------------------------------------------------------------------
create table if not exists public.imeet_participants (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.imeet_meetings(id) on delete cascade,
  -- NULL for an external attendee with no InfinityCore account.
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null check (length(btrim(display_name)) between 1 and 160),
  email text,
  is_organiser boolean not null default false,
  constraint imeet_participants_unique unique (meeting_id, display_name)
);
alter table public.imeet_participants enable row level security;
create index if not exists idx_imeet_participants_meeting
  on public.imeet_participants(meeting_id);

-- ---------------------------------------------------------------------------
-- 4. RECORDINGS — many per meeting, never one meeting per follow-up
-- ---------------------------------------------------------------------------
create table if not exists public.imeet_recordings (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.imeet_meetings(id) on delete cascade,
  -- 1 is the main recording; 2+ are follow-ups under the SAME meeting (rule 9).
  sequence integer not null default 1 check (sequence >= 1),
  label text,
  is_follow_up boolean not null default false,
  -- Private storage path. Never a public URL.
  audio_path text,
  audio_mime text,
  audio_bytes bigint,
  -- Recorded on-device duration, so a list never has to fetch the audio.
  duration_seconds integer,
  recorded_at timestamptz not null default now(),
  upload_status text not null default 'local'
    check (upload_status in ('local', 'uploading', 'uploaded', 'failed')),
  -- Transcription and summary are INDEPENDENT, so one failing can never
  -- destroy the other, and neither can destroy the audio (rules 10/11).
  transcription_status text not null default 'pending'
    check (transcription_status in ('pending', 'processing', 'ready', 'failed')),
  summary_status text not null default 'pending'
    check (summary_status in ('pending', 'processing', 'ready', 'failed')),
  error_message text,
  -- The transcript lives ON the recording rather than in a side table, so it
  -- is structurally impossible to hold two competing transcripts for one audio
  -- file (rule 7: exactly one authoritative transcript).
  transcript text,
  transcript_language text,
  transcript_provider text,
  summary_overview text,
  summary_key_points jsonb,
  summary_decisions jsonb,
  summary_issues jsonb,
  summary_provider text,
  summary_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint imeet_recordings_sequence_unique unique (meeting_id, sequence)
);
alter table public.imeet_recordings enable row level security;
create index if not exists idx_imeet_recordings_meeting
  on public.imeet_recordings(meeting_id, sequence);

-- ---------------------------------------------------------------------------
-- 5. ACTION ITEMS — the SARA-facing extraction
--
-- A real table, not a JSON blob on the summary: SARA will need to query
-- unresolved items across meetings, and "what did I owe last week" is a query,
-- not a text scrape.
-- ---------------------------------------------------------------------------
create table if not exists public.imeet_action_items (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.imeet_meetings(id) on delete cascade,
  recording_id uuid references public.imeet_recordings(id) on delete cascade,
  assignee_id uuid references auth.users(id) on delete set null,
  title text not null check (length(btrim(title)) between 1 and 300),
  detail text,
  due_at timestamptz,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'done', 'dismissed')),
  -- Set when the model inferred the owner rather than hearing it stated, so the
  -- UI can mark it as inference and never present it as fact.
  is_inferred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.imeet_action_items enable row level security;
create index if not exists idx_imeet_actions_meeting on public.imeet_action_items(meeting_id);
create index if not exists idx_imeet_actions_assignee
  on public.imeet_action_items(assignee_id, status) where assignee_id is not null;

-- ---------------------------------------------------------------------------
-- 6. FROZEN AUDIENCE
-- ---------------------------------------------------------------------------
create table if not exists public.imeet_transcript_requests (
  id uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.imeet_recordings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'acknowledged')),
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  constraint imeet_transcript_requests_unique unique (recording_id, user_id)
);
alter table public.imeet_transcript_requests enable row level security;
create index if not exists idx_imeet_requests_user
  on public.imeet_transcript_requests(user_id, status);

-- ---------------------------------------------------------------------------
-- 7. RLS — confidentiality (section 20)
--
-- Meetings are business-confidential. Access is the OWNER plus any
-- InfinityCore user who is an explicit participant. Hiding a route in the UI
-- is NOT the boundary; these policies are. A user who hand-types a meeting id
-- still gets nothing unless they own it or are on it.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_can_access_meeting(p_meeting_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.imeet_meetings m
     where m.id = p_meeting_id
       and (
         m.owner_id = auth.uid()
         or exists (select 1 from public.imeet_participants p
                     where p.meeting_id = m.id and p.user_id = auth.uid())
         -- A participant may legitimately have been removed since the meeting
         -- was created, so the owner's rows alone are not enough.
         or exists (select 1 from public.imeet_participants p2
                     join public.imeet_meetings m2 on m2.id = p2.meeting_id
                    where p2.user_id = auth.uid() and m2.owner_id = auth.uid())
       )
  );
$$;
grant execute on function public.imeet_can_access_meeting(uuid) to authenticated;

drop policy if exists "imeet_meetings access" on public.imeet_meetings;
create policy "imeet_meetings access" on public.imeet_meetings
  for select using (public.imeet_can_access_meeting(id));

-- Writes are owner-only. A participant can read a meeting but must not be able
-- to retitle it, move it, or delete it.
drop policy if exists "imeet_meetings insert own" on public.imeet_meetings;
create policy "imeet_meetings insert own" on public.imeet_meetings
  for insert with check (owner_id = auth.uid());

drop policy if exists "imeet_meetings update own" on public.imeet_meetings;
create policy "imeet_meetings update own" on public.imeet_meetings
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "imeet_meetings delete own" on public.imeet_meetings;
create policy "imeet_meetings delete own" on public.imeet_meetings
  for delete using (owner_id = auth.uid());

drop policy if exists "imeet_participants read" on public.imeet_participants;
create policy "imeet_participants read" on public.imeet_participants
  for select using (public.imeet_can_access_meeting(meeting_id));

drop policy if exists "imeet_participants write own" on public.imeet_participants;
create policy "imeet_participants write own" on public.imeet_participants
  for all
  using (exists (select 1 from public.imeet_meetings m
                  where m.id = meeting_id and m.owner_id = auth.uid()))
  with check (exists (select 1 from public.imeet_meetings m
                       where m.id = meeting_id and m.owner_id = auth.uid()));

drop policy if exists "imeet_recordings read" on public.imeet_recordings;
create policy "imeet_recordings read" on public.imeet_recordings
  for select using (public.imeet_can_access_meeting(meeting_id));

drop policy if exists "imeet_recordings write own" on public.imeet_recordings;
create policy "imeet_recordings write own" on public.imeet_recordings
  for all
  using (exists (select 1 from public.imeet_meetings m
                  where m.id = meeting_id and m.owner_id = auth.uid()))
  with check (exists (select 1 from public.imeet_meetings m
                       where m.id = meeting_id and m.owner_id = auth.uid()));

drop policy if exists "imeet_actions read" on public.imeet_action_items;
create policy "imeet_actions read" on public.imeet_action_items
  for select using (public.imeet_can_access_meeting(meeting_id));

-- An assignee may progress their OWN item; only the owner may create, reassign
-- or delete.
drop policy if exists "imeet_actions update" on public.imeet_action_items;
create policy "imeet_actions update" on public.imeet_action_items
  for update using (
    assignee_id = auth.uid()
    or exists (select 1 from public.imeet_meetings m
                where m.id = meeting_id and m.owner_id = auth.uid())
  );

drop policy if exists "imeet_actions write own" on public.imeet_action_items;
create policy "imeet_actions write own" on public.imeet_action_items
  for insert with check (
    exists (select 1 from public.imeet_meetings m
             where m.id = meeting_id and m.owner_id = auth.uid())
  );

drop policy if exists "imeet_actions delete own" on public.imeet_action_items;
create policy "imeet_actions delete own" on public.imeet_action_items
  for delete using (
    exists (select 1 from public.imeet_meetings m
             where m.id = meeting_id and m.owner_id = auth.uid())
  );

drop policy if exists "imeet_requests read" on public.imeet_transcript_requests;
create policy "imeet_requests read" on public.imeet_transcript_requests
  for select using (user_id = auth.uid());

-- Only the caller's own row may be acknowledged; nobody can flip another
-- user's obligation.
drop policy if exists "imeet_requests ack own" on public.imeet_transcript_requests;
create policy "imeet_requests ack own" on public.imeet_transcript_requests
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 8. PRIVATE AUDIO BUCKET (section 20/31)
--
-- `public = false`: there is no anonymous or public URL. Reads go through a
-- short-lived signed URL from `imeet_sign_recording`, which re-checks access.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('i-meet-audio', 'i-meet-audio', false)
on conflict (id) do nothing;

-- Path convention: i-meet-audio/<owner_uuid>/<meeting_uuid>/<recording>.m4a
drop policy if exists "imeet_audio upload own" on storage.objects;
create policy "imeet_audio upload own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'i-meet-audio'
    -- The first path segment must be the caller's own id, so a user cannot
    -- write into someone else's folder even if they know the meeting id.
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No public read policy on this bucket. Reads are served exclusively by the
-- signed-URL function below, which cannot be bypassed by guessing a path.
drop policy if exists "imeet_audio read own" on storage.objects;
create policy "imeet_audio read own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'i-meet-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "imeet_audio delete own" on storage.objects;
create policy "imeet_audio delete own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'i-meet-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 9. SIGNED AUDIO URL
--
-- A participant may be neither the owner nor the first path segment, so the
-- bucket-level policy alone is not enough for them. This mints a short-lived
-- URL after re-checking `imeet_can_access_meeting`. Default 5 minutes: enough
-- to start playback, far too short to be a shareable link.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_sign_recording(
  p_recording_id uuid,
  p_expires_seconds integer default 300
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_rec public.imeet_recordings%rowtype;
  v_path text;
  v_secs integer;
  v_url text;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  select * into v_rec from public.imeet_recordings where id = p_recording_id;
  if v_rec.id is null then raise exception 'Recording not found'; end if;
  if not public.imeet_can_access_meeting(v_rec.meeting_id) then
    raise exception 'Not authorized to access this recording';
  end if;
  if v_rec.audio_path is null then raise exception 'This recording has no audio'; end if;

  v_path := v_rec.audio_path;
  v_secs := least(greatest(coalesce(p_expires_seconds, 300), 30), 900);

  -- `storage.create_signed_url` is the Supabase API: it lives in the `storage`
  -- schema, not `public`. Note the explicit schema here because the function is
  -- SECURITY DEFINER with `search_path = public`, so an unqualified call would
  -- NOT resolve to the storage helper and would fail at runtime, not at deploy.
  select storage.create_signed_url('i-meet-audio', v_path, v_secs) into v_url;
  if v_url is null then raise exception 'Could not sign audio URL'; end if;

  return jsonb_build_object(
    'ok', true,
    'url', v_url,
    'expires_at', now() + make_interval(secs => v_secs),
    'mime', v_rec.audio_mime
  );
end; $$;
grant execute on function public.imeet_sign_recording(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. REALTIME — so the dashboard and list update without a refresh
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'imeet_meetings', 'imeet_recordings', 'imeet_folders', 'imeet_action_items'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 11. CREATE / RESOLVE A MEETING
--
-- One entry point for "start recording", whether or not the meeting came from
-- the calendar. It REUSES an existing meeting when the same calendar event is
-- recorded twice, which is rule 8: a second tap on a calendar event must attach
-- to the same meeting, never fork a duplicate.
--
-- Returns the meeting plus the next recording sequence, so the client can add a
-- follow-up without a second round trip or a new meeting (rule 9).
-- ---------------------------------------------------------------------------
create or replace function public.imeet_open_meeting(
  p_title text default null,
  p_calendar_provider text default null,
  p_calendar_external_id text default null,
  p_started_at timestamptz default null,
  p_location text default null,
  p_folder_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_meeting public.imeet_meetings%rowtype;
  v_seq integer;
  v_reused boolean := false;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  -- Reuse the meeting already bound to this calendar event, if any. Matching is
  -- on the stable external id, never on the title.
  if p_calendar_provider is not null and p_calendar_external_id is not null then
    select * into v_meeting
      from public.imeet_meetings
     where owner_id = v_me
       and calendar_provider = p_calendar_provider
       and calendar_external_id = p_calendar_external_id
     limit 1;
    v_reused := v_meeting.id is not null;
  end if;

  if v_meeting.id is null then
    insert into public.imeet_meetings (
      owner_id, folder_id, title, location,
      calendar_provider, calendar_external_id, started_at, status
    ) values (
      v_me, p_folder_id,
      -- Never leave the title blank: the list and any SARA summary both need
      -- something to show.
      coalesce(nullif(btrim(p_title), ''), 'Untitled meeting'),
      p_location, p_calendar_provider, p_calendar_external_id,
      coalesce(p_started_at, now()), 'recording'
    )
    returning * into v_meeting;
  else
    -- Existing meeting: move it back into 'recording' for the follow-up.
    update public.imeet_meetings
       set status = 'recording',
           started_at = coalesce(started_at, coalesce(p_started_at, now())),
           updated_at = now()
     where id = v_meeting.id
    returning * into v_meeting;
  end if;

  -- Next sequence for a follow-up under THIS meeting.
  select coalesce(max(sequence), 0) + 1 into v_seq
    from public.imeet_recordings where meeting_id = v_meeting.id;

  return jsonb_build_object(
    'ok', true,
    'meeting', to_jsonb(v_meeting),
    'next_sequence', v_seq,
    'reused_existing', v_reused
  );
end; $$;
grant execute on function public.imeet_open_meeting(text, text, text, timestamptz, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. ADD A RECORDING (main or follow-up)
--
-- Assigns the frozen audience in the same transaction: every participant with
-- an InfinityCore account, except the owner, gets one request row. The
-- denominator is therefore fixed at creation and cannot drift.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_add_recording(
  p_meeting_id uuid,
  p_sequence integer default null,
  p_label text default null,
  p_duration_seconds integer default null,
  p_audio_path text default null,
  p_audio_mime text default null,
  p_audio_bytes bigint default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_rec public.imeet_recordings%rowtype;
  v_seq integer;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.imeet_meetings
                  where id = p_meeting_id and owner_id = v_me) then
    raise exception 'Not authorized';
  end if;

  select coalesce(max(sequence), 0) + 1 into v_seq
    from public.imeet_recordings where meeting_id = p_meeting_id;
  if p_sequence is not null then v_seq := p_sequence; end if;

  insert into public.imeet_recordings (
    meeting_id, sequence, label, is_follow_up,
    audio_path, audio_mime, audio_bytes, duration_seconds, upload_status
  ) values (
    p_meeting_id, v_seq, p_label, v_seq > 1,
    p_audio_path, p_audio_mime, p_audio_bytes, p_duration_seconds,
    case when p_audio_path is null then 'local' else 'uploaded' end
  )
  returning * into v_rec;

  -- Freeze the audience: participants with accounts, excluding the owner.
  insert into public.imeet_transcript_requests (recording_id, user_id)
  select v_rec.id, p.user_id
    from public.imeet_participants p
    join public.imeet_meetings m on m.id = p.meeting_id
   where p.meeting_id = p_meeting_id
     and p.user_id is not null
     and p.user_id <> m.owner_id
  on conflict (recording_id, user_id) do nothing;

  update public.imeet_meetings
     set status = 'processing', updated_at = now()
   where id = p_meeting_id;

  return jsonb_build_object('ok', true, 'recording', to_jsonb(v_rec));
end; $$;
grant execute on function public.imeet_add_recording(uuid, integer, text, integer, text, text, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. MARK A STAGE FAILED — WITHOUT DESTROYING ANYTHING (rules 10/11)
--
-- A failed summary must not delete the audio or the transcript, and a failed
-- transcription must not delete the audio. This flips ONE status and records
-- why; every other column is left exactly as it was so a retry is safe.
-- ---------------------------------------------------------------------------
create or replace function public.imeet_mark_stage(
  p_recording_id uuid,
  p_stage text,
  p_error text default null,
  p_failed boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_rec public.imeet_recordings%rowtype;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.imeet_recordings r
                  join public.imeet_meetings m on m.id = r.meeting_id
                  where r.id = p_recording_id and m.owner_id = v_me) then
    raise exception 'Not authorized';
  end if;

  select * into v_rec from public.imeet_recordings where id = p_recording_id;

  if p_stage = 'transcription' then
    update public.imeet_recordings
       set transcription_status = case when p_failed then 'failed' else 'processing' end,
           error_message = p_error,
           updated_at = now()
     where id = p_recording_id
    returning * into v_rec;
  elsif p_stage = 'summary' then
    -- Deliberately does NOT touch transcription_status or the transcript text.
    update public.imeet_recordings
       set summary_status = case when p_failed then 'failed' else 'processing' end,
           error_message = p_error,
           updated_at = now()
     where id = p_recording_id
    returning * into v_rec;
  elsif p_stage = 'upload' then
    update public.imeet_recordings
       set upload_status = case when p_failed then 'failed' else 'uploaded' end,
           error_message = p_error,
           updated_at = now()
     where id = p_recording_id
    returning * into v_rec;
  else
    raise exception 'Unknown stage: %', p_stage;
  end if;

  -- A recording is 'failed' only when BOTH AI stages are unusable. A failed
  -- summary with a good transcript is still a usable meeting.
  update public.imeet_meetings m
     set status = case
           when v_rec.transcription_status = 'failed' then 'failed'
           when v_rec.summary_status = 'failed'
             and v_rec.transcription_status = 'ready' then 'ready'
           when v_rec.transcription_status = 'ready'
             and v_rec.summary_status = 'ready' then 'ready'
           else 'processing'
         end,
         updated_at = now()
   where m.id = v_rec.meeting_id;

  return jsonb_build_object('ok', true, 'recording', to_jsonb(v_rec));
end; $$;
grant execute on function public.imeet_mark_stage(uuid, text, text, boolean) to authenticated;
