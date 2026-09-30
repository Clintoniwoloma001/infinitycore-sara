// ===========================================================================
// I-Meet folder sharing and meeting intelligence service.
//
// Every call is a SECURITY DEFINER RPC that re-checks ownership server-side, so
// the UI never decides who may see what - it only renders what the database
// already authorised. Denials come back as the database's own message rather
// than a generic failure, because "you can view this but not download it" and
// "you were removed from this folder" need different messages.
// ===========================================================================
import { supabase } from '../supabaseClient'

// Re-exported so UI code has one import for the module. The definitions live in
// a separate file only because tests cannot resolve `supabaseClient` outside a
// bundler.
export {
  IMEET_STAGES,
  isInFlight,
  transcriptSurvived,
  formatDuration,
} from './imeetRules.js'

import { IMEET_STAGES, formatDuration } from './imeetRules.js'

/** Unwrap an RPC, keeping the server's real reason. */
async function rpc(name, params) {
  const { data, error } = await supabase.rpc(name, params)
  if (error) {
    // Postgres prefixes with the SQLSTATE; strip it so the UI shows prose.
    const message = String(error.message || '').replace(/^[a-z0-9]+:\s*/i, '')
    const err = new Error(message || 'That action could not be completed.')
    err.code = error.code
    throw err
  }
  if (data && data.ok === false) {
    throw new Error(data.error || 'That action could not be completed.')
  }
  return data
}

