/**
 * ============================================================================
 * MPR Performance Dashboard — staff scoring, grading and reporting
 * ============================================================================
 *
 * Implements the FINCON blueprint's BI report (Section 3) as a live page:
 *   * a stacked MPR breakdown chart (Disbursement 35 + PAR 35 + Caseload 30)
 *   * the BI performance table with A-E grade badges in the spec's hex colours
 *   * Excel (.xlsx) and PNG export of both the data and the chart
 *
 * PRESENTATION ONLY. Every number comes from src/domains/performance/mprEngine.js
 * — the page never computes a score itself, so what is displayed, exported and
 * graded can never disagree.
 *
 * PROVISIONAL SCORES ARE ALWAYS LABELLED. When any of the three components is
 * unmeasured the engine withholds the total and grade; this page shows the
 * measured subtotal with an explicit "Provisional" marker rather than
 * presenting a partial score as a final grade.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AlertTriangle, BarChart3, Download, FileSpreadsheet, Image as ImageIcon,
  RefreshCw, Trophy, Users,
} from 'lucide-react'
import { EmptyState } from '../components/PageStates'
import {
  GRADE_BANDS, MPR_MAX, PAR_BANDS, assignGrade, evaluateMpr, summariseMpr,
} from '../domains/performance/mprEngine.js'
import { exportMprWorkbook, buildChartData, exportMprChartPng } from '../lib/performanceExport'
import { useMprReport } from '../hooks/useMprReport'

// Stacking colours from the blueprint's own matplotlib figure.
const SERIES = {
  disbursement: { key: 'disbursement', label: `Disbursement (${MPR_MAX.disbursement})`, color: '#2563EB' },
  par: { key: 'par', label: `PAR (${MPR_MAX.par})`, color: '#10B981' },
  caseload: { key: 'caseload', label: `Caseload (${MPR_MAX.caseload})`, color: '#F59E0B' },
}

const card = 'bg-white rounded-xl border border-slate-200 shadow-sm'
const btn = 'inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition'

/** The coloured A-E badge pill, using the spec's hex per grade. */
function GradeBadge({ grade, rating }) {
  if (!grade) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">Not graded</span>
  }
  const hex = (GRADE_BANDS.find((g) => g.grade === grade) || {}).hex
  return (
    <span
      className="inline-flex items-center rounded-full px-3 py-1 text-xs font-bold text-white"
      style={{ backgroundColor: hex }}
      title={`Grade ${grade} — ${rating}`}
    >
      {grade} - {rating}
    </span>
  )
}

/** Header KPI cards: headcount, average and the grade distribution. */
function SummaryCards({ summary }) {
  const cards = [
    {
      label: 'Staff Reviewed',
      value: summary.headcount,
      sub: summary.provisionalCount
        ? `${summary.provisionalCount} provisional`
        : 'All complete',
      icon: Users,
      tone: 'text-slate-900',
    },
    {
      label: 'Average MPR Score',
      value: summary.average ?? '—',
      sub: summary.averageGrade ? `Grade ${summary.averageGrade.grade} — ${summary.averageGrade.rating}` : 'No complete data',
      icon: Trophy,
      tone: 'text-slate-900',
    },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map(({ label, value, sub, icon: Icon, tone }) => (
        <div key={label} className={`${card} p-4`}>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <Icon size={16} className="text-slate-400" />
          </div>
          <p className={`mt-2 text-2xl font-bold ${tone}`}>{value}</p>
          <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
        </div>
      ))}
      {summary.distribution.map((d) => (
        <div key={d.grade} className={`${card} p-4`}>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Grade {d.grade}</p>
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: d.hex }} />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">{d.count}</p>
          <p className="mt-0.5 text-xs text-slate-500">{d.rating}</p>
        </div>
      ))}
    </div>
  )
}

