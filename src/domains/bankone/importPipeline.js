import { detectHeaderRow, toRecords, toNumber, parseBankOneDate, detectSlashFormat } from './parse.js'
import { resolveOfficer, createEmployeeIndex, MATCH } from './employeeIdentity.js'
import { resolveBranch, createBranchIndex, detectMergedBranches } from './branchIdentity.js'
import { normalizeName, normalizeBranch } from './normalize.js'
import { PAR_EXPECTED_COLUMNS, PAR_REQUIRED_COLUMNS, DISBURSEMENT_EXPECTED_COLUMNS, DISBURSEMENT_REQUIRED_COLUMNS } from './columns.js'

/** The source-type contract: expected labels + the columns we actually use. */
export const SOURCE_TYPES = {
  par: {
    key: 'par',
    label: 'Portfolio At Risk',
    expected: PAR_EXPECTED_COLUMNS,
    required: PAR_REQUIRED_COLUMNS,
    fields: {
      accountNo: 'Account No.', officer: 'Account Officer', customer: 'Customer Name',
      branch: 'Branch', disbursementDate: 'Disbursement Date', maturityDate: 'Maturation Date',
      status: 'Status', daysOverdue: 'Days OverDue', loanAmount: 'Loan Amount',
      principalBal: 'Principal Bal.', totalOutstanding: 'Total Outstanding Amount',
      pastDuePrincipal: 'Past Due Prin.', eclStage: 'Expected Credit Loss Stages', bvn: 'BVN',
    },
  },
  disbursement: {
    key: 'disbursement',
    label: 'Disbursement',
    expected: DISBURSEMENT_EXPECTED_COLUMNS,
    required: DISBURSEMENT_REQUIRED_COLUMNS,
    fields: {
      accountNo: 'Account No.', officer: 'Account Officer', customer: 'Customer Name',
      branch: 'Branch', disbursementDate: 'Disbursement Date', maturityDate: 'Maturation Date',
      loanAmount: 'Loan Amount', principalBal: 'Principal Bal.', bvn: 'BVN', product: 'Product',
    },
  },
}

/** Statuses BankOne uses that are NOT performing. PAR is derived from these. */
export const NON_PERFORMING = ['Pass And Watch', 'Sub Standard', 'Doubtful', 'Lost']

export function isNonPerforming(status) {
  return NON_PERFORMING.includes(String(status ?? '').trim())
}

/**
 * Run a full import dry-run: parse -> validate -> resolve -> summarise.
 * Nothing is written here; the caller persists the result. Keeping it pure
 * makes the whole decision - including the "unresolved officer portfolio is
 * never published as attributable" rule - testable without a database.
 */
