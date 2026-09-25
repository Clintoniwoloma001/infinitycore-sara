import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeDirectorSnapshot } from '../src/domains/directorIntelligence/snapshot.js'

const migration = readFileSync('supabase/migrations/20260924000001_director_executive_intelligence.sql', 'utf8')
const repair = readFileSync('supabase/migrations/20260924000002_director_repayments_payment_date_repair.sql', 'utf8')
const executiveMigration = readFileSync('supabase/migrations/20260924000003_chairman_md_ceo_roles_department_hygiene.sql', 'utf8')
const jsonbFix = readFileSync('supabase/migrations/20260924000004_director_snapshot_jsonb_summary_fix.sql', 'utf8')
const rolesFix = readFileSync('supabase/migrations/20260924000005_director_snapshot_roles_record_operator_fix.sql', 'utf8')
const expectedDaysFix = readFileSync('supabase/migrations/20260925160359_director_expected_attendance_20_days.sql', 'utf8')
const previousExpectedDays = '(select count(*) from range_days)::int expected_days'
const fixedExpectedDays = '20::int expected_days'
assert.ok(expectedDaysFix.includes(`v_previous text := '${previousExpectedDays}'`))
assert.ok(expectedDaysFix.includes(`v_replacement text := '${fixedExpectedDays}'`))
assert.match(expectedDaysFix, /pg_get_functiondef\(v_function\)/)
assert.match(expectedDaysFix, /execute replace\(v_definition, v_previous, v_replacement\)/)
assert.match(expectedDaysFix, /elsif strpos\(v_definition, v_replacement\) = 0 then/)
assert.match(expectedDaysFix, /raise exception 'Director expected_days expression not found/)
assert.equal(rolesFix.split(previousExpectedDays).length - 1, 1)
const fixedSnapshot = rolesFix.replace(previousExpectedDays, fixedExpectedDays)
assert.ok(fixedSnapshot.includes(fixedExpectedDays))
assert.ok(!fixedSnapshot.includes(previousExpectedDays))
assert.equal(fixedSnapshot.replace(fixedExpectedDays, previousExpectedDays), rolesFix,
  'Expected-day correction must preserve all other RPC logic and access gates')
assert.match(fixedSnapshot, /100\.0\*attendance_present\/expected_days/)
assert.match(fixedSnapshot, /100\.0\*sum\(attendance_present\)\/nullif\(sum\(expected_days\),0\)/)

const roles = readFileSync('src/constants/roles.js', 'utf8')
const permissions = readFileSync('src/constants/permissions.js', 'utf8')
const app = readFileSync('src/App.jsx', 'utf8')
const navigation = readFileSync('src/config/navigation.jsx', 'utf8')
const service = readFileSync('src/services/directorIntelligenceService.js', 'utf8')
const page = readFileSync('src/pages/DirectorDashboard.jsx', 'utf8')

// These controls render only after a successful load or opening a drill-down.
const iconImports = page.match(/import\s*\{([^}]+)\}\s*from 'lucide-react'/)?.[1] || ''
for (const icon of ['RefreshCw', 'X']) {
  assert.match(iconImports, new RegExp(`\\b${icon}\\b`), `${icon} must be imported before rendering its control`)
}

// Structural SQL assertions must ignore documentation comments: the forward
// repair migrations deliberately quote the exact broken expressions in their
// header so operators can see what was fixed.
const sqlCode = (text) =>
  text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')

