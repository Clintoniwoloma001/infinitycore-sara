/**
 * Build the FILTERED source-of-truth dataset for the authoritative employee
 * replace (REVIEWED-3), and emit a deterministic SQL VALUES list.
 *
 * FILTERING RULES (per the migration brief):
 *   - Exclude BOTH instances of a duplicate staff id:
 *       IMFB/20/0147, IMFB/23/0305
 *   - Exclude BOTH staff records sharing a duplicate email:
 *       a.shittu@infinitymfb.com
 *   HR resolves these out-of-band and inserts them manually afterwards.
 *
 * The script FAILS LOUDLY if the workbook does not contain exactly the expected
 * conflict set — silent drift here would insert the wrong people.
 *
 *   node scripts/build-authoritative-employees.mjs            # dry run + report
 *   node scripts/build-authoritative-employees.mjs --emit     # write the SQL
 */
import * as XLSX from 'xlsx'
import { writeFileSync } from 'node:fs'

const SRC = process.env.HR_MASTER_XLSX
  || '/Users/clintoniwolomaimaginr/Downloads/IT AUTOMATION LIST REVIEWED-3.xlsx'

export const EXCLUDED_STAFF_IDS = ['IMFB/20/0147', 'IMFB/23/0305']
export const EXCLUDED_EMAILS = ['a.shittu@infinitymfb.com']

const PERSON_SHEETS = ['FRONT END', 'BACKEND']
const blank = (v) => String(v ?? '').trim()

/** "OJABINENI, MOSUNMOLA AINA" -> "Olabineni Mosunmola Aina" (tidy for matching). */
export function tidyName(raw) {
  const s = blank(raw)
  if (!s) return ''
  const [last, ...rest] = s.includes(',') ? s.split(',') : ['', s]
  const first = rest.join(' ').replace(/\s+/g, ' ').trim()
  const titleCase = (t) => t.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
  return titleCase(`${blank(last)} ${first}`.replace(/\s+/g, ' ').trim())
}

