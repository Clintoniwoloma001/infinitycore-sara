import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync(new URL('../schema_phase59_training_attendance_link.sql', import.meta.url), 'utf8')

// Attendance link columns on training_sessions, idempotently
for (const column of [
  'attendance_token', 'attendance_link_enabled', 'attendance_link_created_at',
  'attendance_link_created_by', 'attendance_link_regenerated_at',
]) {
  assert.match(migration, new RegExp(`add column if not exists ${column}\\b`), `${column} added idempotently`)
}
assert.match(migration, /create unique index if not exists idx_training_sessions_attendance_token/)

// Token entropy: 48 hex chars from gen_random_bytes(24), not a UUID/sequence
assert.match(migration, /encode\(gen_random_bytes\(24\), 'hex'\)/)
assert.doesNotMatch(migration, /attendance_token\s+uuid/)

// Public RPCs are granted to anon + authenticated
for (const [name, signature] of [
  ['get_training_attendance_context', 'text'],
  ['resolve_training_attendance_employee', 'text, text'],
  ['load_training_attendance_questions', 'text, text'],
  ['submit_training_attendance_quiz', 'text, text, jsonb'],
  ['complete_training_attendance', 'text, text, text'],
]) {
  assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\(${signature}\\) to anon, authenticated`), `${name} reachable anonymously`)
}

// HR-only management RPCs
assert.match(migration, /grant execute on function public\.generate_training_attendance_link\(uuid, boolean\) to authenticated/)
assert.match(migration, /grant execute on function public\.get_training_session_completion\(uuid\) to authenticated/)

// Server-side helpers are never callable directly by anon
assert.match(migration, /revoke all on function public\.training_attendance_session\(text\) from public/)
assert.match(migration, /revoke all on function public\.training_attendance_employee\(text\) from public/)
assert.match(migration, /revoke all on function public\.training_attendance_verify\(text, text\) from public/)
assert.match(migration, /revoke all on function public\.training_attendance_questions\(uuid\) from public/)

// Correct answers must never leave the server in the public load
assert.match(migration, /create or replace function public\.training_attendance_questions\(p_question_set_id uuid\)/)
assert.doesNotMatch(migration, /create or replace function public\.training_attendance_questions[\s\S]{0,1200}correct_answer}/)
assert.match(migration, /'prompt', q\.prompt/)
assert.match(migration, /'question_type', q\.question_type/)
assert.match(migration, /'options', q\.options/)

// Deterministic THREE-question subset, matching the grading loop
assert.match(migration, /order by q\.display_order, q\.id\s+limit 3/)
assert.match(migration, /order by q\.display_order, q\.id limit 3 loop/)

// Server-authoritative grading mirrors the existing assessment flow
assert.match(migration, /update public\.training_assessments\s+set status = 'graded', score = v_score/)
assert.match(migration, /v_passed := v_percentage >= v_session\.assessment_pass_mark/)

// Failures are terminal without HR intervention (no silent retry)
assert.match(migration, /set status = 'failed', submitted_at = now\(\), completed_at = now\(\)/)

// Completion idempotency: existing record + certificate are reused
assert.match(migration, /on conflict \(participant_id\) do nothing/)
assert.match(migration, /on conflict \(employee_training_record_id\) do nothing/)
assert.match(migration, /already_completed/)

// Regenerate rotates the token and records an audit trail
assert.match(migration, /TRAINING_ATTENDANCE_LINK_REGENERATED/)
assert.match(migration, /attendance_link_regenerated_at = now\(\)/)

// Completion stats join certificates through employee_training_records (not participants)
assert.match(migration, /join public\.employee_training_records r on r\.id = c\.employee_training_record_id where r\.session_id = p_session_id/)

// Signature storage: token-hash namespace, path validation, never public-read
assert.match(migration, /not like 'training-attendance\/' \|\| v_token_hash \|\| '\/%\.png'/)
assert.match(migration, /position\('\.\.' in p_signature_path\) > 0/)
assert.match(migration, /length\(p_signature_path\) > 512/)
assert.match(migration, /create policy "training_attendance_sig_upload" on storage\.objects\s+for insert to anon, authenticated/)
assert.match(migration, /and name like 'training-attendance\/%'/)
assert.match(migration, /and name not like 'training-attendance\/%'/)
assert.match(migration, /create policy "training_attendance_sig_hr_read" on storage\.objects[\s\S]{0,400}and public\.training_is_hr\(\)/)

// Employee resolution is guarded: only an EXACT single active match resolves
assert.match(migration, /if v_count is null or v_count = 0 or v_count > 1 then return v; end if/)

console.log('trainingAttendanceLink.test.mjs passed')