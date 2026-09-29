// ============================================================================
// BankOne Import Identity + Branch Resolution Engine
// ============================================================================
// Covers the 13 required cases from the spec. Everything runs against the REAL
// pure domain modules - no database, no mocking - so behaviour is pinned.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeName, squashName } from '../src/domains/bankone/normalize.js'
import { detectHeaderRow, toNumber, parseBankOneDate, detectSlashFormat } from '../src/domains/bankone/parse.js'
import { createEmployeeIndex, resolveOfficer, MATCH } from '../src/domains/bankone/employeeIdentity.js'
import { createBranchIndex, resolveBranch, detectMergedBranches, BRANCH_MATCH } from '../src/domains/bankone/branchIdentity.js'
import { runImport, branchRollup, officerRollup, SOURCE_TYPES, isNonPerforming } from '../src/domains/bankone/importPipeline.js'
import { PAR_EXPECTED_COLUMNS, DISBURSEMENT_EXPECTED_COLUMNS } from '../src/domains/bankone/columns.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

let n = 0
const check = (name, fn) => { fn(); n++; console.log('  ok - ' + name) }

const EMP = [
  { id: 'e1', full_name: 'ABIMBOLA ANIMASHAHUN LANIKE' },
  { id: 'e2', full_name: 'ABIWON TOLULOPE AYODEJI' },
  { id: 'e3', full_name: 'ADEOTI FUNMILAYO MONSURAT' },
  { id: 'e4', full_name: 'BISI AJAYI' },
  { id: 'e5', full_name: 'BISI AJAYI' },        // genuine duplicate name
  { id: 'e6', full_name: 'KEHINDE-PRAISE BABATUNDE' },
  { id: 'e7', full_name: 'ADEKEYE ADELEKE EMMANUEL' },
  { id: 'e8', full_name: 'OKAFOR ADAEZE' },
]
const BRANCHES = [
  { id: 'b1', branch_name: 'KETU' },
  { id: 'b2', branch_name: 'Head Office' },
  { id: 'b3', branch_name: 'HEAD OFFICE' },       // case duplicate
  { id: 'b4', branch_name: 'MUSHIN/YABA' },      // merged
  { id: 'b5', branch_name: 'IBEJU-LEKKI' },
]

const idx = createEmployeeIndex(EMP)
const bidx = createBranchIndex(BRANCHES)
const R = (name) => resolveOfficer(name, idx, new Map())
const B = (name) => resolveBranch(name, bidx, new Map())

console.log('\n1. Exact employee name')
check('an exact name resolves automatically', () => {
  const r = R('ABIMBOLA, ANIMASHAHUN LANIKE')       // source has a comma
  assert.equal(r.status, 'auto_resolved')
  assert.equal(r.matchType, MATCH.EXACT)
  assert.equal(r.employeeId, 'e1')
})

console.log('\n2. Punctuation variation')
check('a punctuation-only difference resolves automatically', () => {
  // normalizeName folds commas/hyphens but keeps brackets, so this reaches the
  // squash stage - exactly the "harmless punctuation" case.
  const r = R('OKAFOR(ADAEZE)')
  assert.equal(r.status, 'auto_resolved')
  assert.equal(r.matchType, MATCH.FORMAT)
  assert.equal(r.employeeId, 'e8')
})
check('a stored name in given-then-surname order is NOT auto-assigned', () => {
  // 'BABATUNDE KEHINDE-PRAISE' vs the stored 'KEHINDE-PRAISE BABATUNDE' differ in
  // token ORDER, so it is correctly demoted to review rather than auto-matched.
  const r = R('BABATUNDE KEHINDE-PRAISE')
  assert.equal(r.status, 'pending_review')
  assert.equal(r.employeeId, undefined)
  assert.equal(r.candidates[0].id, 'e6')
})
check('normalisation is what makes the comma harmless', () => {
  assert.equal(normalizeName('ABIMBOLA, ANIMASHAHUN LANIKE'), 'ABIMBOLA ANIMASHAHUN LANIKE')
  assert.equal(squashName('KEHINDE-PRAISE'), squashName('KEHINDE PRAISE'))
})

console.log('\n3. Token reorder')
check('a reordered name goes to REVIEW, never straight to auto', () => {
  const r = R('ADEOTI MONSURAT FUNMILAYO')
  assert.equal(r.status, 'pending_review')
  assert.equal(r.matchType, MATCH.TOKEN)
  assert.equal(r.candidates[0].id, 'e3')
  assert.equal(r.employeeId, undefined, 'a reordered name must not auto-assign')
})