/** SPLIT into (last, first) parts for the employees.first_name/last_name columns. */
export function splitName(raw) {
  const s = blank(raw)
  if (!s) return { first: null, last: null }
  if (s.includes(',')) {
    const [last, ...rest] = s.split(',')
    return { first: rest.join(' ').trim() || null, last: last.trim() || null }
  }
  const parts = s.split(/\s+/)
  if (parts.length === 1) return { first: null, last: parts[0] }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

/** A person's branch cell may contain several branches separated by commas. */
export function splitBranches(raw) {
  return blank(raw)
    .split(/[,/|;]/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Normalise an email cell.
 *
 * The workbook uses the literal string "N/A" (and sometimes blanks) to mean
 * "no email on file". Storing that verbatim would create a fake shared address
 * and, more importantly, would break every later email-based profile re-link.
 * Any recognised placeholder becomes NULL; anything else must look like an
 * address, otherwise we refuse to invent one.
 */
export function normalizeEmail(raw) {
  const v = blank(raw).toLowerCase()
  if (!v) return null
  if (['n/a', 'na', 'none', 'nil', 'null', '-', '--', 'n\\a', 'not available', 'no email'].includes(v)) return null
  // Keep only values that plausibly are an address.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return null
  return v
}

const emailOf = (r) => normalizeEmail(r.EMAIL)
const staffIdOf = (r) => blank(r['STAFF ID NO.'])
const genderOf = (v) => {
  const g = blank(v).toUpperCase().charAt(0)
  return g === 'M' || g === 'F' ? g : null
}

export function readWorkbook(path = SRC) {
  const wb = XLSX.default.readFile(path)
  const rows = PERSON_SHEETS.flatMap((sheet) =>
    XLSX.default.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' }).map((r) => ({ ...r, _sheet: sheet })),
  )
  const ref = (sheet, col) => XLSX.default.utils
    .sheet_to_json(wb.Sheets[sheet], { defval: '' })
    .map((r) => blank(r[col])).filter(Boolean)
  return {
    rows,
    branches: ref('Branches', 'Branch Location'),
    positions: ref('Positions', 'Positions'),
    departments: ref('Departments', 'Department'),
  }
}

/**
 * Filter the raw rows and report exactly what was excluded and why.
 *
 * IMPORTANT DISTINCTION — a repeated staff id or email is NOT automatically a
 * conflict. One person legitimately covering several branches appears once per
 * branch, which repeats BOTH the staff id and the email. Those are the SAME
 * person and must all be kept (one employee, many branch assignments).
 *
 * A genuine conflict is when one staff id (or one email) resolves to two
 * DIFFERENT people. That is what would break a UNIQUE constraint and must be
 * excluded. So conflicts are detected by comparing the identity fields of the
 * repeated rows, never by mere repetition.
 */
export function findRealConflicts(rows) {
  const norm = (r) => `${tidyName(r['FULL NAME']).toLowerCase()}`
  const group = (keyFn) => {
    const m = new Map()
    for (const r of rows) {
      const k = keyFn(r)
      if (!k) continue
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return [...m.entries()].filter(([, v]) => v.length > 1)
  }

  const idConflicts = []
  for (const [k, group_] of group((r) => staffIdOf(r))) {
    const people = new Set(group_.map(norm))
    if (people.size > 1) {
      idConflicts.push({ key: k, people: [...people], rows: group_ })
    }
  }

  const emailConflicts = []
  for (const [k, group_] of group(emailOf)) {
    // 'N/A' is a placeholder for "no email on file", not an address.
    if (k === 'n/a') continue
    const people = new Set(group_.map(norm))
    if (people.size > 1) {
      emailConflicts.push({ key: k, people: [...people], rows: group_ })
    }
  }
  return { idConflicts, emailConflicts }
}

/**
 * Filter the raw rows and report exactly what was excluded and why.
 * Throws if the workbook's conflicts do not match the expected set.
 */
export function buildDataset(path = SRC) {
  const { rows, branches, positions, departments } = readWorkbook(path)
  const raw = rows.length

  const dupIds = new Map()
  const dupEmails = new Map()
  for (const r of rows) {
    const i = staffIdOf(r)
    const e = emailOf(r)
    if (i) { if (!dupIds.has(i)) dupIds.set(i, []); dupIds.get(i).push(r) }
    if (e) { if (!dupEmails.has(e)) dupEmails.set(e, []); dupEmails.get(e).push(r) }
  }

  // Only a repeated key that resolves to TWO DIFFERENT PEOPLE is a real
  // conflict; a repeat caused by multi-branch coverage is one person and must
  // be preserved (one employee, many branch assignments).
  const { idConflicts, emailConflicts } = findRealConflicts(rows)
  const foundDupIds = idConflicts.map((c) => c.key)
  const foundDupEmails = emailConflicts.map((c) => c.key)

  const problems = []
  const unexpectedIds = foundDupIds.filter((i) => !EXCLUDED_STAFF_IDS.includes(i))
  const missingIds = EXCLUDED_STAFF_IDS.filter((i) => !foundDupIds.includes(i))
  const unexpectedEmails = foundDupEmails.filter((e) => !EXCLUDED_EMAILS.includes(e))
  const missingEmails = EXCLUDED_EMAILS.filter((e) => !foundDupEmails.includes(e))
  if (unexpectedIds.length) problems.push(`unexpected duplicate staff id(s): ${unexpectedIds.join(', ')}`)
  if (missingIds.length) problems.push(`expected duplicate staff id(s) not found: ${missingIds.join(', ')}`)
  if (unexpectedEmails.length) problems.push(`unexpected duplicate email(s): ${unexpectedEmails.join(', ')}`)
  if (missingEmails.length) problems.push(`expected duplicate email(s) not found: ${missingEmails.join(', ')}`)
  if (problems.length) {
    throw new Error(
      `Workbook conflicts do not match the migration brief:\n  - ${problems.join('\n  - ')}\n`
      + 'Refusing to generate a replacement dataset that may insert the wrong people.',
    )
  }

  const excludedRows = []
  const kept = []
  for (const r of rows) {
    const i = staffIdOf(r)
    const e = emailOf(r)
    const reasons = []
    if (EXCLUDED_STAFF_IDS.includes(i)) reasons.push(`duplicate staff id ${i}`)
    if (EXCLUDED_EMAILS.includes(e)) reasons.push(`duplicate email ${e}`)
    if (reasons.length) {
      excludedRows.push({ staff_id: i, name: tidyName(r['FULL NAME']), email: e, reasons })
    } else {
      kept.push(r)
    }
  }

  // De-duplicate people. The workbook lists one person once PER BRANCH, so a
  // multi-branch officer appears several times with identical staff id and name
  // but different BRANCH LOCATION. Those rows are ONE person, and their
  // branches are merged here rather than treated as duplicate records — which
  // is exactly the "one employee, many branch assignments" model.
  const byPerson = new Map()
  for (const r of kept) {
    const i = staffIdOf(r)
    const { first, last } = splitName(r['FULL NAME'])
    const key = i || `${tidyName(r['FULL NAME']).toLowerCase()}`
    if (!byPerson.has(key)) {
      byPerson.set(key, {
        staff_id: i,
        full_name: tidyName(r['FULL NAME']),
        first_name: first,
        last_name: last,
        email: emailOf(r),
        position: blank(r.DESIGNATION) || null,
        department: blank(r.DEPARTMENT) || null,
        branches: [],
        gender: genderOf(r.GENDER),
        confirmation_status: blank(r['CONFIRMED& UNCONFIRMED']) || null,
        supervisor_1: tidyName(r['IST LEVEL SUPERVISOR']),
        supervisor_2: tidyName(r['2ND LEVEL SUPERVISOR']),
        supervisor_3: tidyName(r['3RD LEVEL SUPERVISOR']),
      })
    }
    const person = byPerson.get(key)
    for (const b of splitBranches(r['BRANCH LOCATION'])) {
      if (!person.branches.includes(b)) person.branches.push(b)
    }
  }
  const people = [...byPerson.values()]

  // Post-filter integrity: the excluded records must be GONE, and no key may
  // still map to two different people.
  //
  // A key may legitimately repeat (multi-branch coverage of ONE person), so we
  // re-run the same identity-aware conflict detector rather than a naive
  // "seen twice" test, which would flag those as duplicates.
  const after = findRealConflicts(kept)
  if (after.idConflicts.length || after.emailConflicts.length) {
    throw new Error(
      'Filtering failed to remove all identity conflicts.\n'
      + `  staff ids: ${after.idConflicts.map((c) => c.key).join(', ')}\n`
      + `  emails: ${after.emailConflicts.map((c) => c.key).join(', ')}`,
    )
  }

  return {
    people,
    excludedRows,
    meta: { raw, kept: people.length, excluded: excludedRows.length, branches, positions, departments },
  }
}

export default buildDataset

function sqlq(v) {
  return v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`
}
// --- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { people, excludedRows, meta } = buildDataset()
  console.log('=== AUTHORITATIVE EMPLOYEE REPLACE — DRY RUN ===')
  console.log(`workbook rows      : ${meta.raw}`)
  console.log(`excluded           : ${meta.excluded}`)
  console.log(`to insert          : ${meta.kept}`)
  console.log('\nexcluded records:')
  excludedRows.forEach((r) => console.log(`  ${r.staff_id} | ${r.name} | ${r.email} | ${r.reasons.join('; ')}`))

  const noSupervisor = people.filter((p) => !p.supervisor_1)
  console.log(`\npeople with no 1st-level supervisor: ${noSupervisor.length}`)
  const multiBranch = people.filter((p) => p.branches.length > 1)
  console.log(`people covering multiple branches: ${multiBranch.length}`)

  if (process.argv.includes('--emit')) {
    const values = people.map((p) => `  (${sqlq(p.staff_id)}, ${sqlq(p.full_name)}, ${sqlq(p.first_name)}, `
      + `${sqlq(p.last_name)}, ${sqlq(p.email)}, ${sqlq(p.position)}, ${sqlq(p.department)}, `
      + `${sqlq(p.gender)}, ${sqlq(p.confirmation_status)})`)
    writeFileSync(
      'supabase/migrations/generated/employee_source_values.sql',
      `-- GENERATED by scripts/build-authoritative-employees.mjs — do not hand-edit.\n`
      + `-- ${meta.kept} people after excluding ${meta.excluded} conflicting records:\n`
      + `--   ${excludedRows.map((r) => `${r.staff_id} (${r.reasons.join('; ')})`).join('\n--   ')}\n`
      + 'INSERT INTO stg_hr_employee_source\n'
      + '  (staff_id, full_name, first_name, last_name, email, position, department, gender, confirmation_status)\n'
      + 'VALUES\n' + values.join(',\n') + '\nON CONFLICT (staff_id) DO NOTHING;\n',
    )

    // Trailing commas are illegal directly before ON CONFLICT, so the list is
    // joined without a trailing separator.
    const branchValues = people.flatMap((p) => p.branches.map((b) => `  (${sqlq(p.staff_id)}, ${sqlq(b)})`))
    writeFileSync(
      'supabase/migrations/generated/employee_branch_values.sql',
      `-- GENERATED by scripts/build-authoritative-employees.mjs — do not hand-edit.\n`
      + `-- ${branchValues.length} branch assignments across ${meta.kept} people.\n`
      + 'INSERT INTO stg_hr_employee_branch_source (staff_id, branch_label) VALUES\n'
      + branchValues.join(',\n') + '\nON CONFLICT DO NOTHING;\n',
    )

    const supPeople = people.filter(
      (p) => p.supervisor_1 || p.supervisor_2 || p.supervisor_3,
    )
    const supValues = supPeople.map(
      (p) => `  (${sqlq(p.staff_id)}, ${sqlq(p.supervisor_1)}, ${sqlq(p.supervisor_2)}, ${sqlq(p.supervisor_3)})`,
    )
    writeFileSync(
      'supabase/migrations/generated/employee_supervisor_values.sql',
      `-- GENERATED by scripts/build-authoritative-employees.mjs — do not hand-edit.\n`
      + `-- ${supValues.length} three-level supervisor assignments (by NAME; resolved to\n`
      + '-- employees.id at apply time, never guessed). Unresolved names stay NULL and are\n'
      + '-- reported by the verification report rather than silently dropped.\n'
      + 'INSERT INTO stg_hr_employee_supervisor_source (staff_id, supervisor_1, supervisor_2, supervisor_3) VALUES\n'
      + supValues.join(',\n') + '\nON CONFLICT (staff_id) DO NOTHING;\n',
    )

    console.log('\nwrote generated/{employee_source,employee_branch,employee_supervisor}_values.sql')
  }
}