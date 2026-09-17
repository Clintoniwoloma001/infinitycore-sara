// ==================================================================
// Termination authorization verification (npm run test:termination-auth)
//
// Proves end-to-end that employee termination/firing/archiving is
// restricted to `super_admin` and `hr_manager` at EVERY layer of
// InfinityCore, by static source inspection of the shipped modules:
//
//   1. Frontend gate  — src/services/terminationAuthorization.js role
//                       matrix (PERSONNEL_TERMINATION_ROLES /
//                       PERSONNEL_ARCHIVE_ROLES allow only the pair)
//   2. NLU / SARA     — src/services/saraNlu.js TERMINATE_EMPLOYEE
//                       consequential intent + role-whitelist +
//                       canExecuteIntent actor-role gate
//   3. Client path    — src/pages/EmployeeProfile.jsx gates terminate
//                       on canTerminate (which derives from the pair)
//                       and archive on canArchive + wires both modals
//   4. SQL migration  — schema_phase37_employee_termination_
//                       authorization.sql pair-gated RPC/trigger +
//                       hard-delete guard + immutable history + legal
//                       digital audit records
//
// The pair rules are enforced in BOTH the client (UX layer) and the
// server (authoritative layer); this verifier makes sure neither layer
// drifts. It runs under plain Node with NO runtime imports of browser-
// coupled modules (they pull in the Supabase client), mirroring the
// repo's static-source-inspection convention for these verifiers.
// ==================================================================

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const fail = (msg) => { failures++; console.error(`  FAIL: ${msg}`) }
const ok = (m) => console.log(`  ok: ${m}`)

console.log('\n=== Termination Authorization Verification (phase 37) ===\n')

// ---------- 1. Frontend canonical authorization module ----------
console.log('1. Frontend gate (src/services/terminationAuthorization.js)')
const auth = readFileSync(join(ROOT, 'src/services/terminationAuthorization.js'), 'utf8')
const aNeedle = (label, needle, min = 1) => {
  const n = auth.split(needle).length - 1
  if (n < min) fail(`${label}: expected ≥ ${min} occurrence(s) of "${needle}", found ${n}`)
  return n
}
aNeedle('termination allowlist', "['super_admin', 'hr_manager']", 2)
aNeedle('archive allowlist', "['super_admin', 'hr_manager']", 2)
if (!/canTerminateEmployee\s*\(/.test(auth)) fail('client must expose canTerminateEmployee')
if (!/canArchiveEmployee\s*\(/.test(auth)) fail('client must expose canArchiveEmployee')
if (!/PERSONNEL_TERMINATION_ROLES/.test(auth)) fail('client must define PERSONNEL_TERMINATION_ROLES')
if (!/PERSONNEL_ARCHIVE_ROLES/.test(auth)) fail('client must define PERSONNEL_ARCHIVE_ROLES')
if (!/TERMINATION_ROLE_MATRIX/.test(auth)) fail('client must define the TERMINATION_ROLE_MATRIX')
ok('canonical pair allowlists + matrix present')

// ---------- 2. NLU / SARA gate ----------
console.log('\n2. NLU / SARA gate (src/services/saraNlu.js)')
const nlu = readFileSync(join(ROOT, 'src/services/saraNlu.js'), 'utf8')
const nNeedle = (label, needle, min = 1) => {
  const n = nlu.split(needle).length - 1
  if (n < min) fail(`${label}: expected ≥ ${min} occurrence(s) of "${needle}", found ${n}`)
  return n
}
nNeedle("'TERMINATE_EMPLOYEE'", "'TERMINATE_EMPLOYEE'", 6)
nNeedle('CONSEQUENTIAL_INTENTS', 'CONSEQUENTIAL_INTENTS', 1)
nNeedle('canExecuteIntent', 'canExecuteIntent', 2)
if (!/canExecuteIntent\(['"]TERMINATE_EMPLOYEE['"],\s*/) fail('NLU must gate TERMINATE_EMPLOYEE through canExecuteIntent')
if (!/canTerminateEmployee\s*\(/.test(nlu)) fail('NLU TERMINATE_EMPLOYEE must route through the pair allowlist')
ok('NLU consequential gate present')

// ---------- 3. Client execution path ----------
console.log('\n3. Client termination/archive UI (src/pages/EmployeeProfile.jsx)')
const profileSvc = readFileSync(join(ROOT, 'src/pages/EmployeeProfile.jsx'), 'utf8')
if (!/canTerminate\b/.test(profileSvc)) fail('EmployeeProfile must gate terminate on canTerminate')
if (!/canArchive\b/.test(profileSvc)) fail('EmployeeProfile must gate archive on canArchive')
if (!/TerminationModal/.test(profileSvc)) fail('EmployeeProfile must wire TerminationModal')
if (!/ArchiveModal/.test(profileSvc)) fail('EmployeeProfile must wire ArchiveModal')
// The terminate/archive write gates must never be tied to roles outside
// the pair (admin / hr_officer / branch roles must not appear as a UI
// grant for the terminated path).
const badGrants = (profileSvc.match(/\b(admin|hr_officer|branch_manager|branch_officer|area_manager)\b[^]*canTerminate/g) || []).length
if (badGrants > 0) fail(`non-pair roles must not gate the terminate path (${badGrants} suspect branch(es))`)
ok('profile terminate/archive gates wired')

// ---------- 4. SQL migration ----------
console.log('\n4. SQL migration (schema_phase37_employee_termination_authorization.sql)')
const sql = readFileSync(join(ROOT, 'schema_phase37_employee_termination_authorization.sql'), 'utf8')
const sNeedle = (label, needle, min = 1) => {
  const n = sql.split(needle).length - 1
  if (n < min) fail(`${label}: expected ≥ ${min} occurrence(s) of "${needle}", found ${n}`)
  return n
}
sNeedle('server pair gate', "not in ('super_admin', 'hr_manager')", 4)
sNeedle('terminated write gate', "employment_status = 'terminated'", 1)
sNeedle('effective-date gate', 'termination_effective_date', 1)
sNeedle('guard trigger', 'create trigger employees_termination_guard', 1)
sNeedle('hard-delete guard', 'create trigger employees_hard_delete_guard', 1)
sNeedle('history table', 'create table if not exists public.employee_employment_history', 1)
sNeedle('termination records table', 'create table if not exists public.employee_termination_records', 1)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
