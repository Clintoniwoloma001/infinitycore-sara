// ===========================================================================
// FolderShareDialog — owner-only sharing management for an I-Meet folder.
//
// The owner adds or removes people; members see a read-only list saying who
// else has access. Every action goes through imeetService (server-authorized),
// and a removal takes effect immediately, so the member list is re-read from
// the database afterwards rather than patched optimistically.
// ===========================================================================
import React, { useCallback, useEffect, useState } from 'react'
import { X, UserPlus, Loader2, ShieldOff, Check, AlertTriangle } from 'lucide-react'
import { supabase } from '../../supabaseClient'
import imeetService from '../../services/imeetService'

export default function FolderShareDialog({ folder, onClose }) {
  const isOwner = imeetService.isOwner(folder)
  const [members, setMembers] = useState([])
  const [people, setPeople] = useState([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [canDownload, setCanDownload] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const loadMembers = useCallback(async () => {
    // A member cannot enumerate the folder, so we do not even try.
    if (!isOwner) { setLoading(false); return }
    try {
      setMembers(await imeetService.listMembers(folder.id))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [folder.id, isOwner])

  useEffect(() => { loadMembers() }, [loadMembers])

  // Candidate people, loaded once and filtered locally: a folder can have many
  // meetings but the staff list is small and stable.
  useEffect(() => {
    if (!isOwner) return
    supabase
      .from('profiles')
      .select('id, full_name, email, role, department')
      .eq('status', 'active')
      .order('full_name')
      .then(({ data, error: e }) => {
        if (e) setError(e.message)
        else setPeople(data || [])
      })
  }, [isOwner])

  const existing = new Set(members.map((m) => m.user_id))
  const filtered = people.filter((p) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return (
      (p.full_name || '').toLowerCase().includes(q) ||
      (p.email || '').toLowerCase().includes(q)
    )
  })

  const add = async () => {
    if (!selected) { setError('Choose a person to add.'); return }
    setBusy(true); setError(null); setNotice(null)
    try {
      await imeetService.share(folder.id, selected, { canView: true, canDownload })
      // Re-read from the database: the server is the authority on who has access.
      await loadMembers()
      setNotice(`Access granted to ${people.find((p) => p.id === selected)?.full_name || 'the user'}.`)
      setSelected('')
      setQuery('')
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  const remove = async (m) => {
    if (!window.confirm(`Remove ${m.full_name} from "${folder.name}"? They will lose access immediately.`)) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await imeetService.unshare(folder.id, m.user_id)
      await loadMembers()
      setNotice(`${m.full_name} no longer has access.`)
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl"
        role="dialog" aria-modal="true" aria-label={`Share ${folder.name}`}
      >
        <header className="flex items-start justify-between border-b border-slate-200 p-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Share "{folder.name}"</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {isOwner
                ? 'People you add can see this folder\u2019s summaries, transcripts and recordings. You can remove them at any time.'
                : 'This folder is shared with you by its owner. Only the owner can change who has access.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
            aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
            </p>
          )}
          {notice && (
            <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <Check className="h-3.5 w-3.5" />{notice}
            </p>
          )}

          {isOwner && (
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-medium text-slate-700">Add a person</p>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or email"
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Choose a person…</option>
                {filtered.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email}
                    {existing.has(p.id) ? ' — already has access' : ''}
                  </option>
                ))}
              </select>
              <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox" checked={canDownload}
                  onChange={(e) => setCanDownload(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
                Allow downloading recordings (uncheck to let them read summaries only)
              </label>
              <button
                onClick={add} disabled={busy || !selected}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                Grant access
              </button>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-slate-700">
              {isOwner ? `People with access (${members.length})` : 'Shared by the folder owner'}
            </p>
            {loading ? (
              <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…
              </p>
            ) : isOwner && members.length === 0 ? (
              <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                This folder is private to you. Add someone above to share it.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {members.map((m) => (
                  <li key={m.user_id}
                    className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-slate-800">{m.full_name}</div>
                      <div className="truncate text-[11px] text-slate-500">
                        {m.email}
                        {!m.can_download && ' · view only'}
                      </div>
                    </div>
                    {isOwner && (
                      <button
                        onClick={() => remove(m)} disabled={busy}
                        title="Remove access"
                        className="ml-2 inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        <ShieldOff className="h-3 w-3" />Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
