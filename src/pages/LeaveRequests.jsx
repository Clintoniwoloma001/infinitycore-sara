import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Check, X, Sparkles, AlertTriangle, Clock, ChevronDown, ChevronUp, Ban } from 'lucide-react'
import { leaveRequests as svc, logAction } from '../services/supabaseService'
import {
  listApprovalsFor,
  APPROVAL_CHAIN,
  APPROVER_ROLES,
  currentStage,
  isFinalStage,
  canActOnRequest,
  pendingAgeHours,
  executeLeaveDecision,
} from '../services/leaveApprovalsService'
import { formatDate, StatusBadge } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'
import SignaturePad from '../components/SignaturePad'
import {
  LEAVE_ENTITLEMENTS,
  LEAVE_TYPE_LABELS,
  getEmployeeBalances,
  balanceFor,
  currentYear,
} from '../services/leaveBalanceService'
import { computeLeaveInsights } from '../services/leaveInsightsService'

const EMPTY = { leave_type: 'annual', start_date: '', end_date: '', reason: '' }
const daysBetween = (s, e) => (!s || !e) ? 0 : Math.max(Math.ceil((new Date(e) - new Date(s)) / 86400000) + 1, 0)

export { APPROVAL_CHAIN }

// Aging / escalation policy — adjust freely, nothing else needs to change.
const WARN_HOURS = 24
const ESCALATE_HOURS = 48

