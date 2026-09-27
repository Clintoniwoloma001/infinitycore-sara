// Generate / list / revoke leave booking links.
//
// Deliberately mirrors the QR attendance terminal's token handling: the raw
// key is shown ONCE, at creation, and only its hash lives in the database. A
// link that leaks from the database is therefore not a working link, and HR can
// always revoke and reissue rather than having to reason about who saw what.
import React, { useCallback, useEffect, useState } from 'react'
import { Link2, Plus, Copy, Check, Ban, X, AlertTriangle } from 'lucide-react'
import { leaveBookingService, describeWindow } from '../../services/leaveBookingService'
import { LoadingState, ErrorState } from '../PageStates'

const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'

function statusOf(l) {
  if (!l.is_active) return { label: 'Closed', cls: 'bg-slate-100 text-slate-500' }
  if (l.is_expired) return { label: 'Expired', cls: 'bg-slate-100 text-slate-500' }
  return { label: 'Active', cls: 'bg-emerald-100 text-emerald-800' }
}

export default function BookingLinkManager({ open, onClose }) {
  const [data, setData] = useState({ links: [], window_days: 14 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ label: '', note: '', expiresOn: '' })
  const [fresh, setFresh] = useState(null) // the one-time key
  const [copied, setCopied] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData(await leaveBookingService.listLinks()) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  if (!open) return null

  const create = async (e) => {
    e.preventDefault()
    setCreating(true); setError(null)
    try {
      const res = await leaveBookingService.createLink({
        label: form.label, note: form.note, expiresOn: form.expiresOn,
      })
      setFresh(res)
      setForm({ label: '', note: '', expiresOn: '' })
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (l) => {
    if (!window.confirm(
      `Close the link "${l.label}"?\n\nNo new bookings can be made through it. `
      + 'Bookings already made are kept, because people may be planning around them.',
    )) return
    setBusyId(l.id)
    try { await leaveBookingService.revokeLink(l.id); load() }
    catch (err) { setError(err.message) }
    finally { setBusyId(null) }
  }

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked: the URL is on screen to copy by hand */ }
  }

  const urlFor = (token) => `${window.location.origin}/leave-booking/${token}`

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="my-8 w-full max-w-3xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <Link2 className="w-5 h-5 text-[#009944]" />
            <h2 className="text-lg font-semibold text-slate-900">Booking links</h2>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <p className="text-xs leading-relaxed text-slate-600">
            A booking link asks staff to reserve <strong>planned dates</strong> on the shared
            team calendar. It is <strong>not</strong> a leave request and does not start any
            approval. Each person converts their own booking into a real request later, from
            their Leave Requests page, and that request then follows the normal approval chain.
            Employees can request their booked leave {describeWindow(data.window_days)}.
          </p>

          {error && <ErrorState title="Something went wrong" message={error} />}

          {fresh?.token && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">
                &ldquo;{fresh.label}&rdquo; is ready
              </p>
              <p className="mt-1 text-xs text-amber-800">
                Copy this link now &mdash; for security it is shown only once and is never
                displayed again.
              </p>
              <div className="mt-3 flex gap-2">
                <input readOnly value={urlFor(fresh.token)}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-xs" />
                <button onClick={() => copy(urlFor(fresh.token))}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          <form onSubmit={create} className="rounded-lg border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Create a new link</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block text-sm sm:col-span-2">
                <span className="font-medium text-slate-700">Name</span>
                <input required className={field} value={form.label}
                  placeholder="e.g. December leave planning"
                  onChange={(e) => setForm({ ...form, label: e.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Expires on (optional)</span>
                <input type="date" className={field} value={form.expiresOn}
                  onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
              </label>
            </div>
            <label className="mt-3 block text-sm">
              <span className="font-medium text-slate-700">Note for staff (optional)</span>
              <input className={field} value={form.note}
                placeholder="e.g. Please book by 30 Nov"
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
            <button type="submit" disabled={creating}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-50">
              <Plus className="w-4 h-4" />{creating ? 'Creating...' : 'Create link'}
            </button>
          </form>


          {loading ? <LoadingState label="Loading links..." /> : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    {['Name', 'Created', 'Bookings', 'Staff', 'Expires', 'State', ''].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.links.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                        No booking links yet. Create one above to start collecting planned dates.
                      </td>
                    </tr>
                  )}
                  {data.links.map((l) => {
                    const s = statusOf(l)
                    return (
                      <tr key={l.id}>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-900">{l.label}</div>
                          <div className="font-mono text-[10px] text-slate-400">
                            &hellip;{l.token_preview}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {new Date(l.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-slate-600">
                          {l.booking_count}
                          {l.active_booking_count > 0 && (
                            <span className="ml-1 text-[10px] text-sky-700">
                              ({l.active_booking_count} open)
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-slate-600">
                          {l.employee_count}
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {l.expires_on || '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`rounded px-2 py-0.5 text-xs ${s.cls}`}>
                            {s.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {l.is_active && !l.is_expired && (
                            <button onClick={() => revoke(l)} disabled={busyId === l.id}
                              className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-red-300 hover:text-red-600">
                              <Ban className="w-3 h-3" />Close
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="flex items-start gap-2 text-xs text-slate-500">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Closing a link stops it accepting new bookings immediately. Existing bookings are
            deliberately kept &mdash; closing a link is not a cancellation.
          </p>
        </div>
      </div>
    </div>
  )
}