assert.match(migration, /values \('director', 'Director'/)
assert.match(migration, /'super_admin','admin','director'/)
assert.match(migration, /director\.executive\.read/)
assert.match(migration, /get_director_executive_snapshot/)
assert.match(migration, /generate_series\(v_start::timestamp, v_end::timestamp, interval '1 day'\)/)
assert.match(migration, /from generate_series\(v_start::timestamp, v_end::timestamp, interval '1 day'\) as dates\(series_date\)/)
assert.doesNotMatch(migration, /::date day|\bd\.day\b|order by day\b|group by day\b|as series\(/)
assert.match(migration, /alter table public\.repayments\s+add column if not exists payment_date date/)
assert.match(migration, /'repayments',\(select coalesce\(sum\(amount\),0\) from public\.repayments where payment_date between v_start and v_end\)/)
assert.match(migration, /'previous_repayments',\(select coalesce\(sum\(amount\),0\) from public\.repayments where payment_date between v_previous_start and v_previous_end\)/)
assert.match(repair, /alter table public\.repayments\s+add column if not exists payment_date date/)
assert.match(repair, /not backfill fabricated historical dates/)
assert.doesNotMatch(repair, /update public\.repayments/i)
assert.match(migration, /get_director_employee_detail/)
assert.match(migration, /public\.current_role\(\) not in \('director','super_admin'\)/)
assert.match(migration, /not public\.has_permission\('director\.executive\.read'\)/)
assert.match(migration, /revoke all on function public\.get_director_executive_snapshot/)
assert.match(migration, /grant execute on function public\.get_director_executive_snapshot/)
assert.match(migration, /public\.employee_kpis/)
assert.match(migration, /public\.targets/)
assert.match(migration, /public\.attendance_records/)
assert.match(migration, /public\.leave_requests/)
assert.match(migration, /public\.loans/)
assert.match(migration, /from public\.departments|from public\.employees/)
assert.doesNotMatch(migration, /insert into public\.employee_kpis|insert into public\.attendance_records|insert into public\.targets/)

// PostgreSQL has no json || jsonb operator. All clean-install definitions must
// use to_jsonb, while the forward repair makes already-applied functions safe.
for (const definition of [migration, executiveMigration]) {
  assert.match(definition, /'summary',\(select to_jsonb\(o\) from overall o\) \|\| jsonb_build_object/)
  assert.doesNotMatch(sqlCode(definition), /row_to_json\(o\)[^\n]*\|\|\s*jsonb_build_object/)
}
assert.match(jsonbFix, /v_invalid_expression text := '\(select row_to_json\(o\) from overall o\) \|\| jsonb_build_object\('/)
assert.match(jsonbFix, /v_fixed_expression text := '\(select to_jsonb\(o\) from overall o\) \|\| jsonb_build_object\('/)
assert.match(jsonbFix, /execute v_definition/)
assert.match(jsonbFix, /director_snapshot_jsonb_repair_failed/)
assert.doesNotMatch(jsonbFix, /insert into|update public\.|delete from/i)

// ---------------------------------------------------------------------------
// "operator does not exist: record ->> unknown" (20260924000005).
//
// A bare identifier naming a MULTI-column subquery alias resolves to the whole
// row, whose type is `record`, and PostgreSQL has no `record ->> text` operator.
// The 'roles' aggregate aggregated a four-column subquery aliased "x" and then
// applied "->>" to the bare "x". The sibling departments/branches/areas
// aggregates are safe ONLY because their subqueries project a single jsonb
// column, so this asserts that invariant structurally rather than by name.
// ---------------------------------------------------------------------------
const BROKEN_ROLES_AGG = /jsonb_agg\(x order by x->>'role'\)/
const FIXED_ROLES_AGG = /'roles',\(select coalesce\(jsonb_agg\(to_jsonb\(x\) order by to_jsonb\(x\)->>'role'\),'\[\]'\) from \(/

for (const definition of [migration, executiveMigration, rolesFix]) {
  const code = sqlCode(definition)
  assert.doesNotMatch(code, BROKEN_ROLES_AGG)
  assert.match(code, FIXED_ROLES_AGG)
}

assert.match(rolesFix, /operator does not exist: record ->> unknown/)
assert.match(rolesFix, /to_jsonb\(x\)/)
assert.match(rolesFix, /^begin;$/m)
assert.match(rolesFix, /^commit;$/m)
assert.match(rolesFix, /revoke all on function public\.get_director_executive_snapshot/)
assert.match(rolesFix, /grant execute on function public\.get_director_executive_snapshot/)
assert.doesNotMatch(rolesFix, /insert into|update public\.|delete from/i)

// The forward repair must be the same body the clean install now ships.
const functionBody = (text) => {
  const start = text.indexOf('create or replace function public.get_director_executive_snapshot(')
  assert.ok(start > -1, 'get_director_executive_snapshot definition not found')
  const end = text.indexOf('\n$$;', start)
  assert.ok(end > start, 'get_director_executive_snapshot terminator not found')
  return text.slice(start, end)
}
assert.equal(functionBody(rolesFix), functionBody(executiveMigration))

// Skip over a single-quoted SQL literal (with '' escaping) starting at i.
const skipLiteral = (text, i) => {
  i++
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") i += 2
      else return i + 1
    } else i++
  }
  return i
}

// Count the columns a subquery projects, ignoring commas nested in parens or
// inside string literals.
const projectedColumnCount = (selectList) => {
  let depth = 0
  let count = 1
  for (let i = 0; i < selectList.length; i++) {
    const ch = selectList[i]
    if (ch === "'") {
      i = skipLiteral(selectList, i) - 1
    } else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) count++
  }
  return count
}

// Pull the select list of the `from ( select ... ) x` subquery feeding a bare
// `jsonb_agg(x order by ... x->>...)` aggregate.
const bareAggregateSelectList = (text, from) => {
  const fromPos = text.indexOf('from (', from)
  if (fromPos < 0) return null
  let i = fromPos + 'from ('.length
  while (/\s/.test(text[i])) i++
  if (!text.startsWith('select', i)) return null
  i += 'select'.length
  const start = i
  let depth = 0
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'") {
      i = skipLiteral(text, i) - 1
    } else if (ch === '(') depth++
    else if (ch === ')') {
      // The subquery's own closing paren ends the select list.
      if (depth === 0) return text.slice(start, i)
      depth--
    } else if (
      depth === 0 &&
      /\s/.test(ch) &&
      text.startsWith('from', i) &&
      !/[\w$]/.test(text[i - 1] ?? '') &&
      !/[\w$]/.test(text[i + 4] ?? '')
    ) {
      return text.slice(start, i)
    }
  }
  return null
}

