import React, { useState } from 'react'
import {
  AlertTriangle, Check, CheckCircle2, Loader2, RotateCw, Send, X, XCircle,
} from 'lucide-react'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

function CorrectionRow({ correction, type, canManage, onApprove, onReject, onSubmitValue, busy }) {
  const [showSubmit, setShowSubmit] = useState(false)
  const [correctedValue, setCorrectedValue] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [showReject, setShowReject] = useState(false)

  const statusCls = {
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    submitted: 'bg-blue-50 text-blue-700 border-blue-200',
    approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  }

  return (
    <div className={`rounded-lg border p-4 ${statusCls[correction.status] || 'border-slate-200 bg-white'}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-sm font-semibold text-slate-800">{correction.field_label || correction.field_name}</span>
          {correction.section && (
            <span className="text-xs text-slate-400 ml-2">({correction.section})</span>
          )}
        </div>
        <span className={`text-xs font-medium capitalize px-2 py-0.5 rounded-full border ${statusCls[correction.status]}`}>
          {correction.status}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-slate-400">Original Value:</p>
          <p className="font-mono text-xs text-slate-600 mt-0.5 bg-white rounded px-2 py-1 border border-slate-200 break-words">
            {correction.previous_value || <span className="text-slate-300 italic">(empty)</span>}
          </p>
        </div>
        {correction.corrected_value && (
          <div>
            <p className="text-xs text-slate-400">Corrected Value:</p>
            <p className="font-mono text-xs text-emerald-700 mt-0.5 bg-white rounded px-2 py-1 border border-emerald-200 break-words">
              {correction.corrected_value}
            </p>
          </div>
        )}
        <div className="sm:col-span-2">
          <p className="text-xs text-slate-400">HR Comment:</p>
          <p className="text-sm text-amber-800 mt-0.5">{correction.hr_comment || '—'}</p>
        </div>
        {correction.rejection_reason && (
          <div className="sm:col-span-2">
            <p className="text-xs text-slate-400">Rejection Reason:</p>
            <p className="text-sm text-rose-700 mt-0.5">{correction.rejection_reason}</p>
          </div>
        )}
        {correction.submitted_at && (
          <div>
            <p className="text-xs text-slate-400">Submitted:</p>
            <p className="text-xs text-slate-500 mt-0.5">{new Date(correction.submitted_at).toLocaleString()}</p>
          </div>
        )}
        {correction.reviewed_at && (
          <div>
            <p className="text-xs text-slate-400">Reviewed:</p>
            <p className="text-xs text-slate-500 mt-0.5">{new Date(correction.reviewed_at).toLocaleString()}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      {canManage && correction.status === 'pending' && type === 'onboarding' && (
        <div className="mt-3">
          {!showSubmit ? (
            <button
              onClick={() => setShowSubmit(true)}
              className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700"
            >
              Enter Corrected Value
            </button>
          ) : (
            <div className="space-y-2">
              <input
                className={inputCls}
                value={correctedValue}
                onChange={(e) => setCorrectedValue(e.target.value)}
                placeholder="Enter the corrected value from the candidate…"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { onSubmitValue(correction.id, correctedValue); setShowSubmit(false); setCorrectedValue('') }}
                  disabled={!correctedValue.trim() || busy}
                  className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Submit Value
                </button>
                <button onClick={() => setShowSubmit(false)} className="text-xs px-3 py-1.5 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {canManage && correction.status === 'submitted' && (
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => onApprove(correction.id, type)}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Approve
          </button>
          {!showReject ? (
            <button
              onClick={() => setShowReject(true)}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-md border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
            >
              Reject
            </button>
          ) : (
            <div className="flex-1 space-y-2">
              <input
                className={inputCls}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason for rejection (required)…"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { onReject(correction.id, type, rejectReason); setShowReject(false); setRejectReason('') }}
                  disabled={!rejectReason.trim() || busy}
                  className="text-xs px-3 py-1.5 rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  Confirm Reject
                </button>
                <button onClick={() => setShowReject(false)} className="text-xs px-3 py-1.5 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function CorrectionsTab({
  onboardingCorrections,
  guarantorCorrections,
  canManage,
  onApprove,
  onReject,
  onSubmitValue,
  busy,
}) {
  const allCorrections = [
    ...onboardingCorrections.map((c) => ({ ...c, type: 'onboarding' })),
    ...guarantorCorrections.map((c) => ({ ...c, type: 'guarantor' })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

  if (allCorrections.length === 0) {
    return (
      <div className="text-center py-12">
        <CheckCircle2 className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <p className="text-sm text-slate-400">No corrections have been requested.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-center">
          <div className="text-xl font-bold text-amber-700">{allCorrections.filter((c) => c.status === 'pending').length}</div>
          <div className="text-xs text-amber-600">Pending</div>
        </div>
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-center">
          <div className="text-xl font-bold text-blue-700">{allCorrections.filter((c) => c.status === 'submitted').length}</div>
          <div className="text-xs text-blue-600">Submitted</div>
        </div>
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-center">
          <div className="text-xl font-bold text-emerald-700">{allCorrections.filter((c) => c.status === 'approved').length}</div>
          <div className="text-xs text-emerald-600">Approved</div>
        </div>
        <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-center">
          <div className="text-xl font-bold text-rose-700">{allCorrections.filter((c) => c.status === 'rejected').length}</div>
          <div className="text-xs text-rose-600">Rejected</div>
        </div>
      </div>

      <div className="space-y-3">
        {allCorrections.map((c) => (
          <CorrectionRow
            key={`${c.type}-${c.id}`}
            correction={c}
            type={c.type}
            canManage={canManage}
            onApprove={onApprove}
            onReject={onReject}
            onSubmitValue={onSubmitValue}
            busy={busy}
          />
        ))}
      </div>
    </div>
  )
}
