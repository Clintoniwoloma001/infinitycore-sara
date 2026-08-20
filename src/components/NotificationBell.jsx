import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Clock } from 'lucide-react'
import { formatDate } from '../lib/utils'
import { useMyLeaveApprovals } from '../hooks/useMyLeaveApprovals'

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { count, oldest, queue } = useMyLeaveApprovals()

  const goToLeave = () => {
    setOpen(false)
    navigate('/leave-requests')
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-5 h-5" />
        {count > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-semibold flex items-center justify-center">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white rounded-2xl border border-slate-200 shadow-xl z-40 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 font-semibold text-sm text-slate-800">Notifications</div>
            {count === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">You're all caught up.</div>
            ) : (
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
