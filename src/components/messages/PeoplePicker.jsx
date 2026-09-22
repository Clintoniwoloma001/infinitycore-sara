import React, { useMemo, useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import PersonAvatar from './PersonAvatar'
import { displayPersonName, personMatches } from './personUtils'

// Shared user-search/multi-select component for the Communication module.
// The ONE picker used by the Direct "New Message" modal (mode="single") and
// the channel/group "Add People" modal (mode="multi"). Filters the directory
// with the same personMatches() search used everywhere else in messages.
//
//   people      directory rows (id, full_name/name, email, department, ...)
//   excludeIds  ids to hide (e.g. current members of a conversation)
//   mode        'single' -> click a row to pick immediately
//               'multi'  -> checkbox rows + "Add selected (N)" footer action
//   onPick      (ids) — called with the chosen user ids; parent owns the work
//   busy        disable rows while the parent is saving (add/creating)
export default function PeoplePicker({
  title = 'Pick people',
  subtitle = '',
  people = [],
  excludeIds = [],
  mode = 'multi',
  onClose,
  onPick,
  busy = false,
  busyLabel = 'Saving…',
  emptyLabel = 'No matching people.',
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(() => new Set())

  const filtered = useMemo(() => {
    const excluded = new Set(excludeIds || [])
    return (people || []).filter((p) => !excluded.has(p.id) && personMatches(p, search))
  }, [people, excludeIds, search])

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pickSingle = (id) => onPick?.([id])

  const pickMulti = () => {
    if (busy || selected.size === 0) return
    onPick?.([...selected])
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-slate-900 truncate">{title}</h3>
            {subtitle && <p className="text-xs text-slate-400 truncate">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0 ml-2"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-3 border-b border-slate-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people…"
              className="w-full pl-9 h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
          {filtered.length === 0 && <div className="px-5 py-10 text-center text-sm text-slate-400">{emptyLabel}</div>}
          {filtered.map((p) => {
            const checked = selected.has(p.id)
            return (
              <button
                key={p.id}
                onClick={() => (mode === 'single' ? pickSingle(p.id) : toggle(p.id))}
                disabled={busy}
                className={`w-full text-left px-5 py-3 flex items-center gap-3 disabled:opacity-50 ${mode === 'single' ? 'hover:bg-emerald-50/50' : 'hover:bg-slate-50'}`}
              >
                {mode === 'multi' && (
                  <input type="checkbox" checked={checked} readOnly className="w-4 h-4 accent-[#009944]" />
                )}
                <PersonAvatar person={p} sizeClass="w-9 h-9" textClass="text-xs" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800 truncate">{displayPersonName(p)}</p>
                  <p className="text-xs text-slate-400 truncate">
                    {[p.department, p.position, p.role, p.employee_number || p.staff_id || p.staffId, p.email].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </button>
            )
          })}
        </div>

        {mode === 'multi' && (
          <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">{selected.size} selected</span>
            <button
              onClick={pickMulti}
              disabled={busy || selected.size === 0}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} {busyLabel}
            </button>
          </div>
        )}

        {mode === 'single' && busy && (
          <div className="px-5 py-4 text-center text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> {busyLabel}</div>
        )}
      </div>
    </div>
  )
}