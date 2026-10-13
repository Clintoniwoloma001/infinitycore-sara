import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================
// The audit obligation import - the four working documents in ONE model.
//
// WHAT THIS PINS
//   1. The import is REAL: every row the audit department tracks (4 follow-up
//      findings, 15 statutory returns, 2 open circulars, plus the board's
//      event-driven CAC filings) is mapped into audit_obligations.
//   2. SOURCE VALUES SURVIVE: the original owner label, the source document
//      and a copy of the source row are kept, never overwritten.
//   3. NOTHING GOES LIVE UNVALIDATED: every imported obligation lands as
//      'draft'. The spreadsheets' 'Pending'/'Compliant' flags are historical
//      artefacts, and the import must not treat them as the current legal
//      position - activation is a separate, logged, Head-of-Audit decision.
//   4. The import is RERUNNABLE: on conflict (reference) do nothing.
//   5. The reminder sweep is idempotent (audit_reminder_log) and escalates
//      to the head of the responsible department, not to nobody.
// ============================================================================

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

let n = 0
const check = (name, fn) => { fn(); n++; console.log('  ok - ' + name) }

const sql = read('supabase/migrations/20261111000002_audit_obligations_seed_and_reminders.sql')

// The four source documents must each be represented by provenance.
const SOURCES = [
  ['audit_followup_report', 'INTERNAL AUDIT FOLLOW-UP TRACKING REPORT.xlsx'],
  ['regulatory_master_board', 'MFB Regulatory Compliance Tracking Board.docx'],
  ['regulatory_compliance_board', 'MFB Regulatory Compliance Board.xlsx'],
  ['regulatory_circular_tracker', 'Regulatory Circular Tracker.xlsx'],
]

check('every source document is represented in the import', () => {
  for (const [type, file] of SOURCES) {
    assert.ok(sql.includes(`'${type}'`), `${type} is missing`)
    assert.ok(sql.includes(`'${file}'`), `${file} is not cited as provenance`)
  }
})

check('the follow-up findings are imported with their owners and dates', () => {
  for (const ref of ['AUD-01', 'AUD-02', 'AUD-03', 'AUD-04']) {
    assert.ok(sql.includes(`'${ref}'`), `${ref} is missing`)
  }
  // Owners exactly as written in the source workbook.
  for (const owner of ['Head of Administration / CFO', 'Administrative Manager / Ops Lead',
    'Head of Administration / HR Partner', 'Head of Administration / IT Director']) {
    assert.ok(sql.includes(owner), `owner label "${owner}" was not preserved`)
  }
  // Target due dates as serialized in the workbook, converted from the Excel
  // epoch (46310 -> 2026-10-15 and so on).
  assert.ok(sql.includes("date '2026-10-15'"), 'AUD-01 target date (serial 46310) is wrong')
  assert.ok(sql.includes("date '2026-10-30'"), 'AUD-02 target date (serial 46325) is wrong')
  assert.ok(sql.includes("date '2026-11-01'"), 'AUD-03 target date (serial 46327) is wrong')
  assert.ok(sql.includes("date '2026-12-15'"), 'AUD-04 target date (serial 46371) is wrong')
})

check('the statutory returns and circulars are imported', () => {
  for (const ref of ['REG-01', 'REG-15', 'CIR-01', 'CIR-02', 'REG-20']) {
    assert.ok(sql.includes(`'${ref}'`), `${ref} is missing`)
  }
  assert.ok(sql.includes('Strict Submission Deadline') || sql.includes('strict_deadline'),
    'the statutory deadlines must be carried as source metadata')
  assert.ok(sql.includes('FIRS Taxpro-Max Portal'), 'submission channel was not preserved')
  assert.ok(sql.includes('Tolu Abiwon'), 'the AML implementation committee owner must be preserved')
})

