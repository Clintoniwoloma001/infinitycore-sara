import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000009_hr_jobs_archive_edit_delete.sql')
const page = read('src/pages/HRJobs.jsx')

// --- 1. Status CHECK extended to admit 'archived' (idempotent drop/add) ---
for (const required of [
  `drop constraint if exists hr_jobs_status_check`,
  `add constraint hr_jobs_status_check`,
  `check (status in ('draft', 'published', 'closed', 'archived'))`,
]) {
  assert.ok(migration.includes(required), `migration is missing ${required}`)
}

// --- 2. archived_at column exists ---
assert.match(migration, /add column if not exists archived_at timestamptz/)

// --- 3. RLS delete policy gated to HR management roles ---
assert.match(migration, /drop policy if exists hr_jobs_delete on public\.hr_jobs/)
assert.match(migration, /create policy hr_jobs_delete on public\.hr_jobs/)
assert.match(migration, /for delete using \(/)
assert.match(migration, /public\.current_role\(\) in \('super_admin', 'admin', 'hr_manager'\)/)

// --- 4. Frontend: new status colour + filter option ---
assert.match(page, /archived: 'violet'/)
assert.match(page, /<option value="archived">Archived<\/option>/)

// --- 5. Edit flow: startEdit prefills the form and reuses the modal ---
assert.match(page, /const \[editingJob, setEditingJob\] = useState\(null\)/)
assert.match(page, /const startEdit = \(job\) => \{/)
assert.match(page, /const jobToForm = \(job\) => \{/)
assert.match(page, /setEditingJob\(job\)/)
assert.match(page, /\.from\('hr_jobs'\)\n\s*\.update\(\{ \.\.\.payload, updated_at: new Date\(\)\.toISOString\(\) \}\)/)
assert.match(page, /{editingJob \? 'Edit Job Posting' : 'New Job Posting'}/)
assert.match(page, /{editingJob \? 'Save Changes' : 'Save as Draft'}/)

// --- 6. Archive + restore + delete handlers present in the card actions ---
assert.match(page, /const archiveJob = async \(job\) => \{/)
assert.match(page, /status: 'archived', archived_at: new Date\(\)\.toISOString\(\)/)
assert.match(page, /const restoreJob = async \(job\) => \{/)
assert.match(page, /status: 'draft', archived_at: null, closed_at: null/)
assert.match(page, /const deleteJob = async \(job\) => \{/)
assert.match(page, /\.from\('hr_jobs'\)\.delete\(\)\.eq\('id', job\.id\)/)
assert.match(page, /job\.status !== 'archived' \&\& \(/)
assert.match(page, /Archive/)

// --- 7. Published card relabels Close -> Stop applications (public apply gate
//        already requires status='published', so closed = not collecting) ---
assert.match(page, /Stop applications/)
assert.match(page, /job\.status === 'published' \&\& \(/)
assert.match(page, /job\.status === 'closed' \&\& \(.*Reopen/s)

console.log('hr-jobs archive/edit/delete assertions passed.')