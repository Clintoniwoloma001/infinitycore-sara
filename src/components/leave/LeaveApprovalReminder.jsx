import React, { useEffect, useState, useCallback, useRef } from 'react'
import { AlertTriangle, Volume2, X } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { leaveRequests as svc } from '../../services/supabaseService'
import { myQueue, loadApprovalChainsForRequests } from '../../services/leaveApprovalsService'

const THIRTY_MIN = 30 * 60 * 1000

export default function LeaveApprovalReminder() {
  const { user, isAdmin, role } = useAuth()
  const [queue, setQueue] = useState([])
  const [show, setShow] = useState(true)
  const lastAudioRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!user?.id) return
    try {
      const items = await svc.list()
      const chains = await loadApprovalChainsForRequests(items)
      setQueue(myQueue(items, { userId: user.id, role, isAdmin }, chains))
    } catch { /* best-effort background reminder */ }
  }, [user, role, isAdmin])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, THIRTY_MIN)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    if (queue.length === 0 || !show) return
    const now = Date.now()
    if (now - lastAudioRef.current < THIRTY_MIN) return
    lastAudioRef.current = now

    const text = `You have ${queue.length} leave request${queue.length === 1 ? '' : 's'} awaiting your approval.`
    speak(text)

    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        try {
          new Notification('Leave approval reminder', {
            body: `${queue.length} leave request(s) need your approval.`,
            tag: 'leave-approval',
          })
        } catch { /* ignore */ }
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().catch(() => {})
      }
    }

    if ('vibrate' in navigator) {
      try { navigator.vibrate([200, 100, 200]) } catch { /* ignore */ }
    }
  }, [queue.length, show])

  if (queue.length === 0 || !show) return null

  return (
    <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 text-rose-800 p-4 flex items-start gap-3 shadow-sm">
      <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">
          {queue.length} leave request{queue.length === 1 ? '' : 's'} awaiting your approval
        </p>
        <p className="text-xs text-rose-600 mt-0.5">
          Sara will remind you every 30 minutes until they are decided.
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => speak(`You have ${queue.length} leave request${queue.length === 1 ? '' : 's'} awaiting your approval.`)}
          className="p-1.5 rounded hover:bg-rose-100"
          title="Repeat reminder"
        >
          <Volume2 className="w-4 h-4" />
        </button>
        <button onClick={() => setShow(false)} className="p-1.5 rounded hover:bg-rose-100">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

function speak(text) {
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1
    u.pitch = 1
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  }
}
