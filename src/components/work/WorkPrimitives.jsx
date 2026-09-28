import { SLA_STATE, TASK_STATUS, STEP_STATUS } from '../../services/workEngineService'

/**
 * Small presentational pieces shared by My Work, the review dashboard and the
 * Automation Command Centre. All of them render values the server computed -
 * none of them calculate a completion percentage.
 */

/** Green / amber / red review-SLA badge. */
export function SlaBadge({ state, deadline, className = '' }) {
  const meta = SLA_STATE[state] || SLA_STATE.none
  const when = deadline
    ? new Date(deadline).toLocaleString(undefined, {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.chip} ${className}`}
      title={when ? `Review due ${when}` : undefined}
    >
      {meta.label}
      {when && <span className="font-normal opacity-75">· {when}</span>}
    </span>
  )
}

export function TaskStatusChip({ status }) {
  const meta = TASK_STATUS[status] || { label: status, chip: 'bg-slate-100 text-slate-700' }
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.chip}`}>{meta.label}</span>
}

export function StepStatusChip({ status }) {
  const meta = STEP_STATUS[status] || { label: status, chip: 'bg-slate-100 text-slate-600' }
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.chip}`}>{meta.label}</span>
}

/**
 * Approved vs pending. The approved figure is the score of record; the pending
 * one is only what the employee has CLAIMED and is awaiting a decision, so it
 * is deliberately shown differently and never added to the score.
 */
export function RateIndicator({ approved, pending, hasPending }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-semibold text-slate-900">{Number(approved ?? 0).toFixed(1)}%</span>
      {hasPending && (
        <span
          className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800"
          title="Submitted progress awaiting review - not yet counted in your score"
        >
          {Number(pending ?? 0).toFixed(1)}% pending
        </span>
      )}
    </div>
  )
}

/** Horizontal bar for a 0-100 rate. */
export function RateBar({ value, tone = 'blue' }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0))
  const colour = {
    blue: 'bg-[#009944]',
    violet: 'bg-violet-500',
    amber: 'bg-amber-500',
    emerald: 'bg-emerald-500',
  }[tone] || 'bg-[#009944]'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export default SlaBadge
