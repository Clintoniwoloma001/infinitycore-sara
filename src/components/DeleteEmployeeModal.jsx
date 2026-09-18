import React, { useState } from 'react'
import { AlertTriangle, Loader2, ShieldCheck, X } from 'lucide-react'
import { date } from '../pages/hrShared'

const labelCls = 'block text-xs font-medium text-slate-600 mb-1.5'
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500/40'

// ============================================================================
// DeleteEmployeeModal
// ----------------------------------------------------------------------------
// "Delete" in InfinityCore maps to the canonical decommission path
// (there is deliberately NO physical employee row deletion: employees has a
// hard-delete guard trigger + cascade children that preserve history, and
// phase37/39 RPCs verify the actor role server-side as SECURITY DEFINER).
//
// Deleting an employee therefore:
//   - Requires the SAME authorization as every other personnel-lifecycle
//     action (super_admin / hr_manager only — see terminationAuthorization.js,
//     the single source of truth referenced by useAuth.canTerminate/
//     canArchive/canDelete).
//   - Archives the employee (history preserved, audited), cancels any open
//     payroll rows and drops them from the active roster, and deactivates
//     the linked platform login so the person can no longer use InfinityCore.
//   - NEVER runs a physical row delete and NEVER destroys banking/attendance/
//     payroll history.
//   - Can NEVER target a Super Admin account — protected server-side.
//   - Asks for an explicit typed confirmation ("DELETE") before enabling the
//     destructively-styled button, preventing accidental/double submits.
// ============================================================================
export default function DeleteEmployeeModal({ employee, onClose, onConfirm, busy, error }) {
  const [confirmText, setConfirmText] = useState('')
  const confirmed = confirmText.trim().toUpperCase() === 'DELETE'

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-rose-50 rounded-t-xl">
          <h3 className="text-lg font-semibold text-rose-900 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-rose-600" /> Delete Employee
          </h3>
          <button onClick={onClose} disabled={busy} className="text-rose-400 hover:text-rose-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
            This action is restricted to <span className="font-semibold">super_admin</span> and <span className="font-semibold">hr_manager</span> roles only. Identity is verified server-side. Deleting removes the employee from the roster and payroll (open payroll rows are cancelled), deactivates their platform login, and archives the record — history is preserved, and <span className="font-semibold">Super Admin accounts cannot be deleted</span>.
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div>
              <label className={labelCls}>Employee</label>
              <p className="text-sm font-medium text-slate-900">{employee?.full_name}</p>
            </div>
            <div>
              <label className={labelCls}>Employee ID</label>
              <p className="text-sm font-medium text-slate-900">{employee?.employee_code || employee?.employee_number || '—'}</p>
            </div>
            <div>
              <label className={labelCls}>Department</label>
              <p className="text-sm text-slate-700 truncate">{employee?.department || '—'}</p>
            </div>
            <div>
              <label className={labelCls}>Hire Date</label>
              <p className="text-sm text-slate-700">{date(employee?.hire_date)}</p>
            </div>
          </div>

          <div>
            <label className={labelCls}>Type <span className="font-mono font-semibold">DELETE</span> to confirm</label>
            <input
              className={inputCls}
              placeholder="DELETE"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} disabled={busy}
              className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            <button
              onClick={() => onConfirm(employee)}
              disabled={!confirmed || busy}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />} Delete Employee
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}