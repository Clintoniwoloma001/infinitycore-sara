// ============================================================================
// Leave booking (token link)
// ============================================================================
// A BOOKING, not a request. The copy on this page is deliberately unambiguous:
// reserving a date on the shared team calendar does not ask for time off, and
// nothing here starts an approval. The employee turns a booking into a real
// request themselves, from their Leave Requests page, once the HR window opens.
import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { CalendarCheck, CheckCircle2, Loader2, Lock } from 'lucide-react'
import { leaveBookingService } from '../services/leaveBookingService'
import { LEAVE_TYPE_LABELS } from '../services/leaveRulesService'
import { useAuth } from '../hooks/useAuth'

const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'

export default function LeaveBooking() {
  const { token } = useParams()
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()

  const [link, setLink] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [form, setForm] = useState({ leaveType: 'annual', start: '', end: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  useEffect(() => {
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const res = await leaveBookingService.getLink(token)
        if (!res?.ok) setError(res?.message || 'This booking link is not valid.')
        setLink(res)
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    })()
  }, [token])

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    if (!form.start || !form.end) return setError('Enter both a start and an end date.')
    if (form.end < form.start) return setError('The end date must be on or after the start date.')
    setBusy(true)
    try {
      setDone(await leaveBookingService.book({ token, ...form }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (loading || authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    )
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-lg rounded-xl border border-emerald-200 bg-white p-6 shadow-sm">
          <CheckCircle2 className="w-10 h-10 text-[#009944]" />
          <h1 className="mt-3 text-xl font-bold text-slate-900">Dates reserved</h1>
          <p className="mt-1 text-sm text-slate-600">
            {LEAVE_TYPE_LABELS[done.leave_type] || done.leave_type}: {done.start_date} to{' '}
            {done.end_date} ({done.working_days} working day
            {Number(done.working_days) === 1 ? '' : 's'}).
          </p>
          <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3">
            <p className="text-sm text-sky-900">{done.notice}</p>
          </div>
          <button onClick={() => navigate('/leave-requests')}
            className="mt-4 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
            Go to my leave requests
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <CalendarCheck className="w-6 h-6 text-[#009944]" />
          <h1 className="text-xl font-bold text-slate-900">
            {link?.label || 'Plan your leave'}
          </h1>
        </div>

        <p className="mt-2 text-sm text-slate-600">
          Tell us the dates you are planning to be away so your team can see the coverage
          picture.
        </p>

        {link?.note && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {link.note}
          </p>
        )}

        {!user ? (
          <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <Lock className="w-4 h-4" /> Sign in to reserve these dates
            </p>
            <p className="mt-1 text-xs text-slate-600">
              A reservation has to be attached to you, so we need to know who is booking.
            </p>
            <button onClick={() => navigate('/login')}
              className="mt-3 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
              Sign in
            </button>
          </div>
        ) : error && !link?.ok ? (
          <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        ) : (
          <>
            <form onSubmit={submit} className="mt-5 space-y-3">
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Leave type</span>
                <select className={field} value={form.leaveType}
                  onChange={(e) => setForm({ ...form, leaveType: e.target.value })}>
                  {Object.entries(LEAVE_TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">From</span>
                  <input type="date" required className={field} value={form.start}
                    onChange={(e) => setForm({ ...form, start: e.target.value })} />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">To</span>
                  <input type="date" required className={field} value={form.end}
                    onChange={(e) => setForm({ ...form, end: e.target.value })} />
                </label>
              </div>
              <label className="block text-sm">
                <span className="font-medium text-slate-700">Note (optional)</span>
                <input className={field} value={form.note}
                  placeholder="e.g. Family visit"
                  onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </label>
              {error && <p className="text-sm text-red-700">{error}</p>}
              <button type="submit" disabled={busy}
                className="w-full rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-50">
                {busy ? 'Reserving...' : 'Reserve these dates'}
              </button>
            </form>

            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3">
              <p className="text-sm font-medium text-sky-900">
                This reserves your planned dates on the team calendar &mdash; it is not a leave
                request.
              </p>
              <p className="mt-1 text-xs text-sky-800">
                You will need to formally request this leave closer to the date. You can request
                it once you are within the window HR has set, using the
                &ldquo;Request this leave&rdquo; button on your Leave Requests page.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

