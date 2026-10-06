/**
 * Build the ORGANISATIONAL MASTER (branches / departments / designations) from
 * the authoritative workbook, plus the explicit collapse map that repairs the
 * dirty `branches` rows the bank master left behind.
 *
 * Why this exists
 * ---------------
 * The workbook ("IT AUTOMATION LIST REVIEWED-3") is already CLEANED:
 *   21 branches, 13 departments, 64 designations, one row per person.
 * The database is not. A previous import kept combined labels verbatim as
 * their own branch rows and duplicated master rows, so HR Organisation showed
 * 42 branches including `BARIGA/LAGOS Island 1`, `KETU & HEAD OFFICE` and
 * `LAGOS ISLAND 2/IBEJU -LEKKI/AJAH`. Nothing normalised them, because the
 * earlier replace only ALIASED workbook labels onto rows that already existed.
 *
 * This script emits the target state and an EXPLICIT collapse map for every
 * branch row we have ever seen. The apply script refuses to run when the
 * database holds a branch row the map does not cover, so a new dirty value can
 * never be silently dropped.
 *
 *   node scripts/build-authoritative-org.mjs            # dry run + report
 *   node scripts/build-authoritative-org.mjs --emit     # write the SQL
 */
import * as XLSX from 'xlsx'
import { writeFileSync } from 'node:fs'

const SRC = process.env.HR_MASTER_XLSX
  || '/Users/clintoniwolomaimaginr/Downloads/IT AUTOMATION LIST REVIEWED-3.xlsx'

const blank = (v) => String(v ?? '').trim()

/** Deterministic branch code: BR-01..BR-21 in the workbook's own order. */
export function branchCode(index) {
  return `BR-${String(index + 1).padStart(2, '0')}`
}

/** Canonical, stable slug used by `departments.code`. */
export function departmentCode(name) {
  return blank(name).toUpperCase().replace(/&/g, 'AND')
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * Executive designations, not departments. Kept out of `departments` so no
 * department dropdown can offer "MD/CEO" (mirrors NON_DEPARTMENT_VALUES in
 * src/constants/departments.js).
 */
const NON_DEPARTMENT = new Set([
  'MD/CEO', 'CHAIRMAN', 'DIRECTOR', 'MD', 'M.D.', 'CEO', 'MANAGING DIRECTOR', 'BOARD',
])

function firstColumn(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    .map((r) => r.map(blank))
    .filter((r) => r.some(Boolean))
  return rows.slice(1).map((r) => r[0]).filter(Boolean)
}

export function readMasterLists(path = SRC) {
  const wb = XLSX.default.readFile(path)
  const branches = firstColumn(wb.Sheets.Branches)
  const allDepartments = firstColumn(wb.Sheets.Departments)
  const positions = firstColumn(wb.Sheets.Positions)
  const departments = allDepartments.filter((d) => !NON_DEPARTMENT.has(d.toUpperCase()))

  return {
    branches: branches.map((name, i) => ({ branch_code: branchCode(i), branch_name: name })),
    departments: departments.map((name, i) => ({ code: departmentCode(name), name, sort_order: i + 1 })),
    designations: positions.map((title, i) => ({ title, sort_order: i + 1 })),
  }
}


/**
 * EXPLICIT collapse map.
 *
 * Left  — a branch row that exists (or has existed) in the database, exactly as
 *         `branches.branch_name` stores it, including its original casing.
 * Right — the clean workbook branch(es) it collapses into. An empty array means
 *         "not in the workbook at all": the row must be deactivated, never
 *         silently reinterpreted.
 */
export const BRANCH_COLLAPSE_MAP = {
  // --- rows that already match a workbook branch (case-insensitive) ---------
  'AGEGE': ['Agege'],
  'ALABA': ['Alaba'],
  'BARIGA': ['Bariga'],
  'BOUNDARY': ['Boundary'],
  'EGBEDA': ['Egbeda'],
  'Head Office': ['Head Office'],
  'HEAD OFFICE': ['Head Office'],
  'IBEJU LEKKI': ['Ibeju Lekki'],
  'IBEJU-LEKKI': ['Ibeju Lekki'],
  'IKEJA': ['Ikeja'],
  'IKORODU': ['Ikorodu'],
  'ILE-EPO': ['Ile Epo'],
  'KETU': ['Ketu'],
  'KOLA': ['Kola'],
  'LAGOS ISLAND 1': ['Lagos Island ONE'],
  'LAGOS ISLAND 2': ['Lagos Island TWO SME'],
  'LAGOS ISLAND2': ['Lagos Island TWO SME'],
  'MUSHIN': ['Mushin'],
  'ODONGUNYAN': ['ODONGUNYAN'],
  'ODOGUNYAN': ['ODONGUNYAN'],
  'OSHODI': ['Oshodi'],
  'OWODE': ['Owode'],
  'SABO/YABA': ['Sabo Yaba'],
  'TRADE FAIR': ['Tradefair'],

  // --- combined labels: each collapses into its component branches ---------
  'AGEGE & EGBEDA': ['Agege', 'Egbeda'],
  'BARIGA/LAGOS Island 1': ['Bariga', 'Lagos Island ONE'],
  'HEAD OFFICE - OSHODI': ['Head Office', 'Oshodi'],
  'IKEJA & LEKKI': ['Ikeja', 'Ibeju Lekki'],
  'KETU & HEAD OFFICE': ['Ketu', 'Head Office'],
  'KOLA & ILE-EPO': ['Kola', 'Ile Epo'],
  'LAGOS ISLAND 2/IBEJU -LEKKI/AJAH': ['Lagos Island TWO SME', 'Ibeju Lekki', 'Ibeju Lekki Two (Ajah)'],
  'MUSHIN/YABA': ['Mushin', 'Sabo Yaba'],
  'OSHODI & IKEJA': ['Oshodi', 'Ikeja'],
  'TRADE FAIR/BOUNDARY/ALABA': ['Tradefair', 'Boundary', 'Alaba'],

  // --- legacy spellings of a workbook branch -------------------------------
  'AJAH': ['Ibeju Lekki Two (Ajah)'],
  'YABA': ['Sabo Yaba'],
  'YABA 2': ['Sabo Yaba'],
  'SABO YABA': ['Sabo Yaba'],
  'TRADEFAIR': ['Tradefair'],
  'ILE EPO': ['Ile Epo'],
  'LAGOS ISLAND ONE': ['Lagos Island ONE'],
  'LAGOS ISLAND TWO SME': ['Lagos Island TWO SME'],
  'IBEJU LEKKI TWO (AJAH)': ['Ibeju Lekki Two (Ajah)'],

  // --- not in the workbook: deactivate, do not reinterpret -----------------
  'AMUWO ODOFIN': [],
  'FESTAC': [],
  'MILE 2/BADAGRY ROAD': [],
  'OSOLO/OKOTA': [],
}

const sqlq = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)