/** The stacked MPR breakdown chart (spec Section 3.2). */
function MprChart({ data }) {
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 20, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={60} />
          <YAxis domain={[0, 110]} tick={{ fontSize: 11 }} label={{ value: 'Points (100 max)', angle: -90, position: 'insideLeft', fontSize: 11 }} />
          <Tooltip
            formatter={(v, n) => [Number(v).toFixed(1), n]}
            labelFormatter={(l, p) => (p && p[0] ? `${l} — ${p[0].payload.branch || '—'}` : l)}
          />
          <Legend />
          {Object.values(SERIES).map((s) => (
            <Bar key={s.key} dataKey={s.key} stackId="mpr" fill={s.color} name={s.label} radius={[0, 0, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** The BI performance table with grade badges. */
function MprTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="border-b-2 border-slate-200 bg-slate-50 text-slate-700">
          <tr>
            <th className="px-4 py-3 font-semibold">Staff Name</th>
            <th className="px-4 py-3 font-semibold">Branch</th>
            <th className="px-4 py-3 text-center font-semibold">Disbursement ({MPR_MAX.disbursement})</th>
            <th className="px-4 py-3 text-center font-semibold">PAR ({MPR_MAX.par})</th>
            <th className="px-4 py-3 text-center font-semibold">Caseload ({MPR_MAX.caseload})</th>
            <th className="px-4 py-3 text-center font-semibold">Total Score</th>
            <th className="px-4 py-3 text-center font-semibold">Grade Rating</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const e = r.evaluation
            const cell = 'px-4 py-3 text-center tabular-nums'
            return (
              <tr key={r.employeeId || r.staffName} className="border-b border-slate-100 odd:bg-white even:bg-slate-50/50">
                <td className="px-4 py-3 font-semibold text-slate-900">{r.staffName}</td>
                <td className="px-4 py-3 text-slate-600">{r.branch}</td>
                <td className={cell}>{e.disbursementScore ?? '—'}</td>
                <td className={cell}>
                  {e.parScore ?? '—'}
                  {e.parPercent !== null && (
                    <span className="ml-1 text-xs text-slate-400">({e.parPercent}%)</span>
                  )}
                </td>
                <td className={cell}>{e.caseloadScore ?? '—'}</td>
                <td className={`${cell} font-bold`}>
                  {e.complete ? e.total : e.subtotal}
                  {!e.complete && (
                    <span className="ml-1.5 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
                      <AlertTriangle size={10} /> Provisional
                    </span>
                  )}
                </td>
                <td className={cell}>
                  <GradeBadge grade={e.grade} rating={e.gradeRating} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
export default function MprPerformance() {
  const { rows, loading, error, periodLabel, refresh } = useMprReport()
  const [exporting, setExporting] = useState(null)
  const chartRef = useRef(null)

  // Evaluate once, here, so the table, the chart and both exports all read the
  // exact same evaluation object.
  const evaluated = useMemo(
    () => rows.map((r) => ({ ...r, evaluation: r.evaluation || evaluateMpr(r) })),
    [rows],
  )
  const summary = useMemo(() => summariseMpr(evaluated), [evaluated])
  const chartData = useMemo(() => buildChartData(evaluated), [evaluated])

  const onExportExcel = useCallback(() => {
    if (!evaluated.length) return
    setExporting('excel')
    try {
      exportMprWorkbook(evaluated, { periodLabel })
    } finally {
      setExporting(null)
    }
  }, [evaluated, periodLabel])

  const onExportPng = useCallback(async () => {
    if (!chartRef.current) return
    setExporting('png')
    try {
      await exportMprChartPng(chartRef.current, `MPR-performance-${periodLabel}.png`)
    } catch (e) {
      // Surface rather than swallow: a silently-failed download looks like a bug.
      console.error('MPR chart export failed', e)
      alert(e.message || 'The chart could not be exported.')
    } finally {
      setExporting(null)
    }
  }, [periodLabel])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500">
        <RefreshCw size={18} className="mr-2 animate-spin" /> Loading MPR data…
      </div>
    )
  }

  if (error) {
    return (
      <div className={`${card} p-6`}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 text-red-500" size={20} />
          <div>
            <h2 className="font-semibold text-slate-900">Unable to load MPR data</h2>
            <p className="mt-1 text-sm text-slate-600">{error}</p>
            <button type="button" onClick={refresh} className={`${btn} mt-4`}>Try again</button>
          </div>
        </div>
      </div>
    )
  }

  if (!evaluated.length) {
    return (
      <div className={card}>
        <EmptyState
          title="No MPR data for this period"
          description="Once targets and actuals are recorded for a period, staff scores and grades appear here."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header + actions */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Staff MPR Performance Report
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Period <span className="font-medium text-slate-700">{periodLabel}</span>
            {' · '}
            Disbursement {MPR_MAX.disbursement} + PAR {MPR_MAX.par} + Caseload {MPR_MAX.caseload} = 100
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onExportExcel} disabled={exporting === 'excel'} className={btn}>
            <FileSpreadsheet size={15} />
            {exporting === 'excel' ? 'Preparing…' : 'Export Excel'}
          </button>
          <button type="button" onClick={onExportPng} disabled={exporting === 'png'} className={btn}>
            <ImageIcon size={15} />
            {exporting === 'png' ? 'Rendering…' : 'Export PNG'}
          </button>
          <button type="button" onClick={refresh} className={btn}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      <SummaryCards summary={summary} />

      {/* Chart */}
      <div className={`${card} p-5`}>
        <div className="mb-3 flex items-center gap-2">
          <BarChart3 size={16} className="text-slate-400" />
          <h2 className="font-semibold text-slate-900">MPR Performance Breakdown</h2>
        </div>
        {chartData.length ? (
          // ref target for the PNG capture — captures the chart exactly as shown.
          <div ref={chartRef}>
            <MprChart data={chartData} />
          </div>
        ) : (
          <div className="flex h-80 items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-500">
            No complete MPR scores to chart yet. Provisional rows are excluded from the
            chart so a partial score is never stacked beside a full one.
          </div>
        )}
      </div>

      {/* Table */}
      <div className={card}>
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="font-semibold text-slate-900">Performance Detail</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            PAR % bands: {PAR_BANDS.map((b) => `${b.label} → ${b.points}pts`).join('  •  ')}
          </p>
        </div>
        <MprTable rows={evaluated} />
      </div>
    </div>
  )
}