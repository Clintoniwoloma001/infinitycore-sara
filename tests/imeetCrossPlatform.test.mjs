// ===========================================================================
// I-Meet cross-platform wiring.
//
// The bug this guards against is real and already happened once: the sharing
// dialog, the recorder hook, the recorder controls and a web upload path all
// existed as correct, tested files, but NOTHING imported them. Because Vite
// only parses modules reachable from an entry point, `npm run build` stayed
// green and `imeetService.js` carried a syntax error that would have thrown the
// moment anyone rendered it. The feature was invisible on the web and no test
// noticed.
//
// So these assertions are deliberately about WIRING, not logic: the menu entry
// exists, the route resolves, the page mounts the components, and the client
// targets the same storage bucket and path layout as Flutter. A file that
// exists but is unreachable now fails here instead of silently shipping.
// ===========================================================================
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const root = new URL('../', import.meta.url)
const cwd = new URL('.', root).pathname
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const nav = read('src/config/navigation.jsx')
const app = read('src/App.jsx')
const page = read('src/pages/IMeet.jsx')
const service = read('src/services/imeetService.js')
const recorderHook = read('src/hooks/useRecorder.js')
const migration = read('supabase/migrations/20260930000001_imeet_meeting_intelligence.sql')

// ------------------------------------------------------------------
// 1. Every I-Meet file must PARSE. This is the assertion that would have
//    caught the orphaned duplicate `loadTranscript` method, which shipped in
//    commit 469b4bf undetected because no page imported the service.
// ------------------------------------------------------------------
const parse = (file) => {
  try {
    execFileSync(
      'npx',
      ['esbuild', file, '--bundle', '--external:react',
       '--external:@supabase/supabase-js', '--outfile=/dev/null'],
      { cwd, stdio: 'pipe' }
    )
  } catch (e) {
    throw new Error(`${file} does not parse:\n${e.stderr?.toString() || e.message}`)
  }
}
for (const f of [
  'src/services/imeetService.js',
  'src/services/imeetRules.js',
  'src/pages/IMeet.jsx',
  'src/components/imeet/FolderShareDialog.jsx',
  'src/components/imeet/RecorderControls.jsx',
  'src/hooks/useRecorder.js',
]) parse(f)
// ------------------------------------------------------------------
// 2. The menu entry exists and points at a registered page.
// ------------------------------------------------------------------
assert.match(nav, /label:\s*'I-Meet'/, 'I-Meet must appear in the web menu')
assert.match(nav, /path:\s*'\/imeet'/)
assert.match(nav, /element:\s*'IMeet'/)
assert.match(nav, /\bMic\b/, 'the nav icon must be imported from lucide-react')

assert.match(app, /import IMeet from '\.\/pages\/IMeet'/, 'App must import the page')
assert.match(app, /^\s*IMeet,\s*$/m, 'IMeet must be registered in pageComponents')

// The permission gate is `[]` on purpose: I-Meet is self-service, exactly like
// "My Work" and "My Training", so every signed-in employee can reach their own
// recordings. A restrictive key here would hide the page from most staff.
assert.match(nav, /label:\s*'I-Meet'[^}]*permissions:\s*\[\s*\]/)

// ------------------------------------------------------------------
// 3. The page must actually MOUNT the sharing dialog and the recorder.
//    Their mere existence is not enough — that was the original defect.
// ------------------------------------------------------------------
assert.match(page, /import FolderShareDialog from/)
assert.match(page, /import RecorderControls from/)
assert.match(page, /<FolderShareDialog\s+folder=/, 'the share dialog must be rendered')
assert.match(page, /<RecorderControls[\s\S]*?onRecordingReady=/, 'the recorder must be wired')

// Both must be reachable in the two views, not just one.
assert.ok(
  (page.match(/<FolderShareDialog/g) || []).length >= 2,
  'the share dialog must be reachable from both the list view and the meeting detail view'
)
assert.ok(
  (page.match(/<RecorderControls/g) || []).length >= 2,
  'recording must be offered both from the list view and as a meeting follow-up'
)

