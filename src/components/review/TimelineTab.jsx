import React from 'react'
import { History } from 'lucide-react'

export default function TimelineTab({ events }) {
  if (!events || events.length === 0) {
    return (
      <div className="text-center py-12">
        <History className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <p className="text-sm text-slate-400">No events recorded yet.</p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {events.map((e, idx) => (
        <div key={e.id || idx} className="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0">
          <div className="flex flex-col items-center flex-shrink-0">
            <div className="w-2.5 h-2.5 rounded-full bg-[#009944] mt-1.5" />
            {idx < events.length - 1 && <div className="w-px h-full bg-slate-200 mt-1" />}
          </div>
          <div className="flex-1 min-w-0 pb-1">
            <p className="text-sm font-medium text-slate-700 capitalize">
              {e.event_type?.replace(/_/g, ' ').toLowerCase()}
            </p>
            {e.details && <p className="text-xs text-slate-500 mt-0.5">{e.details}</p>}
            <p className="text-xs text-slate-400 mt-0.5">
              {e.created_at ? new Date(e.created_at).toLocaleString() : ''}
              {e.actor && <span> · {e.actor}</span>}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
