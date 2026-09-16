import React, { useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AlertTriangle, Award, BadgeCheck, BarChart3, BrainCircuit, Briefcase, Building2, Calculator,
  ChevronDown, ChevronRight, Download, Filter, LayoutDashboard, Loader2,
  MapPin, Plus, Printer, RefreshCw, RotateCcw, Target, Trash2, TrendingUp, Users, X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { date, money, status } from './hrShared'
import { performanceService, PERFORMANCE_STATUS_LABELS, DEFAULT_GRADING_BANDS } from '../services/performanceService'
import { performanceConfigService } from '../services/performanceConfigService'
import { employeeService } from '../services/employeeService'
import { reconciliationService } from '../services/reconciliationService'

const STATUS_COLORS = {
  exceeds_target: '#009944',
  meets_target: '#38bdf8',
  below_target: '#f59e0b',
  on_target: '#38bdf8',
  substandard: '#ef4444',
  watch: '#f59e0b',
}

const STATUS_ORDER = ['exceeds_target', 'meets_target', 'below_target']

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

function countByStatus(rows) {
  const map = {}
  rows.forEach((r) => {
    map[r.performance_status] = (map[r.performance_status] || 0) + 1
  })
  return map
}

// ============================================================
// Performance Intelligence Dashboard — presentation layer only.
// All data is derived from the existing performance engine,
// BankOne imports (via performance_results), employee master and
// the reconciliation case-load service. Nothing is fabricated.
// ============================================================

const DEFAULT_GRADES = [
  { grade: 'EXCELLENT', min_score: 90, max_score: 100, letter: 'A' },
  { grade: 'VERY GOOD', min_score: 76, max_score: 89, letter: 'B' },
  { grade: 'GOOD', min_score: 65, max_score: 75, letter: 'C' },
  { grade: 'AVERAGE', min_score: 60, max_score: 64, letter: 'D' },
  { grade: 'UNSATISFACTORY', min_score: 0, max_score: 50, letter: 'E' },
]

// Grade comes from the CONFIGURED performance grade bands (phase 26) —
// never a hard-coded alternative system.
function gradeForScore(score, gradeBands) {
  const bands = Array.isArray(gradeBands) && gradeBands.length ? gradeBands : DEFAULT_GRADES
  const flat = bands
    .map((b, i) => ({ ...b, ord: i }))
    .sort((a, b) => (a.min_score ?? 0) - (b.min_score ?? 0))
  for (const b of flat) {
    const lo = b.min_score ?? -Infinity
    const hi = b.max_score ?? Infinity
    if (score >= lo && (hi === Infinity || score <= hi)) return b
  }
  return null
}

// Classification uses the existing InfinityCore thresholds: meets-band
// starts at 80 (DEFAULT_GRADING_BANDS) and UNSATISFACTORY runs 0–50
// (configured grade band E). Boundaries are derived, not invented.
function classifyPct(pct) {
  if (pct >= 80) return 'PASS'
  if (pct > 50) return 'WATCH'
  return 'SUBSTANDARD'
}

const CLASS_LABELS = { PASS: 'Pass', WATCH: 'Watch', SUBSTANDARD: 'Substandard' }
const CLASS_COLORS = { PASS: '#009944', WATCH: '#f59e0b', SUBSTANDARD: '#dc2626' }

function periodRange(preset, custom) {
  const now = new Date()
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const y = now.getFullYear(), m = now.getMonth()
  const day = (offsetDays) => startOfDay(new Date(now)) - offsetDays * 86400000
  const begin = (yy, mm) => new Date(yy, mm, 1).getTime()
  const endOf = (yy, mm) => new Date(yy, mm + 1, 0).getTime()
  const maps = {
    today: [day(0), day(0) + 86399999],
    week: [day(now.getDay()), day(now.getDay()) + 86399999 + (6 - now.getDay()) * 86400000],
    month: [begin(y, m), endOf(y, m)],
    prevMonth: [begin(y, m - 1), endOf(y, m - 1)],
    quarter: [begin(y, m - (m % 3)), endOf(y, m - (m % 3) + 2)],
    year: [begin(y, 0), endOf(y, 11)],
  }
  if (preset === 'custom' && custom && custom.from && custom.to) {
    const to = new Date(custom.to)
    return [startOfDay(new Date(custom.from)), endOf(to.getFullYear(), to.getMonth())]
  }
  return maps[preset] || maps.month
}

function rowInRange(r, range) {
  if (!range) return true
  const [a, b] = range
  let s = r.period_start ? new Date(r.period_start) : null
  let e = r.period_end ? new Date(r.period_end) : null
  if (s) s = s.getTime()
  if (e) e = e.getTime()
  if (s && e) return !(e < a) && !(s > b)
  if (s) return s >= a && s <= b
  if (e) return e >= a && e <= b
  const label = (r.period_label || '').match(/^\d{4}-\d{2}/)
  if (label) { const t = new Date(Number(label[0].slice(0, 4)), Number(label[0].slice(5, 7)) - 1, 15).getTime(); return t >= a && t <= b }
  return true
}

function DashboardView({ results, metrics, employees, config, caseMetrics, onRefresh, onCalculate, onImport }) {
  const [preset, setPreset] = useState(localStorage.getItem('perf_preset') || 'month')
  const [customRange, setCustomRange] = useState({ from: '', to: '' })
  const [branchF, setBranchF] = useState('')
  const [areaF, setAreaF] = useState('')
  const [deptF, setDeptF] = useState('')
  const [empF, setEmpF] = useState('')
  const [classF, setClassF] = useState('')
  const [applied, setApplied] = useState({ preset: null, custom: null, branchF, areaF, deptF, empF, classF })
  const [branchDrill, setBranchDrill] = useState('')
  const [sortKey, setSortKey] = useState('avgScore')
  const [sortDir, setSortDir] = useState('desc')
  const [branchSort, setBranchSort] = useState({ key: 'avgScore', dir: 'desc' })

  const gradeBands = (config?.sections?.find((sec) => sec.code === 'grades')?.items) || []

  const gradeData = useMemo(
    () => (Array.isArray(gradeBands) && gradeBands.length ? gradeBands : DEFAULT_GRADES),
    [gradeBands]
  )

  const gradeFor = (score) => {
    const g = gradeForScore(score, gradeData)
    return { letter: g?.letter || '—', name: g?.grade || 'Unclassified' }
  }

  const employeeMap = useMemo(() => {
    const map = {}
    ;(employees || []).forEach((emp) => {
      map[emp.id || emp.employee_id] = emp
    })
    return map
  }, [employees])

  const periodSources = useMemo(
    () => [...new Set(results.map((r) => r.period_label).filter(Boolean))].sort(),
    [results]
  )

  const metricsByMetricId = useMemo(() => {
    const map = {}
    ;(metrics || []).forEach((mt) => { map[mt.id] = mt })
    return map
  }, [metrics])

  const isMonetary = (r) => metricsByMetricId[r.metric_id]?.metric_type === 'monetary'
  const isCount = (r) => metricsByMetricId[r.metric_id]?.metric_type === 'quantity'

  const activeRange = applied.preset ? periodRange(applied.preset, applied.custom) : null

  // Merge employee attributes onto each result row.
  const enrichedRows = useMemo(() => {
    return results
      .filter((r) => rowInRange(r, activeRange))
      .map((r) => {
        const emp = employeeMap[r.employee_id] || {}
        return {
          ...r,
          empName: r.employee_name || emp.full_name || r.employee_id?.slice(0, 8) || '—',
          empRole: emp.position || emp.designation || '',
          empDept: emp.department || '',
          empBranch: emp.branch || emp.branch_id || '',
          empArea: emp.area || emp.area_manager_name || '',
          empStaffId: emp.staff_id || emp.employee_number || '',
          empStatus: emp.employment_status || '',
        }
      })
  }, [results, activeRange, employeeMap])

  const metricTypeLabel = (r) => (isMonetary(r) ? 'value' : isCount(r) ? 'count' : 'other')

  const empAgg = useMemo(() => {
    const map = {}
    enrichedRows.forEach((r) => {
      const key = r.employee_id || r.empName
      if (!map[key]) {
        map[key] = {
          employeeId: r.employee_id || null,
          name: r.empName,
          role: r.empRole,
          dept: r.empDept,
          branch: r.empBranch,
          area: r.empArea,
          staffId: r.empStaffId,
          empStatus: r.empStatus,
          rows: [],
          txnCount: 0,
          txnValue: 0,
          hasValueMetric: false,
          hasCountMetric: false,
          weighted: 0,
          statuses: {},
        }
      }
      const e = map[key]
      e.rows.push(r)
      e.weighted += Number(r.achievement_pct >= 0 ? r.achievement_pct * (r.weight || 1) : 0)
      if (metricTypeLabel(r) === 'value') { e.txnValue += Number(r.actual_value) || 0; e.hasValueMetric = true }
      if (metricTypeLabel(r) === 'count') { e.txnCount += Number(r.actual_value) || 0; e.hasCountMetric = true }
      e.statuses[r.performance_status] = (e.statuses[r.performance_status] || 0) + 1
    })
    return Object.values(map).map((e) => {
      const totalWeight = e.rows.reduce((sum, r) => sum + (Number(r.weight) || 0), 0) || e.rows.length
      const avg = Math.round((e.weighted / totalWeight) * 100) / 100
      const graded = gradeFor(avg)
      const cls = classifyPct(avg)
      return {
        ...e,
        avg,
        gradeLetter: graded.letter,
        gradeName: graded.name,
        cls,
        domain: e.empStatus && e.empStatus !== 'active' ? e.empStatus : cls,
      }
    }).sort((a, b) => b.avg - a.avg)
  }, [enrichedRows, gradeFor])

  // Filters (applied only)
  const visible = useMemo(() => {
    return empAgg.filter((e) => {
      if (applied.branchF && e.branch !== applied.branchF) return false
      if (applied.areaF && e.area !== applied.areaF) return false
      if (applied.deptF && e.dept !== applied.deptF) return false
      if (applied.empF && e.employeeId !== applied.empF) return false
      if (applied.classF && e.cls !== applied.classF) return false
      return true
    })
  }, [empAgg, applied])

  const visibleRows = useMemo(() => {
    const ids = new Set(visible.map((e) => e.employeeId))
    return enrichedRows.filter((r) => !ids.size || ids.has(r.employee_id))
  }, [visible, enrichedRows])

  const totalEmp = (employees || []).length
  const activeEmp = (employees || []).filter((e) => (e.employment_status || 'active') === 'active').length
  const assessed = visible.length
  const meetsRows = visibleRows.filter((r) => ['meets_target', 'exceeds_target'].includes(r.performance_status)).length
  const belowRows = visibleRows.filter((r) => r.performance_status === 'below_target').length
  const passCount = visible.filter((e) => e.cls === 'PASS').length
  const watchCount = visible.filter((e) => e.cls === 'WATCH').length
  const subCount = visible.filter((e) => e.cls === 'SUBSTANDARD').length
  const avgScore = assessed ? Math.round((visible.reduce((sum, e) => sum + e.avg, 0) / assessed) * 100) / 100 : 0
  const txnCount = visible.reduce((sum, e) => sum + (e.hasCountMetric ? e.txnCount : 0), 0)
  const txnValue = visible.reduce((sum, e) => sum + (e.hasValueMetric ? e.txnValue : 0), 0)
  const caseTotal = caseMetrics?.total || 0
  const caseResolved = caseMetrics?.resolvedCount || 0
  const caseRate = caseMetrics?.resolutionRate || 0
  const hasCounts = visible.some((e) => e.hasCountMetric)
  const hasValues = visible.some((e) => e.hasValueMetric)

  // Filter options (derived)
  const branches = [...new Set(empAgg.map((e) => e.branch).filter(Boolean))].sort()
  const areas = [...new Set(empAgg.map((e) => e.area).filter(Boolean))].sort()
  const depts = [...new Set(empAgg.map((e) => e.dept).filter(Boolean))].sort()
  const empChoices = empAgg.map((e) => ({ id: e.employeeId, name: e.name })).sort((a, b) => a.name.localeCompare(b.name))

  const sortEmployees = (list) => {
    const dir = sortDir === 'desc' ? -1 : 1
    return [...list].sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name) * dir
      return ((a[sortKey] || 0) - (b[sortKey] || 0)) * dir
    })
  }

  const setSort = (k) => {
    if (sortKey === k) setSortDir(sortDir === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir('desc') }
  }
  const setBranchSortKey = (k) => {
    setBranchSort((bs) => ({ key: k, dir: bs.key === k && bs.dir === 'desc' ? 'asc' : 'desc' }))
  }

  const applyFilters = () => {
    setApplied({ preset, custom: customRange, branchF, areaF, deptF, empF, classF })
    localStorage.setItem('perf_preset', preset)
  }
  const resetFilters = () => {
    setPreset('month'); setCustomRange({ from: '', to: '' })
    setBranchF(''); setAreaF(''); setDeptF(''); setEmpF(''); setClassF(''); setBranchDrill('')
    setApplied({ preset: 'month', custom: null, branchF: '', areaF: '', deptF: '', empF: '', classF: '' })
    localStorage.removeItem('perf_preset')
  }

  const exportCsv = () => {
    const rows = visibleRows
    if (!rows.length) return
    const cols = ['employee_name', 'staff_id', 'department', 'branch', 'area', 'role', 'metric_name', 'period_label', 'target_value', 'actual_value', 'achievement_pct', 'performance_status', 'weighted_score']
    const lines = [
      cols.join(','),
      ...rows.map((r) =>
        cols.map((c) => {
          let v = r[c]
          if (c === 'employee_name') v = r.empName
          if (c === 'staff_id') v = r.empStaffId
          if (c === 'department') v = r.empDept
          if (c === 'branch') v = r.empBranch
          if (c === 'area') v = r.empArea
          if (c === 'role') v = r.empRole
          return `"${(v ?? '').toString().replace(/"/g, '""')}"`
        }).join(',')
      ),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `performance_report_${applied.preset || 'custom'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Branch rollup table (E)
  const branchData = (branches.length ? branches : ['—']).map((b) => {
    const list = visible.filter((e) => (branches.length ? e.branch === b : true))
    return {
      branch: b,
      area: list[0]?.area || '',
      employees: list.length,
      transactions: list.reduce((s, e) => s + (e.hasCountMetric ? e.txnCount : 0), 0),
      value: list.reduce((s, e) => s + (e.hasValueMetric ? e.txnValue : 0), 0),
      cases: caseTotal,
      avgScore: list.length ? Math.round((list.reduce((s, e) => s + e.avg, 0) / list.length) * 100) / 100 : 0,
      pass: list.filter((e) => e.cls === 'PASS').length,
      watch: list.filter((e) => e.cls === 'WATCH').length,
      sub: list.filter((e) => e.cls === 'SUBSTANDARD').length,
      grade: list.length ? gradeFor(Math.round((list.reduce((s, e) => s + e.avg, 0) / list.length) * 100) / 100).letter : '—',
    }
  }).sort((a, b) => {
    const d = branchSort.dir === 'desc' ? -1 : 1
    const av = a[branchSort.key]
    const bv = b[branchSort.key]
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * d
    return String(av || '').localeCompare(String(bv || '')) * d
  })

  // Distribution (C) — PASS / WATCH / SUBSTANDARD
  const distData = [
    { name: 'Pass', value: passCount, color: CLASS_COLORS.PASS },
    { name: 'Watch', value: watchCount, color: CLASS_COLORS.WATCH },
    { name: 'Substandard', value: subCount, color: CLASS_COLORS.SUBSTANDARD },
  ].filter((d) => d.value > 0)

  // Score distribution (D) — configured grades
  const gradeDist = useMemo(() => {
    const map = {}
    visible.forEach((e) => { map[e.gradeLetter] = (map[e.gradeLetter] || 0) + 1 })
    return Object.entries(map)
      .map(([letter, count]) => ({ grade: letter, count }))
      .sort((a, b) => (a.grade < b.grade ? -1 : 1))
  }, [visible])

  // Target vs Actual (G)
  const targetVsActual = useMemo(() => {
    const byMetric = {}
    visibleRows.forEach((r) => {
      const key = r.metric_name || 'Metric'
      if (!byMetric[key]) byMetric[key] = { metric: key, target: 0, actual: 0, n: 0 }
      byMetric[key].target += Number(r.target_value) || 0
      byMetric[key].actual += Number(r.actual_value) || 0
      byMetric[key].n += 1
    })
    return Object.values(byMetric)
      .map((g) => ({ ...g, target: Math.round(g.target * 100) / 100, actual: Math.round(g.actual * 100) / 100 }))
      .slice(0, 8)
  }, [visibleRows])

  // Period trend (J)
  const trend = useMemo(() => {
    const by = {}
    results.forEach((r) => {
      const key = r.period_label || 'N/A'
      if (!by[key]) by[key] = { period: key, achev: 0, n: 0, count: 0, value: 0, countN: 0, valueN: 0 }
      by[key].achev += Number(r.achievement_pct) || 0
      by[key].n += 1
      const t = metricTypeLabel(r)
      if (t === 'value') { by[key].value += Number(r.actual_value) || 0; by[key].valueN += 1 }
      if (t === 'count') { by[key].count += Number(r.actual_value) || 0; by[key].countN += 1 }
    })
    return Object.values(by)
      .map((g) => ({ ...g, avgAchv: g.n ? Math.round(g.achev / g.n) : 0 }))
      .sort((a, b) => (a.period < b.period ? -1 : 1))
  }, [results])

  // Strong / Attention (K) — grounded in configured classification rules
  const strong = visible.filter((e) => e.cls === 'PASS').sort((a, b) => b.avg - a.avg).slice(0, 5)
  const attention = [...visible.filter((e) => e.cls === 'SUBSTANDARD'), ...visible.filter((e) => e.cls === 'WATCH')]
    .slice(0, 5)

  const kpiCards = [
    { label: 'Total Employees', value: totalEmp, sub: activeEmp ? `${activeEmp} active` : '—', icon: Users, color: '#009944', hasData: totalEmp > 0 },
    { label: 'Employees Assessed', value: assessed || 'Awaiting BankOne data', sub: `${visibleRows.length} result rows in view`, icon: LayoutDashboard, color: '#2563eb', hasData: assessed > 0 },
    { label: 'Avg Performance Score', value: assessed ? avgScore.toFixed(1) : 'Awaiting BankOne data', sub: 'weighted achievement %', icon: BrainCircuit, color: '#009944', hasData: assessed > 0 },
    { label: 'Pass', value: passCount || 0, sub: `Watch ${watchCount} · Substandard ${subCount}`, icon: BadgeCheck, color: CLASS_COLORS.PASS, },
    { label: 'Total Transactions', value: hasCounts ? txnCount : 'Awaiting BankOne data', sub: 'BankOne quantity metrics', icon: Calculator, color: '#2563eb', hasData: hasCounts && txnCount > 0 },
    { label: 'Total Financial Value', value: hasValues ? money(txnValue) : 'Awaiting BankOne data', sub: 'BankOne monetary metrics', icon: Building2, color: '#b8860b', hasData: hasValues && txnValue > 0 },
    { label: 'Meeting Target', value: meetsRows || 0, sub: `${belowRows} below target`, icon: Target, color: '#009944', hasData: visibleRows.length > 0 },
    { label: 'Total Case Load', value: caseTotal ? `${caseTotal} (${caseRate}% resolved)` : 'Awaiting BankOne data', sub: `${caseResolved} resolved`, icon: AlertTriangle, color: '#d97706', hasData: caseTotal > 0 },
  ]

  return (
    <div className="space-y-6">
      {/* ---------- A. FILTER / CONTROL BAR ---------- */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-[#009944]" />
          <h3 className="text-sm font-semibold text-slate-800">Filters & Controls</h3>
          <span className="text-xs text-slate-400">BankOne · Performance Intelligence</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Period</label>
            <select value={preset} onChange={(e) => setPreset(e.target.value)} className={inputCls}>
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="prevMonth">Previous Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>
          {preset === 'custom' && (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">From</label>
                <input type="date" className={inputCls} value={customRange.from} onChange={(e) => setCustomRange({ ...customRange, from: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">To</label>
                <input type="date" className={inputCls} value={customRange.to} onChange={(e) => setCustomRange({ ...customRange, to: e.target.value })} />
              </div>
            </>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Branch</label>
            <select value={branchF} onChange={(e) => setBranchF(e.target.value)} className={inputCls}>
              <option value="">All Branches</option>
              {branches.map((b) => (<option key={b} value={b}>{b}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Area</label>
            <select value={areaF} onChange={(e) => setAreaF(e.target.value)} className={inputCls}>
              <option value="">All Areas</option>
              {areas.map((a) => (<option key={a} value={a}>{a}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Department</label>
            <select value={deptF} onChange={(e) => setDeptF(e.target.value)} className={inputCls}>
              <option value="">All Departments</option>
              {depts.map((d) => (<option key={d} value={d}>{d}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Employee</label>
            <select value={empF} onChange={(e) => setEmpF(e.target.value)} className={inputCls}>
              <option value="">All Employees</option>
              {empChoices.map((e) => (<option key={e.id} value={e.id}>{e.name}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
            <select value={classF} onChange={(e) => setClassF(e.target.value)} className={inputCls}>
              <option value="">All</option>
              <option value="PASS">Pass</option>
              <option value="WATCH">Watch</option>
              <option value="SUBSTANDARD">Substandard</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button onClick={applyFilters} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Filter className="w-4 h-4" /> Apply Filters
          </button>
          <button onClick={resetFilters} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
            <RotateCcw className="w-4 h-4" /> Reset Filters
          </button>
          <div className="ml-auto flex items-center gap-2 print:hidden">
            <button onClick={exportCsv} disabled={!visibleRows.length} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40">
              <Download className="w-4 h-4" /> Export CSV
            </button>
            <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
              <Printer className="w-4 h-4" /> Print
            </button>
            <button onClick={onRefresh} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ---------- EMPTY STATE ---------- */}
      {assessed === 0 && empAgg.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 flex flex-col items-center text-center print:hidden">
          <BarChart3 className="w-14 h-14 text-slate-300 mb-4" />
          <h3 className="text-xl font-semibold text-slate-900">Performance Intelligence Awaiting Data</h3>
          <p className="text-sm text-slate-500 max-w-md mt-2">
            Import a BankOne performance export to populate this dashboard. Transaction, financial and
            case-load figures appear here once normalized records exist.
          </p>
          <button onClick={onImport} className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Download className="w-4 h-4" /> Import BankOne Data
          </button>
        </div>
      )}

      {assessed === 0 && empAgg.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800 flex items-start gap-3 print:hidden">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>No performance results for the selected period. Configure metrics & targets, then run a BankOne calculation — or adjust the period filter.</span>
        </div>
      )}

      {assessed > 0 && (
        <>
          {/* ---------- B. EXECUTIVE KPI CARDS ---------- */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {kpiCards.map((c) => (
              <div key={c.label} className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs font-medium text-slate-500">{c.label}</p>
                    <p className="text-xl font-bold mt-1" style={{ color: c.color }}>{c.value}</p>
                    <p className="text-xs text-slate-400 mt-1">{c.sub}</p>
                  </div>
                  <c.icon className="w-5 h-5 mt-1" style={{ color: c.color }} />
                </div>
              </div>
            ))}
          </div>

          {/* ---------- C & D. DISTRIBUTION CHARTS ---------- */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <h4 className="text-sm font-semibold text-slate-700">Performance Distribution</h4>
              <p className="text-xs text-slate-400 mb-2">Classification of assessed employees</p>
              {distData.length === 0 ? (
                <p className="text-sm text-slate-400 py-10 text-center">No classified employees for this view</p>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={210}>
                    <PieChart>
                      <Pie data={distData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={82} paddingAngle={2}>
                        {distData.map((d, i) => (<Cell key={i} fill={d.color} />))}
                      </Pie>
                      <Tooltip formatter={(v, n) => [`${v} employees`, n]} />
                      <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-3 gap-2 mt-1 text-center">
                    {distData.map((d) => (
                      <div key={d.name} className="rounded-lg bg-slate-50 p-2">
                        <p className="text-lg font-bold" style={{ color: d.color }}>{d.value}</p>
                        <p className="text-xs text-slate-500">{d.name}</p>
                        <p className="text-xs text-slate-400">{assessed ? Math.round((d.value / assessed) * 100) : 0}%</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <h4 className="text-sm font-semibold text-slate-700">Performance Score Distribution</h4>
              <p className="text-xs text-slate-400 mb-2">Configured grade bands (A–E) applied to weighted average scores</p>
              {gradeDist.length === 0 ? (
                <p className="text-sm text-slate-400 py-10 text-center">No grades yet</p>
              ) : (
                <ResponsiveContainer width="100%" height={210}>
                  <BarChart data={gradeDist} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="grade" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip formatter={(v, n) => [`${v} employees`, 'Grade count']} cursor={{ fill: '#f8fafc' }} />
                    <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                      {gradeDist.map((g, i) => (<Cell key={i} fill={g.grade === 'A' ? '#009944' : g.grade === 'E' ? '#dc2626' : '#38bdf8'} />))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* ---------- E. BRANCH PERFORMANCE TABLE ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100">
              <h4 className="text-sm font-semibold text-slate-700">Branch Performance</h4>
              <p className="text-xs text-slate-400 mt-0.5">Click a branch to filter the employee table below</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    {[
                      ['branch', 'Branch'], ['area', 'Area'], ['employees', 'Employees'], ['transactions', 'Transactions'],
                      ['value', 'Financial Value'], ['cases', 'Case Load'], ['avgScore', 'Avg Score'], ['pass', 'Pass'],
                      ['watch', 'Watch'], ['sub', 'Substandard'], ['grade', 'Grade'],
                    ].map(([k, h]) => (
                      <th key={h} onClick={() => setBranchSortKey(k)} className="px-4 py-3 font-medium whitespace-nowrap cursor-pointer hover:text-slate-700">
                        {h}{branchSort.key === k ? (branchSort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {branchData.map((b) => (
                    <tr key={b.branch} onClick={() => { setBranchDrill(b.branch); setBranchF(b.branch) }} className={`hover:bg-slate-50 cursor-pointer ${branchDrill === b.branch ? 'bg-[#009944]/5' : ''}`}>
                      <td className="px-4 py-3 font-medium text-slate-800 flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5 text-slate-400" />{b.branch}</td>
                      <td className="px-4 py-3 text-slate-600">{b.area || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{b.employees}</td>
                      <td className="px-4 py-3 text-slate-600">{b.transactions || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{b.value ? money(b.value) : '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{b.cases || '—'}</td>
                      <td className="px-4 py-3 font-medium">{b.avgScore.toFixed(1)}</td>
                      <td className="px-4 py-3 text-[#009944]">{b.pass}</td>
                      <td className="px-4 py-3 text-amber-600">{b.watch}</td>
                      <td className="px-4 py-3 text-rose-600">{b.sub}</td>
                      <td className="px-4 py-3 font-semibold">{b.grade}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---------- G & H. TARGET VS ACTUAL + FINANCIAL ---------- */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <h4 className="text-sm font-semibold text-slate-700">Target vs Actual</h4>
              <p className="text-xs text-slate-400 mb-2">Aggregated by configured metric for the selected period</p>
              {targetVsActual.length === 0 ? (
                <p className="text-sm text-slate-400 py-10 text-center">No metrics in this view</p>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={targetVsActual} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="metric" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => (v.length > 12 ? `${v.slice(0, 11)}…` : v)} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{ fill: '#f8fafc' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="target" name="Target" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="actual" name="Actual" fill="#009944" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <h4 className="text-sm font-semibold text-slate-700">Financial Value (NGN)</h4>
              <p className="text-xs text-slate-400 mb-2">BankOne monetary metrics per period</p>
              {!hasValues ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-slate-400">Awaiting BankOne monetary data</p>
                </div>
              ) : (
                <div className="space-y-3 mt-2">
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3">
                    <span className="text-sm text-slate-600">Total Financial Value</span>
                    <span className="text-lg font-bold text-[#b8860b]">{money(txnValue)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3">
                    <span className="text-sm text-slate-600">Avg per Employee</span>
                    <span className="text-lg font-bold text-slate-800">{assessed && hasValues ? money(txnValue / Math.max(visible.filter(e => e.hasValueMetric).length, 1)) : '—'}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3">
                    <span className="text-sm text-slate-600">Resolved Case Value</span>
                    <span className="text-lg font-bold text-slate-800">{caseMetrics?.resolvedValue ? money(caseMetrics.resolvedValue) : '—'}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ---------- F. EMPLOYEE PERFORMANCE TABLE ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold text-slate-700">Employee Performance</h4>
                <p className="text-xs text-slate-400 mt-0.5">Click an employee name to open their Employee 360 profile</p>
              </div>
              <span className="text-xs text-slate-400">{visible.length} employees · {visibleRows.length} rows</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    {[
                      ['name', 'Employee'], ['staffId', 'Employee ID'], ['dept', 'Department'], ['branch', 'Branch'], ['area', 'Area'], ['role', 'Role'],
                      ['txnCount', 'Transactions'], ['txnValue', 'Financial Value'], ['avg', 'Achievement %'], ['gradeLetter', 'Grade'], ['cls', 'Status'],
                    ].filter(Boolean).map(([k, label]) => (
                      <th key={label} onClick={() => setSort(k)} className="px-3 py-3 font-medium whitespace-nowrap cursor-pointer hover:text-slate-700">
                        {label}{sortKey === k ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sortEmployees(visible).slice(0, 100).map((e) => (
                    <tr key={e.employeeId} className="hover:bg-slate-50">
                      <td className="px-3 py-3 font-medium text-slate-800">
                        <a href={e.employeeId ? `#/employees/${e.employeeId}` : '#'} className="hover:text-[#009944] hover:underline">
                          <span className="inline-flex items-center gap-1.5"><BadgeCheck className="w-3.5 h-3.5 text-[#009944]" />{e.name}</span>
                        </a>
                      </td>
                      <td className="px-3 py-3 text-slate-500">{e.staffId || '—'}</td>
                      <td className="px-3 py-3 text-slate-600">{e.dept || '—'}</td>
                      <td className="px-3 py-3 text-slate-600">{e.branch || '—'}</td>
                      <td className="px-3 py-3 text-slate-600">{e.area || '—'}</td>
                      <td className="px-3 py-3 text-slate-600">{e.role || '—'}</td>
                      <td className="px-3 py-3 text-slate-600">{e.hasCountMetric ? e.txnCount : '—'}</td>
                      <td className="px-3 py-3 text-slate-600">{e.hasValueMetric ? money(e.txnValue) : '—'}</td>
                      <td className="px-3 py-3 font-medium text-[#009944]">{e.avg}%</td>
                      <td className="px-3 py-3 font-bold">{e.gradeLetter}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${e.cls === 'PASS' ? 'bg-[#009944]/10 text-[#009944]' : e.cls === 'WATCH' ? 'bg-amber-50 text-amber-600' : 'bg-rose-50 text-rose-600'}`}>
                          {e.cls}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---------- I. CASE LOAD / OPERATIONAL ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <h4 className="text-sm font-semibold text-slate-700">Case Load & Reconciliation</h4>
            <p className="text-xs text-slate-400 mb-3">From the existing reconciliation module</p>
            {caseTotal === 0 ? (
              <p className="text-sm text-slate-400 py-6 text-center">Awaiting BankOne reconciliation data</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Total Cases</p><p className="text-lg font-bold text-slate-800">{caseTotal}</p></div>
                <div className="rounded-lg bg-emerald-50 p-3"><p className="text-xs text-emerald-600">Resolved</p><p className="text-lg font-bold text-emerald-700">{caseResolved}</p></div>
                <div className="rounded-lg bg-sky-50 p-3"><p className="text-xs text-sky-600">Open / Pending</p><p className="text-lg font-bold text-sky-700">{caseTotal - caseResolved}</p></div>
                <div className="rounded-lg bg-[#009944]/10 p-3"><p className="text-xs text-[#009944]">Resolution Rate</p><p className="text-lg font-bold text-[#009944]">{caseRate}%</p></div>
                <div className="rounded-lg bg-amber-50 p-3"><p className="text-xs text-amber-600">Unresolved Value</p><p className="text-lg font-bold text-amber-700">{money(caseMetrics.unresolvedValue || 0)}</p></div>
              </div>
            )}
          </div>

          {/* ---------- J. PERFORMANCE TREND ---------- */}
          {trend.length > 1 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 print:hidden">
              <h4 className="text-sm font-semibold text-slate-700">Performance Trend</h4>
              <p className="text-xs text-slate-400 mb-3">Weighted average achievement across periods</p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trend} margin={{ top: 4, right: 16, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="period" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} domain={[0, 100]} />
                  <Tooltip cursor={{ stroke: '#cbd5e1' }} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="avgAchv" name="Avg Achievement %" stroke="#009944" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ---------- K. STRONG / ATTENTION ---------- */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <div className="flex items-center gap-2 mb-3">
                <BadgeCheck className="w-4 h-4 text-[#009944]" />
                <h4 className="text-sm font-semibold text-slate-700">Strong Performance</h4>
              </div>
              {strong.length === 0 ? (
                <p className="text-sm text-slate-400 py-6 text-center">No employees in the Pass band for this view</p>
              ) : (
                <div className="space-y-2">
                  {strong.map((e) => (
                    <div key={e.employeeId} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                      <span className="text-sm font-medium text-slate-700">{e.name}</span>
                      <span className="text-xs text-[#009944] font-semibold">{e.avg}% · {e.gradeLetter}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <h4 className="text-sm font-semibold text-slate-700">Attention Required</h4>
              </div>
              {attention.length === 0 ? (
                <p className="text-sm text-slate-400 py-6 text-center">No Watch / Substandard employees for this view</p>
              ) : (
                <div className="space-y-2">
                  {attention.map((e) => (
                    <div key={e.employeeId} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                      <span className="text-sm font-medium text-slate-700">{e.name}</span>
                      <span className={`text-xs font-semibold ${e.cls === 'SUBSTANDARD' ? 'text-rose-600' : 'text-amber-600'}`}>{e.cls} · {e.avg}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default function Performance() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('performance.manage')

  const [tab, setTab] = useState('dashboard')
  const [metrics, setMetrics] = useState([])
  const [results, setResults] = useState([])
  const [employees, setEmployees] = useState([])
  const [pConfig, setPConfig] = useState(null)
  const [caseMetrics, setCaseMetrics] = useState(null)
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
      try { setEmployees(await employeeService.list()) } catch { /* enrichment optional */ }
      try { setPConfig(await performanceConfigService.list()) } catch { /* config optional */ }
      try { setCaseMetrics(await reconciliationService.getDashboardMetrics({})) } catch { /* reconciliation optional */ }
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
          employees={employees}
          config={pConfig}
          caseMetrics={caseMetrics}
          onRefresh={load}
          onCalculate={() => setTab('calculate')}
          onImport={() => { window.location.hash = '#/bankone-imports' }}
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
