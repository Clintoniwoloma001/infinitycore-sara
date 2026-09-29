import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Bell, X } from 'lucide-react'
import { acknowledgeMessage, listMyPendingAcks } from '../../services/acknowledgementService'
import { resolveDirectory } from '../../services/corporateChatService'
import { useAuth } from '../../hooks/useAuth'

// ============================================================================
// GLOBAL ACKNOWLEDGEMENT REMINDER (points 7/8)
//
// Mounted once in Layout, above the routed content, so a pending obligation is
// visible on EVERY page — Dashboard, Employees, Leave, Attendance, Customers,
// Loans, Messages. Deliberately NOT scoped to the conversation carrying the
// message: the point is that a directive cannot be forgotten by navigating away.
//
// Dismissal is NOT acknowledgment. A dismissal is recorded in localStorage with
// a timestamp and resurfaces after exactly RESURFACE_MS, repeating until the
// server record for that message reads 'acknowledged'. Keeping dismissal purely
// client-side is deliberate: if it were an acknowledgment, hiding the banner
// would silently clear a compliance obligation.
//
// A small inline strip, not a modal. A modal would re-introduce the blocking
// behaviour requirement 1 removed.
// ============================================================================
const RESURFACE_MS = 5 * 60 * 1000 // exactly 5 minutes
const DISMISS_KEY = 'infinitycore:ack-dismissed'

function readDismissals() {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDismissals(map) {
  try {
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(map))
  } catch { /* private mode: the banner simply resurfaces sooner */ }
}

export default function AckReminderBanner() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [pending, setPending] = useState([])
  const [dismissed, setDismissed] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [names, setNames] = useState({})
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (!user?.id) return
    try {
      const rows = await listMyPendingAcks()
      if (!mounted.current) return
      setPending(rows)
      setDismissed(readDismissals())
      // Resolve sender names so the strip reads like a person, not a UUID.
      const ids = [...new Set(rows.map((r) => r.sender_id).filter(Boolean))]
      if (ids.length) {
        try {
          const dir = await resolveDirectory(ids)
          if (mounted.current) setNames(dir || {})
        } catch { /* names are cosmetic */ }
      }
    } catch { /* the banner must never break the shell */ }
  }, [user?.id])

  useEffect(() => {
    mounted.current = true
    if (!user?.id) return () => { mounted.current = false }
    refresh()
    // Polls as well, so a banner acknowledged on the mobile app clears here
    // without a manual reload. Realtime covers the same-user case; this covers
    // an acknowledgment recorded on another device minutes earlier.
    const id = setInterval(refresh, 60 * 1000)
    return () => { mounted.current = false; clearInterval(id) }
  }, [refresh, user?.id])

  // Resurface exactly RESURFACE_MS after a dismissal.
  useEffect(() => {
    const now = Date.now()
    const next = { ...readDismissals() }
    let changed = false
    Object.entries(next).forEach(([id, at]) => {
      if (now - Number(at || 0) >= RESURFACE_MS) { delete next[id]; changed = true }
    })
    if (changed) { writeDismissals(next); setDismissed(next) }
  }, [dismissed, pending])

  const visible = (pending || []).filter((row) => !dismissed[row.message_id])
  if (!user?.id || visible.length === 0) return null

  const oldest = visible[0]
  const urgent = String(oldest.priority).toLowerCase() === 'urgent'
  const senderName = names?.[oldest.sender_id]?.full_name
    || names?.[oldest.sender_id]?.email
    || 'A colleague'

  const goToMessage = (row) => {
    if (row.thread_id) navigate(`/messages/${row.thread_id}?focus=${row.message_id}`)
    else if (row.group_id) navigate(`/messages/group/${row.group_id}?focus=${row.message_id}`)
    else if (row.channel_id) navigate(`/messages/channel/${row.channel_id}?focus=${row.message_id}`)
    else navigate('/messages')
  }

  const onAcknowledge = async (row) => {
    setBusyId(row.message_id)
    try {
      await acknowledgeMessage(row.message_id)
      // Only a successful server write clears the obligation. On failure the
      // banner stays, because a locally-faked "done" would desync from the
      // record an audit reads.
      await refresh()
    } catch { /* keep the banner; the user can retry */ } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  const onDismiss = (row) => {
    const next = { ...readDismissals(), [row.message_id]: Date.now() }
    writeDismissals(next)
    setDismissed(next)
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-4 rounded-xl border px-4 py-3 shadow-sm flex items-start gap-3 ${
        urgent ? 'border-rose-300 bg-rose-50' : 'border-amber-300 bg-amber-50'
      }`}
    >
      {urgent
        ? <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
        : <Bell className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${urgent ? 'text-rose-900' : 'text-amber-900'}`}>
          {urgent ? 'URGENT MESSAGE' : 'IMPORTANT MESSAGE'} — acknowledgement required
        </p>
        <p className={`text-sm mt-0.5 ${urgent ? 'text-rose-800' : 'text-amber-800'}`}>
          {senderName} sent you a{urgent ? 'n urgent' : 'n important'} message.
          {visible.length > 1 && ` (${visible.length - 1} more waiting.)`}
        </p>
        {oldest.body && (
          <p className={`text-xs mt-1 line-clamp-2 ${urgent ? 'text-rose-700' : 'text-amber-700'}`}>
            {oldest.body}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => goToMessage(oldest)}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        >
          View
        </button>
        <button
          onClick={() => onAcknowledge(oldest)}
          disabled={busyId === oldest.message_id}
          className={`text-xs font-semibold px-3 py-1.5 rounded-lg text-white disabled:opacity-60 ${
            urgent ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-600 hover:bg-amber-700'
          }`}
        >
          {busyId === oldest.message_id ? 'Saving…' : 'Acknowledge'}
        </button>
        <button
          onClick={() => onDismiss(oldest)}
          title="Hide for 5 minutes (this does not acknowledge)"
          aria-label="Hide for 5 minutes"
          className="p-1.5 rounded-lg hover:bg-white/60"
        >
          <X className="w-4 h-4 text-slate-500" />
        </button>
      </div>
    </div>
  )
}

