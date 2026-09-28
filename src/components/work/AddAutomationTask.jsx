// ============================================================================
// AddAutomationTask - the ACC "Add task" control
// ============================================================================
// ONE TASK PER DEPARTMENT: the server returns {reused:true} when this user
// already has a task for that department, in which case we refresh the existing
// task rather than creating a second one. The modal says so explicitly so
// nobody assumes they are making a duplicate.
import React, { useEffect, useState } from 'react'
import { Plus, Loader2, X, Info } from 'lucide-react'
import { workEngineService } from '../../services/workEngineService'
import { ErrorState } from '../PageStates'

export default function AddAutomationTask({ departments, onCreated, onClose }) {
  const [department, setDepartment] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [slaHours, setSlaHours] = useState(48)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  useEffect(() => {
    if (!department && departments.length) setDepartment(departments[0].department)
  }, [departments, department])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await workEngineService.addAutomationTask({
        department,
        label: label.trim(),
        description: description.trim() || null,
        dueDate: dueDate ? new Date(dueDate).toISOString() : null,
        slaHours: Number(slaHours) || 48,
      })
      setDone(res)
      onCreated?.(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const labelError = label.length > 0 && !label.trim() ? 'A task title is required.' : null
  const disabled = busy || !label.trim()

  const input = 'mt-1 w-full rounded-lg border px-3 py-2 text-sm'
  const labelCls = 'text-xs font-medium text-slate-700'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl" role="dialog" aria-modal="true" aria-label="Add automation task">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Add automation task</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Creates one task for you in this department, tracked from My Work.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {done ? (
          <div className="space-y-3">
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              {done.reused
                ? 'You already had a task for this department, so it was updated rather than duplicated.'
                : 'Task created. It is now in your My Work list and counts towards your KPI score.'}
            </p>
            <button onClick={onClose} className="w-full rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>You get <strong>one task per department</strong>. Adding the same department again updates the existing task instead of creating a second one.</span>
            </div>

            <label className="block">
              <span className={labelCls}>Department</span>
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className={`${input} border-slate-300`}
              >
                {departments.map((d) => (
                  <option key={d.department} value={d.department}>
                    {d.label || d.department}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={labelCls}>Task title</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Automate the monthly audit pack"
                className={`${input} ${labelError ? 'border-red-400' : 'border-slate-300'}`}
              />
              {labelError && <span className="mt-1 block text-xs text-red-600">{labelError}</span>}
            </label>

            <label className="block">
              <span className={labelCls}>Description (optional)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className={`${input} border-slate-300`}
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={labelCls}>Due date</span>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className={`${input} border-slate-300`}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Review SLA (hours)</span>
                <input
                  type="number"
                  min={1}
                  value={slaHours}
                  onChange={(e) => setSlaHours(e.target.value)}
                  className={`${input} border-slate-300`}
                />
              </label>
            </div>

            {error && <ErrorState title="Could not add the task" message={error} />}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600">
                Cancel
              </button>
              <button
                type="submit"
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Add task
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