const formatAge = (h) => h < 1 ? '<1h' : h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)}d`

const TABS = [
  { key: 'pending', label: 'Pending', match: (r) => r.status === 'pending' },
  { key: 'approved', label: 'Approved', match: (r) => r.status === 'approved' },
  { key: 'rejected', label: 'Rejected', match: (r) => r.status === 'rejected' },
  { key: 'cancelled', label: 'Cancelled', match: (r) => r.status === 'cancelled' },
]

export default function LeaveRequests() {
  const [items, setItems] = useState([])
  const [approvalsByRequest, setApprovalsByRequest] = useState({})
  const [expandedTrail, setExpandedTrail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [formError, setFormError] = useState(null)
  const [deciding, setDeciding] = useState(null) // { request, decision }
  const [comment, setComment] = useState('')
  const [signature, setSignature] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [myBalances, setMyBalances] = useState([])
  const [balancesLoading, setBalancesLoading] = useState(true)
  const escalationLoggedRef = useRef(new Set())

  const { name: userName, user, isAdmin, canManageLeave, role } = useAuth()
  const isApproverRole = isAdmin || canManageLeave || APPROVER_ROLES.includes(role)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await svc.list()
      setItems(data)
      try {
        setApprovalsByRequest(await listApprovalsFor(data.map((r) => r.id)))
      } catch { /* trail is supplementary, don't block the page on it */ }
      await escalateStaleRequests(data)
    } catch (e) {
      setError(e?.message || 'Failed to load leave requests')
    } finally {
      setLoading(false)
    }
  }

  // A request stuck at the same stage past ESCALATE_HOURS gets flagged for
  // HR oversight. It does NOT skip the required approver — that would mean
  // the system silently approving on someone's behalf.
  const escalateStaleRequests = async (data) => {
    if (!isApproverRole) return
    const stale = data.filter((r) => r.status === 'pending' && !escalationLoggedRef.current.has(r.id) && pendingAgeHours(r) >= ESCALATE_HOURS)
    for (const r of stale) {
      escalationLoggedRef.current.add(r.id)
      try {
        await logAction({ action: 'leave_stage_stuck', entityType: 'LeaveRequest', entityId: r.id, details: `${r.employee_name} — stuck at ${currentStage(r)?.label} for ${ESCALATE_HOURS}h+`, userName })
      } catch { /* best-effort */ }
    }
  }

  const loadMyBalances = async () => {
    if (!user) return
    setBalancesLoading(true)
    try {
      setMyBalances(await getEmployeeBalances(user.id, userName))
    } catch {
      setMyBalances([])
    } finally {
      setBalancesLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => { loadMyBalances() }, [user])

  const days = daysBetween(form.start_date, form.end_date)
  const liveBalance = useMemo(() => balanceFor(myBalances, form.leave_type), [myBalances, form.leave_type])
  const insights = useMemo(() => {
    if (!deciding) return null
    return computeLeaveInsights(items, deciding.request)
  }, [deciding, items])

  const submit = async () => {
    setFormError(null)
    if (!form.start_date || !form.end_date) return setFormError('Start and end dates are required.')
    if (days <= 0) return setFormError('End date must be on or after the start date.')
    if (form.leave_type !== 'unpaid' && days > liveBalance.remaining) {
      return setFormError(`You only have ${liveBalance.remaining} day(s) of ${LEAVE_TYPE_LABELS[form.leave_type].toLowerCase()} leave remaining this year.`)
    }
    setSubmitting(true)
    try {
      await svc.create({
        employee_name: userName,
        leave_type: form.leave_type,
        start_date: form.start_date,
        end_date: form.end_date,
        days,
        reason: form.reason,
        status: 'pending',
        approval_level: 1,
        is_cancellation: false,
        created_by: user?.id,
      })
      await logAction({ action: 'leave_submitted', entityType: 'LeaveRequest', details: `${form.leave_type} ${days}d`, userName })
      setOpen(false)
      setForm(EMPTY)
      load()
    } catch (e) {
      setFormError(e?.message || 'Failed to submit request.')
    } finally {
      setSubmitting(false)
    }
  }

  const openDecision = (request, decision) => {
    setDeciding({ request, decision })
    setComment('')
    setSignature(null)
  }

  const confirmDecision = async () => {
    if (!deciding || !signature) return
    const { request, decision } = deciding
    setSubmitting(true)
    try {
      await executeLeaveDecision({ request, decision, comment, signature, approverId: user?.id, approverName: userName, source: 'web' })
      setDeciding(null)
      setComment('')
      setSignature(null)
      load()
      loadMyBalances()
    } catch (e) {
      setFormError(e?.message || 'Failed to record decision.')
    } finally {
      setSubmitting(false)
    }
  }

  // Requester-initiated cancellation.
  const requestCancellation = async (r) => {
    if (r.status === 'pending' && !r.is_cancellation) {
      // Never finished the original chain — nothing was deducted yet, so
      // this is a straight cancel, no re-approval needed.
      if (!window.confirm('Cancel this pending leave request?')) return
      try {
        await svc.update(r.id, { status: 'cancelled' })
        await logAction({ action: 'leave_cancelled_pre_approval', entityType: 'LeaveRequest', entityId: r.id, details: `${r.employee_name} cancelled before approval — no balance change needed`, userName })
        load()
      } catch (e) { alert(e?.message || 'Failed to cancel.') }
      return
    }
    if (r.status === 'approved') {
      // Already fully approved (balance deducted) — cancellation must go
      // back through the same chain before it actually takes effect.
      if (!window.confirm('This leave is already approved. Submitting a cancellation will route back through Branch Manager → Area Manager → Head of Business → HR before it takes effect. Continue?')) return
      try {
        await svc.update(r.id, { status: 'pending', is_cancellation: true, approval_level: 1 })
        await logAction({ action: 'leave_cancellation_requested', entityType: 'LeaveRequest', entityId: r.id, details: `${r.employee_name} requested cancellation of an approved leave — routed for re-approval`, userName })
        load()
      } catch (e) { alert(e?.message || 'Failed to request cancellation.') }
    }
  }

  const canAct = (r) => canActOnRequest(r, { userId: user?.id, role, isAdmin })
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const sc = (s) => s === 'approved' ? 'emerald' : s === 'rejected' ? 'rose' : s === 'cancelled' ? 'slate' : 'amber'

  // Visibility: the requester always sees their own; approver-type roles
  // see everything. Everyone else sees only what belongs to them — RLS
  // enforces this server-side too, this is just the matching client view.
  const visibleItems = useMemo(
    () => isApproverRole ? items : items.filter((r) => r.created_by === user?.id),
    [items, isApproverRole, user]
  )

  const [tab, setTab] = useState('pending')
  const tabbedItems = useMemo(() => visibleItems.filter(TABS.find((t) => t.key === tab).match), [visibleItems, tab])
  const tabCounts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, visibleItems.filter(t.match).length])), [visibleItems])

  const myQueue = useMemo(() => visibleItems.filter((r) => canAct(r)), [visibleItems, user, isAdmin, role])
  const oldestPendingHours = myQueue.length ? Math.max(...myQueue.map(pendingAgeHours)) : 0
  const agingCount = myQueue.filter((r) => pendingAgeHours(r) >= WARN_HOURS).length

  return (
    <div>
      <div className="flex justify-between items-end mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Leave Requests</h2>
          <p className="text-sm text-slate-500 mt-1">Branch Manager → Area Manager → Head of Business → HR sign-off, with automated balance tracking</p>
        </div>
        <button onClick={() => { setOpen(true); setFormError(null) }} className="bg-[#009944] hover:bg-[#007a35] text-white px-4 py-2 rounded-lg text-sm flex items-center gap-1.5"><Plus className="w-4 h-4" /> Request Leave</button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-6">
        <h3 className="font-semibold text-slate-800 mb-3 text-sm">My Leave Balance · {currentYear()}</h3>
        {balancesLoading ? (
          <div className="text-sm text-slate-400">Loading balances…</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {Object.keys(LEAVE_ENTITLEMENTS).filter((t) => t !== 'unpaid').map((t) => {
              const b = balanceFor(myBalances, t)
              return (
                <div key={t} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                  <div className="text-xs text-slate-500">{LEAVE_TYPE_LABELS[t]}</div>
                  <div className="text-lg font-semibold text-slate-900 mt-0.5">{b.remaining}<span className="text-xs text-slate-400 font-normal"> / {b.entitled_days}d</span></div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {myQueue.length > 0 && (
        <div className={`mb-6 rounded-2xl border p-4 flex items-center gap-3 ${agingCount > 0 ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
          <Clock className={`w-5 h-5 shrink-0 ${agingCount > 0 ? 'text-amber-600' : 'text-slate-400'}`} />
          <p className="text-sm text-slate-700">
            <b>{myQueue.length}</b> request{myQueue.length === 1 ? '' : 's'} awaiting your approval
            {oldestPendingHours >= 1 && <> · oldest pending <b>{formatAge(oldestPendingHours)}</b></>}
            {agingCount > 0 && <span className="text-amber-700"> · {agingCount} aging past {WARN_HOURS}h</span>}
          </p>
        </div>
      )}

      {error && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-4 flex items-center gap-2"><AlertTriangle className="w-4 h-4 shrink-0" /> {error}</div>
      )}

      {/* Grouped tabs — keeps the list from turning into one long wall of cards */}
      <div className="flex items-center gap-1.5 mb-5 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t.key ? 'border-[#009944] text-[#009944]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            {t.label} <span className={`ml-1 text-xs ${tab === t.key ? 'text-[#009944]' : 'text-slate-400'}`}>{tabCounts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {loading ? <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div> : tabbedItems.length === 0 ? (
        <div className="text-center py-16 text-slate-400">No {tab} leave requests.</div>
      ) : (
        <div className="space-y-4">
          {tabbedItems.map((r) => {
            const trail = approvalsByRequest[r.id] || []
            const expanded = expandedTrail === r.id
            return (
              <div key={r.id} className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="font-semibold text-slate-900">{r.employee_name}</h3>
                      <StatusBadge label={LEAVE_TYPE_LABELS[r.leave_type] || r.leave_type} color="violet" />
                      <StatusBadge label={r.is_cancellation ? 'cancellation pending' : r.status} color={r.is_cancellation ? 'amber' : sc(r.status)} />
                      {r.status === 'pending' && (
                        <span className={`text-xs flex items-center gap-1 ${pendingAgeHours(r) >= ESCALATE_HOURS ? 'text-rose-600 font-medium' : pendingAgeHours(r) >= WARN_HOURS ? 'text-amber-600' : 'text-slate-400'}`}>
                          <Clock className="w-3 h-3" /> {formatAge(pendingAgeHours(r))} at this stage
                        </span>
                      )}
                    </div>

                    {r.status === 'pending' && (
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {APPROVAL_CHAIN.map((stage, i) => {
                          const idx = i + 1
                          const active = idx === r.approval_level
                          const done = idx < r.approval_level
                          return (
                            <React.Fragment key={stage.role}>
                              {i > 0 && <span className="text-slate-300 text-xs">›</span>}
                              <span className={`text-xs px-2 py-0.5 rounded-full ${active ? 'bg-amber-100 text-amber-700 font-medium' : done ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-400'}`}>
                                {stage.label}
                              </span>
                            </React.Fragment>
                          )
                        })}
                      </div>
                    )}

                    <div className="text-sm text-slate-500 mt-1.5">{formatDate(r.start_date)} → {formatDate(r.end_date)} · <b className="text-slate-700">{r.days}d</b></div>
                    {r.reason && <p className="text-sm text-slate-400 mt-1">{r.reason}</p>}

                    <button onClick={() => setExpandedTrail(expanded ? null : r.id)} className="text-xs text-[#009944] hover:underline mt-2 flex items-center gap-1">
                      {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {expanded ? 'Hide' : 'View'} approval trail
                    </button>
                    {expanded && (
                      <div className="mt-2 border-t border-slate-100 pt-2 space-y-1.5">
                        {trail.length === 0 ? (
                          <p className="text-xs text-slate-400">No decisions recorded yet.</p>
                        ) : trail.map((t) => (
                          <div key={t.id} className="text-xs text-slate-600 flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full ${t.decision === 'approved' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                            <b>{t.stage_label}</b> — {t.approver_name} {t.decision}{t.is_cancellation ? ' (cancellation)' : ''} {t.comment ? `· "${t.comment}"` : ''}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {canAct(r) && <>
                      <button onClick={() => openDecision(r, 'rejected')} className="px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 text-sm flex items-center gap-1"><X className="w-4 h-4" /> Reject</button>
                      <button onClick={() => openDecision(r, 'approved')} className="px-3 py-1.5 rounded-lg bg-[#009944] text-white text-sm flex items-center gap-1"><Check className="w-4 h-4" /> Approve</button>
                    </>}
                    {r.created_by === user?.id && (r.status === 'pending' || r.status === 'approved') && !r.is_cancellation && (
                      <button onClick={() => requestCancellation(r)} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-500 text-sm flex items-center gap-1"><Ban className="w-3.5 h-3.5" /> {r.status === 'approved' ? 'Request Cancellation' : 'Cancel'}</button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Request Leave modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <h3 className="font-semibold text-slate-900 mb-4">Request Leave</h3>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-700">Leave Type</label>
                <select value={form.leave_type} onChange={set('leave_type')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3">
                  {Object.keys(LEAVE_ENTITLEMENTS).map((t) => <option key={t} value={t}>{LEAVE_TYPE_LABELS[t]}</option>)}
                </select>
                <p className="text-xs text-slate-500 mt-1.5">
                  {form.leave_type === 'unpaid' ? 'No cap — always available.' : balancesLoading ? 'Checking balance…' : `You have ${liveBalance.remaining} of ${liveBalance.entitled_days} day(s) remaining this year.`}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-sm font-medium text-slate-700">Start *</label><input type="date" value={form.start_date} onChange={set('start_date')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
                <div><label className="text-sm font-medium text-slate-700">End *</label><input type="date" value={form.end_date} onChange={set('end_date')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
              </div>
              {form.start_date && form.end_date && <p className="text-sm text-slate-500">{days} day(s) — routes through Branch Manager → Area Manager → Head of Business → HR</p>}
              <div><label className="text-sm font-medium text-slate-700">Reason</label><textarea value={form.reason} onChange={set('reason')} rows={3} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" /></div>
              {formError && <p className="text-sm text-rose-600">{formError}</p>}
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600">Cancel</button>
              <button onClick={submit} disabled={submitting} className="px-4 py-2 rounded-lg bg-[#009944] text-white hover:bg-[#007a35] disabled:opacity-50">{submitting ? 'Submitting…' : 'Submit'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Approve/Reject decision modal */}
      {deciding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => !submitting && setDeciding(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="font-semibold text-slate-900 mb-1">
              {deciding.decision === 'approved' ? (isFinalStage(deciding.request) ? (deciding.request.is_cancellation ? 'Confirm Cancellation' : 'Give Final Approval') : `Approve — ${currentStage(deciding.request)?.label}`) : (deciding.request.is_cancellation ? 'Deny Cancellation' : 'Reject')}
            </h3>
            <p className="text-sm text-slate-500 mb-4">
              {deciding.request.employee_name} · {LEAVE_TYPE_LABELS[deciding.request.leave_type]}
              {deciding.request.is_cancellation && <span className="text-amber-600"> · cancellation request</span>}
              {deciding.decision === 'approved' && !isFinalStage(deciding.request) && (
                <> · will forward to <b>{APPROVAL_CHAIN[deciding.request.approval_level]?.label}</b> next</>
              )}
            </p>

            {insights && (
              <div className={`rounded-xl border p-4 mb-4 ${insights.suggestion.level === 'flag' ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-1.5 text-slate-600">
                  <Sparkles className="w-3.5 h-3.5" /> Insights
                </div>
                <p className="text-sm text-slate-700">{insights.summary}</p>
                <p className={`text-sm font-medium mt-2 ${insights.suggestion.level === 'flag' ? 'text-amber-700' : 'text-emerald-700'}`}>{insights.suggestion.text}</p>
              </div>
            )}

            <label className="text-sm font-medium text-slate-700">Comments {deciding.decision === 'rejected' ? '*' : '(optional)'}</label>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 mb-4" />

            <label className="text-sm font-medium text-slate-700">Sign to confirm *</label>
            <div className="mt-1"><SignaturePad onChange={setSignature} /></div>

            {formError && <p className="text-sm text-rose-600 mt-3">{formError}</p>}

            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setDeciding(null)} disabled={submitting} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600">Cancel</button>
              <button
                onClick={confirmDecision}
                disabled={submitting || !signature || (deciding.decision === 'rejected' && !comment.trim())}
                className={`px-4 py-2 rounded-lg text-white disabled:opacity-40 ${deciding.decision === 'approved' ? 'bg-[#009944] hover:bg-[#007a35]' : 'bg-rose-600 hover:bg-rose-700'}`}
              >
                {submitting ? 'Saving…' : deciding.decision === 'rejected' ? 'Confirm' : isFinalStage(deciding.request) ? 'Confirm Final Approval' : 'Approve & Forward'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
