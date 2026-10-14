import React from 'react'
import { formatCurrencyValue, formatPercent, formatCount } from './formatScorecard'

/**
 * DirectorDeepDive — Level 1 drawer. Opening a scorecard card (Pass & Watch,
 * Substandard, Doubtful, Lost, Overall) drills into that metric across the
 * locations returned by director_branch_breakdown(). Controlled overlay:
 * the caller passes the data and a close handler; nothing here mutates state.
 *
 * Props:
 *   open          boolean
 *   metricKey     the human label prefix for the title
 *   data          jsonb from director_branch_breakdown (has .branches,
 *                 .managers, .areas, .best, .worst)
 *   onClose       () => close
 *   onSelectBranch (branchId, branchName) => open branch staff table
 */
export function DirectorDeepDive({ open, metricKey, data = {}, onClose, onSelectBranch }) {
  const metricLabel = String(metricKey ?? 'metric')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Amount|Pct|Caseload|Count|Disbursement)\b/g, (w) => w.toLowerCase())

  // `data` arrives as null (useState(null) initial) until a metric is picked.
  // A default param only covers `undefined`, so null-guard explicitly here —
  // this was the "'a.branches' is null" crash on dashboard mount.
  const payload = data || {}
  const branches = payload.branches ?? []
  const managers = payload.managers ?? []
  const areas = payload.areas ?? []

  return (
    <div
      className={`fixed inset-0 z-[80] flex justify-end transition ${open ? 'bg-slate-950/50 backdrop-blur-sm pointer-events-auto' : 'pointer-events-none'}`}
      onClick={() => !open && onClose()}
    >
      <aside
        className={`h-full w-full max-w-4xl overflow-y-auto bg-white shadow-2xl transition ${open ? 'translate-x-0' : 'translate-x-full'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#009944]">{metricLabel} deep-dive</p>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{metricLabel} across locations</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        </div>
        <div className="p-5">
          {branches.length === 0 ? (
            <p className="text-sm text-slate-500">No locations in scope for this metric.</p>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-slate-400">
                {branches.length} locations with data. Scores are produced server-side by the existing MPR engine; these numbers are for comparison only.
              </p>
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-[.1em] text-slate-400">Branch ranking</p>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr className="text-left text-[10px] font-bold uppercase tracking-[.08em] text-slate-400">
                        <th className="px-2 py-1.5">Rank</th>
                        <th className="px-2 py-1.5">Branch</th>
                        <th className="px-2 py-1.5">Manager</th>
                        <th className="px-2 py-1.5">Area manager</th>
                        <th className="px-2 py-1.5 text-right">Portfolio</th>
                        <th className="px-2 py-1.5 text-right">PAR %</th>
                        <th className="px-2 py-1.5 text-right">Disb.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {branches.map((b) => (
                        <tr key={b.branch_id ?? b.id} onClick={() => onSelectBranch && onSelectBranch(b.branch_id ?? b.id, b.branch_name ?? b.branch)} className="cursor-pointer hover:bg-slate-50">
                          <td className="px-2 py-1.5 text-slate-400">{b.rank ?? '—'}</td>
                          <td className="px-2 py-1.5 font-medium text-slate-900">{b.branch_name ?? b.branch}</td>
                          <td className="px-2 py-1.5 text-slate-500">{b.manager ?? '—'}</td>
                          <td className="px-2 py-1.5 text-slate-500">{b.area_manager_name ?? b.area_manager ?? '—'}</td>
                          <td className="px-2 py-1.5 text-right text-slate-600">{formatCurrencyValue(b.portfolio ?? b.loan_portfolio)}</td>
                          <td className="px-2 py-1.5 text-right text-slate-600">{b.par_pct == null ? '—' : formatPercent(b.par_pct)}</td>
                          <td className="px-2 py-1.5 text-right text-slate-600">{formatCount(b.disbursement ?? b.disb)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {managers.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[.1em] text-slate-400">Branch managers</p>
                  <div className="max-h-40 overflow-y-auto text-xs">
                    {managers.map((m) => (
                      <div key={m.manager} className="flex justify-between gap-4 border-b border-slate-100 pb-1">
                        <span className="text-slate-600">{m.manager}</span>
                        <span className="text-slate-400">{m.branches ?? 0} branches · ₦{Number(m.portfolio || 0).toLocaleString('en-US')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {areas.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[.1em] text-slate-400">Area managers</p>
                  <div className="max-h-40 overflow-y-auto text-xs">
                    {areas.map((a) => (
                      <div key={a.area} className="flex justify-between gap-4 border-b border-slate-100 pb-1">
                        <span className="text-slate-600">{a.area}</span>
                        <span className="text-slate-400">{a.branches ?? 0} branches · ₦{Number(a.portfolio || 0).toLocaleString('en-US')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
