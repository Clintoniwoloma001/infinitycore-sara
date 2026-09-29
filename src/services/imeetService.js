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

import { IMEET_STAGES } from './imeetRules.js'

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
  async getDownloadUrl(recordingId, expiresSeconds = 300) {
    const res = await rpc('imeet_sign_recording', {
      p_recording_id: recordingId,
      p_expires_seconds: expiresSeconds,
    })
    return res?.url || null
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

  /** Meetings the caller may read, newest first. */
  async listMeetings({ folderId = null, limit = 50 } = {}) {
    let query = supabase
      .from('imeet_meetings')
      .select(
        'id, title, started_at, ended_at, location, folder_id, owner_id, ' +
          'calendar_provider, calendar_external_id'
      )
      .order('started_at', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (folderId) query = query.eq('folder_id', folderId)
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
    return { ...meeting, recordings: recordings || [] }
  },

  /**
   * Load one recording's transcript on demand.
   *
   * Deliberately not part of [getMeeting]: a meeting with a long history would
   * otherwise transfer every transcript just to render a list.
   */
  async loadTranscript(recordingId) {
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
   * Retry ONE failed stage.
   *
   * `stage` is `'transcription'` or `'summary'`. They are independent on
   * purpose: retrying a summary must not re-transcribe, because the transcript
   * is already good and re-running it risks producing a different answer
   * (rule 10).
   */
  async retryStage(recordingId, stage) {
    return rpc('imeet_mark_stage', {
      p_recording_id: recordingId,
      p_stage: stage,
      p_error: null,
      p_transcript_ready: null,
    })
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
