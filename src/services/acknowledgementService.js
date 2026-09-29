// ============================================================================
// ACKNOWLEDGEMENT LIFECYCLE (shared web/mobile contract)
//
// Message -> Recipient/Audience -> Acknowledgement State -> Notification -> Reminder
//
// The audience is FROZEN at send time by `send_rich_message`, which seeds one
// `chat_message_acks` row per recipient. Every read path here counts SEEDED ROWS
// and never live membership, so a member joining later cannot dilute the
// obligation and a member leaving cannot erase it.
//
// The RULES live in ./ackRules.js with no imports at all, so they can be unit
// tested and reused by any surface. This file holds only the wire calls, and
// the Flutter client consumes the very same RPCs, which is what keeps the two
// platforms from drifting.
// ============================================================================

import { supabase } from '../supabaseClient'

// Re-exported so existing importers keep a single entry point.
export {
  ACK_REQUIRED_PRIORITIES,
  messageRequiresAck,
  messagePriority,
  isOwnMessage,
  ackRequiredByMe,
  summarizeAcks,
  ackProgressLabel,
  ACK_COMPLETE_LABEL,
} from './ackRules.js'


/** The server-side rollup, used for a message not in the local ack cache. */
export async function fetchAckRollup(messageId) {
  if (!messageId) return null
  const { data, error } = await supabase.rpc('get_ack_rollup', { p_message_id: messageId })
  if (error) throw error
  return data
}

/**
 * Record the local user's acknowledgment.
 *
 * Idempotent by design: the server treats a repeat call as success, so a
 * double-tap or a retry after a network drop cannot create a duplicate record
 * (the table also carries a unique (message_id, user_id) constraint).
 */
export async function acknowledgeMessage(messageId) {
  const { data, error } = await supabase.rpc('acknowledge_chat_message', {
    p_message_id: messageId,
    p_ip: null,
    p_user_agent: 'web',
  })
  if (error) throw error
  return data
}

/**
 * Everything the signed-in user still owes, oldest first.
 *
 * The global banner's single data source. The audience size comes from the
 * server so the banner can show "3 messages require acknowledgement" without the
 * client reconstructing the audience.
 */
export async function listMyPendingAcks() {
  const { data, error } = await supabase.rpc('list_pending_acks_for_me')
  if (error) throw error
  return data || []
}

// ---------------------------------------------------------------------------
// REALTIME (point 6)
// ---------------------------------------------------------------------------

/**
 * Subscribe to ack-row changes for [messageIds] so a sender's ledger updates
 * the moment any recipient acknowledges, on either platform.
 *
 * The rows are filtered by message so a large account does not stream every
 * acknowledgment in the system. Returns an unsubscribe function.
 */
export function subscribeToAcks(messageIds, onChange) {
  const ids = (messageIds || []).filter(Boolean)
  if (ids.length === 0) return () => {}
  const filter = `message_id=in.(${ids.join(',')})`
  const channel = supabase
    .channel(`acks:${ids[0]}:${ids.length}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'chat_message_acks', filter },
      (payload) => onChange?.(payload),
    )
    .subscribe()
  return () => {
    supabase.removeChannel(channel)
  }
}
