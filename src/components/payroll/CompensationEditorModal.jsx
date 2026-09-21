import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Plus, Trash2, X } from 'lucide-react'
import { payrollProfileService } from '../../services/payrollProfileService'
import { money } from '../../pages/hrShared'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

// Compensation editor for the Payroll Master (Payroll & BankOne).
//
// Single source of truth = the Phase 41 Salary Structure architecture
// (employee_salary_packages + employee_salary_snapshots via the shared
// _salary_breakdown engine). The modal only edits the SOURCE values
// (basic + allowance/deduction amounts); every derived total (gross, PAYE,
// pension, net, mid/end) is produced by the preview RPC using the same
// engine that the save path persists. A reason is mandatory — enforced
// server-side by upsert_employee_compensation.
//
// Role-based flow (Phase 66): super_admin and head_of_human_resources persist directly
// (super_admin is not audited; head_of_human_resources edits are). When signatureRequired
// (HR Officer), "Save" hands the payload to onNeedSignature so the parent can
// open the signature pad modal and only then persist with the signature.
export default function CompensationEditorModal({ employeeId, onClose, onSaved, signatureRequired = false, onNeedSignature }) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState(null)
  const [basic, setBasic] = useState('')
  const [allowances, setAllowances] = useState([])
  const [deductions, setDeductions] = useState([])
  const [newAllowance, setNewAllowance] = useState({ name: '', amount: '' })
  const [newDeduction, setNewDeduction] = useState({ name: '', amount: '' })
  const [overrides, setOverrides] = useState({ gross: '', net: '', mid: '', end: '' })
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewBusy, setPreviewBusy] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    payrollProfileService
      .getEmployeeCompensation(employeeId)
      .then((res) => {
        if (!active) return
        setData(res)
        setBasic(res.basic_monthly != null ? String(res.basic_monthly) : '')
        const activePkgs = (res.packages || []).filter((p) => p.active)
        setAllowances(
          activePkgs
            .filter((p) => p.component_type === 'allowance')
            .map((p) => ({ component_id: p.component_id, name: p.name, amount: String(p.amount ?? ''), category: p.category }))
        )
        setDeductions(
          activePkgs
            .filter((p) => p.component_type !== 'allowance')
            .map((p) => ({ component_id: p.component_id, name: p.name, amount: String(p.amount ?? '') }))
        )
        setPreview(res.snapshot && Object.keys(res.snapshot).length ? res.snapshot : null)
        setOverrides({
          gross: res.payroll_gross_override != null ? String(res.payroll_gross_override) : '',
          net: res.payroll_net_override != null ? String(res.payroll_net_override) : '',
          mid: res.payroll_mid_override != null ? String(res.payroll_mid_override) : '',
          end: res.payroll_end_override != null ? String(res.payroll_end_override) : '',
        })
      })
      .catch((e) => setError(e?.message || 'Unable to load compensation'))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [employeeId])

  const availableAllowanceNames = useMemo(() => {
    if (!data) return []
    const used = new Set((data.packages || []).filter((p) => p.component_type === 'allowance').map((p) => p.name))
    return [
      'Housing Allowance',
      'Transport Allowance',
      'Utility Allowance',
      'Meal Allowance',
      '13th Month',
      'Overtime Allowance',
      'Other Allowance',
    ].filter((n) => !used.has(n))
  }, [data])

  const availableDeductionNames = useMemo(() => {
    if (!data) return []
    const used = new Set((data.packages || []).filter((p) => p.component_type !== 'allowance').map((p) => p.name))
    return ['Loan Repayment', 'Cooperative Deduction', 'Salary Advance', 'Badge/Loss Recovery', 'Other Deduction'].filter((n) => !used.has(n))
  }, [data])

  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }

  const pushPreview = async () => {
    setPreviewBusy(true)
    try {
      const res = await payrollProfileService.previewCompensation({
        employeeId,
        basic: num(basic),
        allowances: allowances.map((a) => ({ component_id: a.component_id || null, name: a.name, amount: num(a.amount) })),
        deductions: deductions.map((d) => ({ component_id: d.component_id || null, name: d.name, amount: num(d.amount) })),
      })
      setPreview(res)
    } catch (e) {
      /* keep last good preview on transient failure */
    } finally {
      setPreviewBusy(false)
    }
  }

  const save = async () => {
    if (!reason.trim() || reason.trim().length < 5) {
      setError('A reason is required (at least 5 characters).')
      return
    }
    const payload = {
      employeeId,
      basic: num(basic),
      allowances: allowances.map((a) => ({ component_id: a.component_id || null, name: a.name, amount: num(a.amount), category: a.category || 'other' })),
      deductions: deductions.map((d) => ({ component_id: d.component_id || null, name: d.name, amount: num(d.amount) })),
      reason: reason.trim(),
      grossOverride: overrides.gross === '' ? null : num(overrides.gross),
      netOverride: overrides.net === '' ? null : num(overrides.net),
      midOverride: overrides.mid === '' ? null : num(overrides.mid),
      endOverride: overrides.end === '' ? null : num(overrides.end),
    }
    // HR Officer edits require a captured signature first (Phase 66).
    if (signatureRequired && typeof onNeedSignature === 'function') {
      onNeedSignature(payload)
      return
    }
    setBusy('save'); setError('')
    try {
      await payrollProfileService.upsertEmployeeCompensation(payload)
      onSaved()
      onClose()
    } catch (e) {
      setError(e?.message || 'Could not save compensation')
    } finally {
      setBusy('')
    }
  }

  const addRow = (type) => {
    const isAllow = type === 'allowance'
    const pending = isAllow ? newAllowance : newDeduction
    if (!pending.name.trim()) return
    const list = isAllow ? allowances : deductions
    if (list.some((r) => r.name === pending.name.trim())) return
    const updater = isAllow
      ? (next) => [...next, { name: pending.name.trim(), amount: pending.amount, category: 'other' }]
      : (next) => [...next, { name: pending.name.trim(), amount: pending.amount }]
    if (isAllow) setAllowances(updater(list)); else setDeductions(updater(list))
    if (isAllow) setNewAllowance({ name: '', amount: '' }); else setNewDeduction({ name: '', amount: '' })
  }

  const editRow = (type, index, field, value) => {
    if (type === 'allowance') {
      setAllowances((next) => next.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
    } else {
      setDeductions((next) => next.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
    }
  }

  const removeRow = (type, index) => {
    if (type === 'allowance') setAllowances((next) => next.filter((_, i) => i !== index))
    else setDeductions((next) => next.filter((_, i) => i !== index))
  }

  if (!employeeId) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-[#009944]/5 rounded-t-xl">
          <h3 className="text-lg font-semibold text-slate-900">
            Edit Compensation{data?.employee_name ? ` — ${data.employee_name}` : ''}
          </h3>
          <button onClick={onClose} disabled={busy === 'save'} className="text-slate-400 hover:text-slate-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <AlertTriangle className="w-4 h-4 mt-0.5" /> <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              {/* Basic salary (source of truth: employees.salary, monthly) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className={labelCls}>Basic (monthly)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className={inputCls}
                    value={basic}
                    onChange={(e) => setBasic(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Gross (derived)</label>
                  <div className="h-10 flex items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800">
                    {previewBusy ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" /> : money(preview?.gross_monthly)}
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Net pay (derived)</label>
                  <div className="h-10 flex items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-[#009944]">
                    {previewBusy ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" /> : money(preview?.net_monthly)}
                  </div>
                </div>
              </div>

              {/* Allowances */}
              <div className="rounded-lg border border-slate-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-slate-700">Allowances</h4>
                  <button
                    onClick={() => pushPreview()}
                    disabled={previewBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {previewBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Refresh derived totals
                  </button>
                </div>
                {allowances.length === 0 && <p className="text-xs text-slate-400 mb-3">No allowances allocated yet.</p>}
                <div className="space-y-2">
                  {allowances.map((a, i) => (
                    <div key={`${a.component_id || a.name}-${i}`} className="flex items-center gap-2">
                      <input className={`${inputCls} flex-1`} value={a.name} disabled />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Amount"
                        className={`${inputCls} w-40`}
                        value={a.amount}
                        onChange={(e) => editRow('allowance', i, 'amount', e.target.value)}
                      />
                      <button onClick={() => removeRow('allowance', i)} className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg" title="Remove"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <select className={`${inputCls} flex-1`} value={newAllowance.name} onChange={(e) => setNewAllowance({ ...newAllowance, name: e.target.value })}>
                    <option value="">Add allowance component…</option>
                    {availableAllowanceNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Amount"
                    className={`${inputCls} w-40`}
                    value={newAllowance.amount}
                    onChange={(e) => setNewAllowance({ ...newAllowance, amount: e.target.value })}
                  />
                  <button onClick={() => addRow('allowance')} disabled={!newAllowance.name.trim()} className="inline-flex items-center gap-1 px-3 h-10 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
                    <Plus className="w-4 h-4" /> Add
                  </button>
                </div>
              </div>

              {/* Deductions */}
              <div className="rounded-lg border border-slate-200 p-4">
                <h4 className="text-sm font-semibold text-slate-700 mb-3">Deductions (loan, cooperative, etc.)</h4>
                {deductions.length === 0 && <p className="text-xs text-slate-400 mb-3">No deduction components allocated yet.</p>}
                <div className="space-y-2">
                  {deductions.map((d, i) => (
                    <div key={`${d.component_id || d.name}-${i}`} className="flex items-center gap-2">
                      <input className={`${inputCls} flex-1`} value={d.name} disabled />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Amount"
                        className={`${inputCls} w-40`}
                        value={d.amount}
                        onChange={(e) => editRow('deduction', i, 'amount', e.target.value)}
                      />
                      <button onClick={() => removeRow('deduction', i)} className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg" title="Remove"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <select className={`${inputCls} flex-1`} value={newDeduction.name} onChange={(e) => setNewDeduction({ ...newDeduction, name: e.target.value })}>
                    <option value="">Add deduction component…</option>
                    {availableDeductionNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Amount"
                    className={`${inputCls} w-40`}
                    value={newDeduction.amount}
                    onChange={(e) => setNewDeduction({ ...newDeduction, amount: e.target.value })}
                  />
                  <button onClick={() => addRow('deduction')} disabled={!newDeduction.name.trim()} className="inline-flex items-center gap-1 px-3 h-10 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-40">
                    <Plus className="w-4 h-4" /> Add
                  </button>
                </div>
              </div>

              {/* Manual payroll outcomes (override engine-derived figures) */}
              <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-4">
                <h4 className="text-sm font-semibold text-slate-700 mb-1">Manual payroll outcomes (override)</h4>
                <p className="text-xs text-slate-400 mb-3">
                  Leave blank to keep the payroll engine&apos;s derived figures. When set, <span className="font-medium text-slate-500">Gross</span>,{' '}
                  <span className="font-medium text-slate-500">Net</span>, <span className="font-medium text-slate-500">Mid-month</span> and{' '}
                  <span className="font-medium text-slate-500">Month-end</span> are forced to these amounts in the Payroll Master and BankOne push.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ['Gross', 'gross', preview?.gross_monthly],
                    ['Net', 'net', preview?.net_monthly],
                    ['Mid-month', 'mid', preview?.mid_month],
                    ['Month-end', 'end', preview?.end_month],
                  ].map(([label, key, derived]) => (
                    <div key={key}>
                      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder={derived != null ? money(derived).replace('₦', '') : 'Auto'}
                        className={`${inputCls} ${overrides[key] !== '' ? 'border-violet-400 ring-1 ring-violet-200' : ''}`}
                        value={overrides[key]}
                        onChange={(e) => setOverrides((o) => ({ ...o, [key]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Derived summary */}
              {preview && Object.keys(preview).length ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4">
                  <h4 className="text-sm font-semibold text-slate-700 mb-3">Derived payroll totals (computed by the payroll engine)</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      ['Gross', preview.gross_monthly],
                      ['PAYE', preview.tax_paye],
                      ['Pension', preview.pension],
                      ['Other deductions', preview.other_deductions],
                      ['Total deductions', preview.deductions_total],
                      ['Net pay', preview.net_monthly],
                      ['Mid-month', preview.mid_month],
                      ['Month-end', preview.end_month],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg bg-white border border-slate-100 p-2.5">
                        <div className="text-[11px] text-slate-400">{label}</div>
                        <div className="text-sm font-semibold text-slate-800 mt-0.5">{money(value)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
                  No compensation configured yet — set a basic and any allowances to see the derived totals.
                </div>
              )}

              {/* Reason (mandatory) */}
              <div>
                <label className={labelCls}>Reason for change <span className="text-rose-500">*</span></label>
                <textarea
                  className="w-full rounded-lg border border-slate-300 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Cost-of-living adjustment effective this month"
                />
                <p className="text-xs text-slate-400 mt-1">Every compensation change is recorded in the audit log with this reason.</p>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button onClick={onClose} disabled={busy === 'save'} className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={busy === 'save'}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
                >
                  {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Save compensation
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}