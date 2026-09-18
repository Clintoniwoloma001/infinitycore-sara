import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('schema_phase54_recruitment_pipeline.sql')
const recruitmentService = read('src/services/recruitmentService.js')
const careerService = read('src/services/careerService.js')
const candidateProfile = read('src/pages/CandidateProfile.jsx')
const publicJob = read('src/pages/careers/CareerJobDetail.jsx')
const candidateAnalysis = read('supabase/functions/sara-candidate-analysis/index.ts')

for (const required of [
  'recruitment_application_events',
  'recruitment_talent_pool',
  'recruitment_talent_pool_matches',
  'hr_move_candidate_to_talent_pool',
  'hr_blacklist_candidate',
  'hr_generate_talent_pool_matches',
  'hr_attach_candidate_cv',
  'hr_recruitment_dashboard_stats',
  'public_get_published_jobs',
  'public_get_job_by_token',
  'public_apply_for_job',
  'career_cv_hr_read',
  'Recruitment history is immutable',
]) assert.ok(migration.includes(required), `migration is missing ${required}`)

for (const required of ['uploadCandidateCV', 'attachCandidateCV', 'moveToTalentPool', 'blacklistCandidate', 'completeInterview']) {
  assert.ok(recruitmentService.includes(required), `recruitment service is missing ${required}`)
}
assert.match(recruitmentService, /RESUME_MAX_BYTES\s*=\s*10 \* 1024 \* 1024/)
assert.match(careerService, /cvs\/\$\{folder\}-\$\{randomFolder\}/)
assert.match(candidateProfile, /SARA Candidate Insight/)
assert.match(candidateProfile, /Analyse CV with SARA/)
assert.match(candidateProfile, /Immutable recruitment events/)
assert.match(candidateAnalysis, /analyze_cv/)
assert.match(candidateAnalysis, /input_file/)
assert.match(candidateAnalysis, /getCandidateCV/)
assert.match(publicJob, /Submit application/)
assert.match(publicJob, /Remove/)

console.log('Recruitment pipeline contract checks passed.')
