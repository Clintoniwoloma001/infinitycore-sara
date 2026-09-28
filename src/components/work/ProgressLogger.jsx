// ============================================================================
// ProgressLogger - iterative progress logging from My Work
// ============================================================================
// Sends INTENT only: a new figure per step, a tick per deliverable, a summary
// and any evidence links. It never sends a percentage - the server derives the
// rate. A pending submission is labelled so the user can see their score has
// not moved yet.
import React, { useState } from 'react'
import { Loader2, X, Send } from 'lucide-react'
import { workEngineService } from '../../services/workEngineService'
import { StepStatusChip } from './WorkPrimitives'
import { ErrorState } from '../PageStates'

export default function ProgressLogger({ task, onClose, onSubmitted }) {
  const [values, setValues] = useState(() =>
    Object.fromEntries((task.steps || []).map((s) => [s.id, {
      value: s.target_type === 'numerical' ? (s.current_value ?? '') : '',
      done: !!s.is_completed,
    }]))
  )
  const [summary, setSummary] = useState('')
  const [links, setLinks] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const blocked = task.has_pending_report
  const steps = task.steps || []
  const pendingReport = (task.reports || []).find((r) => r.status === 'pending_review')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const payloadSteps = steps.map((s) => (s.target_type === 'numerical'
        ? { task_step_id: s.id, reported_value: values[s.id]?.value === '' ? null : Number(values[s.id]?.value) }
        : { task_step_id: s.id, reported_boolean: !!values[s.id]?.done }))
      const attachments = links.split('\n').map((l) => l.trim()).filter(Boolean).map((url) => ({ file_url: url }))
      const res = await workEngineService.submitProgress({
        taskId: task.id, summary: summary.trim() || null,
        steps: payloadSteps, attachments,
      })
      onSubmitted?.(res)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" role="dialog" aria-modal="true">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Log progress</h2>
            <p className="mt-0.5 text-sm text-slate-500">{task.title}</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {blocked && pendingReport && (
          <div className="mb-3 rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">
            <strong>{Number(pendingReport.pending_percentage ?? 0).toFixed(1)}%</strong> is already awaiting
            review. Your approved score stays at{' '}
            <strong>{Number(task.calculated_completion_rate ?? 0).toFixed(1)}%</strong> until a reviewer decides.
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          {steps.length === 0 && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              This task has no deliverables yet, so there is nothing to report against.
            </p>
          )}

          {steps.map((s) => {
            const v = values[s.id] || {}
            return (
              <div key={s.id} className="rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">{s.title}</div>
                    <div className="text-xs text-slate-500">
                      {s.target_type === 'numerical'
                        ? `Target ${Number(s.target_value).toLocaleString()} · currently ${Number(s.current_value ?? 0).toLocaleString()} · ${Number(s.calculated_step_rate).toFixed(1)}%`
                        : `Deliverable · ${Number(s.calculated_step_rate).toFixed(1)}%`}
                    </div>
                  </div>
                  <StepStatusChip status={s.status} />
                </div>

                <div className="mt-2">
                  {s.target_type === 'numerical' ? (
                    <input
                      type="number"
                      min={0}
                      value={v.value ?? ''}
                      onChange={(e) => setValues((p) => ({ ...p, [s.id]: { ...v, value: e.target.value } }))}
                      placeholder={`New figure (target ${Number(s.target_value).toLocaleString()})`}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  ) : (
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={!!v.done}
                        onChange={(e) => setValues((p) => ({ ...p, [s.id]: { ...v, done: e.target.checked } }))}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Mark this deliverable complete
                    </label>
                  )}
                </div>
              </div>
            )
          })}

          <label className="block">
            <span className="text-xs font-medium text-slate-700">Summary comment</span>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={2}
              placeholder="What did you achieve since the last update?"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-700">Evidence links (one URL per line)</span>
            <textarea
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              rows={2}
              placeholder="https://…"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          {error && <ErrorState title="Could not submit your update" message={error} />}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || blocked || steps.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Submit for review
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
