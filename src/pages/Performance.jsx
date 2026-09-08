import React, { useEffect, useState } from 'react'
import { Calculator, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { date, money, status } from './hrShared'
import { performanceService, PERFORMANCE_STATUS_LABELS, DEFAULT_GRADING_BANDS } from '../services/performanceService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function Performance() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('performance.manage')

  const [tab, setTab] = useState('metrics')
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

      <div className="flex gap-2 overflow-x-auto pb-3 mb-6">
        {[
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