for (const [name, definition] of [
  ['20260924000001', migration],
  ['20260924000003', executiveMigration],
  ['20260924000005', rolesFix],
]) {
  let inspected = 0
  const code = sqlCode(definition)
  // Both spellings are unsafe on a multi-column subquery: jsonb_agg(x order
  // by x->>'k') and jsonb_agg(x order by (x->>'k')::int desc).
  for (const match of code.matchAll(/jsonb_agg\(x order by \(?x->>/g)) {
    inspected++
    const selectList = bareAggregateSelectList(code, match.index)
    assert.ok(selectList, `${name}: could not locate the subquery behind a bare x->> aggregate`)
    assert.equal(
      projectedColumnCount(selectList),
      1,
      `${name}: bare "x->>" aggregates a ${projectedColumnCount(selectList)}-column subquery, ` +
        'so x resolves to the whole row and PostgreSQL raises "record ->> unknown". ' +
        'Wrap the row in to_jsonb(x).',
    )
    assert.match(
      selectList,
      /^\s*jsonb_build_object\(/,
      `${name}: a bare "x->>" is only valid when the subquery projects a single jsonb column`,
    )
  }
  assert.equal(inspected, 3, `${name}: expected the 3 single-column departments/branches/areas aggregates, found ${inspected}`)
}

assert.match(roles, /DIRECTOR: 'director'/)
assert.match(roles, /\[ROLES\.DIRECTOR\]: \[\s*'director\.executive\.read',\s*'hr\.attendance\.self'/)
assert.match(roles, /\[ROLES\.DIRECTOR\]: \[\s*'dashboard',\s*'attendance'/)
assert.match(permissions, /DIRECTOR_EXECUTIVE_READ: 'director\.executive\.read'/)
assert.match(navigation, /path: '\/director'.*DirectorDashboard.*DIRECTOR_EXECUTIVE_READ/)
assert.match(app, /isExecutiveViewerRole\(actualRole\).*DirectorDashboard/)
assert.match(app, /actualRole === 'customer'.*CustomerDashboard.*Dashboard/)

assert.match(service, /rpc\('get_director_executive_snapshot'/)
assert.match(service, /normalizeDirectorSnapshot\(data\)/)
assert.match(service, /rpc\('get_director_employee_detail'/)
assert.doesNotMatch(service, /from\('employees'\)|from\('attendance_records'\)|from\('employee_kpis'\)|from\('targets'\)/)
assert.match(page, /export function tenureLabel/)
assert.match(page, /DepartmentTable/)
assert.match(page, /EmployeeDrawer/)
assert.match(page, /AttendanceView/)
assert.match(page, /LeaveView/)
assert.match(page, /RolePerformance/)
assert.match(page, /to=\"\/attendance\"/)
assert.match(page, /dateWindow/)
assert.match(page, /r\.attendance_date/)
assert.doesNotMatch(page, /Math\.random|7 yr 4 mo/)
assert.match(page, /snapshot\?\.filters/, 'Director filters must tolerate a null hosted RPC field')

// Regression: a successful Supabase RPC may contain JSON null fields. The UI
// must never crash while evaluating snapshot.filters after a page redeploy.
const partialHostedSnapshot = normalizeDirectorSnapshot({
  summary: { total_staff: 42 },
  filters: null,
  staff: null,
  trend: null,
  loans: null,
})
assert.deepEqual(partialHostedSnapshot.filters, {
  branches: [], areas: [], departments: [], roles: [], designations: [], employees: [],
})
assert.deepEqual(partialHostedSnapshot.departments, [])
assert.deepEqual(partialHostedSnapshot.staff, [])
assert.deepEqual(partialHostedSnapshot.trend, [])
assert.deepEqual(partialHostedSnapshot.loans, { status: {} })
assert.equal(partialHostedSnapshot.summary.total_staff, 42)
assert.equal(normalizeDirectorSnapshot(null).filters.departments.length, 0)
assert.throws(() => normalizeDirectorSnapshot([]), /invalid data response/)
assert.throws(() => normalizeDirectorSnapshot('invalid'), /invalid data response/)

console.log('Director intelligence architecture assertions passed.')
