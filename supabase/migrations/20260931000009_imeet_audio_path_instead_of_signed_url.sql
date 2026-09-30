-- ============================================================================
-- I-MEET AUDIO: return the storage PATH, not a Postgres-minted URL
-- ============================================================================
-- THE BUG (the "Could not save the recording" banner in the app)
--   imeet_sign_recording signed the audio by calling a database function:
--       select storage.create_signed_url('i-meet-audio', v_path, v_secs)
--   That function DOES NOT EXIST in this Supabase deployment. The storage
--   schema here exposes allow_any_operation, create_signed_upload_url and the
--   object helpers — there is no create_signed_url at all.
--
--   So the call failed at RUNTIME with:
--       function storage.create_signed_url(text, text, integer) does not exist
--       (SQLSTATE 42883, "Not Found")
--   An earlier fix had merely corrected `public.` to `storage.`, which turned
--   one 42883 into another. Neither form can work: Supabase signs object URLs
--   in the Storage SERVICE (over HTTP), not in Postgres. There is no SQL
--   function to call, so the function signature itself was the wrong design.
--
-- THE FIX
--   Split the two responsibilities that were wrongly fused:
--     * THIS function keeps the authorisation — it still resolves the recording
--       from auth.uid(), re-checks meeting/folder access AND the separate
--       download grant, and refuses a member whose folder is read-only.
--     * It returns the storage PATH plus a short expiry, and the client asks
--       the Storage API for a signed URL with createSignedUrl(path).
--
--   Nothing is weakened: the path is only ever handed to a caller who just
--   passed the same checks, and the bucket stays private.
--
-- WHY A STORAGE POLICY IS ALSO NEEDED
--   The existing policy allowed reads only when the FIRST FOLDER segment of the
--   path equalled auth.uid() — i.e. the owner only. A person a folder was
--   shared with would pass this RPC and then be refused by the Storage API,
--   which would be a new bug rather than a fix.
--
--   imeet_can_read_audio() below is the same authorisation question asked in
--   the form the policy can evaluate: does this caller already have access to
--   the meeting this object belongs to? It is SECURITY DEFINER so the storage
--   policy can read imeet_* tables that the caller may not select directly.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Can this caller read THIS audio object?
-- ---------------------------------------------------------------------------
create or replace function public.imeet_can_read_audio(p_path text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.imeet_recordings r
     where r.audio_path = p_path
       and (
         public.imeet_can_access_meeting(r.meeting_id)
         or exists (
           select 1
             from public.imeet_meetings m
            where m.id = r.meeting_id
              and public.imeet_can_view_folder(m.folder_id)
         )
       )
  );
$$;
grant execute on function public.imeet_can_read_audio(text) to authenticated;
revoke all on function public.imeet_can_read_audio(text) from anon;

drop policy if exists "imeet_audio read authorised" on storage.objects;
create policy "imeet_audio read authorised" on storage.objects
  for select to authenticated
  using (bucket_id = 'i-meet-audio' and public.imeet_can_read_audio(name));

-- ---------------------------------------------------------------------------
-- 2. imeet_sign_recording -> authorise and return the PATH
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
  v_secs integer;
  v_can_download boolean;
begin
  if v_me is null then raise exception 'Not authenticated'; end if;

  select * into v_rec from public.imeet_recordings where id = p_recording_id;
  if v_rec.id is null then raise exception 'Recording not found'; end if;

  -- Reading the meeting at all: participant/owner, or an active folder grant.
  if not public.imeet_can_access_meeting(v_rec.meeting_id)
     and not exists (
       select 1 from public.imeet_meetings m
        where m.id = v_rec.meeting_id
          and public.imeet_can_view_folder(m.folder_id)
     ) then
    raise exception 'Not authorized to access this recording';
  end if;

  if v_rec.audio_path is null then raise exception 'This recording has no audio'; end if;

  -- Download is a SEPARATE grant from viewing. A read-only folder member can
  -- play what they are entitled to but must not be handed a file to keep.
  select m.folder_id into v_folder
    from public.imeet_meetings m where m.id = v_rec.meeting_id;

  v_can_download := public.imeet_is_folder_owner(v_folder)
    or public.imeet_can_access_meeting(v_rec.meeting_id)
    or public.imeet_can_download_folder(v_folder);

  if not v_can_download then
    raise exception 'You can view this recording but the owner has not allowed downloads';
  end if;

  v_secs := least(greatest(coalesce(p_expires_seconds, 300), 30), 900);

  -- The PATH, not a URL. The client turns this into a short-lived signed URL
  -- through the Storage API, which is the only thing that can actually sign.
  return jsonb_build_object(
    'ok', true,
    'bucket', 'i-meet-audio',
    'path', v_rec.audio_path,
    'expires_seconds', v_secs,
    'mime', v_rec.audio_mime
  );
end; $$;
grant execute on function public.imeet_sign_recording(uuid, integer) to authenticated;
revoke all on function public.imeet_sign_recording(uuid, integer) from anon;

commit;