// ------------------------------------------------------------------
// 4. Cross-platform: the web client must use the same bucket and the same
//    <owner>/<meeting>/<recording> path layout as Flutter, otherwise a phone
//    recording would be invisible to the web (and vice versa).
// ------------------------------------------------------------------
assert.match(service, /from\('i-meet-audio'\)/, 'must use the shared private bucket')
assert.match(
  service,
  /`\$\{ownerId\}\/\$\{meetingId\}\/\$\{recordingId\}\$\{ext\}`/,
  'storage path must match the mobile <owner>/<meeting>/<recording>.<ext> convention'
)
// The first path segment must be the caller, because that is what the storage
// INSERT policy checks.
assert.match(
  migration,
  /storage\.foldername\(name\)\)\[1\]\s*=\s*auth\.uid\(\)::text/,
  'the storage policy keys off the first path segment, so web must lead with the caller id'
)

// Downloads go through the server-checked signer, never a direct bucket read.
assert.match(service, /imeet_sign_recording/)
assert.doesNotMatch(
  page,
  /storage\.from\('i-meet-audio'\)\.createSignedUrl/,
  'the page must not mint its own signed URLs; the server re-checks access'
)

// ------------------------------------------------------------------
// 5. The web capture must persist with the same stage order as mobile,
//    because the recording id (which we do not choose) is the final path
//    segment. Creating the row AFTER the upload would have no id to write.
// ------------------------------------------------------------------
const order = ['openMeeting', 'addRecording', 'uploadAudio', 'attachAudioPath']
const positions = order.map((m) => page.indexOf(`imeetService.${m}(`))
order.forEach((m, i) => {
  assert.ok(positions[i] !== -1, `${m} must be called by the web page`)
  if (i > 0) {
    assert.ok(positions[i] > positions[i - 1], `${m} must come after ${order[i - 1]}`)
  }
})

// ------------------------------------------------------------------
// 6. A read-only share must HIDE the download control rather than offer one the
//    server will refuse. The grant is per-folder, so this must read the folder.
// ------------------------------------------------------------------
assert.match(page, /folder\?\.can_download/, 'the download grant must come from the folder')
assert.match(page, /View only/, 'a view-only member must be told why there is no button')
assert.ok(
  (page.match(/canDownload\s*\?/g) || []).length >= 1,
  'the download control must branch on the grant'
)

// Recording must be offered on the web at all — the point of RecorderControls.
assert.match(recorderHook, /MediaRecorder/, 'the web recorder must use MediaRecorder')

console.log('I-Meet cross-platform wiring: all assertions passed')

// A duplicated member is legal-looking but silently drops the first definition,
// so reject the exact shape we hit. Scoped to the `imeetService` object literal
// itself: the module has helper functions above it whose bodies are also
// indented, and a whole-file regex mistakes their `if (...)` for a member.
const objectStart = service.indexOf('const imeetService = {')
assert.ok(objectStart !== -1, 'imeetService object literal not found')
const objectBody = service.slice(objectStart)
const members = [
  ...objectBody.matchAll(/^ {2}async ([a-zA-Z_$][\w$]*)\s*\(/gm),   // async methods
  ...objectBody.matchAll(/^ {2}([a-zA-Z_$][\w$]*)\s*:/gm),          // plain properties
].map((m) => m[1])
const dupes = members.filter((n, i) => members.indexOf(n) !== i)
assert.deepEqual(dupes, [], `imeetService has duplicate members: ${dupes.join(', ')}`)
// The exact regression: loadTranscript was defined twice, the first orphaned.
assert.equal(
  (service.match(/async loadTranscript/g) || []).length, 1,
  'loadTranscript must be defined exactly once'
)
// Every member referenced by the page must actually exist on the service.
// `formatDuration` and friends are deliberately re-exported from imeetRules.js
// (so plain node tests can import them without a bundler), so include those
// names rather than demanding a local definition.
const reexported = ['IMEET_STAGES', 'isInFlight', 'transcriptSurvived', 'formatDuration']
const available = new Set([...members, ...reexported])
for (const m of [...page.matchAll(/imeetService\.([a-zA-Z_$][\w$]*)/g)].map((x) => x[1])) {
  assert.ok(available.has(m), `the page calls imeetService.${m}, which is neither defined nor re-exported`)
}