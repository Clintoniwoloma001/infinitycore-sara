// Regression guards for two bugs that blanked I-Meet on BOTH web and mobile:
//
//   1. `imeetService.formatDuration is not a function`
//      formatDuration was a NAMED export of imeetService.js but every call site
//      read it off the DEFAULT export object. One render of a recording threw
//      and took the whole meeting-detail screen down.
//
//   2. `function public.create_signed_url(unknown, text, integer) does not exist`
//      (SQLSTATE 42883) — migration 20260930000002 re-issued
//      imeet_sign_recording with `public.create_signed_url`. The helper lives in
//      the `storage` schema, and the function is SECURITY DEFINER with
//      search_path=public, so Download / Save / Share audio all failed at
//      runtime on the live database.
//
// Both are read from the real source files rather than reimplemented here, so
// the test fails the moment someone reintroduces either mistake.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

const read = (...p) => fs.readFileSync(path.join(repo, ...p), 'utf8')

test('formatDuration is reachable off the default imeetService export', () => {
  const src = read('src/services/imeetService.js')

  // The object literal must actually carry the property...
  const start = src.indexOf('const imeetService = {')
  assert.notEqual(start, -1, 'imeetService default object not found')
  const body = src.slice(start, src.indexOf('\n}', start))
  assert.match(
    body,
    /(^|\n)\s*formatDuration\s*,/m,
    'formatDuration is missing from the imeetService object — UI calls it as ' +
      '`imeetService.formatDuration(...)` and will throw',
  )

  // ...and it must be imported, not re-exported only.
  assert.match(
    src,
    /import\s*\{[^}]*\bformatDuration\b[^}]*\}\s*from\s*'\.\/imeetRules\.js'/,
    'formatDuration must be imported (not just re-exported) to be put on the object',
  )
})

test('the real formatter still behaves', async () => {
  const { formatDuration } = await import('../src/services/imeetRules.js')
  assert.equal(formatDuration(75), '01:15')
  assert.equal(formatDuration(3671), '1:01:11')
  assert.equal(formatDuration(0), '00:00')
})