console.log('\n4. BankOne truncated name')
check('a truncated source name is flagged as truncation and reviewed', () => {
  const r = R('ABIWON TOLULOPE')
  assert.equal(r.status, 'pending_review')
  assert.equal(r.matchType, MATCH.TRUNCATION)
  assert.equal(r.candidates[0].id, 'e2')
  assert.match(r.reason, /truncated/i)
})

console.log('\n5. Completely unknown employee')
check('an unknown name is unresolved, never invented', () => {
  const r = R('JOHN DOE')
  assert.equal(r.status, 'unresolved')
  assert.equal(r.matchType, MATCH.UNRESOLVED)
  assert.equal(r.employeeId, undefined)
})

console.log('\n6. Duplicate employee names')
check('duplicate names are NEVER auto-resolved to one of them', () => {
  const r = R('BISI AJAYI')
  assert.equal(r.status, 'pending_review',
    'two employees share this name; it must be a human decision')
  assert.equal(r.employeeId, undefined)
  assert.ok(r.candidates.length >= 2)
  assert.match(r.reason, /must choose/)
})

console.log('\n7. Branch capitalisation variation')
check('case-only differences auto-resolve when unique', () => {
  const r = B('ketu')
  assert.equal(r.status, 'auto_resolved')
  assert.equal(r.branchId, 'b1')
})
check('two InfinityCore branches sharing a name force a choice', () => {
  const r = B('Head Office')
  assert.equal(r.status, 'pending_review')
  assert.ok(r.candidates.length >= 2)
})

console.log('\n8. Merged branch')
check('a merged InfinityCore branch is detected, not silently used', () => {
  const r = B('MUSHIN')
  assert.equal(r.status, 'pending_review')
  assert.equal(r.matchType, BRANCH_MATCH.MERGED)
  assert.ok(r.mergeCandidates.includes('YABA'))
  assert.match(r.reason, /combined branch/i)
})
check('merged structures are listed for the structure review', () => {
  const found = detectMergedBranches(['MUSHIN', 'YABA'], BRANCHES)
  assert.equal(found.length, 1)
  assert.equal(found[0].branch.id, 'b4')
})

console.log('\n9. Missing branch')
check('an unknown branch is unresolved, never invented', () => {
  const r = B('NOWHERE')
  assert.equal(r.status, 'unresolved')
  assert.equal(r.matchType, BRANCH_MATCH.MISSING)
})

// ===========================================================================
console.log('\n10-11. Invalid numeric / invalid date')
check('numeric shapes normalise, junk returns null (never 0)', () => {
  assert.equal(toNumber('3000000'), 3000000)
  assert.equal(toNumber('683,000.00'), 683000)
  assert.equal(toNumber('7760710.6'), 7760710.6)
  assert.equal(toNumber('-5,000'), -5000)
  assert.equal(toNumber('(1 234.56)'), -1234.56)
  assert.equal(toNumber(''), null)
  assert.equal(toNumber('N/A'), null)
  assert.equal(toNumber('abc'), null)
})
check('dates parse strictly; the real files are MM/DD, proven not assumed', () => {
  assert.equal(parseBankOneDate('28-Sep-2026').date.toISOString().slice(0, 10), '2026-09-28')
  // 05/30 can only be MM/DD - month 30 does not exist. It is a VALID date.
  assert.equal(parseBankOneDate('05/30/2027').date.toISOString().slice(0, 10), '2027-05-30')
  // 25/03 can only be DD/MM.
  assert.equal(parseBankOneDate('25/03/2027').date.toISOString().slice(0, 10), '2027-03-25')
  // Genuinely ambiguous values defer to the declared column format.
  assert.equal(parseBankOneDate('05/03/2027', { slashFormat: 'MM/DD/YYYY' }).date.toISOString().slice(0, 10), '2027-05-03')
  assert.equal(parseBankOneDate('05/03/2027', { slashFormat: 'DD/MM/YYYY' }).date.toISOString().slice(0, 10), '2027-03-05')
  assert.match(parseBankOneDate('32/01/2027').error, /impossible/)
  assert.match(parseBankOneDate('30-Feb-2027').error, /impossible/)
  assert.ok(parseBankOneDate('29-Feb-2028').date)  // leap year is fine
})
check('slash-format detection matches the real PAR evidence', () => {
  // The real file: first component never > 12, second > 12 in 1,749 rows.
  const d = detectSlashFormat(['04/03/2027', '01/31/2027', '09/27/2026', '11/04/2026'])
  assert.equal(d.format, 'MM/DD/YYYY')
  assert.equal(d.firstGt12, 0)
  assert.ok(d.secondGt12 >= 2)
  assert.equal(detectSlashFormat(['25/03/2027', '28/12/2026']).format, 'DD/MM/YYYY')
  assert.equal(detectSlashFormat(['05/03/2027', '06/04/2027']).format, null, 'all-ambiguous => undecided')
})

