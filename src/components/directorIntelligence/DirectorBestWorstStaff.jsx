import React from 'react'
import { formatCurrencyValue, formatPercent } from './formatScorecard'

/**
 * DirectorBestWorstStaff — bank-wide overall BEST and WORST staff (N=5)
 * plus per-branch top/bottom 5 by overall score. Only fully-measured staff
 * (compute_mpr_score complete=true) are ranked; the configurable
 * min_caseload_for_ranking is honoured.
 *
 * Props:
 *   data         jsonb from director_top_staff (has .best, .worst, .per_branch)
 *   onSelect     (employeeId) => drill into employee detail
 */
export function DirectorBestWorstStaff({ data = {}, onSelect }) {
  const best = data.best ?? []
  const worst = data.worst ?? []
  const perBranch = data.per_branch ?? {}

  if (best.length === 0 && worst.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800">
        <p className="text-sm text-slate-500">No staff with a complete score in the selected period.</p>
      </div>

        {items.map((s, i) => (
          <button
            key={s.employee_id ?? s.id}
            type="button"
            onClick={() => onSelect && onSelect(s.employee_id ?? s.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white dark:hover:bg-slate-800"
          >
            <span className={`text-lg font-bold ${positive ? 'text-emerald-700' : 'text-rose-700'}`}>{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-slate-900 dark:text-white">{s.full_name ?? s.fullName ?? '—'}</p>
              <p className="truncate text-[11px] text-slate-400">{s.position ?? s.role ?? ''} · {s.department ?? ''}</p>
            </div>
            <div className="text-right text-sm font-bold text-slate-900 dark:text-white">
              {s.overall_score == null ? '—' : Number(s.overall_score).toFixed(1)}
            </div>
            <span className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.08em] text-white" style={{ backgroundColor: (s.grade_hex && s.grade_hex !== 'null') ? s.grade_hex : positive ? '#009944' : '#dc2626' }}>
              {s.grade ?? '—'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <RankCard label="Bank-wide overall best" items={best} positive onSelect={onSelect} />
        <RankCard label="Bank-wide overall worst" items={worst} positive={false} onSelect={onSelect} />
      </div>
      {Object.keys(perBranch).length > 0 && (
        <div className="overflow-x-auto rounded-b-2xl bg-white p-4 dark:bg-slate-900">
          <p className="mb-2 text-xs font-bold uppercase tracking-[.12em] text-slate-400">Per-branch top / bottom 5</p>
          <table className="w-full text-sm text-left">
            <thead className="sticky top-0 bg-slate-50">
              <tr className="text-[10px] font-bold uppercase tracking-[.08em] text-slate-400">
                <th className="px-2 py-1.5">Branch</th>
                <th className="px-2 py-1.5 text-center">Top 5</th>
                <th className="px-2 py-1.5 text-center">Bottom 5</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(perBranch).map(([branchId, b]) => (
                <tr key={branchId} className="border-b border-slate-100 dark:border-slate-800">
                  <td className="px-2 py-2 font-medium text-slate-900">{b.branch_name ?? b.branch ?? branchId}</td>
                  <td className="px-2 py-2 text-center">
                    {b.top?.length ? (
                      <div className="space-y-0.5">
                        {b.top.map((s, i) => (
                          <div key={s.employee_id ?? s.id} className="text-[10px] text-slate-500">
                            <span className="font-semibold text-emerald-700">{i + 1}.</span> {s.full_name ?? '—'}
                          </div>
                        ))}
                      </div>
                    ) : <span className="text-[11px] text-slate-400">no data</span>}
                  </td>
                  <td className="px-2 py-2 text-center">
                    {b.bottom?.length ? (
                      <div className="space-y-0.5">
                        {b.bottom.map((s, i) => (
                          <div key={s.employee_id ?? s.id} className="text-[10px] text-slate-500">
                            <span className="font-semibold text-rose-700">{i + 1}.</span> {s.full_name ?? '—'}
                          </div>
                        ))}
                      </div>
                    ) : <span className="text-[11px] text-slate-400">no data</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

    )
  }

  const RankCard = ({ label, items, positive, onSelect }) => (
    <div className={`overflow-hidden rounded-2xl border shadow-sm ${positive ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20' : 'border-rose-200 bg-rose-50/40 dark:border-rose-900 dark:bg-rose-950/20'}`}>
      <div className={`flex items-center justify-between border-b px-4 py-3 ${positive ? 'border-emerald-200 dark:border-emerald-900' : 'border-rose-200 dark:border-rose-900'}`}>
        <p className={`text-[10px] font-bold uppercase tracking-[.16em] ${positive ? 'text-emerald-700' : 'text-rose-700'}`}>{label}</p>
        <span className="text-[11px] text-slate-500">{items.length} staff</span>
      </div>
      <div className={`divide-y ${positive ? 'divide-emerald-100 dark:divide-emerald-900' : 'divide-rose-100 dark:divide-rose-900'}`}>
