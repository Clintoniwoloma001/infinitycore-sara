// ============================================================================
// ReviewDashboard - granular per-step review (HR / supervisor side)
// ============================================================================
// Replaces the old binary approve/reject modal. Each step is ruled on
// individually with target vs reported value; rejecting REQUIRES a reason
// (enforced here and again by a CHECK constraint server-side). Only approved
// steps are written back to the live task, so partial credit survives.
import React, { useState } from 'react'
import { Loader2, X, Check, RotateCcw, CheckCheck } from 'lucide-react'
import { workEngineService } from '../../services/workEngineService'
import { SlaBadge } from './WorkPrimitives'
import { ErrorState } from '../PageStates'

export default function ReviewDashboard({ report, task, onClose, onReviewed }) {
  const [decisions, setDecisions] = useState(() =>
    Object.fromEntries((report.steps || []).map((s) => [s.task_step_id, {
      status: 'approved', reason: '',
    }]))
  )
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const rows = report.steps || []
  const rejectedWithNoReason = rows.some((s) =>
    decisions[s.task_step_id]?.status === 'rejected'
    && !decisions[s.task_step_id]?.reason.trim())

  const setAll = (status) => setDecisions((p) =>
    Object.fromEntries(rows.map((s) => [s.task_step_id, { ...p[s.task_step_id], status }])))

  const run = async (action) => {
    setBusy(true); setError(null)
    try {
      const res = await workEngineService.reviewProgress({
        progressReportId: report.id,
        decisions: rows.map((s) => ({
          task_step_id: s.task_step_id,
          approval_status: decisions[s.task_step_id]?.status,
          rejection_reason: decisions[s.task_step_id]?.status === 'rejected'
            ? decisions[s.task_step_id]?.reason : null,
        })),
        overallAction: action,
        reviewerComment: comment.trim() || null,
      })
      onReviewed?.(res)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" role="dialog" aria-modal="true">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Review submission</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {task?.title} · submitted {new Date(report.created_at).toLocaleString()}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-sm text-slate-600">
            Claimed <strong>{Number(report.pending_percentage ?? 0).toFixed(1)}%</strong>
            {' · '}currently approved{' '}
            <strong>{Number(task?.calculated_completion_rate ?? 0).toFixed(1)}%</strong>
          </span>
          {task?.sla_state && task.sla_state !== 'none' && (
            <SlaBadge state={task.sla_state} deadline={task.sla_review_deadline} />
          )}
        </div>

        <div className="mb-3 flex gap-2">
          <button onClick={() => setAll('approved')} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600">
            Mark all approved
          </button>
          <button onClick={() => setAll('rejected')} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600">
            Mark all rejected
          </button>
        </div>

        <div className="space-y-2">
          {rows.map((s) => {
            const d = decisions[s.task_step_id] || {}
            const rejected = d.status === 'rejected'
            return (
              <div key={s.id} className={`rounded-xl border p-3 ${rejected ? 'border-red-200 bg-red-50/40' : 'border-slate-200'}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">{s.title}</div>
                    <div className="text-xs text-slate-500">
                      Target <strong>{s.target_type === 'numerical' ? Number(s.target_value).toLocaleString() : 'delivered'}</strong>
                      {' · '}reported{' '}
                      <strong>
                        {s.target_type === 'numerical'
                          ? Number(s.reported_value ?? 0).toLocaleString()
                          : (s.reported_boolean ? 'complete' : 'not done')}
                      </strong>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => setDecisions((p) => ({ ...p, [s.task_step_id]: { ...d, status: 'approved' } }))}
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium ${
                        d.status === 'approved' ? 'bg-emerald-600 text-white' : 'border border-slate-300 text-slate-600'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5" />Approve
                    </button>
                    <button
                      onClick={() => setDecisions((p) => ({ ...p, [s.task_step_id]: { ...d, status: 'rejected' } }))}
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium ${
                        rejected ? 'bg-red-600 text-white' : 'border border-slate-300 text-slate-600'
                      }`}
                    >
                      <X className="w-3.5 h-3.5" />Reject
                    </button>
                  </div>
                </div>

                {rejected && (
                  <input
                    value={d.reason || ''}
                    onChange={(e) => setDecisions((p) => ({ ...p, [s.task_step_id]: { ...d, reason: e.target.value } }))}
                    placeholder="Reason for rejection (required)"
                    className="mt-2 w-full rounded-lg border border-red-300 px-3 py-1.5 text-sm"
                  />
                )}
              </div>
            )
          })}
        </div>

        <label className="mt-3 block">
          <span className="text-xs font-medium text-slate-700">Comment to the employee</span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        {rejectedWithNoReason && (
          <p className="mt-2 text-xs text-red-600">A reason is required for every rejected step.</p>
        )}
        {error && <ErrorState title="Could not record this review" message={error} />}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            onClick={() => run('request_revision')}
            disabled={busy || rejectedWithNoReason}
            className="inline-flex items-center gap-1.5 rounded-lg border border-orange-300 px-3 py-2 text-sm font-medium text-orange-700 disabled:opacity-50"
          >
            <RotateCcw className="w-4 h-4" />Request revision
          </button>
          <button
            onClick={() => run('approve_all')}
            disabled={busy || rejectedWithNoReason || rows.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCheck className="w-4 h-4" />}
            Approve &amp; complete
          </button>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          &ldquo;Approve &amp; complete&rdquo; marks the task done only if it genuinely
          reaches 100%. Approved steps keep their credit on a revision request.
        </p>
      </div>
    </div>
  )
}
