// ===========================================================================
// I-Meet presentation rules — PURE, no I/O.
//
// Split out of imeetService.js for the same reason ackRules.js exists: the
// service imports supabaseClient, which node cannot resolve outside a bundler,
// so the logic the UI depends on must be importable by plain tests.
//
// Nothing here may decide ACCESS. These helpers only describe and format what
// the server already authorised (rules 10/12).
// ===========================================================================


/** The pipeline stages, mirrored from the SQL enum. */
export const IMEET_STAGES = Object.freeze({
  queued: 'queued',
  transcribing: 'transcribing',
  transcribed: 'transcribed',
  summarising: 'summarising',
  completed: 'completed',
  failed: 'failed',
  summaryFailed: 'summary_failed',
})

/** True while the server is still working on the recording. */
export function isInFlight(stage) {
  return (
    stage === IMEET_STAGES.queued ||
    stage === IMEET_STAGES.transcribing ||
    stage === IMEET_STAGES.summarising
  )
}

/** 'mm:ss' or 'h:mm:ss' for a recording's duration. */
export function formatDuration(seconds) {
  const n = Number(seconds)
  const s = Number.isFinite(n) && n > 0 ? n : 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * True when the transcript survived even though the run as a whole failed.
 *
 * Transcription and summary are INDEPENDENT columns in the schema, so this is a
 * real, representable state rather than an edge case: the transcript is intact
 * and only the summary is missing. Reporting that as a blanket failure would
 * understate what the user has, so the UI is handed the distinction (rule 10).
 */
export function transcriptSurvived(recording) {
  if (!recording) return false
  return (
    recording.transcription_status === 'ready' &&
    recording.summary_status === 'failed'
  )
}

