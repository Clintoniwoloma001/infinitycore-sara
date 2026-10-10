import React from 'react'
import { formatCurrencyValue, formatCount, formatPercent } from './formatScorecard'

/**
 * DirectorBranchStaffTable — the Level 2 branch page: one branch's full staff
 * roster with rank, every PAR bucket, caseload, disbursement (actual/target/
 * achievement), attendance rate, overall score + grade. Clicking a row opens the
 * employee detail.
 *
 * Props:
 *   staff        jsonb array from director_branch_staff()
 *   branchName   human name of the branch (for the header)
 *   period       'YYYY-MM' (for the period label)
 *   onSelectEmployee  (employeeId) => drill into employee detail
 *   columns      sortable column key
 *   sortDir      'asc' | 'desc'
 *   onSort       (column) => toggle sort
 */
export function DirectorBranchStaffTable({
  staff = [],
  branchName,
  period,
  onSelectEmployee,
  columns = ['overall_score'],
  sortDir = 'desc',
  onSort,
}) {
  const sorted = React.useMemo(() => {
    const arr = [...staff]
    arr.sort((a, b) => {
      let va = 0
      let vb = 0
      for (const col of columns) {
        const ka = (a[col] ?? a[col.replace('overall_', '')] ?? 0)
        const kb = (b[col] ?? b[col.replace('overall_', '')] ?? 0)
        va += Number(ka || 0)
        vb += Number(kb || 0)
      }
      const cmp = va - vb
      return sortDir === 'desc' ? cmp : -cmp
    })
    return arr
  }, [staff, sortDir, columns])

  if (staff.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800">
        <p className="text-sm text-slate-500">No staff in this branch for the selected period.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-slate-400">Branch staff</p>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{branchName || 'Unassigned branch'}</h3>
          <p className="text-[11px] text-slate-400">Period: {period || '—'}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {(columns || ['overall_score', 'portfolio', 'par_pct', 'caseload', 'full_name']).map((col) => (
            <button
              key={col}
              type="button"
              onClick={() => onSort && onSort(col)}
              className={`h-7 rounded-md px-2.5 text-[11px] font-semibold transition focus-visible:outline-focus ${
                columns[0] === col
                  ? 'bg-[#009944] text-white'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {col}
              {columns[0] === col && (sortDir === 'desc' ? ' ▲' : ' ▼')}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-[.08em] text-slate-400">
              <th className="px-3 py-2.5">Rank</th>
              <th className="px-3 py-2.5">Employee</th>
              <th className="px-3 py-2.5">Position</th>
              <th className="px-3 py-2.5">Dept</th>
              <th className="px-3 py-2.5 text-right">Portfolio</th>
              <th className="px-3 py-2.5 text-right">PAR %</th>
              <th className="px-3 py-2.5 text-right">Caseload</th>
              <th className="px-3 py-2.5 text-right">Disb. achieved</th>
              <th className="px-3 py-2.5 text-right">Overall score</th>
              <th className="px-3 py-2.5">Grade</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {sorted.map((r) => (
              <tr
                key={r.employee_id ?? r.id}
                onClick={() => onSelectEmployee && onSelectEmployee(r.employee_id ?? r.id)}
                className="cursor-pointer transition hover:bg-[#f0fdf4] dark:hover:bg-slate-800/40"
              >
                <td className="px-3 py-2 text-slate-400">{r.rank ?? '—'}</td>
                <td className="px-3 py-2 font-medium text-slate-900 dark:text-white">
                  {r.full_name ?? r.fullName ?? '—'}
                </td>
                <td className="px-3 py-2 text-slate-500">{r.position ?? '—'}</td>
                <td className="px-3 py-2 text-slate-500">{r.department ?? r.dept ?? '—'}</td>
                <td className="px-3 py-2 text-right text-slate-600">
                  {formatCurrencyValue(r.portfolio ?? r.loan_portfolio) ?? '—'}
                </td>
                <td className="px-3 py-2 text-right text-slate-600">
                  {r.par_pct == null ? '—' : formatPercent(r.par_pct)}
                </td>
                <td className="px-3 py-2 text-right text-slate-600">
                  {formatCount(r.caseload)}
                </td>
                <td className="px-3 py-2 text-right text-slate-600">
                  {r.disbursement_achievement_pct == null ? '—' : `${Number(r.disbursement_achievement_pct).toFixed(1)}%`}
                </td>
                <td className="px-3 py-2 text-right font-semibold text-slate-900 dark:text-white">
                  {r.overall_score == null ? '—' : Number(r.overall_score).toFixed(1)}
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.08em] text-white" style={{ backgroundColor: (r.grade_hex && r.grade_hex !== 'null') ? r.grade_hex : '#009944' }}>
                    {r.grade ?? '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-200 px-4 py-3 text-[10px] text-slate-400">
        {staff.length} staff shown. Min caseload for ranking: {(staff[0]?.min_caseload_for_ranking ?? 0) || 'default'}.
      </div>
    </div>
  )
}

