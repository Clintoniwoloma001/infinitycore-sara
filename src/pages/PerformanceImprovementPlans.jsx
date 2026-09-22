import React, { useEffect, useMemo, useState } from 'react'
import {
  Plus,
  X,
  Check,
  Loader2,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Calendar,
  Target,
  User,
  ChevronRight,
  Save,
  Trash2,
  ArrowRight,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../supabaseClient'
import pipService from '../services/pipService'
import { formatCurrency } from '../lib/utils'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'

const PIP_STATUS_META = {
  active: { label: 'Active', color: 'bg-blue-100 text-blue-700' },
  completed: { label: 'Completed', color: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'Cancelled', color: 'bg-slate-100 text-slate-600' },
}

const VERDICT_META = {
  upgrade: { label: 'Upgrade', icon: TrendingUp, color: 'text-emerald-700 bg-emerald-100' },
  downgrade: { label: 'Downgrade', icon: TrendingDown, color: 'text-rose-700 bg-rose-100' },
}

const inputCls = 'w-full h-11 rounded-xl border border-slate-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]/40 focus:border-[#009944] transition-all duration-200'
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1.5'

export default function PerformanceImprovementPlans() {
  const { user, role, isAdmin, isHR, name: userName } = useAuth()
  const canManage = isAdmin || isHR || ['super_admin', 'admin', 'head_of_human_resources', 'hr_officer'].includes(role)

  const [pips, setPips] = useState([])
  const [employees, setEmployees] = useState([])
  const [metrics, setMetrics] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const [showCreate, setShowCreate] = useState(false)
  const [selectedPipId, setSelectedPipId] = useState(null)
  const [trendData, setTrendData] = useState([])
  const [loadingTrend, setLoadingTrend] = useState(false)

  const [form, setForm] = useState({
    employeeId: '',
    periodMonths: 3,
    startDate: new Date().toISOString().split('T')[0],
    nextSteps: '',
    selectedMetricIds: [],
    targets: {},
  })

  const [verdictForm, setVerdictForm] = useState({
    verdict: '',
    reason: '',
    adjustments: [],
    signature: null,
  })

  const [showConfirm, setShowConfirm] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [pipRows, empRows, metricRows] = await Promise.all([
        pipService.list(),
        supabase
          .from('employees')
          .select('id, full_name, employee_code, position, department, branch, user_id')
          .not('user_id', 'is', null)
          .order('full_name', { ascending: true })
          .then((r) => {
            if (r.error) throw r.error
            return r.data || []
          }),
        pipService.listMetrics(true),
      ])
      setPips(pipRows)
      setEmployees(empRows)
      setMetrics(metricRows)
    } catch (e) {
      setError(e?.message || 'Failed to load PIPs')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const selectedPip = useMemo(() => pips.find((p) => p.id === selectedPipId), [pips, selectedPipId])

  useEffect(() => {
    if (!selectedPip) {
      setTrendData([])
      return
    }
    const fetchTrend = async () => {
      setLoadingTrend(true)
      try {
        const data = await pipService.getTrendData({ pip: selectedPip })
        setTrendData(data)
      } catch {
        setTrendData([])
      } finally {
        setLoadingTrend(false)
      }
    }
    fetchTrend()
  }, [selectedPip])

  const chartData = useMemo(() => {
    if (!trendData.length) return []
    const byPeriod = {}
    for (const r of trendData) {
      if (!byPeriod[r.period_label]) byPeriod[r.period_label] = { period: r.period_label }
      byPeriod[r.period_label][r.metric_name] = Number(r.actual_value)
      byPeriod[r.period_label][`${r.metric_name}_target`] = Number(r.target_value)
    }
    return Object.values(byPeriod).sort((a, b) => a.period.localeCompare(b.period))
  }, [trendData])

  const chartMetrics = useMemo(() => {
    if (!selectedPip?.metrics) return []
    return selectedPip.metrics.map((m) => m.metric_name)
  }, [selectedPip])

  const COLORS = ['#009944', '#2563eb', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2']

  const handleMetricToggle = (metricId) => {
    setForm((prev) => {
      const next = new Set(prev.selectedMetricIds)
      if (next.has(metricId)) {
        next.delete(metricId)
        const t = { ...prev.targets }
        delete t[metricId]
        return { ...prev, selectedMetricIds: [...next], targets: t }
      }
      next.add(metricId)
      const metric = metrics.find((m) => m.id === metricId)
      return {
        ...prev,
        selectedMetricIds: [...next],
        targets: { ...prev.targets, [metricId]: metric?.target_quantity || metric?.target_monetary_value || 0 },
      }
    })
  }

  const createPip = async () => {
    if (!form.employeeId || form.selectedMetricIds.length === 0) {
      setError('Select an employee and at least one metric.')
      return
    }
    setSaving(true)
    try {
      const metricPayload = form.selectedMetricIds.map((id) => ({
        metric_id: id,
        metric_name: metrics.find((m) => m.id === id)?.metric_name || '',
        target_value: Number(form.targets[id] || 0),
      }))
      await pipService.create({
        employeeId: form.employeeId,
        periodMonths: form.periodMonths,
        startDate: form.startDate,
        nextSteps: form.nextSteps,
        metrics: metricPayload,
        createdBy: user?.id,
      })
      setShowCreate(false)
      setForm({
        employeeId: '',
        periodMonths: 3,
        startDate: new Date().toISOString().split('T')[0],
        nextSteps: '',
        selectedMetricIds: [],
        targets: {},
      })
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to create PIP')
    } finally {
      setSaving(false)
    }
  }

  const addAdjustment = () => {
    setVerdictForm((prev) => ({
      ...prev,
      adjustments: [
        ...prev.adjustments,
        { id: crypto.randomUUID(), component_name: '', mode: 'manual', value: '', percent: '', achievement_pct: '', applyTo: 'single' },
      ],
    }))
  }

  const updateAdjustment = (id, patch) => {
    setVerdictForm((prev) => ({
      ...prev,
      adjustments: prev.adjustments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }))
  }

  const removeAdjustment = (id) => {
    setVerdictForm((prev) => ({
      ...prev,
      adjustments: prev.adjustments.filter((a) => a.id !== id),
    }))
  }

  const applyBulkToAll = (id) => {
    const source = verdictForm.adjustments.find((a) => a.id === id)
    if (!source) return
    setVerdictForm((prev) => ({
      ...prev,
      adjustments: prev.adjustments.map((a) =>
        a.id === id ? a : { ...a, mode: source.mode, value: source.value, percent: source.percent, achievement_pct: source.achievement_pct }
      ),
    }))
  }

  const applyVerdict = async () => {
    if (!selectedPip || !verdictForm.verdict || verdictForm.adjustments.length === 0) {
      setError('Select a verdict and at least one adjustment.')
      return
    }
    setSaving(true)
    try {
      await pipService.close(selectedPip.id, verdictForm.verdict, verdictForm.reason, userName)
      await pipService.applyAllowanceAdjustments({
        pipId: selectedPip.id,
        employeeId: selectedPip.employee_id,
        adjustments: verdictForm.adjustments,
        verdict: verdictForm.verdict,
        reason: verdictForm.reason,
        signature: verdictForm.signature,
        userName,
        actorRole: role,
      })
      setShowConfirm(false)
      setVerdictForm({ verdict: '', reason: '', adjustments: [], signature: null })
      await load()
      setSelectedPipId(null)
    } catch (e) {
      setError(e?.message || 'Failed to apply verdict')
    } finally {
      setSaving(false)
    }
  }

  const averageAchievement = useMemo(() => {
    if (!trendData.length) return null
    const total = trendData.reduce((sum, r) => sum + Number(r.achievement_pct || 0), 0)
    return Math.round((total / trendData.length) * 100) / 100
  }, [trendData])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Performance Improvement Plans</h2>
          <p className="text-sm text-slate-500 mt-1">Track underperforming or high-potential staff, set metric targets, and record verdict-driven allowance adjustments.</p>
        </div>
        {canManage && (
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] transition-all shadow-sm hover:shadow"
          >
            <Plus className="w-4 h-4" /> Add to PIP
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-[#009944]" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-4">
            {pips.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-400">
                No performance improvement plans yet.
              </div>
            ) : (
              pips.map((pip) => {
                const emp = pip.employee
                const meta = PIP_STATUS_META[pip.status]
                return (
                  <button
                    key={pip.id}
                    onClick={() => setSelectedPipId(pip.id)}
                    className={`w-full text-left rounded-2xl border p-4 transition-all hover:shadow-sm ${selectedPipId === pip.id ? 'border-[#009944] bg-[#009944]/5' : 'border-slate-200 bg-white'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-slate-900">{emp?.full_name || 'Unknown'}</p>
                        <p className="text-xs text-slate-500">{emp?.position || '—'} · {emp?.branch || '—'}</p>
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-1 rounded-full ${meta.color}`}>{meta.label}</span>
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {pip.period_months} mo</span>
                      <span className="flex items-center gap-1"><Target className="w-3 h-3" /> {pip.metrics?.length || 0} metrics</span>
                      {pip.verdict && (
                        <span className={`font-medium px-1.5 py-0.5 rounded ${VERDICT_META[pip.verdict].color}`}>
                          {VERDICT_META[pip.verdict].label}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })
            )}
          </div>

          <div className="lg:col-span-2">
            {!selectedPip ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center text-slate-400">
                Select a plan to view trend data and verdict options.
              </div>
            ) : (
              <div className="space-y-6">
                <div className="rounded-2xl border border-slate-200 bg-white p-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">{selectedPip.employee?.full_name}</h3>
                      <p className="text-sm text-slate-500">{selectedPip.employee?.position} · {selectedPip.employee?.department} · {selectedPip.employee?.branch}</p>
                    </div>
                    <button onClick={() => setSelectedPipId(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
                  </div>
                  <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="rounded-xl bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Status</p>
                      <p className="text-sm font-semibold text-slate-900">{PIP_STATUS_META[selectedPip.status].label}</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Period</p>
                      <p className="text-sm font-semibold text-slate-900">{selectedPip.period_months} months</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Start / End</p>
                      <p className="text-sm font-semibold text-slate-900">{selectedPip.start_date} → {selectedPip.end_date}</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Avg Achievement</p>
                      <p className="text-sm font-semibold text-slate-900">{averageAchievement ?? '—'}%</p>
                    </div>
                  </div>
                  {selectedPip.next_steps && (
                    <div className="mt-4 rounded-xl bg-amber-50 border border-amber-100 p-3 text-sm text-amber-800">
                      <span className="font-semibold">Next steps:</span> {selectedPip.next_steps}
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-6">
                  <h4 className="text-sm font-semibold text-slate-900 mb-4">Performance Trend</h4>
                  {loadingTrend ? (
                    <div className="h-64 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-[#009944]" /></div>
                  ) : chartData.length === 0 ? (
                    <div className="h-64 flex items-center justify-center text-slate-400 text-sm">No historical metric data for this period.</div>
                  ) : (
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="period" tick={{ fontSize: 12 }} />
                          <YAxis tick={{ fontSize: 12 }} />
                          <Tooltip />
                          <Legend />
                          {chartMetrics.map((name, i) => (
                            <Line
                              key={name}
                              type="monotone"
                              dataKey={name}
                              name={name}
                              stroke={COLORS[i % COLORS.length]}
                              strokeWidth={2}
                              dot={false}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-6">
                  <h4 className="text-sm font-semibold text-slate-900 mb-4">Metric Breakdown</h4>
                  {selectedPip.metrics?.length === 0 ? (
                    <p className="text-sm text-slate-400">No metrics selected.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 text-left">
                          <tr>
                            <th className="px-4 py-3 font-medium">Metric</th>
                            <th className="px-4 py-3 font-medium">Target</th>
                            <th className="px-4 py-3 font-medium">Latest Actual</th>
                            <th className="px-4 py-3 font-medium">Achievement</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {selectedPip.metrics.map((m) => {
                            const latest = trendData
                              .filter((r) => r.metric_id === m.metric_id)
                              .sort((a, b) => b.period_start.localeCompare(a.period_start))[0]
                            return (
                              <tr key={m.id}>
                                <td className="px-4 py-3 font-medium text-slate-800">{m.metric_name}</td>
                                <td className="px-4 py-3 text-slate-600">{m.target_value}</td>
                                <td className="px-4 py-3 text-slate-600">{latest ? latest.actual_value : '—'}</td>
                                <td className="px-4 py-3">
                                  {latest ? (
                                    <span className={`font-semibold ${Number(latest.achievement_pct) >= 100 ? 'text-emerald-600' : 'text-amber-600'}`}>
                                      {latest.achievement_pct}%
                                    </span>
                                  ) : '—'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {canManage && selectedPip.status === 'active' && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-6">
                    <h4 className="text-sm font-semibold text-slate-900 mb-4">Verdict & Allowance Adjustment</h4>
                    <div className="space-y-5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className={labelCls}>Verdict</label>
                          <select
                            className={inputCls}
                            value={verdictForm.verdict}
                            onChange={(e) => setVerdictForm({ ...verdictForm, verdict: e.target.value })}
                          >
                            <option value="">Select verdict…</option>
                            <option value="upgrade">Upgrade</option>
                            <option value="downgrade">Downgrade</option>
                          </select>
                        </div>
                        <div>
                          <label className={labelCls}>Reason</label>
                          <input
                            type="text"
                            className={inputCls}
                            value={verdictForm.reason}
                            onChange={(e) => setVerdictForm({ ...verdictForm, reason: e.target.value })}
                            placeholder="Reason for adjustment"
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className={labelCls}>Allowance Adjustments</label>
                          <button
                            onClick={addAdjustment}
                            className="text-xs font-medium text-[#009944] hover:text-[#007a36] flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add row
                          </button>
                        </div>
                        {verdictForm.adjustments.length === 0 && (
                          <p className="text-sm text-slate-400">No adjustments configured.</p>
                        )}
                        {verdictForm.adjustments.map((adj, idx) => (
                          <div key={adj.id} className="grid grid-cols-12 gap-3 items-end mb-3">
                            <div className="col-span-3">
                              <label className={labelCls}>Component</label>
                              <input
                                type="text"
                                className={inputCls}
                                value={adj.component_name}
                                onChange={(e) => updateAdjustment(adj.id, { component_name: e.target.value })}
                                placeholder="e.g. Transport"
                              />
                            </div>
                            <div className="col-span-3">
                              <label className={labelCls}>Mode</label>
                              <select
                                className={inputCls}
                                value={adj.mode}
                                onChange={(e) => updateAdjustment(adj.id, { mode: e.target.value })}
                              >
                                <option value="manual">Manual value</option>
                                <option value="percent_achievement">% of achievement</option>
                                <option value="percent_previous">% of previous</option>
                              </select>
                            </div>
                            {adj.mode === 'manual' ? (
                              <div className="col-span-3">
                                <label className={labelCls}>New value</label>
                                <input
                                  type="number"
                                  className={inputCls}
                                  value={adj.value}
                                  onChange={(e) => updateAdjustment(adj.id, { value: e.target.value })}
                                />
                              </div>
                            ) : (
                              <>
                                <div className="col-span-2">
                                  <label className={labelCls}>%</label>
                                  <input
                                    type="number"
                                    className={inputCls}
                                    value={adj.percent}
                                    onChange={(e) => updateAdjustment(adj.id, { percent: e.target.value })}
                                  />
                                </div>
                                {adj.mode === 'percent_achievement' && (
                                  <div className="col-span-2">
                                    <label className={labelCls}>Achv %</label>
                                    <input
                                      type="number"
                                      className={inputCls}
                                      value={adj.achievement_pct}
                                      onChange={(e) => updateAdjustment(adj.id, { achievement_pct: e.target.value })}
                                    />
                                  </div>
                                )}
                                {adj.mode === 'percent_previous' && <div className="col-span-2" />}
                              </>
                            )}
                            <div className="col-span-2 flex items-center gap-2">
                              <button
                                onClick={() => applyBulkToAll(adj.id)}
                                title="Apply this row's calculation to all rows"
                                className="text-xs text-[#009944] hover:text-[#007a36] px-2 py-2 rounded-lg border border-slate-200 hover:border-[#009944]/40"
                              >
                                Bulk
                              </button>
                              <button
                                onClick={() => removeAdjustment(adj.id)}
                                className="p-2 rounded-lg text-rose-500 hover:bg-rose-50"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="flex justify-end">
                        <button
                          onClick={() => setShowConfirm(true)}
                          disabled={!verdictForm.verdict || verdictForm.adjustments.length === 0}
                          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50 transition-all shadow-sm hover:shadow"
                        >
                          <Save className="w-4 h-4" /> Apply Verdict
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {selectedPip.verdict && (
                  <div className={`rounded-2xl border p-6 ${selectedPip.verdict === 'upgrade' ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
                    <div className="flex items-center gap-3">
                      {React.createElement(VERDICT_META[selectedPip.verdict].icon, { className: 'w-5 h-5' })}
                      <div>
                        <p className="font-semibold text-slate-900">Verdict: {VERDICT_META[selectedPip.verdict].label}</p>
                        <p className="text-sm text-slate-600">Recorded {selectedPip.verdict_at ? new Date(selectedPip.verdict_at).toLocaleString() : '—'}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="relative bg-white rounded-2xl w-full max-w-2xl shadow-2xl p-6 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Add Employee to PIP</h3>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-5">
              <div>
                <label className={labelCls}>Employee</label>
                <select
                  className={inputCls}
                  value={form.employeeId}
                  onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
                >
                  <option value="">Select employee…</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.full_name} · {emp.position || '—'}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Period (months)</label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    className={inputCls}
                    value={form.periodMonths}
                    onChange={(e) => setForm({ ...form, periodMonths: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls}>Start date</label>
                  <input
                    type="date"
                    className={inputCls}
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <label className={labelCls}>Next steps</label>
                <textarea
                  rows={3}
                  className={`${inputCls} h-auto py-3`}
                  value={form.nextSteps}
                  onChange={(e) => setForm({ ...form, nextSteps: e.target.value })}
                  placeholder="What actions will the employee take to improve?"
                />
              </div>
              <div>
                <label className={labelCls}>Metrics</label>
                <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 max-h-60 overflow-y-auto">
                  {metrics.map((m) => {
                    const selected = form.selectedMetricIds.includes(m.id)
                    return (
                      <label key={m.id} className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${selected ? 'bg-[#009944]/5' : 'hover:bg-slate-50'}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => handleMetricToggle(m.id)}
                          className="w-4 h-4 text-[#009944] rounded border-slate-300"
                        />
                        <span className="text-sm text-slate-700 flex-1">{m.metric_name}</span>
                        {selected && (
                          <input
                            type="number"
                            className={`${inputCls} w-24 h-8`}
                            value={form.targets[m.id]}
                            onChange={(e) => setForm({ ...form, targets: { ...form.targets, [m.id]: e.target.value } })}
                            placeholder="Target"
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-xl border border-slate-300 text-sm text-slate-600 hover:bg-white">Cancel</button>
              <button
                onClick={createPip}
                disabled={saving || !form.employeeId || form.selectedMetricIds.length === 0}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Create PIP
              </button>
            </div>
          </div>
        </div>
      )}

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="relative bg-white rounded-2xl w-full max-w-md shadow-2xl p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Apply verdict?</h3>
            <p className="text-sm text-slate-600 mb-5">
              This will update the employee's real compensation and close the PIP. {verdictForm.adjustments.length} adjustment(s) will be applied.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowConfirm(false)} className="px-4 py-2 rounded-xl border border-slate-300 text-sm text-slate-600 hover:bg-white">Cancel</button>
              <button
                onClick={applyVerdict}
                disabled={saving}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Confirm & Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
