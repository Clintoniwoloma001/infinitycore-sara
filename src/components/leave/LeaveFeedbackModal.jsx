import React, { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { leaveRequests as svc } from '../../services/supabaseService'
import { submitLeaveFeedback, listApprovalsFor } from '../../services/leaveApprovalsService'
import { formatDate } from '../../lib/utils'
import { LEAVE_TYPE_LABELS } from '../../services/leaveBalanceService'

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function LeaveFeedbackModal() {
  const { user } = useAuth()
  const [items, setItems] = useState([])
  const [approvals, setApprovals] = useState({})
  const [loading, setLoading] = useState(true)
  const [turnaround, setTurnaround] = useState(0)
  const [ease, setEase] = useState(0)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const load = async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const data = await svc.list()
      const pending = data.filter(
        (r) => r.created_by === user.id && ['approved', 'rejected'].includes(r.status) && !r.feedback_submitted
      )
      setItems(pending)
      if (pending.length > 0) {
        setApprovals(await listApprovalsFor(pending.map((r) => r.id)))
      }
    } catch { /* best-effort */ } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [user])

  const current = items[0]
  if (!loading && items.length === 0) return null
  if (!current) return null

  const submit = async () => {
    if (turnaround < 1 || ease < 1 || text.trim().length < 10) return
    setBusy(true)
    try {
      await submitLeaveFeedback({
        requestId: current.id,
        turnaroundRating: turnaround,
        easeRating: ease,
        feedbackText: text.trim(),
      })
      setDone(true)
      setTimeout(() => {
        setDone(false)
        setTurnaround(0)
        setEase(0)
        setText('')
        load()
      }, 1200)
    } catch (e) {
      alert(e?.message || 'Failed to submit feedback.')
    } finally {
      setBusy(false)
    }
  }

  const trail = approvals[current.id] || []

  return (
    <div className="fixed inset-0 z-[55] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-slate-900">Leave Feedback Required</h3>
          <p className="text-sm text-slate-500">
            Your {LEAVE_TYPE_LABELS[current.leave_type] || current.leave_type} request ({formatDate(current.start_date)} → {formatDate(current.end_date)}) was {current.status}.
          </p>
          {items.length > 1 && (
            <p className="text-xs text-slate-400 mt-1">{items.length} requests need feedback; this form will show the next one after you submit.</p>
          )}
        </div>

        {trail.length > 0 && (
          <div className="mb-5 border-l-2 border-slate-200 pl-3 space-y-2">
            {trail.map((t) => (
              <div key={t.id} className="text-xs text-slate-600">
                <b>{t.stage_label}</b> — {t.approver_name} {t.decision}
                {t.created_at ? ' · ' + new Date(t.created_at).toLocaleDateString() : ''}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className={labelCls}>How quickly was your request processed? *</label>
            <StarRating value={turnaround} onChange={setTurnaround} />
          </div>
          <div>
            <label className={labelCls}>How easy was the approval process? *</label>
            <StarRating value={ease} onChange={setEase} />
          </div>
          <div>
            <label className={labelCls}>Your feedback *</label>
            <textarea
              className={inputCls}
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Tell us about your experience so HR can keep improving the process."
            />
            <p className="text-xs text-slate-400 mt-1">Minimum 10 characters.</p>
          </div>
        </div>

        <div className="mt-6 flex justify-end items-center gap-3">
          {done && <span className="text-sm text-emerald-600">Feedback saved.</span>}
          <button
            onClick={submit}
            disabled={busy || turnaround < 1 || ease < 1 || text.trim().length < 10}
            className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Submit Feedback'}
          </button>
        </div>
      </div>
    </div>
  )
}

function StarRating({ value, onChange }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={`p-1 rounded hover:bg-amber-50 transition-colors ${n <= value ? 'text-amber-400' : 'text-slate-300'}`}
          aria-label={`Rate ${n}`}
        >
          <Star className="w-6 h-6" fill={n <= value ? 'currentColor' : 'none'} />
        </button>
      ))}
      <span className="ml-2 text-sm text-slate-500">{value > 0 ? `${value} / 5` : 'Select a rating'}</span>
    </div>
  )
}