/**
 * Build the collapse rows actually written to SQL: every clean branch maps to
 * itself, then every extra spelling the map knows about maps to its targets.
 * A spelling with no target produces a single row with a NULL target, which the
 * apply script reads as "deactivate this branch".
 */
export function buildCollapseRows(master) {
  const rows = master.branches.map((b) => ({ existing: b.branch_name, targets: [b.branch_name] }))
  const clean = new Set(master.branches.map((b) => b.branch_name.toLowerCase()))
  for (const [existing, targets] of Object.entries(BRANCH_COLLAPSE_MAP)) {
    if (clean.has(existing.toLowerCase())) continue
    rows.push({ existing, targets })
  }
  return rows
}

export function buildOrgSql(master) {
  const collapseRows = buildCollapseRows(master)
  const files = {}

  files['org_branch_values.sql'] =
    '-- GENERATED by scripts/build-authoritative-org.mjs — do not hand-edit.\n'
    + `-- ${master.branches.length} canonical branches, verbatim from the workbook "Branches" sheet.\n`
    + '-- RUN ORDER: supabase/manual/20261101000007a_authoritative_staging_schema.sql\n'
    + '-- FIRST, then this file. The CREATE TABLE below is a harmless no-op when the\n'
    + '-- schema file already ran, and a safety net when this file runs first.\n'
    + 'CREATE TABLE IF NOT EXISTS public.stg_hr_branch_source (\n'
    + '  branch_name text primary key,\n'
    + '  branch_code text\n'
    + ');\n'
    + 'INSERT INTO stg_hr_branch_source (branch_code, branch_name) VALUES\n'
    + master.branches.map((b) => `  (${sqlq(b.branch_code)}, ${sqlq(b.branch_name)})`).join(',\n') + '\n'
    + 'ON CONFLICT (branch_name) DO UPDATE SET branch_code = excluded.branch_code;\n'

  files['org_branch_collapse_values.sql'] =
    '-- GENERATED by scripts/build-authoritative-org.mjs — do not hand-edit.\n'
    + `-- ${collapseRows.length} collapse rules. A spelling with only a NULL target is not in the\n`
    + '-- workbook and must be deactivated rather than reinterpreted.\n'
    + '-- RUN ORDER: 20261101000007a FIRST, then this file (CREATE TABLE below is a\n'
    + '-- harmless no-op when the schema file already ran).\n'
    + 'CREATE TABLE IF NOT EXISTS public.stg_hr_branch_collapse (\n'
    + '  existing_name text not null,\n'
    + '  target_name text not null default \'\',\n'
    + '  primary key (existing_name, target_name)\n'
    + ');\n'
    + 'INSERT INTO stg_hr_branch_collapse (existing_name, target_name) VALUES\n'
    + collapseRows.flatMap((r) => (r.targets.length
      ? r.targets.map((t) => `  (${sqlq(r.existing)}, ${sqlq(t)})`)
      : [`  (${sqlq(r.existing)}, '')`])).join(',\n') + '\n'
    + 'ON CONFLICT (existing_name, target_name) DO NOTHING;\n'

  files['org_department_values.sql'] =
    '-- GENERATED by scripts/build-authoritative-org.mjs — do not hand-edit.\n'
    + `-- ${master.departments.length} departments (executive titles such as MD/CEO are excluded).\n`
    + '-- RUN ORDER: 20261101000007a FIRST, then this file (CREATE TABLE below is a\n'
    + '-- harmless no-op when the schema file already ran).\n'
    + 'CREATE TABLE IF NOT EXISTS public.stg_hr_department_source (\n'
    + '  name text primary key,\n'
    + '  code text,\n'
    + '  sort_order int\n'
    + ');\n'
    + 'INSERT INTO stg_hr_department_source (code, name, sort_order) VALUES\n'
    + master.departments.map((d) => `  (${sqlq(d.code)}, ${sqlq(d.name)}, ${d.sort_order})`).join(',\n') + '\n'
    + 'ON CONFLICT (name) DO UPDATE SET code = excluded.code, sort_order = excluded.sort_order;\n'

  files['org_designation_values.sql'] =
    '-- GENERATED by scripts/build-authoritative-org.mjs — do not hand-edit.\n'
    + `-- ${master.designations.length} designations, verbatim from the workbook "Positions" sheet.\n`
    + '-- RUN ORDER: 20261101000007a FIRST, then this file (CREATE TABLE below is a\n'
    + '-- harmless no-op when the schema file already ran).\n'
    + 'CREATE TABLE IF NOT EXISTS public.stg_hr_designation_source (\n'
    + '  title text primary key,\n'
    + '  sort_order int\n'
    + ');\n'
    + 'INSERT INTO stg_hr_designation_source (title, sort_order) VALUES\n'
    + master.designations.map((d) => `  (${sqlq(d.title)}, ${d.sort_order})`).join(',\n') + '\n'
    + 'ON CONFLICT (title) DO UPDATE SET sort_order = excluded.sort_order;\n'

  return { files, collapseRows }
}