// ===========================================================================
console.log('\n12. Header detection + duplicate import')
const pad = (a, n) => { const o = [...a]; while (o.length < n) o.push(''); return o }

/** A PAR sheet whose header sits on `headerRow` (1-based). */
function parSheet(headerRow) {
  const loan = (sNo, acc, officer, out, status, dpd) => pad([
    sNo, acc, officer, 'CUSTOMER', 'Male', 'Ketu',
    '28-Sep-2026', '10-Apr-2027', 'Trade And Commerce', 'General Loan',
    '', '0', out, out, out, '0', '0', '0', out, '0', '0', '0', '0', String(dpd),
    status, '12 Months ECL', 'Other', '', '', '', '0', 'Monthly', '',
    '1400360246', '22144981782', '5', 'Ketu', '', 'Cash', '1', '2', '', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '', 'False', 'False', '', '', '',
    '', '', '', '', '', '', '', '', '', '', '', '',
  ], PAR_EXPECTED_COLUMNS.length)
  return [
    ['INFINITY MICROFINANCE BANK LIMITED'],
    ['Portfolio At Risk(Extended)'],
    ...Array.from({ length: Math.max(0, headerRow - 3) }, () => ['']),
    [...PAR_EXPECTED_COLUMNS],
    loan('1', 'ACC1', 'ABIMBOLA, ANIMASHAHUN LANIKE', '3000000', 'Performing', 0),
    loan('2', 'ACC2', 'ABIWON TOLULOPE', '2500000', 'Doubtful', 45),
  ]
}

check('the header row is DETECTED, not assumed (row 3 here)', () => {
  const h = detectHeaderRow(parSheet(3), PAR_EXPECTED_COLUMNS)
  assert.equal(h.headerIndex, 2)
  assert.equal(h.error, undefined)
})
check('the SAME columns are found on a different row (row 9)', () => {
  const h = detectHeaderRow(parSheet(9), PAR_EXPECTED_COLUMNS)
  assert.equal(h.headerIndex, 8)
})
check('a file with no recognisable header STOPS with a useful error', () => {
  const h = detectHeaderRow([['nothing'], ['to'], ['see']], PAR_EXPECTED_COLUMNS)
  assert.match(h.error, /Could not identify the column headers/)
})
check('a missing required column stops the import', () => {
  const rows = parSheet(3)
  rows[2] = rows[2].filter((c) => c !== 'Days OverDue')
  const res = runImport({ rows, sourceType: 'par', asAtDate: '2026-09-28', employees: EMP, branches: BRANCHES })
  assert.equal(res.ok, false)
  assert.match(res.error, /Days OverDue/)
  assert.match(res.error, /Nothing was imported/)
})
check('PAR derives non-performing from REAL status, never an assumption', () => {
  const res = runImport({ rows: parSheet(3), sourceType: 'par', asAtDate: '2026-09-28', employees: EMP, branches: BRANCHES })
  assert.equal(res.ok, true)
  assert.equal(res.portfolio.loanCount, 2)
  assert.equal(res.portfolio.nonPerformingCount, 1)
  assert.equal(res.portfolio.totalOutstanding, 5500000)
  assert.equal(isNonPerforming('Lost'), true)
  assert.equal(isNonPerforming('Performing'), false)
})
check('a missing as-at date is refused (snapshots must be dated)', () => {
  const res = runImport({ rows: parSheet(3), sourceType: 'par', asAtDate: null, employees: EMP, branches: BRANCHES })
  assert.equal(res.ok, false)
  assert.match(res.error, /as at/i)
})

