import React from 'react'
import { DirectorScorecardCard } from './DirectorScorecardCard'
import { formatCurrencyValue, formatPercent, formatCount } from './formatScorecard'

/**
 * DirectorScorecardCards — the grid of scorecard cards for the Director
 * Intelligence page. Renders the bank-level (or scope-level) figures produced
 * by director_scorecards():
 *
 *   portfolio, par_amount, par_pct, pass_watch, substandard, doubtful, lost,
 *   caseload_count, disbursement_amount, disbursement_count
 *
 * plus the overall score + grade computed by compute_mpr_score() (the existing
 * MPR engine), and a per-card deep-dive trigger.
 *
 * Props:
 *   scorecards  { scorecards: jsonb, fetched: boolean }
 *   onSelectMetric  (key) => open deep dive
 *   onSelectBranch  (branchId) => open branch staff table
 */
export function DirectorScorecardCards({ scorecards = {}, fetched = false, onSelectMetric, onSelectBranch }) {
  const s = scorecards
  const snapped = (key) => (s[key] && typeof s[key] === 'object' ? s[key] : null)

  const portfolio = snapped('portfolio')
  const parAmount = snapped('par_amount')
  const parPct = snapped('par_pct')
  const passWatch = snapped('pass_watch')
  const substandard = snapped('substandard')
  const doubtful = snapped('doubtful')
  const lost = snapped('lost')
  const caseload = snapped('caseload')
  const disbursement = snapped('disbursement')

  const overall = s.overall || {}
  const grade = overall.grade || overall.grade_rating || '—'
  const gradeHex = overall.grade_hex || '#009944'
  const overallScore = overall.total ?? overall.overall_score

  const overallDelta = overall.previous_total != null ? overall.previous_total : null

  const cards = [
    { key: 'portfolio', metricKey: 'portfolio', value: portfolio?.value, previous: portfolio?.previous, imported: portfolio?.imported !== false, unit: 'currency', label: 'Portfolio (outstanding)' },
    { key: 'par_amount', metricKey: 'par_amount', value: parAmount?.value, previous: parAmount?.previous, imported: parAmount?.imported !== false, unit: 'currency', label: 'PAR amount' },
    { key: 'par_pct', metricKey: 'par_pct', value: parPct?.value, previous: parPct?.previous, imported: parPct?.imported !== false, unit: 'percent', label: 'PAR %' },
    { key: 'pass_watch', metricKey: 'pass_watch', value: passWatch?.value, previous: passWatch?.previous, imported: passWatch?.imported !== false, unit: 'currency', label: 'Pass & Watch' },
    { key: 'substandard', metricKey: 'substandard', value: substandard?.value, previous: substandard?.previous, imported: substandard?.imported !== false, unit: 'currency', label: 'Substandard' },
    { key: 'doubtful', metricKey: 'doubtful', value: doubtful?.value, previous: doubtful?.previous, imported: doubtful?.imported !== false, unit: 'currency', label: 'Doubtful' },
    { key: 'lost', metricKey: 'lost', value: lost?.value, previous: lost?.previous, imported: lost?.imported !== false, unit: 'currency', label: 'Lost' },
    { key: 'caseload', metricKey: 'caseload_count', value: caseload?.value, previous: caseload?.previous, imported: caseload?.imported !== false, unit: 'count', label: 'Caseload' },
    { key: 'disbursement_amount', metricKey: 'disbursement_amount', value: disbursement?.value, previous: disbursement?.previous, imported: disbursement?.imported !== false, unit: 'currency', label: 'Disbursement' },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {cards.map(({ key, metricKey, value, previous, imported, unit, label }) => (
        <DirectorScorecardCard
          key={key}
          metricKey={metricKey}
          value={value}
          previous={previous}
          imported={imported}
          unit={unit}
          label={label}
          onSelect={onSelectMetric}
        />
      ))}
      <div className="col-span-2 sm:col-span-3 xl:col-span-5">
        <button
          type="button"
          onClick={() => onSelectMetric('overall')}
          className="group flex w-full items-center justify-between overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md hover:border-[#009944]/40 focus-visible:outline-focus"
        >
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="text-[10px] font-bold uppercase tracking-[.14em] text-slate-400">Overall</span>
          </div>
          <div className="px-4 py-5">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight text-slate-900 group-hover:text-[#009944] dark:text-white">
                {overallScore == null ? '—' : overallScore.toFixed(Number(overallScore) % 1 ? 1 : 0)}
              </span>
              <span className="inline-flex items-center rounded-full bg-[#009944] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[.1em] text-white" style={{ backgroundColor: gradeHex }}>
                {grade || '—'}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-slate-400">
              {overallScore == null ? <>No data imported</> : <>{overall.score_complete ? 'Complete' : 'Incomplete — awaiting PAR + disbursement + caseload targets'}</>}
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 h-1 bg-gradient-to-t from-[#009944] opacity-0 transition group-hover:opacity-100" />
        </button>
      </div>
    </div>
  )
}
