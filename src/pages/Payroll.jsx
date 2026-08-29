import React, { useEffect, useState } from 'react'
import { Calculator, Check, Loader2, Plus, Settings, Sliders, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { date, money, status } from './hrShared'
import { payrollService } from '../services/payrollService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const EMPTY_ITEMS = []

export default function Payroll() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('payroll.manage')

  const [periods, setPeriods] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const [items, setItems] = useState(EMPTY_ITEMS)
  const [itemsLoading, setItemsLoading] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [view, setView] = useState('periods') // periods | settings
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({})
  const [config, setConfig] = useState(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await payrollService.listPeriods()
      setPeriods(data)
      if (selected) {
        const fresh = data.find((p) => p.id === selected.id)
        if (fresh) setSelected(fresh)
      }
    } catch (e) {
      setError(e?.message || 'Unable to load payroll periods')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const selectPeriod = async (period) => {
    setSelected(period)
    setItemsLoading(true)
    try {
      const data = await payrollService.itemsForPeriod(period.period_label)
      setItems(data)
    } catch {
      setItems(EMPTY_ITEMS)
    } finally {
      setItemsLoading(false)
    }
  }

  const loadConfig = async () => {
    const cfg = await payrollService.getConfig()
    setConfig(cfg ? { ...cfg, configText: JSON.stringify(cfg.config, null, 2) } : { configText: '{}' })
  }

  useEffect(() => {
    if (view === 'settings') loadConfig()
  }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setError('')
    try {
      const p = await payrollService.createPeriod({
        periodLabel: createForm.period_label,
        startDate: createForm.start_date,
        endDate: createForm.end_date,
        notes: createForm.notes,
      })
      setShowCreate(false)
      setCreateForm({})
      await load()
      await selectPeriod(p)
    } catch (e) {
      setError(e?.message || 'Failed to create period')
    }
  }

  const compute = async (period) => {
    setBusyId(period.id)
    setError('')
    try {
      const res = await payrollService.compute(period.id)
      await load()
      await selectPeriod({ ...period, status: 'calculated' })
      setError(`Calculated ${res.rows} payroll rows for ${res.period}.`)
    } catch (e) {
      setError(e?.message || 'Calculation failed')
    } finally {
      setBusyId('')
    }
  }

  const advance = async (period, next) => {
    setBusyId(period.id)
    setError('')
    try {
      const updated = await payrollService.advance(period, next)
      await load()
      setSelected(updated || period)
      if (updated) {
        const data = await payrollService.itemsForPeriod(updated.period_label)
        setItems(data)
      }
    } catch (e) {
      setError(e?.message || 'Transition failed')
    } finally {
      setBusyId('')
    }
  }

  const saveConfig = async () => {
    setError('')
    try {
      const parsed = JSON.parse(config.configText)
      await payrollService.updateConfig(parsed)
      await loadConfig()
      setError('Payroll settings saved.')
    } catch (e) {
      setError(e?.message || 'Invalid JSON or save failed')
    }
  }

  const totals = items.reduce((acc, r) => ({
    salary: acc.salary + Number(r.salary || 0),
    allowances: acc.allowances + Number(r.allowances || 0),
    deductions: acc.deductions + Number(r.deductions || 0),
    net: acc.net + Number(r.net_pay ?? (Number(r.salary || 0) + Number(r.allowances || 0) - Number(r.deductions || 0))),
    tax: acc.tax + Number(r.tax_paye || 0),
    pension: acc.pension + Number(r.pension_deduction || 0),
  }), { salary: 0, allowances: 0, deductions: 0, net: 0, tax: 0, pension: 0 })

  const canCancel = !['paid', 'cancelled'].includes(selected?.status)

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Payroll</h2>
          <p className="text-sm text-slate-500 mt-1">Period-driven payroll: draft → calculated → review → approved → processed → paid.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setView('settings')} className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm ${view === 'settings' ? 'border-[#009944] text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
            <Settings className="w-4 h-4" /> Settings
          </button>
          <button onClick={() => setView('periods')} className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm ${view === 'periods' ? 'border-[#009944] text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
            <Sliders className="w-4 h-4" /> Periods
          </button>
          {canManage && (
            <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <Plus className="w-4 h-4" /> New Period
            </button>
          )}
        </div>
      </div>

      {error && <div className="mb-5 text-sm text-slate-700"><ErrorState message={error} /></div>}

      {view === 'settings' && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 max-w-2xl">
          <h3 className="font-semibold text-slate-900 mb-1">Payroll calculation settings</h3>
          <p className="text-sm text-slate-500 mb-4">Annual tax bands (NGN consolidated relief), pension rates, and default other deductions.</p>
          {!config && <LoadingState label="Loading settings..." />}
          {config && (
            <>
              <textarea
                className="w-full rounded-lg border border-slate-300 p-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#009944]"
                rows={14}
                value={config.configText}
                readOnly={!canManage}
                onChange={(e) => setConfig({ ...config, configText: e.target.value })}
              />
              {canManage ? (
                <button onClick={saveConfig} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
                  <Check className="w-4 h-4" /> Save settings
                </button>
              ) : (
                <p className="mt-4 text-sm text-slate-400">Only admins can modify payroll settings.</p>
              )}
            </>
          )}
        </div>
      )}

      {view === 'periods' && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1">
              {loading && <LoadingState label="Loading periods..." />}
              {!loading && error && <ErrorState message={error} />}
              {!loading && !error && periods.length === 0 && <EmptyState title="No payroll periods" description="Create a period to get started." />}
              {!loading && periods.length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 divide-y divide-slate-100">
                  {periods.map((p) => (
                    <button key={p.id} onClick={() => selectPeriod(p)} className={`w-full text-left px-4 py-3 hover:bg-slate-50 ${selected?.id === p.id ? 'bg-emerald-50' : ''}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-800">{p.period_label}</span>
                        {status(p.status)}
                      </div>
                      <div className="text-xs text-slate-400 mt-1">{p.start_date ? `${date(p.start_date)} → ${date(p.end_date)}` : 'No dates set'}</div>
                      {busyId === p.id && <div className="text-xs text-[#009944] mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Working...</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-2 space-y-6">
              {!selected && <EmptyState title="Select a period" description="Choose a period on the left to see its payroll items and actions." />}

              {selected && (
                <>
                  <div className="bg-white rounded-lg border border-slate-200 p-5">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                      <div>
                        <h3 className="font-semibold text-slate-900">{selected.period_label}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{selected.start_date ? `${date(selected.start_date)} → ${date(selected.end_date)}` : 'Custom'}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {selected.status === 'draft' && canManage && (
                          <button onClick={() => compute(selected)} disabled={busyId === selected.id} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                            <Calculator className="w-4 h-4" /> Calculate
                          </button>
                        )}
                        {selected.status === 'calculated' && canManage && (
                          <button onClick={() => advance(selected, 'review')} disabled={busyId === selected.id} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">Send to Review</button>
                        )}
                        {selected.status === 'review' && canManage && (
                          <button onClick={() => advance(selected, 'approved')} disabled={busyId === selected.id} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-60">
                            <Check className="w-4 h-4" /> Approve
                          </button>
                        )}
                        {selected.status === 'approved' && canManage && (
                          <button onClick={() => advance(selected, 'processed')} disabled={busyId === selected.id} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-60">Mark Processed</button>
                        )}
                        {(selected.status === 'approved' || selected.status === 'processed') && canManage && (
                          <button onClick={() => advance(selected, 'paid')} disabled={busyId === selected.id} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-60">Mark Paid</button>
                        )}
                        {canCancel && canManage && (
                          <button onClick={() => advance(selected, 'cancelled')} disabled={busyId === selected.id} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-300 text-rose-600 text-sm font-medium hover:bg-rose-50 disabled:opacity-60">Cancel</button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {[
                        { label: 'Items', value: items.length },
                        { label: 'Gross', value: money(totals.salary + totals.allowances) },
                        { label: 'Tax (PAYE)', value: money(totals.tax) },
                        { label: 'Pension', value: money(totals.pension) },
                        { label: 'Total Deductions', value: money(totals.deductions) },
                        { label: 'Net Pay', value: money(totals.net) },
                      ].map((s) => (
                        <div key={s.label} className="rounded-lg bg-slate-50 p-3">
                          <div className="text-xs text-slate-400">{s.label}</div>
                          <div className="text-sm font-medium text-slate-800 mt-0.5">{s.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {itemsLoading && <LoadingState label="Loading payroll items..." />}
                  {!itemsLoading && items.length === 0 && <EmptyState title="No items yet" description="Run Calculate to generate payroll rows for this period." />}
                  {!itemsLoading && items.length > 0 && (
                    <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 text-left">
                          <tr>
                            <th className="px-5 py-3 font-medium">Employee</th>
                            <th className="px-5 py-3 font-medium">Salary</th>
                            <th className="px-5 py-3 font-medium">Allow.</th>
                            <th className="px-5 py-3 font-medium">Tax</th>
                            <th className="px-5 py-3 font-medium">Pension</th>
                            <th className="px-5 py-3 font-medium">Deductions</th>
                            <th className="px-5 py-3 font-medium">Net Pay</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {items.map((r) => (
                            <tr key={r.id} className="hover:bg-slate-50">
                              <td className="px-5 py-3">
                                <div className="font-medium text-slate-900">{r.employee_name}</div>
                                <div className="text-xs text-slate-400">{status(r.status)}</div>
                              </td>
                              <td className="px-5 py-3">{money(r.salary)}</td>
                              <td className="px-5 py-3">{money(r.allowances)}</td>
                              <td className="px-5 py-3">{money(r.tax_paye)}</td>
                              <td className="px-5 py-3">{money(r.pension_deduction)}</td>
                              <td className="px-5 py-3">{money(r.deductions)}</td>
                              <td className="px-5 py-3 font-medium">{money(r.net_pay)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">New Payroll Period</h3>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div><label className={labelCls}>Period Label (e.g. Aug 2026) *</label><input className={inputCls} value={createForm.period_label || ''} onChange={(e) => setCreateForm({ ...createForm, period_label: e.target.value })} placeholder="Sep 2026" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Start Date</label><input type="date" className={inputCls} value={createForm.start_date || ''} onChange={(e) => setCreateForm({ ...createForm, start_date: e.target.value })} /></div>
                <div><label className={labelCls}>End Date</label><input type="date" className={inputCls} value={createForm.end_date || ''} onChange={(e) => setCreateForm({ ...createForm, end_date: e.target.value })} /></div>
              </div>
              <div><label className={labelCls}>Notes</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={createForm.notes || ''} onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })} /></div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={create} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">Create</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}