test('no create_signed_url call is left in the public schema', () => {
  const dir = path.join(repo, 'supabase', 'migrations')
  const offenders = []

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.sql')) continue
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
    // Strip comments first: the explanation of this very bug necessarily
    // contains the broken text, and must not count as an occurrence.
    const code = sql.replace(/--[^\n]*/g, '')
    // `storage.create_signed_url` is correct. Anything else is a 42883 waiting
    // to happen to a user pressing Download.
    for (const m of code.matchAll(/(\w+)\.create_signed_url\s*\(/g)) {
      if (m[1] !== 'storage') offenders.push(`${f}: ${m[0]}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `create_signed_url must be schema-qualified as storage.create_signed_url: ${offenders.join(', ')}`,
  )
})

test('imeet_sign_recording returns a PATH, not a Postgres-minted URL', () => {
  const sql = read('supabase/migrations/20260931000009_imeet_audio_path_instead_of_signed_url.sql')

  // The authoritative fix. storage.create_signed_url does not exist in this
  // deployment, so every play/download failed with SQLSTATE 42883 and the UI
  // showed "Could not save the recording". Supabase signs object URLs in the
  // Storage service over HTTP, not in Postgres, so there is no SQL to call.
  assert.doesNotMatch(
    sql.replace(/--[^\n]*/g, ''),
    /create_signed_url\s*\(/,
    'the RPC must not call create_signed_url in Postgres — it returns the path instead',
  )
  assert.match(sql, /'path',\s*v_rec\.audio_path/, 'the RPC must return the storage path')
  assert.match(sql, /'bucket',\s*'i-meet-audio'/)
  assert.match(
    sql,
    /create policy "imeet_audio read authorised"/,
    'a storage policy is required or a shared-folder member is refused after the RPC lets them through',
  )
})

test('both clients mint the signed URL through the Storage API', () => {
  const mobile = read('../infinitycore-mobile/lib/features/imeet/imeet_service.dart')
  const web = read('src/services/imeetService.js')

  for (const [name, src] of [['mobile', mobile], ['web', web]]) {
    assert.match(src, /createSignedUrl/, `${name} must mint the signed URL via the Storage API`)
    assert.doesNotMatch(
      src,
      /res\[.url.\]|res\?\.url/,
      `${name} must not read a 'url' key the RPC never returns`,
    )
  }
})

test('executive roles are allowed to exist on a profile', () => {
  // THE ROOT CAUSE of the "all pages error for the director" report. The apps
  // define md_ceo / chairman / director as executive roles and
  // get_director_executive_snapshot() *requires* current_role() to be one of
  // them — but profiles_role_check rejected all three, so an executive could
  // not hold their own role at all.
  const sql = read('supabase/migrations/20260931000007_executive_roles_allowed_on_profiles.sql')
  for (const role of ['md_ceo', 'chairman', 'director']) {
    assert.match(sql, new RegExp(`'${role}'::text`), `profiles_role_check must permit ${role}`)
  }
  // And it must be a widening: every pre-existing role has to survive.
  for (const role of ['super_admin', 'admin', 'staff', 'loan_officer', 'customer']) {
    assert.match(sql, new RegExp(`'${role}'::text`), `must not drop the existing ${role} role`)
  }
})

test('the executive snapshot no longer creates a duplicate employee_id', () => {
  // SQLSTATE 42702 on Branch Performance. leave_requests ALREADY has an
  // employee_id column, so `select lr.*, e.id employee_id` produced two columns
  // of that name and every bare reference became ambiguous.
  const raw = read('supabase/migrations/20260931000008_executive_snapshot_ambiguous_employee_id_fix.sql')
  // Strip comments: the file necessarily QUOTES the broken `e.id employee_id`
  // in order to explain it, and that must not count as an occurrence.
  const sql = raw.replace(/--[^\n]*/g, '')
  assert.doesNotMatch(
    sql,
    /e\.id employee_id/,
    'leave_rows must not alias a second employee_id column',
  )
  assert.match(
    sql,
    /coalesce\(lr\.employee_id, e\.id\) as resolved_employee_id/,
    'the owner must be resolved into a distinctly-named column',
  )
  assert.match(sql, /l\.resolved_employee_id/, 'the leave list must join on the resolved column')
})

test('the executive snapshot groups roles by job title, not permission role', () => {
  const sql = read('supabase/migrations/20260931000008_executive_snapshot_ambiguous_employee_id_fix.sql')
  const roles = sql.slice(sql.indexOf("'roles',(select coalesce(jsonb_agg("))

  assert.doesNotMatch(roles, /group by platform_role/, 'must not group by the permission role')
  assert.match(roles, /nullif\(btrim\(designation_title\),''\)/, 'must group by designation')
  for (const key of ['staff', 'attendance_rate', 'kpi_completion', 'target_completion']) {
    assert.ok(roles.includes(key), `roles aggregate lost the '${key}' key`)
  }
})

test('the designation fix does not repurpose the permission-role filter', () => {
  const sql = read('supabase/migrations/20260931000005_executive_targets_by_designation.sql')

  // Filtering BY authorisation is a different question from reporting BY job
  // title. p_role must still filter on the platform role.
  assert.match(
    sql,
    /p_role is null or coalesce\(p\.role,'staff'\)=p_role/,
    'p_role must keep filtering on the platform permission role',
  )
  // And the filter dropdown legitimately still lists permission roles.
  assert.match(
    sql,
    /'roles',\(select coalesce\(jsonb_agg\(jsonb_build_object\('id',role,'name',role\)[^]*?from \(select distinct role from public\.profiles\) x\)/,
    'filters.roles must still offer platform permission roles as filter options',
  )
})

test('importExternalAudio only calls methods that exist', () => {
  // Guards against shipping a call to a method that was never written: the
  // first draft of this feature called `addParticipants`, which does not
  // exist, and the failure would only surface at runtime mid-upload.
  const src = read('src/services/imeetService.js')
  const body = src.slice(src.indexOf('const imeetService = {'))

  const defined = new Set(
    [...body.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1]),
  )
  // Shorthand properties (`formatDuration,`) count as defined too.
  for (const m of body.matchAll(/^\s{2}([A-Za-z_]\w*)\s*,/gm)) defined.add(m[1])

  const fn = body.slice(
    body.indexOf('async importExternalAudio('),
    body.indexOf('async _currentUserId('),
  )

  const called = new Set(
    [...fn.matchAll(/this\.([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]),
  )
  for (const name of called) {
    assert.ok(defined.has(name), `importExternalAudio calls this.${name}(), which does not exist`)
  }

  // It must reuse the real pipeline rather than invent a parallel one.
  assert.ok(called.has('openMeeting'), 'must open a meeting')
  assert.ok(called.has('addRecording'), 'must create the recording row')
  assert.ok(called.has('uploadAudio'), 'must upload the bytes')
  assert.ok(called.has('attachAudioPath'), 'must persist the storage path')
})

test('importExternalAudio keeps audio durable when later steps fail', () => {
  const src = read('src/services/imeetService.js')
  const fn = src.slice(
    src.indexOf('async importExternalAudio('),
    src.indexOf('async _currentUserId('),
  )

  // Attach the path BEFORE any optional/failable work, and never let a
  // transcript or audience failure throw out of the upload.
  assert.ok(
    fn.indexOf('attachAudioPath') < fn.indexOf('processRecording'),
    'audio must be attached to the recording before processing is kicked off',
  )
  assert.match(fn, /\.catch\(\(\) => \{\}\)/, 'optional steps must not reject the upload')
})