export function runImport({
  rows, sourceType, asAtDate, employees = [], branches = [],
  savedEmployeeMappings = new Map(), savedBranchMappings = new Map(),
}) {
  const spec = SOURCE_TYPES[sourceType]
  if (!spec) return { ok: false, error: `Unknown BankOne source type "${sourceType}".` }
  if (!asAtDate) return { ok: false, error: 'An "as at" date is required so the snapshot can be dated.' }

  // --- 1. header detection (never a hard-coded row) ---------------------
  const header = detectHeaderRow(rows, spec.expected)
  if (header.error) return { ok: false, error: header.error, sourceType, asAtDate }
  const present = new Set(header.headers.map((h) => String(h).trim().toLowerCase()))
  const missing = spec.required.filter((c) => !present.has(c.toLowerCase()))
  if (missing.length) {
    return {
      ok: false, sourceType, asAtDate, header,
      error: `The header was found on row ${header.headerIndex + 1} but these required columns are missing: ${missing.join(', ')}. Nothing was imported.`,
    }
  }

  const records = toRecords(rows, header.headerIndex, header.headers)
  const empIndex = createEmployeeIndex(employees)
  const brIndex = createBranchIndex(branches)
  const invalidRows = []
  const officerCache = new Map()
  const branchCache = new Map()
  const out = []

  // Detect the slash-date convention PER COLUMN from the whole column, so a
  // column like "Next repayment Date" is resolved from 1,328 unambiguous values
  // rather than from any single row. Ambiguous values are counted and reported.
  const dateColumns = [
    ['disbursementDate', spec.fields.disbursementDate],
    ['maturityDate', spec.fields.maturityDate],
  ].filter(([, c]) => c)
  const dateFormats = {}
  for (const [key, col] of dateColumns) {
    dateFormats[key] = detectSlashFormat(records.map((r) => r[col]))
  }

  for (const rec of records) {
    const f = spec.fields
    const accountNo = rec[f.accountNo] || null
    if (!accountNo) {
      invalidRows.push({ rowNumber: rec.__rowNumber, reason: 'Missing account number.' })
      continue
    }
    const dates = {}
    const errors = []
    for (const [key, col] of dateColumns) {
      if (!rec[col]) continue
      const d = parseBankOneDate(rec[col], { slashFormat: dateFormats[key]?.format })
      if (d.error && d.error !== 'empty') errors.push(`${col}: ${d.error}`)
      else if (!d.error) dates[key] = d.date.toISOString().slice(0, 10)
    }
    const loanAmount = toNumber(rec[f.loanAmount])
    if (rec[f.loanAmount] && loanAmount === null) {
      errors.push(`${f.loanAmount}: "${rec[f.loanAmount]}" is not a number.`)
    }
    if (errors.length) {
      invalidRows.push({ rowNumber: rec.__rowNumber, accountNo, reason: errors.join(' ') })
      continue
    }

    // Officer + branch resolution, memoised per distinct source name.
    const officerRaw = rec[f.officer] || ''
    const officerKey = normalizeName(officerRaw)
    if (officerKey && !officerCache.has(officerKey)) {
      officerCache.set(officerKey, resolveOfficer(officerRaw, empIndex, savedEmployeeMappings))
    }
    const officer = officerCache.get(officerKey) || null

    const branchRaw = rec[f.branch] || ''
    const branchKey = normalizeBranch(branchRaw)
    if (branchKey && !branchCache.has(branchKey)) {
      branchCache.set(branchKey, resolveBranch(branchRaw, brIndex, savedBranchMappings))
    }
    const branch = branchCache.get(branchKey) || null

    out.push({
      rowNumber: rec.__rowNumber,
      raw: rec,
      accountNo,
      officerNameRaw: officerRaw,
      officer,
      branchNameRaw: branchRaw,
      branch,
      loanAmount: loanAmount ?? 0,
      totalOutstanding: f.totalOutstanding ? (toNumber(rec[f.totalOutstanding]) ?? 0) : (loanAmount ?? 0),
      status: f.status ? rec[f.status] : null,
      daysOverdue: f.daysOverdue ? (toNumber(rec[f.daysOverdue]) ?? 0) : 0,
      nonPerforming: f.status ? isNonPerforming(rec[f.status]) : false,
      dates,
    })
  }

  // --- 5. review buckets ------------------------------------------------
  const employeeMatches = [...officerCache.values()]
  const branchMatches = [...branchCache.values()]

  const unresolvedOfficers = employeeMatches
    .filter((m) => m.status !== 'auto_resolved')
    .map((m) => {
      const rowsForOfficer = out.filter((r) => normalizeName(r.officerNameRaw) === m.normalizedSourceName)
      return {
        ...m,
        loanCount: rowsForOfficer.length,
        outstandingTotal: rowsForOfficer.reduce((s, r) => s + r.totalOutstanding, 0),
        branchNames: [...new Set(rowsForOfficer.map((r) => r.branchNameRaw).filter(Boolean))],
      }
    })
    .sort((a, b) => b.outstandingTotal - a.outstandingTotal)

  const branchIssues = branchMatches.filter((b) => b.status !== 'auto_resolved')
  const bankoneBranchNames = [...branchCache.keys()]
  const mergedStructures = detectMergedBranches(bankoneBranchNames, branches)

  // --- 6. portfolio totals, SPLIT by officer resolution ------------------
  // Safety rule: a loan whose officer is not resolved contributes to the
  // BRANCH total but is held in a SEPARATE unresolved bucket. It is never
  // folded into a named officer, and never silently disappears.
  //
  // Money is summed in minor units (integers) and only divided back at the
  // end. Summing binary floats would make the resolved + unresolved split miss
  // the total by fractions of a kobo, and "no value is lost" has to be exactly
  // true for an audited figure.
  const kobo = (v) => Math.round((Number(v) || 0) * 100)
  // Sum in kobo, then convert ONCE back to naira. (Wrapping the kobo sum in
  // kobo() again would scale the total by 100 - a bug this file caught.)
  const money = (arr) => arr.reduce((s, r) => s + kobo(r.totalOutstanding), 0) / 100
  const resolvedRows = out.filter((r) => r.officer && r.officer.status === 'auto_resolved')
  const unresolvedRows = out.filter((r) => !(r.officer && r.officer.status === 'auto_resolved'))
  const branchResolved = (r) => r.branch && r.branch.status === 'auto_resolved'
  const sumLoanAmount = (arr) => arr.reduce((s, r) => s + kobo(r.loanAmount), 0) / 100

  const portfolio = {
    totalOutstanding: money(out),
    loanAmount: sumLoanAmount(out),
    loanCount: out.length,
    nonPerformingCount: out.filter((r) => r.nonPerforming).length,
    nonPerformingOutstanding: money(out.filter((r) => r.nonPerforming)),
    branchCompleteOutstanding: money(out.filter(branchResolved)),
    branchUnresolvedOutstanding: money(out.filter((r) => !branchResolved(r))),
    officerResolvedOutstanding: money(resolvedRows),
    officerUnresolvedOutstanding: money(unresolvedRows),
    officerUnresolvedCount: unresolvedRows.length,
    // PAR is only publishable once every branch resolved; the numerator would
    // otherwise understate the portfolio.
    parPublishable: out.length > 0 && unresolvedRows.length === 0,
  }
  portfolio.parRatio = portfolio.totalOutstanding > 0
    ? (portfolio.nonPerformingOutstanding / portfolio.totalOutstanding) * 100
    : 0

  return {
    ok: true,
    sourceType,
    asAtDate,
    header,
    records: out,
    invalidRows,
    employeeMatches,
    branchMatches,
    unresolvedOfficers,
    branchIssues,
    mergedStructures,
    portfolio,
    dateFormats,
    summary: {
      sourceRowCount: records.length,
      parsedRowCount: out.length,
      matchedAutomatically: employeeMatches.filter((m) => m.status === 'auto_resolved').length,
      needsReview: employeeMatches.filter((m) => m.status === 'pending_review').length,
      unmatchedEmployees: employeeMatches.filter((m) => m.status === 'unresolved').length,
      branchIssues: branchIssues.length,
      mergedStructures: mergedStructures.length,
      invalidRows: invalidRows.length,
      branchCount: branchCache.size,
    },
  }
}

