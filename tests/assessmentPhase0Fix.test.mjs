import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000002_assessment_template_antcheat_default.sql')
const service = read('src/services/assessmentService.js')

// --- Bug A source (Assessments page crash): Plus must be imported & used ---
const assessments = read('src/pages/Assessments.jsx')
assert.match(assessments, /\bPlus\b/, 'Assessments.jsx must use the Plus icon')
const importLine = assessments.split('\n').find((l) => l.includes("from 'lucide-react'"))
assert.ok(importLine && /\bPlus\b/.test(importLine), `Assessments.jsx must import Plus from lucide-react: ${importLine}`)

// --- Bug B service-side: createTemplate always sends a concrete anti_cheat ---
const DEFAULT_ANTI_CHEAT = read('src/services/assessmentService.js').match(/\{\s*max_flags:\s*3,[\s\S]*?\}/)?.[0]
assert.ok(DEFAULT_ANTI_CHEAT, 'assessmentService.js must define a DEFAULT_ANTI_CHEAT config')
assert.ok(service.includes('anti_cheat: data.anti_cheat || DEFAULT_ANTI_CHEAT'),
  'createTemplate must fall back to DEFAULT_ANTI_CHEAT, never send undefined')
for (const key of ['max_flags', 'flag_severity', 'close_on_flag', 'require_hr_review',
  'retake_limit', 'retake_time_hours', 'keep_previous_attempt', 'track_copy_paste',
  'track_context_menu', 'track_fullscreen', 'inactivity_timeout_minutes']) {
  assert.ok(service.includes(`${key}:`), `DEFAULT_ANTI_CHEAT is missing ${key}`)
}
assert.ok(!service.includes('anti_cheat: data.anti_cheat || undefined'),
  'createTemplate must not rely on the DB column default')
assert.ok(/if \(clean\.anti_cheat === null \|\| clean\.anti_cheat === undefined\) delete clean\.anti_cheat/,
  'updateTemplate must never null the anti_cheat column')

// --- Bug B DB-side: corrective migration backfills, sets DEFAULT, asserts NOT NULL ---
assert.match(migration, /assessment_templates/i)
assert.match(migration, /update public\.assessment_templates/, 'must backfill legacy NULL rows')
assert.match(migration, /where anti_cheat is null/)
assert.match(migration, /alter column anti_cheat set default/i, 'must give the column a DEFAULT')
assert.match(migration, /alter column anti_cheat set not null/i, 'must (re)assert NOT NULL')
assert.match(migration, /max_flags/, 'default config must carry the runtime-read keys')

console.log('assessment-fix tests passed.')