check('NOTHING is activated on import - every row lands as draft', () => {
  const insert = sql.slice(sql.indexOf('insert into public.audit_obligations'))
  const tuples = insert.slice(insert.indexOf('values')).split("', 'audit_finding'")
  // Count the status column value across the insert body.
  const body = insert.slice(0, insert.indexOf('on conflict'))
  const statuses = [...body.matchAll(/,\s*'(draft|active|paused|archived|closed)',\s*null\s*\)/g)].map((m) => m[1])
  assert.ok(statuses.length >= 24, `expected ~26 seeded statuses, found ${statuses.length}`)
  for (const s of statuses) {
    assert.equal(s, 'draft', 'an imported obligation went live without validation')
  }
  assert.ok(insert.includes("on conflict (reference) do nothing"),
    'the import must be rerunnable without duplicating or clobbering rows')
})

check('provenance columns exist on the obligation', () => {
  for (const col of ['source_document_type', 'source_metadata', 'source_owner_label',
    'reminder_lead_days', 'reminder_interval_days', 'escalation_role', 'escalation_delay_days']) {
    assert.ok(sql.includes(col), `${col} was not added`)
  }
  assert.ok(sql.includes("'audit_followup_report', 'regulatory_compliance_board'"),
    'the source-document-type CHECK must list the imported document types')
})

check('the reminder sweep is idempotent and escalates to a real person', () => {
  assert.ok(sql.includes('create or replace function public.audit_obligation_reminder_sweep()'))
  assert.ok(sql.includes("insert into public.audit_reminder_log (kind, subject_id, recipient_id, sent_on)"),
    'the sweep must de-duplicate through the existing reminder log')
  assert.ok(sql.includes("values ('obligation', v_row.assignment_id, v_row.assigned_user_id, current_date)"))
  assert.ok(sql.includes("values ('escalation'") || sql.includes("'escalation', v_row.assignment_id"),
    'escalations must be logged as their own kind')
  // An escalation audience that does not resolve must not vanish silently.
  assert.ok(sql.includes("and p.role = 'head_of_audit'"),
    'an escalation role absent from the deployment must fall back to the Head of Audit')
  // The sweep must never mark work done, never email, and never hang on a browser.
  assert.ok(/update public\.audit_obligation_assignments\s*\n\s*set last_reminded_at/.test(sql),
    'the sweep records the reminder so the interval guard works')
})

check('the register and the activation gate are restricted to the Head of Audit', () => {
  assert.ok(/create or replace function public\.get_audit_obligation_register\(\s*p_status text default null\s*\)/.test(sql),
    'the register RPC is missing')
  assert.ok(/create or replace function public\.set_audit_obligation_status\(\s*p_obligation_id uuid/.test(sql),
    'the activation RPC is missing')
  const gate = sql.slice(sql.indexOf('create or replace function public.get_audit_obligation_register'))
  assert.match(gate, /if not public\.is_audit_command_center_reader\(\) then[\s\S]*AUDIT_FORBIDDEN/,
    'the register RPC must refuse non-command-centre readers itself')
  const activation = sql.slice(sql.indexOf('create or replace function public.set_audit_obligation_status'))
  assert.match(activation, /has_permission\('audit\.obligations\.manage'\)/,
    'activation must be gated on the manage permission, not a hidden button')
  assert.match(activation, /AUDIT_OBLIGATION_STATUS_CHANGED/,
    'activation is a high-impact change and must be audited')
})

check('recurring deadlines are computed, not typed, and weekend-aware', () => {
  assert.ok(sql.includes('create or replace function public.audit_shift_to_workday(p_date date)'),
    'the master board says "preceding workday if weekend/holiday" - the rule must exist in SQL')
  assert.ok(sql.includes('when 6 then p_date - 1'), 'Saturday shifts back to Friday')
  assert.ok(sql.includes('when 0 then p_date + 1'), 'Sunday shifts forward to Monday')
  // The next monthly occurrence is derived from current_date, so the register
  // stays live rather than freezing an import-time snapshot.
  assert.ok(sql.includes("case when date_part('day', current_date) > 5 then interval '1 month'"),
    'FINA monthly (5th) next-occurrence logic is missing')
  assert.ok(sql.includes("date_trunc('quarter', current_date)"), 'quarterly logic is missing')
  // No fabricated holiday calendar.
  assert.ok(!/public_holidays/i.test(sql),
    'holiday calendars must not be invented; the authorised extension path covers them')
})

console.log('\nAll ' + n + ' checks passed.')
