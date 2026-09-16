#!/usr/bin/env node
/**
 * Phase 26 — HR Master Data parser.
 *
 * Reads INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md (the
 * authoritative source) and emits, into scripts/generated/:
 *   1. phase26_staff_seed.sql  — the full staff UPSERT block (keyed on staff_id)
 *   2. phase26_masterdata.json — parsed staff/branches/designations/departments
 *   3. console validation summary (row counts, duplicates, unmatched lookups)
 *
 * No third-party dependencies. Deterministic given the markdown input.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = join(ROOT, 'INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md')
const OUT_DIR = join(__dirname, 'generated')

const text = readFileSync(SRC, 'utf8')

const esc = (v) => String(v ?? '').replace(/'/g, "''")
const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ')

// ---------------------------------------------------------------------------
// Staff table
// ---------------------------------------------------------------------------
function parseStaffTable(src) {
  const rows = []
  const lines = src.split('\n')
  let inTable = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\| S\/N \| STAFF ID \|/.test(trimmed)) { inTable = true; continue }
    if (!inTable) continue
    if (!trimmed.startsWith('|')) { inTable = false; continue }
    const cells = trimmed.replace(/^\||\|$/g, '').split('|').map((c) => clean(c))
    if (cells.length < 12) continue
    const [sn, staffId, fullName, email, designation, department, branch, sup1, sup2, sup3, status, hired] = cells
    const n = Number(sn)
    if (!Number.isInteger(n)) continue
    rows.push({
      sn: n,
      staff_id: staffId,
      full_name: fullName,
      email: email.toLowerCase(),
      designation,
      department,
      branch,
      supervisor1: sup1 === '—' || sup1 === '' ? null : sup1,
      supervisor2: sup2 === '—' || sup2 === '' ? null : sup2,
      supervisor3: sup3 === '—' || sup3 === '' ? null : sup3,
      confirmation_status: status,
      hire_date: hired === '—' || hired === '' ? null : hired,
    })
  }
  return rows
}

function toIsoDate(ddmmyyyy) {
  const m = ddmmyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`
}

function buildSeedSql(rows) {
  const lines = []
  const push = (s) => lines.push(s)
  push('-- GENERATED FILE — do not edit by hand. Regenerate with:')
  push('--   node scripts/parse_hr_masterdata.js')
  push('-- Source: INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md')
  push(`-- Rows: ${rows.length}`)
  push('')
  push('insert into public.employees (')
  push('  full_name, email, department, "position", designation_id,')
  push('  staff_id, employee_number, employee_code,')
  push('  branch, branch_id, confirmation_status, hire_date,')
  push('  employment_status, source, import_source, imported_from_bank_master,')
  push('  updated_at')
  push(') values')
  rows.forEach((r, i) => {
    const designationId =
      '(select id from public.designations d where d.title = ' +
      `'${esc(r.designation)}' and d.department = ${r.department ? `'${esc(r.department)}'` : 'null'} limit 1)`
    const branchId = `(select id from public.branches b where b.branch_name = '${esc(r.branch)}' limit 1)`
    const date = toIsoDate(r.hire_date)
    const sep = i === rows.length - 1 ? '' : ','
    push(
      `  ('${esc(r.full_name)}', '${esc(r.email)}', '${esc(r.department)}', '${esc(r.designation)}', ${designationId},` +
      ` '${esc(r.staff_id)}', '${esc(r.staff_id)}', '${esc(r.staff_id)}',` +
      ` '${esc(r.branch)}', ${branchId}, '${esc(r.confirmation_status)}', ${date ? `'${date}'` : 'null'},` +
      ` 'active', 'bank_master_import', 'bank_master', true, now())${sep}`
    )
  })
  push('')
  push('on conflict (staff_id) where staff_id is not null do update set')
  push("  full_name = coalesce(nullif(employees.full_name, ''), excluded.full_name),")
  push('  email = coalesce(nullif(employees.email, \'\'), excluded.email),')
  push("  department = coalesce(nullif(employees.department, ''), excluded.department),")
  push("  \"position\" = coalesce(nullif(employees.\"position\", ''), excluded.\"position\"),")
  push('  designation_id = coalesce(employees.designation_id, excluded.designation_id),')
  push("  branch = coalesce(nullif(employees.branch, ''), excluded.branch),")
  push('  branch_id = coalesce(employees.branch_id, excluded.branch_id),')
  push("  confirmation_status = coalesce(nullif(employees.confirmation_status, ''), excluded.confirmation_status),")
  push('  hire_date = coalesce(employees.hire_date, excluded.hire_date),')
  push("  employment_status = coalesce(nullif(employees.employment_status, ''), 'active'),")
  push("  source = case when employees.source is null then 'bank_master_import' else employees.source end,")
  push('  imported_from_bank_master = true,')
  push('  updated_at = now();')
  push('')
  push('-- Supervisor relationships (level 1 = primary line manager)')
  push('drop table if exists _phase26_tmp_supervisors;')
  push('create temp table _phase26_tmp_supervisors (')
  push('  staff_id text primary key,')
  push('  sup1 text, sup2 text, sup3 text')
  push(');')
  push('')
  push('insert into _phase26_tmp_supervisors (staff_id, sup1, sup2, sup3) values')
  const tmp = rows.map((r, i) => {
    const q = (v) => (v ? `'${esc(v)}'` : 'null')
    const sep = i === rows.length - 1 ? ';' : ','
    return `  ('${esc(r.staff_id)}', ${q(r.supervisor1)}, ${q(r.supervisor2)}, ${q(r.supervisor3)})${sep}`
  })
  push(tmp.join('\n'))
  push('')
  return lines.join('\n')
}

function buildSeedJson(rows) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceFile: 'INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md',
      staffCount: rows.length,
      staff: rows,
    },
    null,
    2
  )
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------
function validate(rows) {
  const issues = []
  const seen = new Set()
  const emails = new Set()
  const statusCounts = {}
  const depts = new Set()
  const branches = new Set()
  const designations = new Set()

  for (const r of rows) {
    if (seen.has(r.staff_id)) issues.push(`Duplicate staff_id ${r.staff_id}`)
    seen.add(r.staff_id)
    if (emails.has(r.email)) issues.push(`Duplicate email ${r.email} (${r.full_name})`)
    emails.add(r.email)
    statusCounts[r.confirmation_status] = (statusCounts[r.confirmation_status] || 0) + 1
    depts.add(r.department)
    branches.add(r.branch)
    designations.add(r.designation)
    if (r.hire_date && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(r.hire_date)) {
      issues.push(`Bad hire date '${r.hire_date}' for ${r.staff_id}`)
    }
  }

  const supNames = new Map()
  for (const r of rows) {
    for (const sup of [r.supervisor1, r.supervisor2, r.supervisor3]) {
      if (!sup) continue
      supNames.set(sup, (supNames.get(sup) || 0) + 1)
    }
  }
  const byFullName = new Map()
  for (const r of rows) byFullName.set(r.full_name.toLowerCase(), (byFullName.get(r.full_name.toLowerCase()) || 0) + 1)

  // Supervisors that are NOT resolvable to a unique employee full_name
  for (const [name, count] of supNames) {
    const matches = byFullName.get(name.toLowerCase()) || 0
    if (matches === 0) issues.push(`Supervisor not in master list: ${name}`)
    else if (matches > 1) issues.push(`Ambiguous supervisor name (${matches} employees): ${name}`)
  }

  return {
    rows: rows.length,
    statusCounts,
    departments: depts.size,
    branches: branches.size,
    designations: designations.size,
    issues,
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const staff = parseStaffTable(text)
if (staff.length === 0) {
  console.error('No staff rows parsed — check the markdown table format.')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'phase26_staff_seed.sql'), buildSeedSql(staff))
writeFileSync(join(OUT_DIR, 'phase26_masterdata.json'), buildSeedJson(staff))

const report = validate(staff)
console.log(`Parsed staff rows      : ${report.rows}`)
console.log(`Confirmation statuses  : ${JSON.stringify(report.statusCounts)}`)
console.log(`Distinct departments   : ${report.departments}`)
console.log(`Distinct branches used : ${report.branches}`)
console.log(`Distinct designations  : ${report.designations}`)
console.log(`Validation issues      : ${report.issues.length}`)
for (const i of report.issues) console.log(`  - ${i}`)
console.log(`\nWrote scripts/generated/phase26_staff_seed.sql and phase26_masterdata.json`)