// ===========================================================================
// ScheduleMeetingDialog — put a meeting in the future, and manage it.
//
// This is the piece that was missing entirely: meetings could only be created
// at the instant you pressed record, so there was no "upcoming" list to show
// and no way to line up tomorrow's standup. A scheduled meeting is a real row
// with a future `started_at` and status 'scheduled'; recording it later
// appends a recording to that SAME row rather than creating a second meeting.
//
// It doubles as the edit sheet: with `meeting` supplied it reschedules,
// renames, moves the meeting between folders and manages participants.
//
// Everything goes through server-authorized RPCs, so the dialog never decides
// who may see a meeting — it renders what the database allowed.
// ===========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  X, Loader2, CalendarPlus, AlertTriangle, Check, Trash2, Save,
} from 'lucide-react'
import imeetService from '../../services/imeetService'

/** `YYYY-MM-DDTHH:mm` in LOCAL time, which is what `<input type="datetime-local">` wants. */
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** A sensible default: tomorrow at 09:00, not "now". */
function defaultStart() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d
}

export default function ScheduleMeetingDialog({
  folders = [],
  meeting = null,
  onClose,
  onSaved,
}) {
  const editing = Boolean(meeting)
  const [title, setTitle] = useState(meeting?.title || '')
  const [location, setLocation] = useState(meeting?.location || '')
  const [description, setDescription] = useState(meeting?.description || '')
  const [startsAt, setStartsAt] = useState(
    toLocalInput(meeting?.started_at ? new Date(meeting.started_at) : defaultStart()),
  )
  const [duration, setDuration] = useState(60)
  const [folderId, setFolderId] = useState(meeting?.folder_id || '')
  const [participants, setParticipants] = useState(meeting?.participants || [])
  const [people, setPeople] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    imeetService
      .listShareablePeople()
      .then(setPeople)
      .catch(() => setPeople([])) // a picker that cannot load must not block saving
  }, [])

  // Only folders the caller OWNS can receive a meeting. A folder shared with
  // the user is read-only, and the server would refuse the move anyway.
  const ownedFolders = useMemo(() => folders.filter((f) => f.is_owner), [folders])

  const chosen = useMemo(() => new Set(participants.map((p) => p.id || p)), [participants])

  const toggle = useCallback((person) => {
    const id = person.id
    setNotice(null)
    setParticipants((prev) => {
      const without = prev.filter((p) => (p.id || p) !== id)
      return chosen.has(id)
        ? without
        : [...without, { id, full_name: person.full_name, email: person.email }]
    })
  }, [chosen])

  const save = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const when = new Date(startsAt)
      if (Number.isNaN(when.getTime())) throw new Error('Choose a valid date and time.')
      const ids = participants.map((p) => p.id || p).filter(Boolean)

      if (editing) {
        await imeetService.updateMeeting(meeting.id, {
          title: title.trim(),
          startsAt: when.toISOString(),
          location: location.trim(),
          description: description.trim(),
          folderId: folderId || null,
          // Always explicit: without this, clearing the folder is a no-op.
          moveToFolder: true,
          durationMinutes: Number(duration) || 60,
          participantIds: ids.length ? ids : null,
        })
        setNotice('Meeting updated.')
      } else {
        await imeetService.scheduleMeeting({
          title: title.trim(),
          startsAt: when.toISOString(),
          location: location.trim(),
          description: description.trim(),
          folderId: folderId || null,
          durationMinutes: Number(duration) || 60,
          participantIds: ids.length ? ids : null,
        })
        setNotice('Meeting scheduled.')
      }
      await onSaved?.()
      // Give the notice a moment to register before the dialog disappears.
      setTimeout(() => onClose?.(), 600)
    } catch (e) {
      setError(e.message || 'The meeting could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!editing) return
    const ok = window.confirm(
      'Cancel this meeting? It stays in your history, marked as cancelled.',
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await imeetService.cancelMeeting(meeting.id)
      await onSaved?.()
      onClose?.()
    } catch (e) {
      setError(e.message || 'The meeting could not be cancelled.')
    } finally {
      setBusy(false)
    }
  }

  const field =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-[#009944]'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div className="my-8 w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              {editing ? 'Edit meeting' : 'Schedule a meeting'}
            </h2>
            <p className="text-xs text-slate-500">
              {editing
                ? 'Reschedule, rename, or move it into another folder.'
                : 'Set it up now and record it when the time comes.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Meeting title"
            className={field}
          />

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-slate-600">Starts</span>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className={field}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-slate-600">Duration (minutes)</span>
              <input
                type="number"
                min={5}
                max={1440}
                step={5}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className={field}
              />
            </label>
          </div>

          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location or link (optional)"
            className={field}
          />

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Agenda or notes (optional)"
            className={`${field} resize-y`}
          />

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-slate-600">Folder</span>
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className={field}
            >
              <option value="">No folder</option>
              {ownedFolders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>

          <div>
            <span className="mb-1 block text-[11px] font-medium text-slate-600">
              Participants ({participants.length})
            </span>
            {people.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                No one else could be loaded. You can still save the meeting.
              </p>
            ) : (
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {people.map((p) => {
                  const on = chosen.has(p.id)
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => toggle(p)}
                        className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs ${
                          on
                            ? 'border-[#009944] bg-emerald-50 text-[#007a37]'
                            : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <span className="min-w-0 truncate">
                          {p.full_name}
                          {p.email ? <span className="text-slate-400"> · {p.email}</span> : null}
                        </span>
                        {on && <Check className="ml-2 h-3.5 w-3.5 shrink-0" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>

        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
          </p>
        )}
        {notice && (
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            <Check className="h-3.5 w-3.5" />{notice}
          </p>
        )}

        <div className="mt-4 flex items-center justify-between gap-2">
          {editing ? (
            <button
              onClick={cancel}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />Cancel meeting
            </button>
          ) : <span />}

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Close
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : editing
                  ? <Save className="h-3.5 w-3.5" />
                  : <CalendarPlus className="h-3.5 w-3.5" />}
              {editing ? 'Save changes' : 'Schedule'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
