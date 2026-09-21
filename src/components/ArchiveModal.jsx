import React, { useState } from 'react'
import { Archive, Loader2, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { employeeLabel } from '../services/terminationAuthorization'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]/40'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

// Archive confirmation modal. Archive hides the employee from normal
// active views while preserving ALL history. Restricted server-side to
// super_admin / Head of Human Resources — the same authorization as termination.
export default function ArchiveModal({ employee, restore = false, onClose, onConfirm, busy, error }) {
  const [reason, setReason] = useState('')
  const ready = (restore || reason.trim().length > 0) && !busy

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50 rounded-t-xl">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            {restore ? (
              <><RotateCcw className="w-5 h-5 text-[#009944]" /> Restore Archived Employee</>
            ) : (
              <><Archive className="w-5 h-5 text-slate-600" /> Archive Employee</>
            )}
          </h3>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-[#009944]" />
            Restricted to <span className="font-semibold">super_admin</span> and <span className="font-semibold">Head of Human Resources</span>. This preserves the employee's full record and history.
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="font-medium text-slate-800">{employee?.full_name} <span className="text-slate-400">({employeeLabel(employee)})</span></div>
            <div className="text-xs text-slate-500 mt-1">
              {employee?.position || '—'} · {employee?.department || '—'} · {employee?.branch || '—'}
            </div>
          </div>

          {!restore && (
            <div>
              <label className={labelCls}>Archive Reason {restore ? '' : '*'} (preserved in audit)</label>
              <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]/40"
                rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}
                placeholder="Why is this employee being archived?" />
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} disabled={busy}
              className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            <button
              onClick={() => onConfirm({ reason })}
              disabled={!ready}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : restore ? <RotateCcw className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
              {restore ? 'Restore Employee' : 'Archive Employee'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}