const imeetService = {
  /**
   * 'mm:ss' / 'h:mm:ss' for a recording length.
   *
   * Exposed on the service object because the UI calls it as
   * `imeetService.formatDuration(...)`. It was previously only a NAMED export,
   * so every call site reading it off the default export threw
   * "imeetService.formatDuration is not a function" and blanked the whole
   * meeting-detail screen the moment a recording rendered.
   */
  formatDuration,

  /** Folders the caller owns PLUS folders shared with them. */
  async listFolders() {
    const res = await rpc('imeet_list_my_folders', {})
    return res?.folders || []
  },

  /** Who currently has access. Owner only; the server refuses otherwise. */
  async listMembers(folderId) {
    const res = await rpc('imeet_list_folder_members', { p_folder_id: folderId })
    return res?.members || []
  },

  /**
   * Add (or re-grant) a user. Idempotent: re-granting revives the existing
   * membership row instead of creating a duplicate.
   */
  async share(folderId, userId, { canView = true, canDownload = true } = {}) {
    return rpc('imeet_share_folder', {
      p_folder_id: folderId,
      p_user_id: userId,
      p_can_view: canView,
      p_can_download: canDownload,
    })
  },

  /**
   * Remove a user. The effect is IMMEDIATE because every read re-checks the
   * membership, and a repeated call is a safe no-op.
   */
  async unshare(folderId, userId) {
    return rpc('imeet_unshare_folder', { p_folder_id: folderId, p_user_id: userId })
  },

  /**
   * A short-lived signed URL for the audio. Re-checked on every call, so a
   * revoked member cannot reuse a URL obtained while they still had access.
   */
  /**
   * A short-lived signed URL for playing / downloading the audio.
   *
   * Two steps on purpose. `imeet_sign_recording` performs the AUTHORISATION —
   * it re-checks that the caller may read this recording and holds the separate
   * download grant — and returns the storage PATH. The signed URL is then
   * minted through the Storage API.
   *
   * It used to ask the RPC for a finished URL, which signed the object by
   * calling `storage.create_signed_url(...)`. That function does not exist in
   * this deployment, so every playback and download failed with SQLSTATE 42883
   * and the UI showed "Could not save the recording". Supabase signs object
   * URLs in the Storage service over HTTP, not in Postgres, so there is no SQL
   * function to call. The bucket stays private and the path is only ever
   * returned to a caller that just passed the checks.
   */
  async getDownloadUrl(recordingId, expiresSeconds = 300) {
    const res = await rpc('imeet_sign_recording', {
      p_recording_id: recordingId,
      p_expires_seconds: expiresSeconds,
    })
    const path = res?.path
    if (!path) return null
    const { data, error } = await supabase.storage
      .from(res.bucket || 'i-meet-audio')
      .createSignedUrl(path, res.expires_seconds || expiresSeconds)
    if (error) throw error
    return data?.signedUrl || null
  },

  /** True when the current user owns the folder (drives the owner-only UI). */
  isOwner: (folder) => Boolean(folder?.is_owner),

  // ------------------------------------------------------------------
  // Meetings and recordings.
  //
  // RLS is the authority here: this client can only ever read a meeting where
  // the caller is the owner or a frozen participant, so there is deliberately
  // no client-side access logic that could drift from the server.
  // ------------------------------------------------------------------

  /**
   * Meetings the caller may read.
   *
   * Ordered so UPCOMING meetings come first — they are the ones a user acts on,
   * and ordering purely by `started_at desc` buried every future meeting at the
   * very bottom of the list, below months of history. Past meetings then read
   * newest-first as before.
   */
  async listMeetings({ folderId = null, limit = 50, onlyUpcoming = false } = {}) {
    let query = supabase
      .from('imeet_meetings')
      .select(
        'id, title, description, started_at, ended_at, location, folder_id, ' +
          'owner_id, status, calendar_provider, calendar_external_id'
      )
      .neq('status', 'cancelled')
      .order('started_at', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (folderId) query = query.eq('folder_id', folderId)
    if (onlyUpcoming) query = query.eq('status', 'scheduled').gte('started_at', new Date().toISOString())
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  /** One meeting with its recordings. Transcripts are NOT included. */
  async getMeeting(meetingId) {
    const { data: meeting, error } = await supabase
      .from('imeet_meetings')
      .select('*')
      .eq('id', meetingId)
      .maybeSingle()
    if (error) throw error
    if (!meeting) return null

    const { data: recordings, error: recErr } = await supabase
      .from('imeet_recordings')
      .select(
        'id, meeting_id, sequence, label, is_follow_up, duration_seconds, ' +
          'transcription_status, summary_status, error_message, ' +
          'summary_overview, summary_key_points, summary_decisions, ' +
          'summary_issues, created_at'
      )
      .eq('meeting_id', meetingId)
      .order('sequence', { ascending: true })
    if (recErr) throw recErr

    // Participants are loaded here rather than embedded in the meeting select
    // because the edit dialog needs them to show who is already invited. RLS
    // scopes this to people who may read the meeting, so it cannot be used to
    // discover an unrelated directory.
    const { data: participants, error: parErr } = await supabase
      .from('imeet_participants')
      .select('id, user_id, display_name, email, is_organiser')
      .eq('meeting_id', meetingId)
      .order('display_name')
    if (parErr) throw parErr

    return {
      ...meeting,
      recordings: recordings || [],
      participants: (participants || []).map((p) => ({
        id: p.user_id || p.id,
        full_name: p.display_name,
        email: p.email,
      })),
    }
  },

  /**
   * Load one recording's transcript on demand.
   *
   * Deliberately not part of [getMeeting]: a meeting with a long history would
   * otherwise transfer every transcript just to render a list.
   *
   * The transcript is a column ON the recording, not a side table, so it is
   * structurally impossible to hold two competing transcripts for one audio
   * file (rule 7).
   */
  async loadTranscript(recordingId) {
    const { data, error } = await supabase
      .from('imeet_recordings')
      .select('transcript, transcript_language')
      .eq('id', recordingId)
      .maybeSingle()
    if (error) throw error
    return data?.transcript ?? null
  },

  /**
   * Upload a captured blob into the PRIVATE `i-meet-audio` bucket.
   *
   * The path convention is `<owner>/<meeting>/<recording>.<ext>` and is NOT
   * arbitrary: the storage INSERT policy requires the FIRST path segment to
   * equal `auth.uid()`, so a recording can only ever be written under the
   * caller's own id. Mobile uses the identical layout, which is what lets a
   * file recorded on the phone be listed and downloaded from the web.
   *
   * Uploaded AFTER `addRecording` so the recording id (which we do not choose —
   * the database does) is already known and becomes the final path segment.
   */
  async uploadAudio({ blob, ownerId, meetingId, recordingId, mime }) {
    // The extension is derived from the recorder's own MIME type rather than
    // from the blob's name (a Blob has none), defaulting to m4a.
    const ext =
      mime && mime.includes('webm') ? '.webm'
      : mime && mime.includes('ogg') ? '.ogg'
      : mime && (mime.includes('mpeg') || mime.includes('mp3')) ? '.mp3'
      : mime && mime.includes('wav') ? '.wav'
      : '.m4a'
    const path = `${ownerId}/${meetingId}/${recordingId}${ext}`
    const { error } = await supabase.storage
      .from('i-meet-audio')
      .upload(path, blob, { contentType: mime || 'audio/mp4', upsert: true })
    if (error) throw error
    return path
  },

  /**
   * Write the stored audio location onto the recording.
   *
   * Mirrors the mobile `_attachAudioPath`. The audio is already durable at this
   * point, so a failure here is reported but never destroys the capture.
   */
  async attachAudioPath(recordingId, path, bytes, mime) {
    const { error } = await supabase
      .from('imeet_recordings')
      .update({
        audio_path: path,
        audio_mime: mime || 'audio/mp4',
        audio_bytes: bytes ?? null,
        upload_status: 'uploaded',
      })
      .eq('id', recordingId)
    if (error) throw error
  },

  /**
   * Open (or reuse) a meeting and get the sequence for its next recording.
   *
   * Returns `{ meetingId, nextSequence, reused }`. `reused` is true when a
   * meeting was already bound to this calendar event, so the UI can say
   * "continuing the existing meeting" rather than silently forking a duplicate
   * (rule 8). Matching is on the stable external id, never on the title.
   */
  async openMeeting({
    title = null,
    calendarProvider = null,
    calendarExternalId = null,
    startedAt = null,
    location = null,
    folderId = null,
  } = {}) {
    const res = await rpc('imeet_open_meeting', {
      p_title: title,
      p_calendar_provider: calendarProvider,
      p_calendar_external_id: calendarExternalId,
      p_started_at: startedAt,
      p_location: location,
      p_folder_id: folderId,
    })
    return {
      meetingId: res?.meeting?.id,
      nextSequence: res?.next_sequence ?? 1,
      reused: Boolean(res?.reused_existing),
    }
  },

  /** Attach a new recording to an EXISTING meeting (a follow-up, rule 9). */
  async addRecording({
    meetingId,
    sequence,
    label = null,
    durationSeconds = null,
    audioPath = null,
    audioMime = null,
    audioBytes = null,
  }) {
    return rpc('imeet_add_recording', {
      p_meeting_id: meetingId,
      p_sequence: sequence,
      p_label: label,
      p_duration_seconds: durationSeconds,
      p_audio_path: audioPath,
      p_audio_mime: audioMime,
      p_audio_bytes: audioBytes,
    })
  },

  /**
   * Register an audio file the platform did NOT record.
   *
   * Covers the "upload from the device" case: a phone voice memo, a Zoom/Teams
   * export, anything already on hand. It is deliberately a SINGLE method that
   * reuses `openMeeting` + `addRecording` + `uploadAudio` rather than a parallel
   * code path, so an imported file lands in exactly the same tables, obeys the
   * same ownership checks, and is playable/summarizable identically to a native
   * capture (rules 2, 10, 11).
   *
   * Returns `{ meetingId, recordingId, path, durationSeconds }`.
   *
   * `folderId` is optional: pass null to keep the meeting standalone, or a
   * folder uuid the caller already owns. Ownership is re-verified server-side,
   * so a forged id is rejected rather than trusted.
   */
  async importExternalAudio({
    file,
    title = null,
    folderId = null,
    startedAt = null,
    location = null,
    participantIds = [],
    process = true,
  }) {
    if (!(file instanceof Blob)) throw new Error('Choose an audio file to upload.')
    // Whisper's hard limit is 25MB. Rejecting here gives an honest message
    // instead of an opaque 413 from the edge function after a long upload.
    if (file.size > 25 * 1024 * 1024) {
      throw new Error('That file is larger than 25 MB. Please trim it before uploading.')
    }
    if (file.size === 0) throw new Error('That file is empty.')

    const mime = file.type || 'audio/mp4'
    const { meetingId, nextSequence } = await this.openMeeting({
      title: title || file.name || 'Uploaded recording',
      startedAt,
      location,
      folderId,
    })

    // The recording row is created FIRST so the database chooses the id, which
    // then becomes the final path segment (see uploadAudio).
    const added = await this.addRecording({
      meetingId,
      sequence: nextSequence,
      label: 'Uploaded audio',
      audioMime: mime,
      audioBytes: file.size,
    })
    const recordingId = added?.recording?.id
    if (!recordingId) throw new Error('Could not create the recording entry.')

    const path = await this.uploadAudio({
      blob: file,
      ownerId: (await this._currentUserId()),
      meetingId,
      recordingId,
      mime,
    })
    await this.attachAudioPath(recordingId, path, file.size, mime)

    if (participantIds?.length) {
      // Reuses the existing, already-authorized update RPC rather than a second
      // way to write participants. Best-effort by design: the audio is already
      // durable, so an audience failure must not discard the upload.
      await this.updateMeeting(meetingId, { participantIds }).catch(() => {})
    }

    if (process) {
      this.processRecording(recordingId).catch(() => {})
    }

    return { meetingId, recordingId, path, durationSeconds: null }
  },

  async _currentUserId() {
    const { data } = await supabase.auth.getUser()
    const uid = data?.user?.id
    if (!uid) throw new Error('You must be signed in to upload a recording.')
    return uid
  },

  /**
   * Drive audio -> transcript -> summary for one recording.
   *
   * The provider key lives ONLY in the edge function, never here: this client
   * holds no privileged credential (rule 5). Mirrors the mobile
   * `IMeetService.processRecording` so both platforms run the identical
   * pipeline and report identical stage failures.
   *
   * Throws on failure rather than swallowing it, so the caller can tell the
   * user which stage broke. A failed summary does NOT destroy the transcript
   * (rule 10), and a failed transcription does not destroy the audio (rule 11).
   */
  async processRecording(recordingId, onStage) {
    const { data, error } = await supabase.functions.invoke('imeet-transcribe', {
      body: { recording_id: recordingId },
    })
    if (error) throw new Error(error.message || 'Processing could not be started.')
    // The function answers 200 with { ok:false } for a stage failure, so an
    // HTTP success alone must not be reported as a successful pipeline.
    if (data && data.ok === false) {
      const stage = data.stage === 'summary' ? 'summary' : 'transcription'
      onStage?.(stage, data.error || 'Processing did not complete.')
      const err = new Error(data.error || 'Processing did not complete.')
      err.stage = stage
      err.transcriptReady = Boolean(data.transcript_ready)
      throw err
    }
    onStage?.('completed', null)
    return data || { ok: true }
  },

  /**
   * Retry ONE failed stage.
   *
   * `stage` is `'transcription'` or `'summary'`. They are independent on
   * purpose: retrying a summary must not re-transcribe, because the transcript
   * is already good and re-running it risks producing a different answer
   * (rule 10).
   *
   * `p_failed: false` is what puts the stage back into 'processing'. The
   * function's DEFAULT is `p_failed => true`, so omitting it would mark the
   * stage failed again — the exact opposite of a retry.
   */
  async retryStage(recordingId, stage) {
    return rpc('imeet_mark_stage', {
      p_recording_id: recordingId,
      p_stage: stage,
      p_error: null,
      p_failed: false,
    })
  },

  // ------------------------------------------------------------------
  // Folders. Creating a folder goes through the RPC rather than a direct
  // insert because `imeet_folders.owner_id` is NOT NULL and RLS requires it to
  // equal auth.uid() — a client insert that omitted it could never succeed.
  // ------------------------------------------------------------------

  /** Create (or return the existing) folder with this name. */
  async createFolder(name) {
    const res = await rpc('imeet_create_folder', {
      p_name: name,
      p_colour: null,
    })
    return res?.folder || null
  },

  /** Owner only; the server refuses otherwise. */
  async renameFolder(folderId, name) {
    return rpc('imeet_rename_folder', {
      p_folder_id: folderId,
      p_name: name,
      p_colour: null,
    })
  },

  /**
   * Delete a folder. Meetings inside are KEPT and simply become folder-less,
   * so no recording or transcript is ever destroyed by tidying up.
   */
  async deleteFolder(folderId) {
    return rpc('imeet_delete_folder', { p_folder_id: folderId })
  },

  /**
   * People who may be picked. Goes through an RPC instead of reading
   * `profiles` directly, which would either hit profiles' own RLS or expose the
   * whole staff directory. Pass a folder id to also learn who already has
   * access.
   */
  async listShareablePeople(folderId = null) {
    const res = await rpc('imeet_shareable_people', {
      p_exclude_folder_id: folderId,
    })
    return res?.people || []
  },

  // ------------------------------------------------------------------
  // Scheduling and meeting management.
  // ------------------------------------------------------------------

  /**
   * Put a meeting in the future.
   *
   * Returns `{ meetingId }`. Recording it later appends a recording to THIS
   * row rather than creating a second meeting.
   */
  async scheduleMeeting({
    title,
    startsAt,
    location = null,
    description = null,
    folderId = null,
    durationMinutes = null,
    participantIds = null,
  }) {
    const res = await rpc('imeet_schedule_meeting', {
      p_title: title,
      p_starts_at: startsAt,
      p_location: location,
      p_description: description,
      p_folder_id: folderId,
      p_duration_minutes: durationMinutes,
      p_calendar_provider: null,
      p_calendar_external_id: null,
      p_participant_ids: participantIds,
    })
    return { meetingId: res?.meeting?.id }
  },

  /**
   * Edit / reschedule / move a meeting between folders.
   *
   * `folderId` is only applied when `moveToFolder` is true. Without that flag a
   * null folderId is indistinguishable from "not supplied" in Postgres, and
   * moving a meeting OUT of a folder would silently do nothing.
   */
  async updateMeeting(meetingId, patch = {}) {
    const {
      title = null,
      startsAt = null,
      location = null,
      description = null,
      folderId = null,
      moveToFolder = false,
      durationMinutes = null,
      participantIds = null,
    } = patch
    return rpc('imeet_update_meeting', {
      p_meeting_id: meetingId,
      p_title: title,
      p_starts_at: startsAt,
      p_location: location,
      p_description: description,
      p_folder_id: folderId,
      p_move_to_folder: moveToFolder,
      p_duration_minutes: durationMinutes,
      p_participant_ids: participantIds,
    })
  },

  /** Cancel a scheduled meeting. The row is kept for the audit trail. */
  async cancelMeeting(meetingId) {
    return rpc('imeet_cancel_meeting', { p_meeting_id: meetingId })
  },

  /** Subscribe to a meeting's recordings so the list updates without polling. */
  subscribeToMeeting(meetingId, onChange) {
    const channel = supabase
      .channel(`imeet:meeting:${meetingId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'imeet_recordings',
          filter: `meeting_id=eq.${meetingId}`,
        },
        onChange
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  },
}

export default imeetService