export default readMasterLists

// --- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const master = readMasterLists()
  console.log('=== ORGANISATION MASTER — DRY RUN ===')
  console.log(`branches    : ${master.branches.length}`)
  console.log(`departments : ${master.departments.length}`)
  console.log(`designations: ${master.designations.length}`)

  const known = new Set(master.branches.map((b) => b.branch_name.toLowerCase()))
  const bad = Object.entries(BRANCH_COLLAPSE_MAP)
    .filter(([, targets]) => targets.some((t) => !known.has(t.toLowerCase())))
  if (bad.length) {
    console.error('\nABORT — collapse map points at branches that are not in the workbook:')
    bad.forEach(([from, to]) => console.error(`  ${from} -> ${to.join(', ')}`))
    process.exit(1)
  }

  const { collapseRows } = buildOrgSql(master)
  const deactivate = collapseRows.filter((r) => r.targets.length === 0)
  console.log(`\ncollapse rules: ${collapseRows.length} (${deactivate.length} deactivate-only)`)
  deactivate.forEach((r) => console.log(`  deactivate: ${r.existing}`))

  if (process.argv.includes('--emit')) {
    const { files } = buildOrgSql(master)
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(`supabase/migrations/generated/${name}`, body)
    }
    console.log('\nwrote generated/org_{branch,branch_collapse,department,designation}_values.sql')
  }
}
