// ===========================================================================
// I-Meet SCHEDULING + FOLDER MANAGEMENT.
//
// These are the defects that made the feature unusable in the field:
//
//   1. `imeet_open_meeting` hardcoded status='recording' at now(), and the
//      status CHECK constraint had no 'scheduled' value, so an upcoming
//      meeting could not exist. The mobile "Upcoming" section was dead UI.
//   2. `imeet_folders.owner_id` is NOT NULL and RLS demands it equal
//      auth.uid(), but the Flutter client inserted a folder with only a name.
//      That insert could never succeed, so there was no way to create a
//      folder — and therefore nothing to share.
//   3. The web page hid the entire folder block behind `folders.length > 0`,
//      so a user with no folders saw no folder UI at all.
//   4. Web `retryStage` sent `p_transcript_ready`, which is not a parameter of
//      `imeet_mark_stage`, so every retry failed with a PostgREST error — and
//      omitting `p_failed: false` would mark the stage failed again anyway.
//   5. Web `onRecordingReady` ignored the `meetingId` it was handed, so
//      recording a "follow-up" silently created a disconnected new meeting.
//   6. Web never invoked the transcribe function, so a web capture sat at
//      'pending' forever with no transcript and no summary.
//
// These assertions are about wiring and contracts, so a regression fails here
// rather than in front of a user mid-meeting.
// ===========================================================================
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

const page = read('src/pages/IMeet.jsx')
const service = read('src/services/imeetService.js')
const dialog = read('src/components/imeet/ScheduleMeetingDialog.jsx')
const share = read('src/components/imeet/FolderShareDialog.jsx')
const sql = read('supabase/migrations/20260930000003_imeet_scheduling_and_folders.sql')

// ------------------------------------------------------------------
// 1. Every new file must PARSE. A file that exists but does not parse is
//    invisible to the build if nothing imports it yet.
// ------------------------------------------------------------------
for (const [name, file] of [
  ['ScheduleMeetingDialog', 'src/components/imeet/ScheduleMeetingDialog.jsx'],
  ['IMeet page', 'src/pages/IMeet.jsx'],
  ['imeetService', 'src/services/imeetService.js'],
  ['FolderShareDialog', 'src/components/imeet/FolderShareDialog.jsx'],
]) {
  try {
    execFileSync(
      'npx',
      ['esbuild', file, '--bundle', '--external:react', '--external:react-dom',
       '--external:@supabase/supabase-js', '--outfile=/dev/null'],
      { cwd: new URL('.', root).pathname, stdio: 'pipe' },
    )
    assert.ok(true, `${name} should parse`)
  } catch (e) {
    assert.fail(`${name} does not parse: ${e.stderr?.toString().slice(0, 400)}`)
  }
}

