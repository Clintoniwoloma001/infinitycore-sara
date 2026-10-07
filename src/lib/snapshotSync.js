import { supabase } from '../supabaseClient'

/**
 * Snapshot refresh bus.
 *
 * Publishing a BankOne import is the single moment that has to wake up every
 * open page reading that data (Director Intelligence cards, Performance
 * scorecards). Pages cannot watch `bankone_portfolio_snapshots` with a
 * `postgres_changes` listener and still receive events — the read policy is
 * `can_manage_bankone()`, so an MD/CEO subscriber would be filtered out — so
 * publish fans out a lightweight "something changed, reload" ping instead.
 *
 * Two hops:
 *  - the window event reaches components/tabs of the SAME session
 *  - a Supabase realtime broadcast reaches OTHER sessions (the payload carries
 *    no data, only the snapshot id, so nothing bypasses RLS)
 */

export const SNAPSHOT_EVENT = 'bankone:snapshot_published'
export const SNAPSHOT_CHANNEL = 'bankone:snapshot-sync'

let channel = null
// One wrapper per subscription — never the raw callback, so two callers that
// pass the same function reference still each receive their own ping.
const subscribers = new Set()

const dispatchLocal = (detail) => {
  subscribers.forEach((fn) => {
    try { fn(detail) } catch { /* one bad subscriber must not break the bus */ }
  })
}

const getChannel = () => {
  if (channel || typeof window === 'undefined') return channel
  try {
    channel = supabase
      .channel(SNAPSHOT_CHANNEL)
      .on('broadcast', { event: 'published' }, (payload) => dispatchLocal(payload?.payload || null))
      .subscribe()
  } catch {
    channel = null
  }
  return channel
}

const releaseChannel = () => {
  if (subscribers.size > 0 || !channel) return
  try { supabase.removeChannel(channel) } catch { /* ignore */ }
  channel = null
}

/** Fire the refresh signal — call immediately after a successful publish. */
export function notifySnapshotPublished(snapshot = null) {
  if (typeof window === 'undefined') return
  const detail = snapshot && typeof snapshot === 'object' ? snapshot : {}
  window.dispatchEvent(new CustomEvent(SNAPSHOT_EVENT, { detail }))
  try {
    getChannel()?.send({ type: 'broadcast', event: 'published', payload: { snapshotId: detail.snapshot_id ?? null } })
  } catch {
    /* realtime unavailable — the local event already fired */
  }
}

/**
 * Subscribe to refresh signals (local window event + remote broadcast).
 * Returns an unsubscribe function.
 */
export function subscribeSnapshotRefresh(callback) {
  if (typeof window === 'undefined' || typeof callback !== 'function') return () => {}

  const handler = (e) => callback(e?.detail || null)
  const wrapper = (detail) => callback(detail)
  window.addEventListener(SNAPSHOT_EVENT, handler)
  subscribers.add(wrapper)
  getChannel()

  let active = true
  return () => {
    if (!active) return
    active = false
    window.removeEventListener(SNAPSHOT_EVENT, handler)
    subscribers.delete(wrapper)
    releaseChannel()
  }
}
