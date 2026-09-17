import React, { useState } from 'react'
import { AlertTriangle, CalendarDays, Loader2, ShieldCheck, X } from 'lucide-react'
import { employeeLabel } from '../services/terminationAuthorization'
import { date } from '../pages/hrShared'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500/40'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const COMMON_REASONS = [
  'Misconduct / gross misconduct',
  'Poor performance',
  'Redundancy / organizational restructuring',
  'Absenteeism / abandonment of duty',
  'End of probation',
  'Gross insubordination',
  'Fraud / financial impropriety',
  'Expiry of contract',
  'Voluntary-initiated separation (approved as involuntary)',
  'Other (please specify above)',
]

// Serious confirmation modal for employee termination. The ONLY way the
// UI invokes termination; the server still re-verifies the actor role.
export default function TerminationModal({ employee, onClose, onConfirm, busy, error }) {
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [rehireEligible, setRehireEligible] = useState('true')
  const [confirmed, setConfirmed] = useState(false)

  const minDate = employee?.hire_date ? employee.hire_date.slice(0, 10) : null
  const reasonInvalid = !reason.trim()
  const ready = Boolean(effectiveDate && reason.trim() && confirmed && !busy)

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-rose-50 rounded-t-xl">
          <h3 className="text-lg font-semibold text-rose-900 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-rose-600" /> Terminate Employee
          </h3>
          <button onClick={onClose} disabled={busy} className="text-rose-400 hover:text-rose-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
            This action is restricted to <span className="font-semibold">super_admin</span> and <span className="font-semibold">hr_manager</span> roles only. Your identity is verified server-side — the record is never deleted and full history is preserved.
          </div>

          {/* Employee details */}
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <Field label="Employee Name" value={employee?.full_name} />
            <Field label="Employee ID" value={employeeLabel(employee)} />
            <Field label="Department" value={employee?.department} />
            <Field label="Designation" value={employee?.position} />
            <Field label="Branch" value={employee?.branch} />
            <Field label="Current Employment Status" value={employee?.employment_status} />
            <Field label="Date Employed" value={date(employee?.hire_date)} />
            <Field label="ID Card Status" value={employee?.confirmation_status || employee?.staff_id_status || '—'} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Termination Effective Date *</label>
              <input type="date" className={inputCls} value={effectiveDate}
                min={minDate || undefined}
                onChange={(e) => setEffectiveDate(e.target.value)} disabled={busy} />
              {minDate && effectiveDate < minDate && (
                <p className="text-xs text-rose-600 mt-1">Cannot precede hire date ({date(employee?.hire_date)}).</p>
              )}
            </div>
            <div>
              <label className={labelCls}>Rehire Eligibility</label>
              <select className={inputCls} value={rehireEligible}
                onChange={(e) => setRehireEligible(e.target.value)} disabled={busy}>
                <option value="true">Eligible for rehire</option>
                <option value="false">Not eligible for rehire</option>
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>Termination Reason *</label>
            <select className={inputCls} value={reason}
              onChange={(e) => setReason(e.target.value)} disabled={busy}>
              <option value="">Select or type a reason…</option>
              {COMMON_REASONS.filter((r) => !r.startsWith('Other')).map((r) => <option key={r} value={r}>{r}</option>)}
              <option value="__other">Other (type below)…</option>
            </select>
            {reason === '__other' && (
              <input className={`${inputCls} mt-2`} placeholder="Specify reason…"
                onChange={(e) => setReason(e.target.value)} value={reason === '__other' ? '' : reason} disabled={busy} />
            )}
            {reasonInvalid && <p className="text-xs text-rose-600 mt-1">A termination reason is required.</p>}
          </div>

          <div>
            <label className={labelCls}>HR Notes</label>
            <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500/40"
              rows={3} value={notes} placeholder="Supporting details for the HR audit record…"
              onChange={(e) => setNotes(e.target.value)} disabled={busy} />
          </div>

          <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)} disabled={busy}
              className="mt-0.5 w-4 h-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500" />
            <span>
              I understand this <span className="font-semibold">terminates</span> the employee's employment, changes their status to <span className="font-semibold">terminated</span>, and creates an immutable HR audit record. No payroll, attendance, leave, performance, onboarding, or document history is deleted.
            </span>
          </label>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} disabled={busy}
              className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            <button
              onClick={() => onConfirm({ effectiveDate, reason, notes, rehireEligible: rehireEligible === 'true' })}
              disabled={!ready}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarDays className="w-4 h-4" />} Terminate Employee
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-sm font-medium text-slate-800 truncate">{value || '—'}</div>
    </div>
  )
}