// ------------------------------------------------------------------
// 2. Scheduling is actually possible.
// ------------------------------------------------------------------
assert.match(
  sql,
  /check \(status in \([^)]*'scheduled'/,
  "the status CHECK constraint must allow 'scheduled', or no future meeting can exist",
)
assert.match(sql, /create or replace function public\.imeet_schedule_meeting/,
  'imeet_schedule_meeting must exist')
assert.match(sql, /idx_imeet_meetings_upcoming/,
  'the upcoming-meetings query needs its index')
assert.match(service, /async scheduleMeeting\(/, 'the client needs scheduleMeeting')
assert.match(service, /async updateMeeting\(/, 'the client needs updateMeeting')
assert.match(service, /async cancelMeeting\(/, 'the client needs cancelMeeting')

// ------------------------------------------------------------------
// 3. Folder creation must be possible, and must go through the RPC.
//
// A direct client insert CANNOT work here: owner_id is NOT NULL and the RLS
// policy requires it to equal auth.uid(), which the client may not assert.
// ------------------------------------------------------------------
assert.match(sql, /create or replace function public\.imeet_create_folder/,
  'imeet_create_folder must exist')
assert.match(sql, /values \(v_me, v_name,/,
  'the folder owner must come from auth.uid(), never from a client parameter')
assert.doesNotMatch(
  sql,
  /function public\.imeet_create_folder\([\s\S]*?p_owner_id uuid/,
  'imeet_create_folder must not accept a client-supplied owner',
)
assert.match(service, /async createFolder\(/, 'the web client needs createFolder')
assert.match(service, /async renameFolder\(/, 'the web client needs renameFolder')
assert.match(service, /async deleteFolder\(/, 'the web client needs deleteFolder')

// Deleting a folder must never take recordings with it. The FK is ON DELETE
// SET NULL, and the migration must not override that.
assert.match(sql, /function public\.imeet_delete_folder[\s\S]*?delete from public\.imeet_folders/,
  'imeet_delete_folder must delete only the folder row')
assert.doesNotMatch(sql, /delete from public\.imeet_recordings/,
  'deleting a folder must never delete a recording')

// ------------------------------------------------------------------
// 4. The folder block must be reachable with ZERO folders.
//
// Regression guard for `folders.length > 0 && (...)`, which hid every trace
// of folder UI from exactly the users who needed to create their first folder.
// ------------------------------------------------------------------
assert.doesNotMatch(
  page,
  /folders\.length\s*>\s*0\s*&&\s*\(/,
  'the folder section must not be hidden when there are no folders yet',
)
assert.match(page, /newFolderName/, 'the page needs folder-creation state')
assert.match(page, /imeetService\.createFolder\(/, 'the page must offer folder creation')
assert.match(page, /setScheduleTarget\(null\)/,
  'the page must offer a way to schedule a new meeting')

// ------------------------------------------------------------------
// 5. Web retry must call the RPC with the signature it actually has.
//
// `imeet_mark_stage(p_recording_id, p_stage, p_error, p_failed)` — sending
// p_transcript_ready is a hard PostgREST error, and omitting p_failed:false
// re-marks the stage failed, which is the opposite of a retry.
// ------------------------------------------------------------------
const retryBlock = service.slice(
  service.indexOf('async retryStage'),
  service.indexOf('async retryStage') + 400,
)
assert.match(retryBlock, /p_failed:\s*false/,
  'retryStage must pass p_failed:false or it re-fails the stage')
assert.doesNotMatch(retryBlock, /p_transcript_ready/,
  'imeet_mark_stage has no p_transcript_ready parameter')

// ------------------------------------------------------------------
// 6. A follow-up must append to the existing meeting.
//
// Regression guard for the ignored `meetingId` that made every web follow-up
// create a brand-new, disconnected meeting.
// ------------------------------------------------------------------
assert.match(page, /onRecordingReady = useCallback\(async \(\{[^}]*meetingId/,
  'onRecordingReady must accept the meetingId it is given')
assert.match(page, /let targetMeetingId = meetingId/,
  'onRecordingReady must reuse the supplied meeting rather than opening a new one')
assert.match(page, /\.processRecording\(/,
  'the web capture must invoke the transcribe function, or it never gets a transcript')

// ------------------------------------------------------------------
// 7. Identity comes from the session, never from the client.
// ------------------------------------------------------------------
for (const fn of [
  'imeet_create_folder', 'imeet_rename_folder', 'imeet_delete_folder',
  'imeet_schedule_meeting', 'imeet_update_meeting', 'imeet_cancel_meeting',
]) {
  const i = sql.indexOf(`function public.${fn}`)
  assert.ok(i > -1, `${fn} must exist`)
  const body = sql.slice(i, sql.indexOf('$$;', i))
  assert.match(body, /auth\.uid\(\) is null|if v_me is null/,
    `${fn} must refuse an unauthenticated caller`)
  assert.match(body, /security definer/,
    `${fn} must be SECURITY DEFINER to write past RLS`)
  assert.doesNotMatch(body, /p_user_id\s+uuid|p_owner_id\s+uuid/,
    `${fn} must never take an actor id from the client`)
}

// The folder-move flag must exist, or moving a meeting OUT of a folder is
// silently a no-op (a null folderId is indistinguishable from "not supplied").
assert.match(sql, /p_move_to_folder boolean default false/,
  'imeet_update_meeting needs an explicit move flag to clear a folder')
assert.match(dialog, /moveToFolder: true/,
  'the edit dialog must set moveToFolder so clearing a folder actually works')

// ------------------------------------------------------------------
// 8. The people picker must not read `profiles` directly.
//
// It either trips over profiles' own RLS or hands every signed-in user the
// whole staff directory. Both clients go through the RPC instead.
// ------------------------------------------------------------------
assert.doesNotMatch(share, /from\('profiles'\)/,
  'the share dialog must not query profiles directly')
assert.doesNotMatch(share, /supabaseClient/,
  'the share dialog no longer needs a direct supabase client')
assert.match(service, /async listShareablePeople\(/,
  'the client needs listShareablePeople')
assert.match(sql, /p\.id <> auth\.uid\(\)/,
  'the picker must never offer the caller as a share target')

// ------------------------------------------------------------------
// 9. Both dialogs are actually reachable from the page.
// ------------------------------------------------------------------
assert.match(page, /import ScheduleMeetingDialog/,
  'the page must import the scheduling dialog')
assert.match(page, /<ScheduleMeetingDialog/,
  'the page must render the scheduling dialog')
assert.match(page, /<FolderShareDialog/,
  'the page must render the sharing dialog')
// `undefined` = closed, `null` = create. A plain boolean would make "new
// meeting" indistinguishable from "edit this one".
assert.match(page, /useState\(undefined\)/,
  'scheduleTarget must distinguish closed (undefined) from new (null)')

console.log('I-Meet scheduling + folder management: all assertions passed')