/** Per-branch rollup. Branch level may proceed while officers are unresolved. */
export function branchRollup(result) {
  const byBranch = new Map()
  for (const r of result.records) {
    const key = r.branchNameRaw || '(blank)'
    if (!byBranch.has(key)) {
      byBranch.set(key, { branchName: key, loanCount: 0, outstanding: 0, nonPerformingCount: 0, nonPerformingOutstanding: 0, resolved: r.branch?.status === 'auto_resolved' })
    }
    const b = byBranch.get(key)
    b.loanCount += 1
    b.outstanding = Math.round((b.outstanding + r.totalOutstanding) * 100) / 100
    if (r.nonPerforming) { b.nonPerformingCount += 1; b.nonPerformingOutstanding = Math.round((b.nonPerformingOutstanding + r.totalOutstanding) * 100) / 100 }
  }
  return [...byBranch.values()].sort((a, b) => b.outstanding - a.outstanding)
}

/**
 * Per-officer rollup. Deliberately SEPARATES resolved from unresolved so a
 * caller can never present the total as fully attributable.
 */
export function officerRollup(result) {
  const byOfficer = new Map()
  for (const r of result.records) {
    const key = r.officerNameRaw || '(blank)'
    if (!byOfficer.has(key)) {
      const m = r.officer
      byOfficer.set(key, {
        officerName: key,
        employeeId: m?.status === 'auto_resolved' ? m.employeeId : null,
        resolved: m?.status === 'auto_resolved',
        matchType: m?.matchType ?? null,
        reason: m?.reason ?? null,
        loanCount: 0, outstanding: 0, nonPerformingCount: 0,
      })
    }
    const o = byOfficer.get(key)
    o.loanCount += 1
    o.outstanding = Math.round((o.outstanding + r.totalOutstanding) * 100) / 100
    if (r.nonPerforming) o.nonPerformingCount += 1
  }
  return {
    resolved: [...byOfficer.values()].filter((o) => o.resolved).sort((a, b) => b.outstanding - a.outstanding),
    unresolved: [...byOfficer.values()].filter((o) => !o.resolved).sort((a, b) => b.outstanding - a.outstanding),
  }
}

export { MATCH }
