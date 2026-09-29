// ============================================================================
// PURE ACKNOWLEDGEMENT RULES (no I/O — safe to import anywhere and in tests)
// ============================================================================

/** `normal` never requires acknowledgment. `high`/`urgent` always do. */
export const ACK_REQUIRED_PRIORITIES = new Set(['high', 'urgent'])

/**
 * True when [message] demands an acknowledgment from its recipients.
 *
 * Accepts the bool and the string spellings because PostgREST returns a bool on
 * Postgres and occasionally the string 'true' through a view.
 */
export function messageRequiresAck(message) {
  if (!message) return false
  return message.requires_ack === true || message.requires_ack === 'true'
}

/** Normalised priority: 'normal' | 'high' | 'urgent'. */
export function messagePriority(message) {
  const raw = String(message?.priority ?? 'normal').trim().toLowerCase()
  if (raw === 'urgent' || raw === 'critical') return 'urgent'
  if (raw === 'high' || raw === 'important') return 'high'
  return 'normal'
}

/** True when [messageId] is the local user's own message. */
export function isOwnMessage(message, me) {
  return Boolean(me) && String(message?.sender_id ?? '') === String(me)
}

/**
 * Whether the local user still owes an acknowledgment for [message].
 *
 * Point 1: the sender is never in debt, so this is false for their own
 * messages regardless of the seeded rows. Point 2: once acknowledged it stays
 * acknowledged — an ack is a durable fact, not a transient UI state.
 */
export function ackRequiredByMe(message, acks, me) {
  if (!messageRequiresAck(message) || !me) return false
  if (isOwnMessage(message, me)) return false
  const rows = acks || []
  return !rows.some((r) => r.user_id === me && r.status === 'acknowledged')
}

/**
 * Summarise seeded ack rows for a sender-facing ledger.
 *
 * Counts only `status === 'acknowledged'`. The previous UI tallied the ROW
 * count, which made a brand-new group broadcast read as fully acknowledged the
 * instant it was sent, because every recipient already has a seeded `pending`
 * row. Returns the two lists separately so callers can render them as clearly
 * separated sections.
 */
export function summarizeAcks(acks) {
  const rows = acks || []
  const acknowledged = rows.filter((r) => r.status === 'acknowledged')
  const pending = rows.filter((r) => r.status !== 'acknowledged')
  return {
    total: rows.length,
    done: acknowledged.length,
    pending: pending.length,
    complete: rows.length > 0 && pending.length === 0,
    acknowledgedList: acknowledged,
    pendingList: pending,
  }
}

/** Canonical completion wording, shared with the server's `complete_label`. */
export const ACK_COMPLETE_LABEL = 'ALL RECIPIENTS ACKNOWLEDGED'

/** '8 of 10 acknowledged · 2 pending' — the sender's at-a-glance progress. */
export function ackProgressLabel(summary) {
  if (!summary || summary.total === 0) return ''
  if (summary.complete) {
    return summary.total === 1 ? ACK_COMPLETE_LABEL : `ALL ${summary.total} RECIPIENTS ACKNOWLEDGED`
  }
  return `${summary.done} of ${summary.total} acknowledged · ${summary.pending} pending`
}


