import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Clock } from 'lucide-react'
import { formatDate } from '../lib/utils'
import { useMyLeaveApprovals } from '../hooks/useMyLeaveApprovals'
import { getUnreadMessageCounts, unreadMessageTotal, markAllRead } from '../services/corporateChatService'
import { listMyPendingAcks } from '../services/acknowledgementService'

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [chatUnread, setChatUnread] = useState(0)
  const [ackPending, setAckPending] = useState(0)
  const [marking, setMarking] = useState(false)
  const navigate = useNavigate()
  const { count, oldest, queue } = useMyLeaveApprovals()
  const totalCount = count + chatUnread + ackPending

  useEffect(() => {
    let mounted = true
    const refresh = async () => {
      try {
        const payload = await getUnreadMessageCounts()
        if (mounted) setChatUnread(unreadMessageTotal(payload))
      } catch (_) {
        // The chat unread RPC is additive; the existing notification feed remains usable before it is deployed.
      }
      try {
        // Ack obligations are surfaced in the bell as well as the shell
        // banner, so a user who ignores the banner still sees them counted.
        const rows = await listMyPendingAcks()
        if (mounted) setAckPending(rows.length)
      } catch (_) { /* the banner is the authoritative surface */ }
    }
    refresh()
    const timer = window.setInterval(refresh, 60000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [])

  const goToLeave = () => {
    setOpen(false)
    navigate('/leave-requests')
  }

  const goToChat = () => {
    setOpen(false)
    navigate('/chat')
  }

  // "Mark all as read" clears the READ side of the feed only. It deliberately
  // does NOT acknowledge anything: dismissing or clearing a notification is
  // never compliance, and conflating the two would let a compliance obligation
  // be cleared without the user ever confirming it.
  const onMarkAllRead = async () => {
    setMarking(true)
    try {
      const ok = await markAllRead()
      if (ok) {
        setChatUnread(0)
        setAckPending(0)
      }
    } finally {
      setMarking(false)
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {totalCount > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-semibold flex items-center justify-center">
            {totalCount > 9 ? '9+' : totalCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white rounded-2xl border border-slate-200 shadow-xl z-40 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <span className="font-semibold text-sm text-slate-800">Notifications</span>
              {totalCount > 0 && (
                <button
                  onClick={onMarkAllRead}
                  disabled={marking}
                  className="text-[11px] font-medium text-[#009944] hover:underline disabled:opacity-50"
                >
                  {marking ? 'Marking…' : 'Mark all as read'}
                </button>
              )}
            </div>
            {totalCount === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">You're all caught up.</div>
            ) : (
              <>
                {count > 0 && (
                  <button onClick={goToLeave} className="w-full text-left px-4 py-3.5 hover:bg-slate-50 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                      <span className="text-sm font-medium text-slate-800">Leave Approval Required</span>
                    </div>
                    <p className="text-sm text-slate-500 mt-1">
                      {count} leave request{count === 1 ? '' : 's'} require{count === 1 ? 's' : ''} your approval.
                    </p>
                    {oldest && (
                      <p className="text-xs text-slate-400 mt-1.5 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Oldest pending: {formatDate(oldest.created_at)}
                      </p>
                    )}
                    <span className="inline-block text-xs font-medium text-[#009944] mt-2">Review →</span>
                  </button>
                )}
                {chatUnread > 0 && (
                  <button onClick={goToChat} className="w-full text-left px-4 py-3.5 border-t border-slate-100 hover:bg-slate-50 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#009944] shrink-0" />
                      <span className="text-sm font-medium text-slate-800">Unread messages</span>
                    </div>
                    <p className="text-sm text-slate-500 mt-1">{chatUnread} message{chatUnread === 1 ? '' : 's'} waiting in Messages.</p>
                    <span className="inline-block text-xs font-medium text-[#009944] mt-2">Open Messages →</span>
                  </button>
                )}
                {ackPending > 0 && (
                  <button
                    onClick={() => { setOpen(false); navigate('/messages') }}
                    className="w-full text-left px-4 py-3.5 border-t border-slate-100 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />
                      <span className="text-sm font-medium text-slate-800">Acknowledgement required</span>
                    </div>
                    <p className="text-sm text-slate-500 mt-1">
                      {ackPending} important or urgent message{ackPending === 1 ? '' : 's'} still awaiting your confirmation.
                    </p>
                    <span className="inline-block text-xs font-medium text-rose-600 mt-2">Review now →</span>
                  </button>
                )}
              </>
            )}
            {queue.length > 0 && (
              <div className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
                {queue.slice(0, 3).map((r) => r.employee_name).join(', ')}{queue.length > 3 ? ` +${queue.length - 3} more` : ''}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
