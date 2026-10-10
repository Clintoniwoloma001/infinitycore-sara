import React from 'react'
import { Delta, NoData } from './formatScorecard'

/**
 * DirectorScorecardCard — one numeric card in the Director Intelligence
 * scorecard grid. Renders any metric key the RPC returns; never computes a
 * score or a bucket. Clicking the card opens the deep-dive drawer that shows
 * this metric for every location in scope (Level 1).
 *
 * Props:
 *   metricKey    e.g. 'pass_watch', 'substandard', 'doubtful', 'lost',
 *                'portfolio', 'par_amount', 'par_pct', 'caseload_count',
 *                'disbursement_amount', 'disbursement_count'
 *   value        the server-returned current-period value (null when missing)
 *   previous     the previous-period value (null = none)
 *   imported     boolean (from the RPC) — false means "no data imported"
 *   label        display label (optional; defaults to the humanised key)
 *   unit         'amount' | 'percent' | 'count' | 'currency'
 *   onSelect     (key) => open deep dive for this metric
 */
export function DirectorScorecardCard({
  metricKey,
  value,
  previous,
  imported = true,
  label,
  unit = 'amount',
  onSelect,
}) {
  const humanLabel =
    label ||
    metricKey
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\b(Amount|Count|Pct|Percent)\b/g, (w) => w.toLowerCase())

  const renderValue = () => {
    if (value == null) return <NoData />
    switch (unit) {
      case 'percent':
        return <>{Number(value).toFixed(Number(value) % 1 ? 1 : 0)}%</>
      case 'currency':
        return <>₦{Number(value).toLocaleString('en-US')}</>
      case 'count':
        return <>{Number(value).toLocaleString('en-US')}</>
      case 'amount':
      default:
        return <>₦{Number(value).toLocaleString('en-US')}</>
    }
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(metricKey)}
      className="group text-left overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md hover:border-[#009944]/40 focus-visible:outline-focus"
    >
      <div className="flex items-center justify-between px-4 py-3.5">
        <span className="text-[10px] font-bold uppercase tracking-[.14em] text-slate-400">
          {humanLabel}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[.14em] text-slate-300">
          {imported ? 'Imported' : 'No data imported'}
        </span>
      </div>
      <div className="px-4 py-5">
        <span className="text-xl font-semibold tracking-tight text-slate-900 group-hover:text-[#009944] dark:text-white">
          {renderValue()}
        </span>
        <div className="mt-2">
          {previous != null
            ? <Delta current={value} previous={previous} suffix=" pts" />
            : <span className="text-[11px] text-slate-400">No comparison</span>}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1 bg-gradient-to-t from-[#009944] opacity-0 transition group-hover:opacity-100" />
    </button>
  )
}
