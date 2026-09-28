// ============================================================================
// TaskStepBuilder - the iterative step builder (creator / manager side)
// ============================================================================
// Replaces the flat single-field instruction box. Deliverables are added one at
// a time, each with a type (checkbox vs numeric target) and a weight. The form
// never shows or accepts a completion percentage - the engine derives it.
import React, { useMemo, useState } from 'react'
import { Plus, Trash2, GripVertical, Info } from 'lucide-react'

let seq = 0
const blankStep = () => ({
  key: `s${++seq}`,
  title: '',
  description: '',
  target_type: 'boolean',
  target_value: '',
  step_weight: '',
})

/**
 * Total of the explicit weights, or auto mode when none are set - in which case
 * the SERVER distributes them equally across the deliverables.
 */
export function weightSummary(steps) {
  const filled = steps.filter((s) => Number(s.step_weight) > 0)
  if (filled.length === 0) return { mode: 'auto' }
  return { mode: 'explicit', total: filled.reduce((s, x) => s + Number(x.step_weight), 0) }
}

export default function TaskStepBuilder({ steps, onChange, error }) {
  const [showWeights, setShowWeights] = useState(false)
  const weights = useMemo(() => weightSummary(steps), [steps])

  const patch = (key, field, value) =>
    onChange(steps.map((s) => (s.key === key ? { ...s, [field]: value } : s)))
  const addStep = () => onChange([...steps, blankStep()])
  const removeStep = (key) => onChange(steps.filter((s) => s.key !== key))
  const move = (from, to) => {
    if (to < 0 || to >= steps.length) return
    const next = [...steps]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange(next)
  }

  const input = 'w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm'

  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800">Deliverables / steps</span>
        <button type="button" onClick={addStep}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
          <Plus className="w-3.5 h-3.5" />Add deliverable
        </button>
      </div>

      {steps.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          No deliverables yet. Add at least one so progress can be measured step by step.
        </p>
      ) : (
        <ul className="space-y-2">
          {steps.map((s, i) => (
            <li key={s.key} className="rounded-lg border border-slate-100 p-2">
              <div className="flex items-start gap-2">
                <div className="flex flex-col items-center pt-1">
                  <GripVertical className="h-3.5 w-3.5 text-slate-300" />
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0}
                    className="text-[10px] text-slate-400 disabled:opacity-30" aria-label="Move up">▲</button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === steps.length - 1}
                    className="text-[10px] text-slate-400 disabled:opacity-30" aria-label="Move down">▼</button>
                </div>

                <div className="min-w-0 flex-1 space-y-1.5">
                  <input value={s.title} onChange={(e) => patch(s.key, 'title', e.target.value)}
                    placeholder={`Deliverable ${i + 1} title`} className={input} />
                  <input value={s.description} onChange={(e) => patch(s.key, 'description', e.target.value)}
                    placeholder="Description (optional)" className={`${input} text-xs`} />
                  <div className="flex flex-wrap gap-2">
                    <select value={s.target_type} onChange={(e) => patch(s.key, 'target_type', e.target.value)}
                      className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs">
                      <option value="boolean">Checkbox deliverable</option>
                      <option value="numerical">Numeric target</option>
                    </select>
                    {s.target_type === 'numerical' && (
                      <input type="number" min={1} value={s.target_value}
                        onChange={(e) => patch(s.key, 'target_value', e.target.value)}
                        placeholder="Target (e.g. 4000000)"
                        className="w-44 rounded-lg border border-slate-300 px-2 py-1.5 text-xs" />
                    )}
                    {showWeights && (
                      <input type="number" min={0} value={s.step_weight}
                        onChange={(e) => patch(s.key, 'step_weight', e.target.value)}
                        placeholder="Weight %"
                        className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-xs" />
                    )}
                  </div>
                </div>

                <button type="button" onClick={() => removeStep(s.key)}
                  className="rounded-lg p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove deliverable">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {steps.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <button type="button" onClick={() => setShowWeights((v) => !v)}
            className="text-xs font-medium text-[#009944]">
            {showWeights ? 'Hide weights' : 'Set custom weights'}
          </button>
          <span className="text-xs text-slate-500">
            {weights.mode === 'auto'
              ? 'Weights will be split equally.'
              : `Weights total ${Number(weights.total.toFixed(1))}%`}
          </span>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <p className="mt-2 flex items-start gap-1.5 text-[11px] text-slate-400">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Progress is calculated from these deliverables. A step counts as a fraction
        of its target, and the task score is the weighted average.
      </p>
    </div>
  )
}
