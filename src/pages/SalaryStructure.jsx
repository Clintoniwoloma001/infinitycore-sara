import React, { useEffect, useState } from 'react'
import { Calculator, Loader2, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { payrollProfileService } from '../services/payrollProfileService'
import { formatCurrency, formatDate } from '../lib/utils'
import { ErrorState } from '../components/PageStates'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

// Salary structure editor — price items at the bank level, then allocate
// them per employee. The breakdown mirrors the payroll processor.
export default function SalaryStructure() {
  const [employees, setEmployees] = useState([])
  const [components, setComponents] = useState([])
  const [employeeId, setEmployeeId] = useState('')
  const [employee, setEmployee] = useState(null)
  const [packages, setPackages] = useState([])
  const [breakdown, setBreakdown] = useState(null)
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [compForm, setCompForm] = useState({ name: '', component_type: 'allowance', basis: 'percentage', rate: '', taxable: true, recurring: true, payment_schedule: 'both', category: 'other' })
  const [alloc, setAlloc] = useState({ component_id: '', amount: '', rate: '' })
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    Promise.all([
      supabase.from('employees').select('id, full_name, department, salary, basic_salary, salary_currency').eq('is_archived', false).order('full_name', { ascending: true }),
      payrollProfileService.listComponents(),
    ]).then(([empRes, comps]) => {
      if (empRes.error) throw empRes.error
      setEmployees(empRes.data || [])
      setComponents(comps || [])
      if (empRes.data?.[0] && !employeeId) setEmployeeId(empRes.data[0].id)
    }).catch((e) => setError(e?.message || 'Salary data could not be loaded.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!employeeId) { setEmployee(null); setPackages([]); setBreakdown(null); setSnapshots([]); return }
    let active = true
    const load = async () => {
      try {
        const emp = employees.find((e) => e.id === employeeId)
        if (active) setEmployee(emp || null)
        const [pkgs, snaps] = await Promise.all([
          payrollProfileService.listPackages(employeeId),
          payrollProfileService.listSnapshots(employeeId),
        ])
        if (active) { setPackages(pkgs || []); setSnapshots(snaps || []) }
      } catch (e) {
        if (active) setError(e?.message || 'Employee package could not be loaded.')
      }
    }
    load()
    return () => { active = false }
  }, [employeeId, employees])

  const saveComponent = async () => {
    if (!compForm.name.trim()) return
    setBusy('comp')
    setMsg('')
    try {
      await payrollProfileService.upsertComponent(compForm)
      setCompForm({ name: '', component_type: 'allowance', basis: 'percentage', rate: '', taxable: true, recurring: true, payment_schedule: 'both', category: 'other' })
      setComponents(await payrollProfileService.listComponents())
      setMsg('Salary component saved.')
    } catch (e) {
      setMsg(e?.message || 'Component could not be saved.')
    } finally {
      setBusy('')
    }
  }

  const assign = async () => {
    if (!employeeId || !alloc.component_id) return
    setBusy('assign')
    setMsg('')
    try {
      await payrollProfileService.assignComponent(employeeId, alloc.component_id, alloc.amount || null, alloc.rate || null)
      setAlloc({ component_id: '', amount: '', rate: '' })
      setPackages(await payrollProfileService.listPackages(employeeId))
      setMsg('Component allocated.')
    } catch (e) {
      setMsg(e?.message || 'Allocation failed.')
    } finally {
      setBusy('')
    }
  }

  const remove = async (componentId) => {
    setBusy('remove')
    setMsg('')
    try {
      await payrollProfileService.removeComponent(employeeId, componentId)
      setPackages(await payrollProfileService.listPackages(employeeId))
      setMsg('Component removed.')
    } catch (e) {
      setMsg(e?.message || 'Removal failed.')
    } finally {
      setBusy('')
    }
  }

  const calc = async () => {
    setBusy('calc')
    setMsg('')
    try {
      const res = await payrollProfileService.calculateBreakdown(employeeId)
      setBreakdown(res?.breakdown || null)
      setSnapshots(await payrollProfileService.listSnapshots(employeeId))
      if (!res?.breakdown) setMsg('No breakdown returned — check the employee base salary is set.')
    } catch (e) {
      setMsg(e?.message || 'Breakdown calculation failed.')
    } finally {
      setBusy('')
    }
  }

  const breakdownLines = breakdown
    ? [
        ['Gross monthly', breakdown.gross_salary || breakdown.gross || employee?.salary],
        ...(Object.entries(breakdown.components || {}).map(([k, v]) => [String(k).replace(/_/g, ' '), v])),
        ['Statutory deductions', breakdown.statutory_deductions || breakdown.deductions],
        ['Income tax (PAYE)', breakdown.tax || breakdown.paye],
        ['Net pay', breakdown.net_salary || breakdown.net],
      ]
    : []

  if (loading) return <div className="flex items-center justify-center py-20 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading salary structure…</div>

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Salary Structure</h1>
          <p className="text-sm text-slate-500 mt-1">Define salary components and calculate employee pay breakdowns (pension, consolidated relief, PAYE).</p>
        </div>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={inputCls + ' w-80'}>
          <option value="">Select employee…</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} — {e.department || 'No dept'}</option>)}
        </select>
      </div>

      {error && <ErrorState message={error} />}
      {msg && <div className={`rounded-lg px-4 py-2 text-sm ${msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail') ? 'bg-rose-50 text-rose-700 border border-rose-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'}`}>{msg}</div>}

      {!employeeId && <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-slate-400">Select an employee to view and configure their salary package.</div>}

      {!error && employeeId && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          {/* Employee base pay */}
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-bold text-slate-900 mb-4">Base pay</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between"><dt className="text-slate-400">Employee</dt><dd className="text-slate-800 font-medium">{employee?.full_name}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Department</dt><dd className="text-slate-800">{employee?.department || '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Monthly gross</dt><dd className="text-slate-800 font-semibold">{employee?.salary != null ? formatCurrency(employee.salary) : '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Basic salary</dt><dd className="text-slate-800">{employee?.basic_salary != null ? formatCurrency(employee.basic_salary) : '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-400">Currency</dt><dd className="text-slate-800">{employee?.salary_currency || 'NGN'}</dd></div>
            </dl>
            <button onClick={calc} disabled={busy === 'calc'} className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 text-white py-2.5 text-sm font-medium hover:bg-slate-700 disabled:opacity-50">
              {busy === 'calc' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calculator className="w-4 h-4" />} Calculate breakdown
            </button>
          </div>

          {/* Breakdown */}
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-bold text-slate-900 mb-4">Monthly breakdown</h2>
            {!breakdown ? (
              <p className="text-sm text-slate-400">Run the calculation to see gross, statutory deductions, tax and net pay.</p>
            ) : (
              <dl className="space-y-2 text-sm">
                {breakdownLines.filter(([, v]) => v != null).map(([k, v]) => (
                  <div key={k} className={`flex justify-between rounded-lg px-3 py-2 ${String(k).toLowerCase().includes('net') ? 'bg-emerald-50 text-emerald-800 font-semibold' : ''}`}>
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="text-slate-800">{typeof v === 'number' ? formatCurrency(v) : v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {snapshots.length > 0 && !breakdown && (
              <div className="mt-4">
                <p className="text-xs text-slate-400 mb-2">Previous snapshots</p>
                <div className="space-y-1.5">
                  {snapshots.slice(0, 3).map((s) => (
                    <div key={s.id} className="text-xs text-slate-500 flex justify-between border border-slate-100 rounded-lg px-3 py-2">
                      <span>{s.period_label || formatDate(s.calc_timestamp)}</span>
                      <span className="font-medium">{s.net_pay != null ? formatCurrency(s.net_pay) : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Package */}
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-bold text-slate-900 mb-4">Allocated components</h2>
            <div className="space-y-2 max-h-64 overflow-y-auto mb-4">
              {packages.length === 0 && <p className="text-sm text-slate-400">No components allocated yet.</p>}
              {packages.map((p) => (
                <div key={p.id} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-sm flex items-center justify-between">
                  <div>
                    <p className="font-medium text-slate-800">{p.payroll_salary_components?.name || 'Component'}</p>
                    <p className="text-xs text-slate-400">
                      {p.amount != null ? formatCurrency(p.amount) : `${p.rate ?? '—'}%`} · {p.payroll_salary_components?.basis || 'percentage'} {p.payroll_salary_components?.taxable === false ? '· non-taxable' : ''}
                    </p>
                  </div>
                  <button onClick={() => remove(p.component_id)} disabled={busy === 'remove'} className="text-slate-300 hover:text-rose-500 disabled:opacity-40"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <select className={inputCls} value={alloc.component_id} onChange={(e) => {
                const c = components.find((x) => x.id === e.target.value)
                setAlloc({ ...alloc, component_id: e.target.value, rate: c?.basis === 'amount' ? '' : alloc.rate })
              }}>
                <option value="">Add component…</option>
                {components.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2"><label className={labelCls}>Amount or rate</label><input className={inputCls} type="number" value={alloc.amount} placeholder="Amount" onChange={(e) => setAlloc({ ...alloc, amount: e.target.value })} /></div>
                <div><label className={labelCls}>Rate %</label><input className={inputCls} type="number" value={alloc.rate} onChange={(e) => setAlloc({ ...alloc, rate: e.target.value })} /></div>
              </div>
              <button onClick={assign} disabled={!alloc.component_id} className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#009944] text-white py-2.5 text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                {busy === 'assign' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Allocate
              </button>
            </div>
          </div>

          {/* Components catalog */}
          <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-base font-bold text-slate-900 mb-4">Component catalog</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-1 space-y-3">
                <div><label className={labelCls}>Name</label><input className={inputCls} value={compForm.name} onChange={(e) => setCompForm({ ...compForm, name: e.target.value })} placeholder="Housing allowance" /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={labelCls}>Type</label><select className={inputCls} value={compForm.component_type} onChange={(e) => setCompForm({ ...compForm, component_type: e.target.value })}>{['allowance', 'deduction', 'statutory', 'reimbursement'].map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
                  <div><label className={labelCls}>Basis</label><select className={inputCls} value={compForm.basis} onChange={(e) => setCompForm({ ...compForm, basis: e.target.value })}>{['percentage', 'amount', 'flat'].map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
                  <div><label className={labelCls}>Rate %</label><input className={inputCls} type="number" value={compForm.rate} onChange={(e) => setCompForm({ ...compForm, rate: e.target.value })} /></div>
                  <div><label className={labelCls}>Schedule</label><select className={inputCls} value={compForm.payment_schedule} onChange={(e) => setCompForm({ ...compForm, payment_schedule: e.target.value })}>{['mid', 'end', 'both'].map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" className="accent-[#009944]" checked={compForm.taxable} onChange={(e) => setCompForm({ ...compForm, taxable: e.target.checked })} /> Taxable</label>
                <button onClick={saveComponent} disabled={busy === 'comp' || !compForm.name.trim()} className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#009944] text-white py-2.5 text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {busy === 'comp' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Save component
                </button>
              </div>
              <div className="lg:col-span-2">
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {components.length === 0 && <p className="text-sm text-slate-400">No components defined. Add the first one.</p>}
                  {components.map((c) => (
                    <div key={c.id} className="rounded-lg border border-slate-100 px-3 py-2.5 text-sm flex items-center justify-between">
                      <div>
                        <p className="font-medium text-slate-800 inline-flex items-center gap-2">{c.name} <span className="text-xs font-normal text-slate-400">{c.component_type}</span></p>
                        <p className="text-xs text-slate-400">{c.basis} · rate {c.rate}%{c.taxable ? ' · taxable' : ' · non-taxable'} · {c.payment_schedule}{c.active ? '' : ' · inactive'}</p>
                      </div>
                      <span className="text-xs text-slate-400">{c.id === alloc.component_id ? 'selected' : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}