import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url).pathname

// --- Static checks -------------------------------------------------------

const svc = await readFile(`${root}src/services/userProvisioningService.js`, 'utf8')

assert.match(svc, /findEmployeeForProfile\(profile\)/, 'findEmployeeForProfile must exist')
assert.match(svc, /resendInvitationForProfile\(profile/, 'resendInvitationForProfile must exist')
assert.match(svc, /getDepartmentBranchOptions\(\)/, 'getDepartmentBranchOptions must exist')

// Employee resolution: linked-first (user_id), then email fallback.
assert.match(
  svc,
  /user_id\.eq\.\$\{profile\.id\}/,
  'employee lookup must try user_id linkage first'
)
assert.match(
  svc,
  /ilike\('email', profile\.email\)/,
  'employee lookup must fall back to email match'
)
assert.match(
  svc,
  /enrichEmployeeLocations\(\[employee\]\)/,
  'matched employee must be enriched for department/branch'
)

// Re-invite must reuse the employee-backed invite path (never re-create).
assert.match(
  svc,
  /const employee = await this\.findEmployeeForProfile\(profile\)/,
  'resendInvitationForProfile must resolve the employee first'
)
assert.match(
  svc,
  /return this\.resendInvitation\(employee/,
  're-invite must reuse resendInvitation (invite-employees resend path)'
)

// Option sources: free-text employee values + master tables.
assert.match(svc, /from\('employees'\)\.select\('department'\)/, 'departments sourced from employees.department')
assert.match(svc, /from\('employees'\)\.select\('branch'\)/, 'branches sourced from employees.branch')
assert.match(svc, /from\('departments'\)\.select\('name'\)/, 'departments unioned with departments master')
assert.match(svc, /from\('branches'\)\.select\('branch_name'\)/, 'branches unioned with branches master')
assert.match(svc, /new Set/, 'options must be deduplicated')
assert.match(svc, /localeCompare/, 'options must be sorted')

const users = await readFile(`${root}src/pages/Users.jsx`, 'utf8')

// Re-invite button in pending rows, gated to invite-capable roles.
assert.match(
  users,
  /\[['"]super_admin['"],\s*['"]admin['"],\s*['"]head_of_human_resources['"]\]\.includes\(actorRole\)[\s\S]*?Re-invite/,
  'Re-invite button must be gated to super_admin/admin/head_of_human_resources'
)
assert.match(users, /resendInvitationForProfile\(u,/, 'Re-invite must call resendInvitationForProfile')
assert.match(
  users,
  /result\?\.result !== ['"]RESENT['"]/,
  'Re-invite must verify the RESENT result from invite-employees'
)
assert.match(users, /USER_INVITE_RESENT/, 'Re-invite must write a USER_INVITE_RESENT audit entry')

// Review modal dropdowns + employee auto-fill.
assert.match(users, /getDepartmentBranchOptions\(\)/, 'Review modal must load department/branch options')
assert.match(users, /findEmployeeForProfile\(user\)/, 'Review modal must auto-fill from the employee record')
assert.match(users, /Select department…/, 'Department must be a dropdown with a placeholder')
assert.match(users, /Select branch…/, 'Branch must be a dropdown with a placeholder')
assert.match(users, /Pre-filled from employee record/, 'Review modal must surface the auto-filled source')
assert.match(
  users,
  /useInputFallback[\s\S]{0,400}?<input className=\{inputCls\}/,
  'free-text fallback must remain when option lookup fails'
)
assert.match(users, /options\.departments\.includes\(assignment\.department\)/, 'current value must always stay selectable')

console.log('reinviteReviewModal: all assertions passed')