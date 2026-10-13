// ============================================================================
// Audit obligation board model - pure domain layer (no React, no Supabase)
// ============================================================================
// The Kanban board's COLUMNS and the card copy are presentation, so they live
// here; the LIFECYCLE they render is computed once, in Postgres, by
// audit_obligation_states() (migration 20261111000004). Nothing in this module
// may derive a completion percentage or invent a status - it only formats what
// the server already decided.
//
// Lifecycle keys the server can return (derived labels, NOT stored statuses):
//   not_started | needs_clarification | blocked | in_progress
//   | awaiting_approval | completed
// ============================================================================

export const LIFECYCLE = {
  not_started: { label: 'Not started', chip: 'bg-slate-100 text-slate-600' },
  needs_clarification: { label: 'Needs clarification', chip: 'bg-sky-100 text-sky-800' },
  blocked: { label: 'Blocked', chip: 'bg-red-100 text-red-800' },
  in_progress: { label: 'In progress', chip: 'bg-amber-100 text-amber-800' },
  awaiting_approval: { label: 'Awaiting final review', chip: 'bg-violet-100 text-violet-800' },
  completed: { label: 'Completed', chip: 'bg-emerald-100 text-emerald-800' },
}

/**
 * The board's visual columns, in workflow order, each mapped to the canonical
 * lifecycle the server derives. Colours are the app's existing brand neutrals
 * plus one hue per column header; cards stay white on a restrained background.
 */
export const BOARD_COLUMNS = [
  {
    key: 'pending',
    label: 'Pending / Not started',
    hint: 'Nobody has started',
    lifecycles: ['not_started'],
    header: 'bg-slate-200 text-slate-800',
    dot: 'bg-slate-500',
  },
  {
    key: 'clarification',
    label: 'Needs clarification',
    hint: 'A submission was returned for correction',
    lifecycles: ['needs_clarification'],
    header: 'bg-sky-200 text-sky-900',
    dot: 'bg-sky-600',
  },
  {
    key: 'blocked',
    label: 'Cannot proceed / blocked',
    hint: 'Paused by the audit office',
    lifecycles: ['blocked'],
    header: 'bg-red-200 text-red-900',
    dot: 'bg-red-600',
  },
  {
    key: 'progress',
    label: 'In progress',
    hint: 'Some responsible persons have responded',
    lifecycles: ['in_progress'],
    header: 'bg-amber-200 text-amber-900',
    dot: 'bg-amber-600',
  },
  {
    key: 'review',
    label: 'Awaiting final review',
    hint: 'Everyone has responded, audit has not accepted yet',
    lifecycles: ['awaiting_approval'],
    header: 'bg-violet-200 text-violet-900',
    dot: 'bg-violet-600',
  },
  {
    key: 'done',
    label: 'Completed',
    hint: 'Every responsible person satisfied the completion criteria',
    lifecycles: ['completed'],
    header: 'bg-emerald-200 text-emerald-900',
    dot: 'bg-emerald-600',
  },
]

export const ALL_LIFECYCLES = BOARD_COLUMNS.flatMap((c) => c.lifecycles)

/** Which column a lifecycle belongs to. Unknown lifecycles never crash a render. */
export function columnForLifecycle(lifecycle) {
  return BOARD_COLUMNS.find((c) => c.lifecycles.includes(lifecycle)) || null
}

/** True when the card belongs on the board at all (archived rows never do). */
export function isBoardCard(obligation) {
  if (!obligation) return false
  return obligation.status !== 'archived'
}

/** Up to `limit` names, then "+N more" - the full list lives in the detail drawer. */
export function summariseNames(names = [], limit = 3) {
  const list = (names || []).filter(Boolean)
  if (list.length === 0) return ''
  if (list.length <= limit) return list.join(', ')
  return `${list.slice(0, limit).join(', ')} +${list.length - limit} more`
}

/**
 * The outstanding-person sentence every incomplete obligation must show, e.g.
 *   "2 of 3 completed · Awaiting: Jane Doe"
 * A obligation with no resolved responsible person is never described as
 * complete - it says so instead.
 */
export function completionSummary(obligation) {
  if (!obligation) return { text: '', done: 0, total: 0, pending: [] }
  const total = Number(obligation.assigned_count) || 0
  const done = Number(obligation.complete_count) || 0
  const pending = obligation.outstanding_names || []
  const pct = Number(obligation.completion_pct) || 0
  if (total === 0) {
    return { text: 'No responsible person assigned yet', done, total, pending }
  }
  const base = `${done} of ${total} completed · ${Math.round(pct)}%`
  const text = done === total
    ? base
    : `${base} · Awaiting: ${summariseNames(pending)}`
  return { text, done, total, pending }
}

/** Two-letter initials for an avatar, e.g. "Jane Doe" -> "JD". */
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return parts.slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

/**
 * The stored recurrence rule is free text (e.g. "monthly:5"). It is shown as
 * written - this module never expands it into invented occurrences.
 */
export function recurrenceLabel(rule) {
  const r = String(rule || '').trim()
  if (!r) return 'One-off'
  const [kind, rest] = r.split(':')
  const label = kind.charAt(0).toUpperCase() + kind.slice(1)
  return rest ? `${label} (${rest})` : label
}

/** Which date the schedule entry is really about. */
export function scheduleDate(obligation) {
  return obligation?.effective_deadline || obligation?.due_date || obligation?.next_occurrence || null
}

/** True when the obligation carries any scheduling information at all. */
export function hasSchedule(obligation) {
  if (!obligation) return false
  return Boolean(scheduleDate(obligation)) || Boolean(obligation.recurrence_rule)
}

/**
 * True when the obligation is one the regulatory-body registers track, i.e.
 * its type is a regulatory one ('regulatory_return', 'regulatory_circular',
 * and any future 'regulatory_*' value). Everything else is not regulatory work.
 */
export function isRegulatoryObligation(obligation) {
  if (!obligation) return false
  const type = String(obligation.obligation_type || '')
  return type.startsWith('regulatory')
}

/** The obligations that ARE the audit findings register. */
export function isFindingObligation(obligation) {
  if (!obligation) return false
  return obligation.obligation_type === 'audit_finding'
}

/** Tone helper for the small badges on a card. */
export const RISK_TONE = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  medium: 'bg-amber-50 text-amber-700',
  low: 'bg-slate-100 text-slate-600',
}
