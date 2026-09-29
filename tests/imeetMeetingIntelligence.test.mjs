import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  IMEET_STAGES,
  isInFlight,
  transcriptSurvived,
  formatDuration,
} from '../src/services/imeetRules.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260930000001_imeet_meeting_intelligence.sql')
const service = read('src/services/imeetService.js')

// ------------------------------------------------------------------
// 1. Audio must stay private. The bucket is private and the ONLY way out is a
//    short-lived signed URL minted by a function that re-checks access.
// ------------------------------------------------------------------
assert.match(migration, /create or replace function public\.imeet_sign_recording\(/)
assert.match(
  migration,
  /if not public\.imeet_can_access_meeting\(v_rec\.meeting_id\) then/,
  'signing must re-check meeting access, or a guessed id would mint a URL'
)
assert.match(migration, /grant execute on function public\.imeet_sign_recording\(uuid, integer\) to authenticated/)
// The Supabase helper lives in `storage`. Calling `public.create_signed_url`
// would fail AT RUNTIME (not at deploy), because this function is SECURITY
// DEFINER with search_path = public and would not resolve the name.
assert.match(
  migration,
  /select storage\.create_signed_url\('i-meet-audio'/,
  'the signed-url helper must be schema-qualified to storage'
)
assert.doesNotMatch(migration, /public\.create_signed_url/)

// ------------------------------------------------------------------
// 2. A follow-up adds a RECORDING to the same meeting, never a second meeting
//    (rule 9), and a calendar event reuses its meeting rather than forking a
//    duplicate (rule 8).
// ------------------------------------------------------------------
assert.match(migration, /create or replace function public\.imeet_add_recording\(/)
assert.match(migration, /create or replace function public\.imeet_open_meeting\(/)
// Reuse matches on the stable external id, never on the title: two meetings
// can share a title, but no two can share a provider + event id.
assert.match(migration, /and calendar_provider = p_calendar_provider/)
assert.match(migration, /and calendar_external_id = p_calendar_external_id/)
assert.match(migration, /'reused_existing', v_reused/)

// ------------------------------------------------------------------
// 3. A failed stage must not destroy the work that succeeded (rules 10/11).
//    Transcription and summary are INDEPENDENT columns, so one failing can
//    never destroy the other, and neither can destroy the audio.
assert.match(
  migration,
  /transcription_status text not null default 'pending'\s*\n\s*check \(transcription_status in \('pending', 'processing', 'ready', 'failed'\)\)/,
  'transcription status must be its own column, independent of the summary'
)
assert.match(
  migration,
  /summary_status text not null default 'pending'\s*\n\s*check \(summary_status in \('pending', 'processing', 'ready', 'failed'\)\)/,
  'summary status must be its own column, independent of transcription'
)
// The transcript lives ON the recording, so two competing transcripts for one
// audio file are structurally impossible (rule 7).
assert.match(migration, /^\s*transcript text,$/m)
assert.doesNotMatch(migration, /create table if not exists public\.imeet_transcripts/)
// The web client must never SELECT the private audio path. Passing audio_path
// to the add-recording RPC is fine (it is the write side, and the bucket policy
// still governs the upload), so scope this to read paths only.
const selectsInService = service.match(/\.select\(([^)]*)\)/g) || []
assert.doesNotMatch(
  selectsInService.join('\n'),
  /audio_path/,
  'the signed RPC is the only route to the audio; never select the path'
)

// ------------------------------------------------------------------
// 4. Pure helpers the UI depends on.
// ------------------------------------------------------------------
const noTranscript = { transcription_status: 'failed', summary_status: 'pending' }
const transcriptOnly = { transcription_status: 'ready', summary_status: 'failed' }
const bothReady = { transcription_status: 'ready', summary_status: 'ready' }
const inProgress = { transcription_status: 'processing', summary_status: 'pending' }

// The "transcript survived, summary missing" case must be distinguishable, or
// the UI would report a total loss when the transcript is actually there.
assert.equal(
  transcriptSurvived(transcriptOnly),
  true,
  'a ready transcript with a failed summary must read as a partial success'
)
assert.equal(transcriptSurvived(bothReady), false, 'a complete recording is not a partial failure')
assert.equal(transcriptSurvived(noTranscript), false, 'no transcript is a real loss')
assert.equal(transcriptSurvived(inProgress), false, 'still working is not a failure')
assert.equal(transcriptSurvived(undefined), false, 'a missing row is not a partial success')

assert.equal(isInFlight(IMEET_STAGES.queued), true, 'queued is still working')
assert.equal(isInFlight(IMEET_STAGES.transcribing), true)
assert.equal(isInFlight(IMEET_STAGES.summarising), true)
assert.equal(isInFlight(IMEET_STAGES.transcribed), false, 'transcribed is a resting state')
assert.equal(isInFlight(IMEET_STAGES.completed), false)
assert.equal(isInFlight(IMEET_STAGES.failed), false, 'a failure is not in flight')
assert.equal(isInFlight(undefined), false, 'a missing stage is not in flight')

assert.equal(formatDuration(0), '00:00')
assert.equal(formatDuration(9), '00:09')
assert.equal(formatDuration(65), '01:05')
assert.equal(formatDuration(3661), '1:01:01', 'hours appear only when needed')
assert.equal(formatDuration(null), '00:00', 'a missing duration must not print NaN')
assert.equal(formatDuration('bad'), '00:00', 'garbage must not print NaN')

console.log('I-Meet meeting-intelligence contract: all assertions passed')