// ===========================================================================
console.log('\nImport safety: unresolved work is never published as attributable')
check('officer rollup splits resolved from unresolved, losing no value', () => {
  const res = runImport({ rows: parSheet(3), sourceType: 'par', asAtDate: '2026-09-28', employees: EMP, branches: BRANCHES })
  const roll = officerRollup(res)
  assert.equal(roll.resolved.length, 1)      // ABIMBOLA - exact
  assert.equal(roll.unresolved.length, 1)    // ABIWON  - truncated, needs review
  assert.equal(res.portfolio.officerResolvedOutstanding, 3000000)
  assert.equal(res.portfolio.officerUnresolvedOutstanding, 2500000)
  assert.equal(res.portfolio.officerResolvedOutstanding + res.portfolio.officerUnresolvedOutstanding,
    res.portfolio.totalOutstanding, 'no value may be lost or double counted')
})
check('PAR is withheld while any officer is unresolved', () => {
  const res = runImport({ rows: parSheet(3), sourceType: 'par', asAtDate: '2026-09-28', employees: EMP, branches: BRANCHES })
  assert.equal(res.portfolio.parPublishable, false)
})
check('branch rollup still works while officers are unresolved', () => {
  const res = runImport({ rows: parSheet(3), sourceType: 'par', asAtDate: '2026-09-28', employees: EMP, branches: BRANCHES })
  const roll = branchRollup(res)
  assert.equal(roll.length, 1)
  assert.equal(roll[0].outstanding, 5500000)
  assert.equal(roll[0].resolved, true)
})

// ===========================================================================
console.log('\n13. Re-import after a mapping has been saved')
check('the SECOND import resolves with NO second review', () => {
  const saved = new Map([['ABIWON TOLULOPE', {
    normalized_source_name: 'ABIWON TOLULOPE', employee_id: 'e2', status: 'active',
  }]])
  const first = runImport({ rows: parSheet(3), sourceType: 'par', asAtDate: '2026-09-28', employees: EMP, branches: BRANCHES })
  assert.equal(first.summary.needsReview, 1, 'the first import must ask')

  const second = runImport({
    rows: parSheet(3), sourceType: 'par', asAtDate: '2026-10-31',
    employees: EMP, branches: BRANCHES, savedEmployeeMappings: saved,
  })
  assert.equal(second.summary.needsReview, 0, 'the second import must NOT ask again')
  assert.equal(second.summary.matchedAutomatically, 2)
  assert.equal(second.portfolio.officerUnresolvedOutstanding, 0)
  assert.equal(second.unresolvedOfficers.length, 0)
  assert.equal(second.portfolio.parPublishable, true, 'PAR becomes publishable once resolved')
  assert.equal(second.asAtDate, '2026-10-31', 'each import is its own dated snapshot')
})
check('a saved mapping pointing at a deleted employee is re-flagged, not trusted', () => {
  const saved = new Map([['ABIWON TOLULOPE', {
    normalized_source_name: 'ABIWON TOLULOPE', employee_id: 'GONE', status: 'active',
  }]])
  const r = resolveOfficer('ABIWON TOLULOPE', idx, saved)
  assert.equal(r.status, 'pending_review')
  assert.match(r.reason, /no longer exists/)
})
check('a saved branch mapping short-circuits later imports', () => {
  const saved = new Map([['NOWHERE', { normalized_bankone_branch_name: 'NOWHERE', canonical_branch_id: 'b1', status: 'active' }]])
  const r = resolveBranch('NOWHERE', bidx, saved)
  assert.equal(r.status, 'auto_resolved')
  assert.equal(r.branchId, 'b1')
})

