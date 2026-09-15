import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Offline-first internal chat.
//
// Design:
//   - All network writes flow through `sendMessage`, which keeps an
//     in-memory optimistic copy AND a persisted outbox in
//     localStorage so nothing is lost on reload/disconnect.
//   - `syncOutbox` is called on demand and on the 'online' event so
//     queued messages flush the moment connectivity returns.
//   - Reads (threads + messages) hit Supabase; realtime subscriptions
//     keep the conversation live while the tab is open.
//
// Storage keys are per-user to avoid cross-account leakage.
// ------------------------------------------------------------------

const OUTBOX_PREFIX = 'chat_outbox_'
const getOutboxKey = (userId) => `${OUTBOX_PREFIX}${userId}`

export function readOutbox(userId) {
  if (!userId) return []
  try {
    const raw = localStorage.getItem(getOutboxKey(userId))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeOutbox(userId, items) {
  if (!userId) return
  try {
    localStorage.setItem(getOutboxKey(userId), JSON.stringify(items.slice(-200)))
  } catch {
    // storage full/unavailable — the in-memory copy still works for this session
  }
}

// deterministic pair key used for local optimistic thread ids
export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export async function getOrCreateThread(otherUserId) {
  const { data, error } = await supabase.rpc('get_or_create_chat_thread', { p_other_user: otherUserId })
  if (error) throw error
  return data
}

export async function listMyThreads() {
  const me = supabase.auth.getUser()
  const { data: user } = await me
  if (!user?.user?.id) return []
  const { data, error } = await supabase
    .from('chat_threads')
    .select('*')
    .or(`member_a.eq.${user.user.id},member_b.eq.${user.user.id}`)
    .order('last_message_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function listMessages(threadId, limit = 200) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  return data || []
}

// Attempt to send one message through the RPC. Returns { ok:true } or
// throws — caller decides whether to keep it queued.
export async function sendNow(threadId, body) {
  const { data, error } = await supabase.rpc('send_chat_message', { p_thread_id: threadId, p_body: body })
  if (error) throw error
  return data
}

// Offline-first send. Returns { queued, optimistic } so the UI can
// render instantly regardless of connectivity.
export async function sendMessage({ threadId, body, senderId }) {
  const optimistic = {
    id: `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    thread_id: threadId,
    sender_id: senderId,
    body,
    status: 'queued',
    created_at: new Date().toISOString(),
  }

  try {
    await sendNow(threadId, body)
    return { queued: false, optimistic }
  } catch {
    // Offline (or transient error): persist to outbox, flush on reconnect.
    const outbox = readOutbox(senderId)
    outbox.push({ thread_id: threadId, body, queued_at: new Date().toISOString() })
    writeOutbox(senderId, outbox)
    return { queued: true, optimistic }
  }
}

// Flush any messages that couldn't be sent while offline.
export async function syncOutbox(senderId) {
  const outbox = readOutbox(senderId)
  if (outbox.length === 0) return { sent: 0, remaining: 0 }

  let sent = 0
  let remaining = []

  for (const item of outbox) {
    try {
      await sendNow(item.thread_id, item.body)
      sent += 1
    } catch {
      remaining.push(item)
    }
  }

  if (remaining.length === 0) writeOutbox(senderId, [])
  else writeOutbox(senderId, remaining)
  return { sent, remaining: remaining.length }
}

export const outboxKey = getOutboxKey
export default { getOrCreateThread, listMyThreads, listMessages, sendMessage, sendNow, syncOutbox, readOutbox }