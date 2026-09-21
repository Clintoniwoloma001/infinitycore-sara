import React, { useState } from 'react'
import { CheckCircle2, Loader2, PenLine, X } from 'lucide-react'
import SignaturePad from '../SignaturePad'

const btnPrimary = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50'
const btnGhost = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50'

// Signature capture step for HR Officer payroll edits (Phase 66). Shows the
// change summary being approved + a canvas signature pad. The received
// signature is a base64 PNG data URL persisted with the change as
// signature_data_url in payroll_audit_logs.
export default function PayrollSignatureModal({ title = 'Confirm payroll change', subtitle, employeeName, summary = [], onConfirm, onClose, busy = false }) {
  const [signature, setSignature] = useState(null)
  const [error, setError] = useState('')

  const confirm = () => {
    if (!signature) {
      setError('Please sign before confirming this payroll change.')
      return
    }
    setError('')
    onConfirm(signature)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-amber-50 rounded-t-xl">
          <div className="flex items-center gap-2">
            <PenLine className="w-5 h-5 text-amber-600" />
            <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          </div>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
          {employeeName && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-700">
              <span className="font-medium">{employeeName}</span>
            </div>
          )}

          {summary.length > 0 && (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-medium text-slate-400 mb-2">Change summary</div>
              <dl className="space-y-1">
                {summary.map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between text-sm gap-3">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="font-medium text-slate-800">{value ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div>
            <div className="flex items-center gap-1.5 mb-2 text-sm font-medium text-slate-700">
              <PenLine className="w-4 h-4" /> Sign to approve
            </div>
            <SignaturePad onChange={setSignature} height={140} />
            <p className="text-xs text-slate-400 mt-1">This signature is stored with the change in the payroll audit trail.</p>
          </div>

          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-sm text-rose-700">{error}</div>}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button className={btnGhost} onClick={onClose} disabled={busy}>Cancel</button>
            <button className={btnPrimary} onClick={confirm} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Sign &amp; save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}