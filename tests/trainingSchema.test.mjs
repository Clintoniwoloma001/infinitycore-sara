import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync(new URL('../schema_phase51_training_man_hours.sql', import.meta.url), 'utf8')

for (const table of [
  'training_programmes', 'training_sessions', 'training_participants',
  'training_question_sets', 'training_questions', 'training_assessments',
  'training_answers', 'training_signatures', 'training_attendance',
  'employee_training_records', 'training_certificates', 'training_materials',
]) assert.match(migration, new RegExp(`create table if not exists public\\.${table}`), `${table} exists`)

assert.match(migration, /create or replace function public\.generate_kss_question_sets/)
assert.match(migration, /training_type = 'kss' and jsonb_array_length\(p_sets\) <> 3/)
assert.match(migration, /create or replace function public\.assign_training_participants/)
assert.match(migration, /offset \(\(v_index - 1\) % 3\)/)
assert.match(migration, /create or replace function public\.submit_training_assessment/)
assert.match(migration, /training-signatures\/' \|\| p_participant_id::text/)
assert.match(migration, /p_declaration_accepted/)
assert.match(migration, /create or replace function public\.next_training_certificate_number/)
assert.match(migration, /INF-' \|\| case when v_type = 'kss' then 'KSS' else 'TRN' end/)
assert.match(migration, /create or replace function public\.verify_training_certificate/)
assert.match(migration, /grant execute on function public\.verify_training_certificate\(text\) to anon, authenticated/)
assert.match(migration, /employee_training_records_immutable/)
assert.match(migration, /training_certificates_immutable/)
assert.match(migration, /training_certificate_read on storage\.objects/)
assert.match(migration, /training_signature_upload on storage\.objects/)
assert.match(migration, /get_training_dashboard/)
assert.match(migration, /get_man_hour_intelligence/)
assert.match(migration, /public\.attendance_records ar/)
assert.doesNotMatch(migration, /insert into public\.attendance_records/)

console.log('trainingSchema.test.mjs passed')