// ===========================================================================
console.log('\nSource contracts & wiring')
check('both source types carry expected + required columns', () => {
  assert.equal(SOURCE_TYPES.par.expected.length, 66)
  assert.equal(SOURCE_TYPES.disbursement.expected.length, 30)
  assert.ok(SOURCE_TYPES.par.required.includes('Total Outstanding Amount'))
  assert.ok(SOURCE_TYPES.disbursement.required.includes('Loan Amount'))
})
check('an unknown source type is refused', () => {
  const r = runImport({ rows: parSheet(3), sourceType: 'nope', asAtDate: '2026-09-28' })
  assert.equal(r.ok, false)
})
check('the disbursement profile (header on row 8) is detected too', () => {
  const rows = [
    ['INFINITY MICROFINANCE BANK LIMITED'], ['TITLE:'], ['Disbursed Date Range:'],
    ['Status'], ['Product'], ['Branch'], ['Account Officer'],
    [...DISBURSEMENT_EXPECTED_COLUMNS],
    pad(['178199', 'YUSUF, BOLAKALE FATAI', '', '03610054000178199', 'ADDR', 'Ketu', 'Male', '081', '',
      '2100000', '2100000', '28-Sep-2026', '10-Apr-2027', '05-Oct-2026', '7', '', '', 'General Loan',
      '03610052150178199', 'YUSUF BOLAKALE FATAI', '22174353384', '42', 'Pro rated(Monthly)',
      'Pro rated(Monthly)', 'HASSAN, BOLANLE MONSURAT', '1', '2', 'true', '0.00', 'TILES'],
      DISBURSEMENT_EXPECTED_COLUMNS.length),
  ]
  const h = detectHeaderRow(rows, DISBURSEMENT_EXPECTED_COLUMNS)
  assert.equal(h.headerIndex, 7, 'header is on row 8, i.e. index 7')
  const res = runImport({ rows, sourceType: 'disbursement', asAtDate: '2026-09-28', employees: EMP, branches: BRANCHES })
  assert.equal(res.ok, true)
  assert.equal(res.portfolio.loanCount, 1)
  assert.equal(res.records[0].loanAmount, 2100000)
})
check('the migration creates the persistent mapping tables', () => {
  const sql = read('supabase/migrations/20260929000001_bankone_identity_and_branch_mapping.sql')
  for (const t of ['bankone_employee_mappings', 'bankone_branch_mappings',
    'bankone_unresolved_officers', 'bankone_created_employees']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${t}`), `missing ${t}`)
  }
  assert.match(sql, /uq_bankone_employee_mappings_name/, 'one authoritative mapping per name')
  assert.match(sql, /bankone_employee_mappings_resolved check/, 'an active mapping must name an employee')
  assert.match(sql, /add column if not exists as_at_date/)
  assert.match(sql, /mapping_version/)
  assert.match(sql, /validation_status/)
})
check('the header row is never hard-coded', () => {
  const p = read('src/domains/bankone/parse.js')
  assert.match(p, /detectHeaderRow/)
  assert.doesNotMatch(p, /headerIndex\s*=\s*[0-9]/, 'a literal header index would be a hard-coded row')
})

// ===========================================================================
console.log('\nPersistence, RLS and the review UI')
const mig2 = read('supabase/migrations/20260929000002_bankone_mapping_rls_and_audit.sql')
const svc = read('src/services/bankonePortfolioService.js')
const page = read('src/pages/BankOneImportReview.jsx')
const empUi = read('src/components/bankone/EmployeeReview.jsx')
const brUi = read('src/components/bankone/BranchReview.jsx')
const valUi = read('src/components/bankone/ValidationPanel.jsx')

check('RLS is enabled on all four mapping tables', () => {
  for (const t of ['bankone_employee_mappings', 'bankone_branch_mappings',
    'bankone_unresolved_officers', 'bankone_created_employees']) {
    assert.match(mig2, new RegExp(`alter table public\\.${t}\\s+enable row level security`),
      `RLS not enabled on ${t}`)
  }
  assert.match(mig2, /Deliberately NO insert\/update\/delete policies/,
    'mapping writes must go through the audited RPCs only')
})

check('every write RPC is role-gated and audited', () => {
  for (const fn of ['confirm_bankone_employee_mapping', 'mark_bankone_officer_unresolved',
    'confirm_bankone_branch_mapping', 'add_employee_from_bankone', 'split_bankone_branch']) {
    assert.match(mig2, new RegExp(`create or replace function public\\.${fn}`), `missing ${fn}`)
  }
  assert.match(mig2, /public\.can_review_work_tasks\(\)/)
  assert.match(mig2, /public\.bankone_audit\(/)
  for (const action of ['BANKONE_IMPORT_CREATED', 'BANKONE_EMPLOYEE_MAPPING_CREATED',
    'BANKONE_BRANCH_MAPPING_CREATED', 'BANKONE_EMPLOYEE_CREATED', 'BANKONE_BRANCH_SPLIT',
    'BANKONE_OFFICER_LEFT_UNRESOLVED']) {
    assert.ok(mig2.includes(action) || svc.includes(action), `audit action ${action} not written`)
  }
})

check('§12 add-as-employee invents nothing and stays pending', () => {
  assert.match(mig2, /'pending_verification', 'pending_verification'/)
  assert.match(mig2, /'bankone_import'/)
  // Inspect the ACTUAL employees column list, not the whole body (the audit
  // note legitimately contains the words "no account, email or compensation").
  const fn = mig2.slice(mig2.indexOf('create or replace function public.add_employee_from_bankone'))
  const body = fn.slice(0, fn.indexOf('$$;'))
  const ins = body.slice(body.indexOf('insert into public.employees'), body.indexOf('returning id into v_employee'))
  assert.ok(ins, 'employees insert not found')
  for (const forbidden of ['email', 'salary', 'designation', 'department', 'auth.users', 'password']) {
    assert.ok(!ins.includes(forbidden), `add_employee_from_bankone must not write ${forbidden}`)
  }
  assert.match(ins, /full_name/)
  assert.match(ins, /confirmation_status/)
  assert.match(ins, /employment_status/)
  assert.match(empUi, /No sign-in account is created/)
  assert.match(empUi, /No email, salary, department or designation is invented/)
})

check('§15 branch split deactivates rather than deletes', () => {
  const fn = mig2.slice(mig2.indexOf('create or replace function public.split_bankone_branch'))
  const body = fn.slice(0, fn.indexOf('$$;'))
  assert.match(body, /update public\.branches set status = 'inactive'/)
  assert.doesNotMatch(body, /delete from public\.branches/, 'a split must never delete a branch')
  assert.match(body, /A reason is required to split a branch/)
  assert.match(body, /p_new_branch_names is null or array_length\(p_new_branch_names, 1\) < 2/)
  assert.match(brUi, /Split into BankOne branches/)
  assert.match(brUi, /deactivated, not deleted/)
})

check('an import is a dated, immutable snapshot', () => {
  assert.match(svc, /as_at_date: asAtDate/)
  assert.match(svc, /source_type: sourceType/)
  assert.match(svc, /mapping_version: 1/)
  assert.match(svc, /validation_status: 'passed'/)
  assert.doesNotMatch(svc, /\.update\(\{[^}]*parsed_row_count/, 'a re-import must not overwrite a snapshot')
  // A failed parse must write nothing.
  assert.match(svc, /if \(!result\.ok\) return \{ \.\.\.result, persisted: false \}/)
})

check('unresolved officers are retained, never dropped', () => {
  assert.match(svc, /bankone_unresolved_officers'\)\.insert/)
  assert.match(svc, /outstanding_total: u\.outstandingTotal/)
  assert.match(svc, /status: 'unresolved'/)
})

check('§18/§19 review UI shows the financial impact and all three actions', () => {
  // The review screen now renders the PERSISTED decision row, so the field is
  // the snake_case one the database returns, not the pipeline's camelCase.
  assert.match(empUi, /money\(item\.outstanding_total\)/)
  assert.match(empUi, /Confirm/)
  assert.match(empUi, /Add as employee/)
  assert.match(empUi, /Leave unresolved/)
  assert.match(empUi, /confidence/)
})

check('§20 branch review offers mapping and split', () => {
  assert.match(brUi, /Branch structure review/)
  assert.match(brUi, /Accept/)
  assert.match(brUi, /Scissors/)
})

check('§17 validation panel shows refused rows and the detected header', () => {
  assert.match(valUi, /Header detected on row/)
  assert.match(valUi, /not imported/)
  assert.match(valUi, /These rows were refused rather than imported with a guessed value/)
})

check('the review page is routed and gated', () => {
  assert.match(read('src/config/navigation.jsx'), /Portfolio Import Review/)
  assert.match(read('src/App.jsx'), /BankOneImportReview/)
  assert.match(page, /canManage/)
  // PAR is no longer a client-side boolean: the page renders the server's
  // publish verdict, which is derived from the real imported data.
  assert.match(page, /verdict/)
  assert.match(page, /validatePublish/)
})

check('the review page is resumable and does not re-upload on Accept', () => {
  // The reported bug was compounded by onDone() calling run(), which re-parsed
  // the whole workbook after every single decision.
  assert.match(page, /getImportState/)
  assert.match(page, /listOpenImports/)
  assert.ok(!/onDone=\{\(m\) => \{ setNotice\(m\); run\(\) \}\}/.test(page),
    'a decision must not trigger a full re-upload')
  assert.match(page, /Import in progress — nothing was lost/)
})

console.log('\nAll ' + n + ' checks passed.')



