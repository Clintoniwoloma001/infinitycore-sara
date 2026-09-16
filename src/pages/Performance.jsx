import React, { useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  Award, BarChart3, BrainCircuit, Calculator, ChevronDown, ChevronRight, Download,
  LayoutDashboard, Loader2, Plus, RefreshCw, Target, Trash2, TrendingUp, Users, X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { date, money, status } from './hrShared'
import { performanceService, PERFORMANCE_STATUS_LABELS, DEFAULT_GRADING_BANDS } from '../services/performanceService'

const STATUS_COLORS = {
  exceeds_target: '#009944',
  meets_target: '#38bdf8',
  below_target: '#f59e0b',
  on_target: '#38bdf8',
  substandard: '#ef4444',
  watch: '#f59e0b',
}

const STATUS_ORDER = ['exceeds_target', 'meets_target', 'below_target']

function countByStatus(rows) {
  const map = {}
  rows.forEach((r) => {
    map[r.performance_status] = (map[r.performance_status] || 0) + 1
  })
  return map
}

function DashboardView({ results, metrics, onRefresh, onCalculate }) {
  const [period, setPeriod] = useState('')
  const [statusF, setStatusF] = useState('')
  const [drill, setDrill] = useState(null)
  const [showAll, setShowAll] = useState(false)

  const periods = useMemo(
    () => [...new Set(results.map((r) => r.period_label).filter(Boolean))].sort(),
    [results]
  )

  const effectivePeriod = period || periods[0] || ''

  const filtered = useMemo(
    () =>
      results.filter(
        (r) =>
          (!effectivePeriod || r.period_label === effectivePeriod) &&
          (!statusF || r.performance_status === statusF)
      ),
    [results, effectivePeriod, statusF]
  )

  const byEmployee = useMemo(() => {
    const map = {}
    filtered.forEach((r) => {
      const key = r.employee_id || r.employee_name || 'unknown'
      if (!map[key]) {
        map[key] = { id: key, name: r.employee_name || key, weighted: 0, statuses: {}, rows: [] }
      }
      map[key].weighted += Number(r.weighted_score || r.score || 0)
      map[key].statuses[r.performance_status] = (map[key].statuses[r.performance_status] || 0) + 1
      map[key].rows.push(r)
    })
    return Object.values(map)
      .map((e) => ({
        ...e,
        avg: e.rows.length ? Math.round(e.weighted / e.rows.length * 100) / 100 : 0,
        status: e.rows.length
          ? Object.entries(e.statuses).sort((a, b) => b[1] - a[1])[0]?.[0]
          : 'below_target',
      }))
      .sort((a, b) => b.avg - a.avg)
  }, [filtered])

  const dist = useMemo(() => countByStatus(filtered), [filtered])

  const totalByPeriod = useMemo(() => {
    const map = {}
    results.forEach((r) => {
      const key = r.period_label || 'N/A'
      if (!map[key]) map[key] = { period: key, total: 0, meets: 0 }
      map[key].total += 1
      if (r.performance_status === 'meets_target' || r.performance_status === 'exceeds_target') map[key].meets += 1
    })
    return Object.values(map)
      .filter((p) => p.total > 0)
      .sort((a, b) => (a.period < b.period ? -1 : 1))
  }, [results])

  const avgScore = byEmployee.length
    ? byEmployee.reduce((s, e) => s + e.avg, 0) / byEmployee.length
    : 0
  const meetsCount = (dist.exceeds_target || 0) + (dist.meets_target || 0)
  const onTrackPct = filtered.length ? Math.round((meetsCount / filtered.length) * 100) : 0

  const visibleEmp = showAll ? byEmployee : byEmployee.slice(0, 8)

  const exportCsv = () => {
    if (!filtered.length) return
    const cols = ['employee_name', 'metric_name', 'period_label', 'target_value', 'actual_value', 'achievement_pct', 'performance_status', 'weighted_score']
    const lines = [
      cols.join(','),
      ...filtered.map((r) =>
        cols.map((c) => `"${(r[c] ?? '').toString().replace(/"/g, '""')}"`).join(',')
      ),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `performance_${effectivePeriod || 'all'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const kpiCards = [
    {
      label: 'Assessed Employees',
      value: byEmployee.length,
      sub: `${filtered.length} result rows`,
      icon: Users,
      color: '#009944',
    },
    {
      label: 'Average Score',
      value: avgScore.toFixed(1),
      sub: 'weighted org average',
      icon: BrainCircuit,
      color: '#2563eb',
    },
    {
      label: 'Meets / Exceeds',
      value: `${meetsCount} (${onTrackPct}%)`,
      sub: 'of assessed rows on target',
      icon: Target,
      color: '#009944',
    },
    {
      label: 'Below Target',
      value: dist.below_target || 0,
      sub: 'rows flagged for attention',
      icon: TrendingUp,
      color: '#dc2626',
    },
  ]

  const pieData = Object.entries(dist).map(([k, v]) => ({
    name: (PERFORMANCE_STATUS_LABELS[k] || k).replace(' Target', ''),
    value: v,
    color: STATUS_COLORS[k] || '#94a3b8',
  }))

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <LayoutDashboard className="w-4 h-4 text-[#009944]" />
          <span className="font-medium text-slate-700">Filters</span>
        </div>
        <select
          value={effectivePeriod}
          onChange={(e) => setPeriod(e.target.value)}
          className="h-9 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
        >
          {periods.length === 0 && <option value="">No periods</option>}
          {periods.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          value={statusF}
          onChange={(e) => setStatusF(e.target.value)}
          className="h-9 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
        >
          <option value="">All statuses</option>
          {Object.entries(PERFORMANCE_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={exportCsv} disabled={!filtered.length} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40">
            <Download className="w-4 h-4" /> CSV
          </button>
          <button onClick={onRefresh} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-10 flex flex-col items-center text-center">
          <BarChart3 className="w-12 h-12 text-slate-300 mb-4" />
          <h3 className="text-lg font-semibold text-slate-900">No performance data yet</h3>
          <p className="text-sm text-slate-500 max-w-md mt-2">
            Configure metrics, then run a calculation from BankOne transactions for a period
            to populate the intelligence dashboard.
          </p>
          <button onClick={onCalculate} className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Calculator className="w-4 h-4" /> Run Calculation
          </button>
        </div>
      )}

      {filtered.length > 0 && (
        <>
          {/* Executive KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {kpiCards.map((c) => (
              <div key={c.label} className="bg-white rounded-lg border border-slate-200 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs font-medium text-slate-500">{c.label}</p>
                    <p className="text-2xl font-bold text-slate-900 mt-1" style={{ color: c.color }}>{c.value}</p>
                    <p className="text-xs text-slate-400 mt-1">{c.sub}</p>
                  </div>
                  <c.icon className="w-5 h-5" style={{ color: c.color }} />
                </div>
              </div>
            ))}
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1 bg-white rounded-lg border border-slate-200 p-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-1">Status Distribution</h4>
              <p className="text-xs text-slate-400 mb-2">Performance results for {effectivePeriod || 'all periods'}</p>
              {pieData.length === 0 ? (
                <p className="text-sm text-slate-400 py-10 text-center">No rows</p>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={2}>
                      {pieData.map((d, i) => (
                        <Cell key={i} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v, n) => [`${v} rows`, n]} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="lg:col-span-2 bg-white rounded-lg border border-slate-200 p-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-1">Employee Performance Leaderboard</h4>
              <p className="text-xs text-slate-400 mb-3">Weighted average score across assessed metrics</p>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={visibleEmp} layout="vertical" margin={{ left: 8, right: 24, top: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={110}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
                  />
                  <Tooltip formatter={(v) => [`${v} pts`, 'Avg Score']} cursor={{ fill: '#f8fafc' }} />
                  <Bar dataKey="avg" name="Avg Score" radius={[0, 4, 4, 0]} barSize={14}>
                    {visibleEmp.map((e, i) => (
                      <Cell key={i} fill={STATUS_COLORS[e.status] || '#94a3b8'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {byEmployee.length > 8 && (
                <button onClick={() => setShowAll(!showAll)} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[#009944] hover:underline">
                  {showAll ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  {showAll ? 'Show top 8' : `Show all ${byEmployee.length} employees`}
                </button>
              )}
            </div>
          </div>

          {/* Period trend */}
          {totalByPeriod.length > 1 && (
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-1">Period Trend</h4>
              <p className="text-xs text-slate-400 mb-3">Results per period · meets/exceeds share</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={totalByPeriod} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="period" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip cursor={{ fill: '#f8fafc' }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="total" name="Total rows" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="meets" name="Meets / Exceeds" fill="#009944" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Employee drill-down table */}
          <div className="bg-white rounded-lg border border-slate-200">
            <div className="px-4 py-3 border-b border-slate-100">
              <h4 className="text-sm font-semibold text-slate-700">Employee Performance Detail</h4>
              <p className="text-xs text-slate-400 mt-0.5">Click a row to see metric-level results</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Employee</th>
                    <th className="px-4 py-3 font-medium">Metrics</th>
                    <th className="px-4 py-3 font-medium">Avg Score</th>
                    <th className="px-4 py-3 font-medium">Dominant Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleEmp.map((e) => (
                    <React.Fragment key={e.id}>
                      <tr
                        onClick={() => setDrill(drill === e.id ? null : e.id)}
                        className="hover:bg-slate-50 cursor-pointer"
                      >
                        <td className="px-4 py-3 font-medium text-slate-800">
                          <span className="inline-flex items-center gap-1.5">
                            {drill === e.id ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                            {e.name}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{e.rows.length}</td>
                        <td className="px-4 py-3 font-semibold text-slate-800">{e.avg.toFixed(1)}</td>
                        <td className="px-4 py-3">{PERFORMANCE_STATUS_LABELS[e.status] || e.status}</td>
                      </tr>
                      {drill === e.id && (
                        <tr className="bg-slate-50/60">
                          <td colSpan={4} className="px-4 py-3">
                            <div className="overflow-x-auto rounded-lg border border-slate-200">
                              <table className="w-full text-xs">
                                <thead className="bg-white text-slate-500 text-left">
                                  <tr>
                                    <th className="px-3 py-2 font-medium">Metric</th>
                                    <th className="px-3 py-2 font-medium">Target</th>
                                    <th className="px-3 py-2 font-medium">Actual</th>
                                    <th className="px-3 py-2 font-medium">Achv%</th>
                                    <th className="px-3 py-2 font-medium">Status</th>
                                    <th className="px-3 py-2 font-medium">Score</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {e.rows.map((r) => (
                                    <tr key={r.id} className="bg-white">
                                      <td className="px-3 py-2 text-slate-700">{r.metric_name}</td>
                                      <td className="px-3 py-2 text-slate-600">{r.target_value}</td>
                                      <td className="px-3 py-2 text-slate-600">{r.actual_value}</td>
                                      <td className="px-3 py-2 text-slate-600">{r.achievement_pct}%</td>
                                      <td className="px-3 py-2">{PERFORMANCE_STATUS_LABELS[r.performance_status] || r.performance_status}</td>
                                      <td className="px-3 py-2 font-medium text-slate-700">{r.weighted_score}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Management shortcut */}
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between bg-[#009944]/5 border border-[#009944]/20 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <Award className="w-5 h-5 text-[#009944]" />
              <div>
                <p className="text-sm font-semibold text-slate-800">Smart at-a-glance intelligence</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {metrics.length} configured metrics · {results.length} total result rows across {periods.length} period(s).
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={onCalculate} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
                <Calculator className="w-4 h-4" /> Calculate
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}


const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function Performance() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('performance.manage')

  const [tab, setTab] = useState('dashboard')
  const [metrics, setMetrics] = useState([])
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAddMetric, setShowAddMetric] = useState(false)
  const [calculating, setCalculating] = useState(false)
  const [calcPeriod, setCalcPeriod] = useState('')
  const [calcStart, setCalcStart] = useState('')
  const [calcEnd, setCalcEnd] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const m = await performanceService.listMetrics()
      setMetrics(m)
      const r = await performanceService.getResults()
      setResults(r)
    } catch (e) {
      setError(e?.message || 'Failed to load performance data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const calculate = async () => {
    if (!calcPeriod || !calcStart || !calcEnd) { setError('Period label, start and end dates are required.'); return }
    setCalculating(true)
    setError('')
    try {
      const activeMetrics = await performanceService.listMetrics({ activeOnly: true })
      await performanceService.calculatePerformance({
        periodLabel: calcPeriod,
        periodStart: calcStart,
        periodEnd: calcEnd,
        metrics: activeMetrics,
      })
      await load()
      setError('')
      setTab('results')
    } catch (e) {
      setError(e?.message || 'Calculation failed')
    } finally {
      setCalculating(false)
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">📊 Performance</h2>
          <p className="text-sm text-slate-500 mt-1">Configurable metrics, targets, and BankOne transaction performance calculations.</p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {error && <div className="mb-5"><ErrorState message={error} /></div>}

      {tab === 'dashboard' && (
        <DashboardView
          results={results}
          metrics={metrics}
          onRefresh={load}
          onCalculate={() => setTab('calculate')}
        />
      )}

      <div className="flex gap-2 overflow-x-auto pb-3 mb-6">
        {[
          { id: 'dashboard', label: 'Intelligence Dashboard' },
          { id: 'metrics', label: 'Metrics & Targets' },
          { id: 'results', label: 'Results' },
          { id: 'calculate', label: 'Calculate' },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'metrics' && (
        <div>
          {canManage && (
            <button onClick={() => setShowAddMetric(true)} className="mb-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <Plus className="w-4 h-4" /> Add Metric
            </button>
          )}
          {loading && <div className="text-sm text-slate-500">Loading…</div>}
          {!loading && metrics.length === 0 && <EmptyState title="No performance metrics configured" description="Add metrics like Transaction Count, Transaction Value, or Success Rate." />}
          {!loading && metrics.length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Metric</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Target</th>
                    <th className="px-4 py-3 font-medium">Weight</th>
                    <th className="px-4 py-3 font-medium">Period</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {metrics.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-800">{m.metric_name}<br /><span className="text-xs text-slate-400">{m.description}</span></td>
                      <td className="px-4 py-3 text-slate-600">{m.metric_type}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {m.target_quantity ? `${m.target_quantity}` : ''} {m.target_monetary_value ? money(m.target_monetary_value) : ''}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{m.score_weight}%</td>
                      <td className="px-4 py-3 text-slate-600">{m.target_period}</td>
                      <td className="px-4 py-3">{status(m.is_active ? 'active' : 'inactive', ['active'])}</td>
                      {canManage && (
                        <td className="px-4 py-3 text-right">
                          <button onClick={async () => { await performanceService.deleteMetric(m.id); load() }} className="text-rose-500 hover:text-rose-700"><Trash2 className="w-4 h-4" /></button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'results' && (
        <div>
          {loading && <div className="text-sm text-slate-500">Loading…</div>}
          {!loading && results.length === 0 && <EmptyState title="No performance results" description="Run a calculation to generate results from BankOne transactions." />}
          {!loading && results.length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Employee</th>
                    <th className="px-4 py-3 font-medium">Metric</th>
                    <th className="px-4 py-3 font-medium">Period</th>
                    <th className="px-4 py-3 font-medium">Target</th>
                    <th className="px-4 py-3 font-medium">Actual</th>
                    <th className="px-4 py-3 font-medium">Achievement</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.slice(0, 100).map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-600">{r.employee_name || r.employee_id?.slice(0, 8) || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{r.metric_name}</td>
                      <td className="px-4 py-3 text-slate-600">{r.period_label}</td>
                      <td className="px-4 py-3 text-slate-600">{r.target_value}</td>
                      <td className="px-4 py-3 text-slate-600">{r.actual_value}</td>
                      <td className="px-4 py-3 font-medium">{r.achievement_pct}%</td>
                      <td className="px-4 py-3">{PERFORMANCE_STATUS_LABELS[r.performance_status] || r.performance_status}</td>
                      <td className="px-4 py-3 text-slate-600">{r.weighted_score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'calculate' && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 max-w-lg">
          <h3 className="font-semibold text-slate-900 mb-4">Calculate Performance from BankOne Transactions</h3>
          <p className="text-sm text-slate-500 mb-4">This will aggregate BankOne transaction data for the specified period and compare against configured metrics/targets.</p>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Period Label</label>
              <input className={inputCls} value={calcPeriod} onChange={(e) => setCalcPeriod(e.target.value)} placeholder="e.g. 2025-09" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Period Start</label>
                <input type="date" className={inputCls} value={calcStart} onChange={(e) => setCalcStart(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Period End</label>
                <input type="date" className={inputCls} value={calcEnd} onChange={(e) => setCalcEnd(e.target.value)} />
              </div>
            </div>
            <button onClick={calculate} disabled={calculating} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
              {calculating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calculator className="w-4 h-4" />} Calculate
            </button>
          </div>
        </div>
      )}

      {/* Add Metric Modal */}
      {showAddMetric && (
        <AddMetricModal
          onClose={() => setShowAddMetric(false)}
          onSaved={() => { setShowAddMetric(false); load() }}
        />
      )}
    </div>
  )
}

function AddMetricModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    metric_name: '', description: '', metric_type: 'quantity',
    target_period: 'monthly', target_quantity: '', target_monetary_value: '',
    minimum_threshold: '', score_weight: '', department: '', employee_category: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!form.metric_name.trim()) { setError('Metric name is required.'); return }
    setBusy(true)
    setError('')
    try {
      await performanceService.createMetric({
        ...form,
        target_quantity: form.target_quantity ? Number(form.target_quantity) : null,
        target_monetary_value: form.target_monetary_value ? Number(form.target_monetary_value) : null,
        minimum_threshold: form.minimum_threshold ? Number(form.minimum_threshold) : null,
        score_weight: form.score_weight ? Number(form.score_weight) : 0,
        achievement_bands: DEFAULT_GRADING_BANDS,
        is_active: true,
      })
      onSaved()
    } catch (e) {
      setError(e?.message || 'Failed to save metric')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-slate-900">Add Performance Metric</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        {error && <div className="mb-4"><ErrorState message={error} /></div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className={labelCls}>Metric Name *</label>
            <input className={inputCls} value={form.metric_name} onChange={(e) => setForm({ ...form, metric_name: e.target.value })} placeholder="e.g. Transaction Count" />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Description</label>
            <input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Metric Type</label>
            <select className={inputCls} value={form.metric_type} onChange={(e) => setForm({ ...form, metric_type: e.target.value })}>
              <option value="quantity">Quantity (count)</option>
              <option value="monetary">Monetary (value)</option>
              <option value="percentage">Percentage</option>
              <option value="rating">Rating</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Target Period</label>
            <select className={inputCls} value={form.target_period} onChange={(e) => setForm({ ...form, target_period: e.target.value })}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Target Quantity</label>
            <input type="number" className={inputCls} value={form.target_quantity} onChange={(e) => setForm({ ...form, target_quantity: e.target.value })} placeholder="e.g. 100" />
          </div>
          <div>
            <label className={labelCls}>Target Monetary Value</label>
            <input type="number" className={inputCls} value={form.target_monetary_value} onChange={(e) => setForm({ ...form, target_monetary_value: e.target.value })} placeholder="e.g. 10000000" />
          </div>
          <div>
            <label className={labelCls}>Score Weight (%)</label>
            <input type="number" className={inputCls} value={form.score_weight} onChange={(e) => setForm({ ...form, score_weight: e.target.value })} placeholder="e.g. 20" />
          </div>
          <div>
            <label className={labelCls}>Minimum Threshold</label>
            <input type="number" className={inputCls} value={form.minimum_threshold} onChange={(e) => setForm({ ...form, minimum_threshold: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Department (optional)</label>
            <input className={inputCls} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="All if empty" />
          </div>
          <div>
            <label className={labelCls}>Employee Category (optional)</label>
            <input className={inputCls} value={form.employee_category} onChange={(e) => setForm({ ...form, employee_category: e.target.value })} placeholder="All if empty" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save Metric
          </button>
        </div>
      </div>
    </div>
  )
}
