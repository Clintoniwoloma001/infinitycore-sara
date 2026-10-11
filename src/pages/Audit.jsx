// ============================================================================
// Audit & Compliance - the shared audit workspace (Phase 71 + Phase 72 + 73)
// ============================================================================
// TWO legacy registers, plus the Phase 72 shared obligation workspace:
//   REGULATORY MONITORING - what is due and who owns it.
//   AUDIT FINDINGS        - Open -> In Progress -> Pending Closeout -> Closed.
//   OBLIGATIONS           - every audit obligation, with the assignment rollup
//   SUBMISSIONS           - the versioned responses against them
//   SHARED AUDIT SCHEDULE - the obligations that carry a date or a recurrence
//   BOARD                 - the same obligations as a workflow
//
// PHASE 73 - ONE SOURCE OF TRUTH
// The Command Centre and this screen now read the SAME derived rollup:
// audit_obligation_states() (migration 20261111000004) is the single place the
// assignment count, the completion percentage, the outstanding-person list, the
// SLA state and the board lifecycle are computed. This page renders what the
// server returns and calls the server's RPCs - it never derives a percentage
// and never decides a transition.
//
// The board is therefore a VIEW of the canonical records, not a second system:
// a card's column is its obligation's derived lifecycle, so accepting the last
// outstanding submission moves the card to Completed with no manual drag. There
// is no drag-and-drop: a card cannot be moved past the server's rules.
//
// PERMISSIONS
// get_audit_workspace() refuses anyone who is not an audit-workspace member
// (audit department staff, Head of Audit, the two break-glass admins) and
// rejects the call server-side with AUDIT_FORBIDDEN. That is NOT rendered as an
// error: such an account simply keeps the two legacy registers, exactly as it
// did before the shared workspace existed.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ShieldCheck, Plus, CalendarClock, ClipboardList, CheckCircle2, Loader2, X,
  ListChecks, Gavel, MessageSquareWarning, Inbox, LayoutGrid, CalendarDays,
  AlertTriangle, ArrowRight, Users, FileText,
} from 'lucide-react'
import {
  auditService, REGULATORY_STATUS, FINDING_STATUS, ASSIGNMENT_STATUS, SUBMISSION_STATUS,
  SLA_STATE, OBLIGATION_TYPE, fmtDate,
} from '../services/auditService'
import { employeeService } from '../services/employeeService'
import { LoadingState, ErrorState, EmptyState } from '../components/PageStates'
import { useAuth } from '../hooks/useAuth'
import {
  BOARD_COLUMNS, LIFECYCLE, RISK_TONE,
  completionSummary, initialsOf, isBoardCard, isFindingObligation, isRegulatoryObligation,
  recurrenceLabel, summariseNames,
} from '../domains/audit/obligationBoard'

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'
const ghostBtn = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1'
const card = 'bg-white rounded-2xl border border-slate-200 p-5'

function Stat({ label, value, tone = 'slate' }) {
  const tones = { slate: 'text-slate-900', red: 'text-red-600', amber: 'text-amber-600', green: 'text-emerald-600' }
  return (
    <div className="rounded-xl border border-slate-200 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  )
}

function Chip({ map, value }) {
  const s = map[value] || { label: value, chip: 'bg-slate-100 text-slate-600' }
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.chip}`}>{s.label}</span>
}

/** The next stage. Enforced server-side as well - this is only a shortcut. */
function nextStatus(status) {
  if (status === 'open') return 'in_progress'
  if (status === 'in_progress') return 'pending_closeout'
  return 'closed'
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const BLANK_REG = {
  id: null, name: '', dueDate: '', processOwnerEmployeeId: '',
  leadTimeDays: 14, status: 'pending', description: '',
}
const BLANK_FIND = {
  title: '', processOwnerEmployeeId: '', department: '',
  severity: 'medium', description: '', dueDate: '',
}

// ===========================================================================
// Shared card chrome
// ===========================================================================
function Meter({ pct, tone }) {
  const tones = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', slate: 'bg-slate-400' }
  const value = Math.max(0, Math.min(100, Number(pct) || 0))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
      <div className={`h-full rounded-full ${tones[tone] || tones.slate}`} style={{ width: `${value}%` }} />
    </div>
  )
}

function AvatarStack({ assignees = [], max = 4 }) {
  const shown = assignees.slice(0, max)
  const extra = assignees.length - shown.length
  return (
    <div className="flex items-center">
      <div className="flex -space-x-1.5">
        {shown.map((a) => (
          <span key={a.assignment_id || a.name}
            title={`${a.name} — ${ASSIGNMENT_STATUS[a.status]?.label || a.status}`}
            className={`flex h-6 w-6 items-center justify-center rounded-full ring-2 ring-white text-[9px] font-bold ${
              a.is_complete ? 'bg-emerald-500 text-white' : 'bg-slate-300 text-slate-700'}`}>
            {initialsOf(a.name)}
          </span>
        ))}
      </div>
      {extra > 0 && (
        <span className="ml-1.5 text-[10px] font-medium text-slate-500">+{extra}</span>
      )}
    </div>
  )
}

/**
 * One obligation, one card. Everything on it is a value the server already
 * computed on the canonical obligation record.
 */
function ObligationCard({ obligation: o, onOpen }) {
  const summary = completionSummary(o)
  const lifecycle = LIFECYCLE[o.lifecycle] || { label: o.lifecycle, chip: 'bg-slate-100 text-slate-600' }
  const due = o.effective_deadline
  const overdue = o.is_overdue
  return (
    <button type="button" onClick={() => onOpen(o.id)}
      className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-slate-300 hover:shadow focus:outline-none focus:ring-2 focus:ring-[#009944]/40">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-slate-400">{o.reference}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${RISK_TONE[o.risk_rating] || RISK_TONE.medium}`}>
          {o.risk_rating || '—'}
        </span>
      </div>

      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-slate-900">{o.title}</div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
          {OBLIGATION_TYPE[o.obligation_type] || o.obligation_type}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${lifecycle.chip}`}>{lifecycle.label}</span>
        {overdue && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">Overdue</span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="truncate">{o.department}</span>
        <AvatarStack assignees={o.assignees} />
      </div>

      <div className="mt-2 space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span className="font-medium text-slate-600">
            {summary.done} of {summary.total} · {Math.round(Number(o.completion_pct) || 0)}%
          </span>
          <span className={overdue ? 'font-semibold text-red-600' : ''}>
            {due ? fmtDate(due) : 'No date'}
            {o.days_until_due != null && due
              ? (o.days_until_due >= 0 ? ` · ${o.days_until_due}d` : ` · ${Math.abs(o.days_until_due)}d late`)
              : ''}
          </span>
        </div>
        <Meter pct={o.completion_pct}
          tone={(Number(o.completion_pct) || 0) >= 100 ? 'green' : (Number(o.completion_pct) || 0) >= 50 ? 'amber' : 'red'} />
        {summary.total > 0 && summary.done < summary.total && (
          <p className="text-[11px] text-slate-500">
            <span className="font-medium text-slate-600">Awaiting:</span> {summariseNames(summary.pending)}
          </p>
        )}
        {summary.total === 0 && (
          <p className="text-[11px] text-amber-700">No responsible person assigned yet.</p>
        )}
      </div>
    </button>
  )
}

// ===========================================================================
// The board: the obligations the table shows, as the workflow the audit team
// actually works. One column per derived lifecycle, so a card's position IS
// its state and nothing can drift between the two.
// ===========================================================================
function AuditBoard({ obligations, onOpen }) {
  const cards = (obligations || []).filter(isBoardCard)
  return (
    <div className="-mx-1 overflow-x-auto pb-2" role="region" aria-label="Audit obligation board">
      <div className="flex min-w-max gap-3 px-1">
        {BOARD_COLUMNS.map((col) => {
          const items = cards.filter((o) => col.lifecycles.includes(o.lifecycle))
          return (
            <section key={col.key} className="flex w-[264px] shrink-0 flex-col rounded-2xl bg-slate-100/70 p-2 sm:w-[288px]">
              <header className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 ${col.header}`} title={col.hint}>
                <span className="text-xs font-semibold leading-tight">{col.label}</span>
                <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-bold tabular-nums">{items.length}</span>
              </header>
              <div className="mt-2 space-y-2">
                {items.map((o) => (
                  <ObligationCard key={o.id} obligation={o} onOpen={onOpen} />
                ))}
                {items.length === 0 && (
                  <p className="rounded-xl border border-dashed border-slate-200 bg-white/60 px-3 py-6 text-xs text-slate-400">
                    Nothing here
                  </p>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

// ===========================================================================
// Obligation detail drawer - the complete record behind a card
// ===========================================================================
function ObligationDrawer({ obligation, submissions, onClose }) {
  if (!obligation) return null
  const o = obligation
  const summary = completionSummary(o)
  const lifecycle = LIFECYCLE[o.lifecycle] || { label: o.lifecycle, chip: 'bg-slate-100 text-slate-600' }
  const mine = (submissions || []).filter((s) => s.obligation_id === o.id)
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40" onClick={onClose} role="dialog" aria-modal="true">
      <aside className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="font-mono text-xs text-slate-400">{o.reference}</span>
            <h2 className="text-lg font-semibold text-slate-900">{o.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${lifecycle.chip}`}>{lifecycle.label}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {OBLIGATION_TYPE[o.obligation_type] || o.obligation_type}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{o.department}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_TONE[o.risk_rating] || RISK_TONE.medium}`}>
                {o.risk_rating} risk
              </span>
              {o.is_overdue && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Overdue</span>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close detail" className="text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 p-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium text-slate-800">Completion</span>
            <span className="tabular-nums text-xs text-slate-500">
              {summary.done} of {summary.total} · {Math.round(Number(o.completion_pct) || 0)}%
            </span>
          </div>
          <div className="mt-2"><Meter pct={o.completion_pct} tone={(Number(o.completion_pct) || 0) >= 100 ? 'green' : 'amber'} /></div>
          <p className="mt-2 text-xs text-slate-600">{summary.text}</p>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-600">
          <div><dt className="text-slate-400">Submission due</dt><dd className="font-medium text-slate-800">{o.effective_deadline ? fmtDate(o.effective_deadline) : '—'}</dd></div>
          <div><dt className="text-slate-400">Acknowledgement by</dt><dd className="font-medium text-slate-800">{o.acknowledgement_deadline ? fmtDate(o.acknowledgement_deadline) : '—'}</dd></div>
          <div><dt className="text-slate-400">Review by</dt><dd className="font-medium text-slate-800">{o.review_deadline ? fmtDate(o.review_deadline) : '—'}</dd></div>
          <div><dt className="text-slate-400">Recurrence</dt><dd className="font-medium text-slate-800">{recurrenceLabel(o.recurrence_rule)}</dd></div>
          <div><dt className="text-slate-400">Next occurrence</dt><dd className="font-medium text-slate-800">{o.next_occurrence ? fmtDate(o.next_occurrence) : '—'}</dd></div>
          <div><dt className="text-slate-400">SLA state</dt><dd className="font-medium text-slate-800">{o.sla_state}</dd></div>
          <div><dt className="text-slate-400">Acknowledgement required</dt><dd className="font-medium text-slate-800">{o.requires_acknowledgement ? 'Yes' : 'No'}</dd></div>
          <div><dt className="text-slate-400">Submission required</dt><dd className="font-medium text-slate-800">{o.requires_submission ? 'Yes' : 'No'}</dd></div>
        </dl>

        {o.description && <p className="mt-4 text-sm text-slate-600">{o.description}</p>}
        {o.instructions && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            <span className="font-semibold text-slate-700">Instructions: </span>{o.instructions}
          </div>
        )}

        {Array.isArray(o.required_documents) && o.required_documents.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Required documents</h3>
            <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
              {o.required_documents.map((d, i) => (
                <li key={i}>{typeof d === 'string' ? d : d?.name || JSON.stringify(d)}</li>
              ))}
            </ul>
          </div>
        )}

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Responsible persons ({summary.total})
        </h3>
        <div className="mt-2 space-y-2">
          {(o.assignees || []).map((a) => (
            <div key={a.assignment_id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  a.is_complete ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-700'}`}>
                  {initialsOf(a.name)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-800">{a.name}</div>
                  <div className="truncate text-[11px] text-slate-400">{a.email || ''}</div>
                </div>
              </div>
              <Chip map={ASSIGNMENT_STATUS} value={a.status} />
            </div>
          ))}
          {(o.assignees || []).length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
              No responsible person has been assigned yet.
            </p>
          )}
        </div>

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Submissions ({mine.length})
        </h3>
        <div className="mt-2 space-y-2">
          {mine.map((s) => (
            <div key={s.submission_id} className="rounded-lg border border-slate-200 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-slate-800">v{s.version} · {s.submitted_by_name}</span>
                <Chip map={SUBMISSION_STATUS} value={s.status} />
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {s.submitted_at ? new Date(s.submitted_at).toLocaleString() : ''}
                {s.reviewed_at ? ` · reviewed ${new Date(s.reviewed_at).toLocaleDateString()} by ${s.reviewed_by_name || 'audit'}` : ''}
              </div>
              {s.correction_reason && (
                <p className="mt-1 rounded bg-orange-50 px-2 py-1 text-[11px] text-orange-800">
                  Correction requested: {s.correction_reason}
                </p>
              )}
            </div>
          ))}
          {mine.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
              No submissions yet.
            </p>
          )}
        </div>

        <p className="mt-5 font-mono text-[10px] text-slate-300">obligation id {o.id}</p>
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
            Close
          </button>
        </div>
      </aside>
    </div>
  )
}

export default function Audit() {
  const { hasPermission, profile } = useAuth()
  const [params, setParams] = useSearchParams()

  // The shared Audit Workspace (Phase 72). The server refuses non-members with
  // AUDIT_FORBIDDEN; that is NOT an error here - it simply means this account
  // keeps the two registers below and loses the shared tabs.
  const [workspace, setWorkspace] = useState(null)

  // Shared-workspace tabs are only offered when the server admitted this
  // account; otherwise the param falls back to the first register so a
  // bookmarked link never lands on an unavailable tab.
  const SHARED_TABS = ['obligations', 'submissions', 'schedule', 'board', 'review']
  const rawTab = params.get('tab')
  const tab = (SHARED_TABS.includes(rawTab) && !workspace)
    ? 'regulatory'
    : rawTab || 'regulatory'

  // Read is gated server-side too; this only decides whether to show buttons.
  const canManage = hasPermission('audit.monitoring.manage')
    || ['super_admin', 'admin', 'head_of_audit'].includes(profile?.role)

  const [draft, setDraft] = useState({})
  const [returning, setReturning] = useState(null)
  const [returnReason, setReturnReason] = useState('')
  // View toggle on the obligations tab: the same obligations as a table or as
  // the board the audit team works from day to day.
  const [view, setView] = useState('board')
  const [detailId, setDetailId] = useState(null)

  // Registers and UI state for the original two tabs
  const [reg, setReg] = useState(null)
  const [findings, setFindings] = useState(null)
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showReg, setShowReg] = useState(false)
  const [showFinding, setShowFinding] = useState(false)
  const [closeout, setCloseout] = useState(null)
  const [closeoutNotes, setCloseoutNotes] = useState('')
  const [regForm, setRegForm] = useState(BLANK_REG)
  const [findForm, setFindForm] = useState(BLANK_FIND)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [r, f] = await Promise.all([auditService.listRegulatory(), auditService.listFindings()])
      setReg(r); setFindings(f)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [])

  // The shared workspace loads SEPARATELY and softly: a refusal (the server's
  // role check) or a network failure leaves the registers above untouched.
  const loadWorkspace = useCallback(async () => {
    try {
      const w = await auditService.workspace()
      setWorkspace(w && w.ok !== false ? w : null)
    } catch { setWorkspace(null) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadWorkspace() }, [loadWorkspace])
  useEffect(() => { employeeService.list().then(setEmployees).catch(() => setEmployees([])) }, [])

  // ---- Phase 73: live refresh ---------------------------------------------
  // The board is a view of canonical rows, so it is REFETCHED when those rows
  // change - never optimistically patched. Realtime is scoped to the three
  // audit tables and torn down on unmount; a focus refetch covers a grant
  // revoked or a submission accepted from another device.
  useEffect(() => auditService.subscribeToObligationChanges(() => { loadWorkspace() }), [loadWorkspace])

  useEffect(() => {
    const onFocus = () => { loadWorkspace() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadWorkspace])

  // ---- Shared workspace actions (Phase 72) --------------------------------
  const acknowledge = async (assignmentId) => {
    setFormError(null); setBusy(true)
    try { await auditService.acknowledgeAssignment(assignmentId); await loadWorkspace() }
    catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const submitResponse = async (assignmentId, isFinal = true) => {
    setFormError(null); setBusy(true)
    try {
      const response = (draft[assignmentId] || '').trim()
      if (!response) { setFormError('Type your response before submitting.'); setBusy(false); return }
      await auditService.submitResponse(assignmentId, {
        payload: { response }, files: [], isFinal,
      })
      setDraft((d) => ({ ...d, [assignmentId]: '' }))
      await loadWorkspace()
    } catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const reviewSubmission = async (submissionId, decision) => {
    setFormError(null); setBusy(true)
    try {
      await auditService.reviewSubmission(submissionId, decision, returnReason.trim() || null, [])
      setReturning(null); setReturnReason('')
      await loadWorkspace()
    } catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const saveReg = async (e) => {
    e.preventDefault(); setFormError(null); setBusy(true)
    try {
      await auditService.saveRegulatory(regForm)
      setShowReg(false); setRegForm(BLANK_REG); load()
    } catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const markFiled = async (item) => {
    setFormError(null); setBusy(true)
    try {
      await auditService.saveRegulatory({ ...item, dueDate: item.due_date, status: 'filed' })
      load()
    } catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const saveFinding = async (e) => {
    e.preventDefault(); setFormError(null); setBusy(true)
    try {
      await auditService.createFinding(findForm)
      setShowFinding(false); setFindForm(BLANK_FIND); load()
    } catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const advance = async (f, to) => {
    if (to === 'closed') { setCloseout(f); setCloseoutNotes(''); return }
    setFormError(null); setBusy(true)
    try { await auditService.advanceFinding(f.id, to); load() }
    catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const confirmCloseout = async () => {
    setFormError(null); setBusy(true)
    try {
      await auditService.advanceFinding(closeout.id, 'closed', closeoutNotes)
      setCloseout(null); setCloseoutNotes(''); load()
    } catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  // Derived from the workspace payload; empty until the server admits us.
  // Declared BEFORE the register views below: a const is in its temporal dead
  // zone until its own declaration runs, so anything above it that touches
  // `obligations` throws "Cannot access 'obligations' before initialization".
  const obligations = workspace?.obligations || []
  const submissions = workspace?.submissions || []
  const schedule = workspace?.schedule || []
  const myAssignments = workspace?.my_assignments || []
  const reviewQueue = workspace?.review_queue || []
  const completion = workspace?.completion || {}
  const byLifecycle = completion.by_lifecycle || {}
  const obligationById = useMemo(
    () => new Map(obligations.map((o) => [o.id, o])),
    [obligations],
  )
  const detail = detailId ? obligationById.get(detailId) || null : null

  const regSummary = reg?.summary || {}
  const findSummary = findings?.summary || {}
  // Phase 73: the two legacy registers are REPLACED on screen by the canonical
  // obligations they describe. regulatory_items / audit_findings were a separate
  // table that nobody populated, which is why these tabs read "No regulatory
  // items yet" while the Command Centre showed the real register. The obligations
  // ARE the register: a REG-* obligation is a regulatory return, a CIR-* one a
  // regulatory circular, an AUD-* finding obligation is an audit finding. The
  // legacy tables stay live below as the manual-entry path.
  const regRows = useMemo(() => (obligations || []).filter(isRegulatoryObligation), [obligations])
  const findRows = useMemo(() => (obligations || []).filter(isFindingObligation), [obligations])
  const regLegacy = reg?.items || []
  const findLegacy = findings?.findings || []
  const dueWithin = (o, days) => o.effective_deadline != null
    && o.days_until_due != null && o.days_until_due >= 0 && o.days_until_due <= days
  const outstandingWork = (rows) => rows.reduce((n, o) => n + (Number(o.outstanding_count) || 0), 0)

  const tabs = [
    ...(workspace ? [
      { id: 'obligations', label: 'Obligations', icon: ListChecks, count: obligations.length },
      { id: 'submissions', label: 'Submissions', icon: Inbox, count: submissions.length },
      { id: 'schedule', label: 'Shared audit schedule', icon: CalendarDays, count: schedule.length },
      { id: 'board', label: 'Board', icon: LayoutGrid, count: obligations.filter(isBoardCard).length },
      ...(reviewQueue.length > 0 ? [{ id: 'review', label: 'Review queue', icon: Gavel, count: reviewQueue.length }] : []),
    ] : []),
    { id: 'regulatory', label: 'Regulatory monitoring', icon: CalendarClock },
    { id: 'findings', label: 'Audit findings', icon: ClipboardList },
  ]

  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <ShieldCheck className="w-6 h-6 text-[#009944]" />Audit &amp; Compliance
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          One canonical obligation record behind every view: the register, the submissions, the shared schedule and the board.
        </p>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button key={id} onClick={() => setParams(id === 'regulatory' ? {} : { tab: id })}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === id
              ? 'border-[#009944] text-[#009944]'
              : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            <Icon className="w-4 h-4" />{label}
            {count != null && (
              <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-600">{count}</span>
            )}
          </button>
        ))}
      </nav>

      {error && <ErrorState title="Unable to load audit data" message={error} />}
      {formError && <p className="text-sm text-red-700">{formError}</p>}
      {loading && <LoadingState label="Loading audit registers..." />}


      {!loading && !error && tab === 'regulatory' && (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Regulatory obligations" value={regRows.length} />
            <Stat label="Completed" value={regRows.filter((o) => o.lifecycle === 'completed').length} tone="green" />
            <Stat label="In progress" value={regRows.filter((o) => o.lifecycle === 'in_progress').length} tone="amber" />
            <Stat label="Outstanding people" value={outstandingWork(regRows)} tone="red" />
            <Stat label="Overdue" value={regRows.filter((o) => o.sla_state === 'overdue').length} tone="red" />
            <Stat label="Due in 30 days" value={regRows.filter((o) => dueWithin(o, 30)).length} />
          </div>

          {canManage && (
            <div className="flex justify-end">
              <button onClick={() => setShowReg(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
                <Plus className="w-4 h-4" />Add regulatory item
              </button>
            </div>
          )}

          {regRows.length === 0 ? (
            regLegacy.length === 0 ? (
              <EmptyState title="No regulatory items yet"
                description="Add the filings and monitoring items Audit tracks, with an owner and a due date." />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>{['Item', 'Process owner', 'Due', 'Days', 'Status', ''].map((h) => (
                      <th key={h} className="px-4 py-2 font-medium">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {regLegacy.map((r) => (
                      <tr key={r.id} className={r.is_overdue ? 'bg-red-50' : ''}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900">{r.name}</div>
                          {r.description && <div className="text-xs text-slate-500">{r.description}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{r.process_owner_name}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{fmtDate(r.due_date)}</td>
                        <td className="px-4 py-2.5 tabular-nums">
                          {r.status === 'filed' ? <span className="text-slate-400">—</span>
                            : r.is_overdue
                              ? <span className="font-medium text-red-700">{Math.abs(r.days_until_due)}d late</span>
                              : <span className="text-slate-600">{r.days_until_due}d</span>}
                        </td>
                        <td className="px-4 py-2.5"><Chip map={REGULATORY_STATUS} value={r.status} /></td>
                        <td className="px-4 py-2.5 text-right">
                          {canManage && r.status !== 'filed' && (
                            <button onClick={() => markFiled(r)} disabled={busy}
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-emerald-300 hover:text-emerald-700">
                              Mark filed
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white">
              <header className="border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-900">Regulatory obligations</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Every obligation of a regulatory type — regulatory returns and regulatory circulars — read live from the
                  canonical register, so this tab, the Command Centre and the board can never disagree.
                </p>
              </header>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>{['Reference', 'Obligation', 'Type', 'Department', 'Responsible', 'Completion', 'Next / due', 'SLA', 'Lifecycle'].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {regRows.map((o) => {
                      const summary = completionSummary(o)
                      const lifecycle = LIFECYCLE[o.lifecycle] || { label: o.lifecycle, chip: 'bg-slate-100 text-slate-600' }
                      return (
                        <tr key={o.id} className={o.sla_state === 'overdue' ? 'bg-red-50' : ''}>
                          <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{o.reference}</td>
                          <td className="px-3 py-2.5">
                            <button onClick={() => setDetailId(o.id)} className="text-left">
                              <div className="font-medium text-slate-900 hover:text-[#009944]">{o.title}</div>
                            </button>
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">{OBLIGATION_TYPE[o.obligation_type] || o.obligation_type}</td>
                          <td className="px-3 py-2.5 text-slate-600">{o.department}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <AvatarStack assignees={o.assignees} />
                              <span className="text-xs text-slate-500">{o.assigned_count}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-xs tabular-nums text-slate-600">
                            {summary.done}/{summary.total} · {Math.round(Number(o.completion_pct) || 0)}%
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                            {o.effective_deadline ? fmtDate(o.effective_deadline) : '—'}
                            {o.days_until_due != null && o.effective_deadline && (
                              <div className="text-[11px] text-slate-400">
                                {o.days_until_due >= 0 ? `in ${o.days_until_due}d` : `${Math.abs(o.days_until_due)}d late`}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5"><Chip map={SLA_STATE} value={o.sla_state} /></td>
                          <td className="px-3 py-2.5"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${lifecycle.chip}`}>{lifecycle.label}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}


      {!loading && !error && tab === 'findings' && (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Audit findings" value={findRows.length} />
            <Stat label="Open" value={findRows.filter((o) => o.status !== 'closed').length} tone="red" />
            <Stat label="Completed" value={findRows.filter((o) => o.lifecycle === 'completed').length} tone="green" />
            <Stat label="Outstanding people" value={outstandingWork(findRows)} tone="amber" />
            <Stat label="Overdue" value={findRows.filter((o) => o.sla_state === 'overdue').length} tone="red" />
          </div>

          {canManage && (
            <div className="flex justify-end">
              <button onClick={() => setShowFinding(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
                <Plus className="w-4 h-4" />Raise finding
              </button>
            </div>
          )}

          {findRows.length === 0 ? (
            <>
              {(findSummary.by_owner || []).length > 0 && (
                <div className={card}>
                  <h2 className="mb-3 text-sm font-semibold text-slate-800">Open actions by owner</h2>
                  <div className="flex flex-wrap gap-2">
                    {findSummary.by_owner.map((o) => (
                      <span key={o.process_owner_employee_id || 'none'}
                        className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-700">
                        {o.process_owner_name}{' '}
                        <span className="font-semibold tabular-nums">{o.open_count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {findLegacy.length === 0 ? (
                <EmptyState title="No audit findings"
                  description="Findings raised here are tracked from Open through to Closeout." />
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <tr>{['Reference', 'Finding', 'Owner', 'Age', 'Status', ''].map((h) => (
                        <th key={h} className="px-4 py-2 font-medium">{h}</th>
                      ))}</tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {findLegacy.map((f) => (
                        <tr key={f.id} className={f.is_overdue ? 'bg-red-50' : ''}>
                          <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{f.reference}</td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-slate-900">{f.title}</div>
                            {f.description && <div className="text-xs text-slate-500">{f.description}</div>}
                          </td>
                          <td className="px-4 py-2.5 text-slate-600">{f.process_owner_name}</td>
                          <td className="px-4 py-2.5 tabular-nums text-slate-600">{f.age_days}d</td>
                          <td className="px-4 py-2.5"><Chip map={FINDING_STATUS} value={f.status} /></td>
                          <td className="px-4 py-2.5 text-right">
                            {canManage && f.status !== 'closed' && (
                              <button onClick={() => advance(f, nextStatus(f.status))} disabled={busy}
                                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:border-emerald-300 hover:text-emerald-700">
                                Move to {FINDING_STATUS[nextStatus(f.status)].label}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white">
              <header className="border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-900">Audit findings</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Every obligation whose type is an audit finding, read live from the canonical register — the same records
                  the Command Centre shows and the board renders.
                </p>
              </header>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>{['Reference', 'Finding', 'Department', 'Risk', 'Responsible', 'Completion', 'Due', 'SLA', 'Lifecycle'].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {findRows.map((o) => {
                      const summary = completionSummary(o)
                      const lifecycle = LIFECYCLE[o.lifecycle] || { label: o.lifecycle, chip: 'bg-slate-100 text-slate-600' }
                      return (
                        <tr key={o.id} className={o.sla_state === 'overdue' ? 'bg-red-50' : ''}>
                          <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{o.reference}</td>
                          <td className="px-3 py-2.5">
                            <button onClick={() => setDetailId(o.id)} className="text-left">
                              <div className="font-medium text-slate-900 hover:text-[#009944]">{o.title}</div>
                              {o.description && (
                                <div className="max-w-xl text-xs text-slate-500">{o.description}</div>
                              )}
                            </button>
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">{o.department}</td>
                          <td className="px-3 py-2.5">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_TONE[o.risk_rating] || RISK_TONE.medium}`}>
                              {o.risk_rating || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <AvatarStack assignees={o.assignees} />
                              <span className="text-xs text-slate-500">{o.assigned_count}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-xs tabular-nums text-slate-600">
                            {summary.done}/{summary.total} · {Math.round(Number(o.completion_pct) || 0)}%
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                            {o.effective_deadline ? fmtDate(o.effective_deadline) : '—'}
                            {o.days_until_due != null && o.effective_deadline && (
                              <div className="text-[11px] text-slate-400">
                                {o.days_until_due >= 0 ? `in ${o.days_until_due}d` : `${Math.abs(o.days_until_due)}d late`}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5"><Chip map={SLA_STATE} value={o.sla_state} /></td>
                          <td className="px-3 py-2.5"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${lifecycle.chip}`}>{lifecycle.label}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}


      {!loading && !error && tab === 'obligations' && workspace && (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Obligations" value={completion.obligations ?? obligations.length} />
            <Stat label="In progress" value={byLifecycle.in_progress ?? 0} tone="amber" />
            <Stat label="Awaiting final review" value={byLifecycle.awaiting_approval ?? 0} />
            <Stat label="Needs clarification" value={byLifecycle.needs_clarification ?? 0} tone="amber" />
            <Stat label="Blocked" value={byLifecycle.blocked ?? 0} tone="red" />
            <Stat label="Completed" value={byLifecycle.completed ?? 0} tone="green" />
          </div>

          <div className={card}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-800">
                Assigned to me <span className="font-normal text-slate-400">({myAssignments.length})</span>
              </h2>
              <button onClick={() => setParams({ tab: 'board' })} className={ghostBtn}>
                <LayoutGrid className="w-4 h-4" />Open board
              </button>
            </div>
            {myAssignments.length === 0 ? (
              <EmptyState title="Nothing assigned to you"
                description="Obligations the Audit office issues to you personally will appear here, with your own deadlines." />
            ) : (
              <div className="space-y-3">
                {myAssignments.map((a) => (
                  <div key={a.assignment_id} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-slate-900">{a.title}</div>
                        <div className="text-xs text-slate-500">
                          {a.reference} · {a.department}
                          {a.acknowledgement_deadline ? ` · acknowledge by ${a.acknowledgement_deadline}` : ''}
                          {a.submission_deadline ? ` · submit by ${a.submission_deadline}` : ''}
                          {a.days_until_due != null && a.submission_deadline
                            ? ` · ${a.days_until_due >= 0 ? `${a.days_until_due}d left` : `${Math.abs(a.days_until_due)}d late`}`
                            : ''}
                        </div>
                        {a.instructions && (
                          <p className="mt-1 max-w-2xl text-xs text-slate-500">{a.instructions}</p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Chip map={ASSIGNMENT_STATUS} value={a.assignment_status} />
                        {a.completion_pct != null && (
                          <span className="text-[11px] text-slate-500">
                            Obligation {Math.round(Number(a.completion_pct) || 0)}% complete
                          </span>
                        )}
                      </div>
                    </div>
                    {a.required_documents?.length > 0 && (
                      <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
                        {a.required_documents.map((d, i) => <li key={i}>{typeof d === 'string' ? d : d?.name || JSON.stringify(d)}</li>)}
                      </ul>
                    )}
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      {a.assignment_status === 'not_started' && (
                        <button disabled={busy} onClick={() => acknowledge(a.assignment_id)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                          <MessageSquareWarning className="w-4 h-4" />Acknowledge receipt
                        </button>
                      )}
                      {['not_started', 'acknowledged', 'returned_for_correction'].includes(a.assignment_status) && (
                        <>
                          <textarea rows={2} placeholder="Type your response, or describe the document you are attaching"
                            value={draft[a.assignment_id] || ''}
                            onChange={(e) => setDraft((d) => ({ ...d, [a.assignment_id]: e.target.value }))}
                            className="min-w-[260px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                          <button disabled={busy} onClick={() => submitResponse(a.assignment_id, true)}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-3 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
                            <CheckCircle2 className="w-4 h-4" />Submit response
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={card}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-800">
                  Obligations <span className="font-normal text-slate-400">({obligations.length})</span>
                </h2>
                <p className="text-xs text-slate-500">
                  Every obligation the audit office can see, with the responsible persons and the server-computed completion.
                </p>
              </div>
              <div className="inline-flex overflow-hidden rounded-lg border border-slate-300">
                {[['table', 'Table'], ['board', 'Board']].map(([id, label]) => (
                  <button key={id} onClick={() => setView(id)}
                    className={`px-3 py-1.5 text-xs font-medium ${view === id
                      ? 'bg-[#009944] text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {obligations.length === 0 ? (
              <EmptyState title="No obligations yet"
                description="Obligations created in the Audit Command Centre appear here immediately, with their responsible persons." />
            ) : view === 'board' ? (
              <AuditBoard obligations={obligations} onOpen={setDetailId} />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>{['Reference', 'Obligation', 'Department', 'Responsible', 'Completion', 'Outstanding', 'Due', 'Lifecycle'].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {obligations.map((o) => {
                      const summary = completionSummary(o)
                      const lifecycle = LIFECYCLE[o.lifecycle] || { label: o.lifecycle, chip: 'bg-slate-100 text-slate-600' }
                      return (
                        <tr key={o.id} className={o.is_overdue ? 'bg-red-50' : ''}>
                          <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{o.reference}</td>
                          <td className="px-3 py-2.5">
                            <button onClick={() => setDetailId(o.id)} className="text-left">
                              <div className="font-medium text-slate-900 hover:text-[#009944]">{o.title}</div>
                              <div className="text-xs text-slate-500">{OBLIGATION_TYPE[o.obligation_type] || o.obligation_type}</div>
                            </button>
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">{o.department}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <AvatarStack assignees={o.assignees} />
                              <span className="text-xs text-slate-500">{o.assigned_count}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="w-24">
                              <div className="text-[11px] tabular-nums text-slate-600">
                                {summary.done}/{summary.total} · {Math.round(Number(o.completion_pct) || 0)}%
                              </div>
                              <Meter pct={o.completion_pct}
                                tone={(Number(o.completion_pct) || 0) >= 100 ? 'green' : (Number(o.completion_pct) || 0) >= 50 ? 'amber' : 'red'} />
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-xs text-slate-600">{summariseNames(summary.pending) || '—'}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                            {o.effective_deadline ? fmtDate(o.effective_deadline) : '—'}
                          </td>
                          <td className="px-3 py-2.5"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${lifecycle.chip}`}>{lifecycle.label}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}


      {!loading && !error && tab === 'submissions' && workspace && (
        <div className={card}>
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-slate-800">
              Submissions <span className="font-normal text-slate-400">({submissions.length})</span>
            </h2>
            <p className="text-xs text-slate-500">
              Every version is kept: a corrected response never erases the evidence it replaces. Repeat submissions by
              the same person do not inflate an obligation&apos;s completion - completion counts responsible PERSONS.
            </p>
          </div>
          {submissions.length === 0 ? (
            <EmptyState title="No submissions yet"
              description="Responses to issued obligations appear here the moment they are submitted, with their review state." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>{['Submission', 'Obligation', 'Submitted by', 'Department', 'Submitted', 'Due', 'Review status', 'Correction'].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {submissions.map((s) => (
                    <tr key={s.submission_id} className={
                      s.status === 'returned_for_correction' ? 'bg-orange-50'
                        : s.status === 'accepted' ? 'bg-emerald-50/40' : ''}>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-500">
                        {String(s.submission_id).slice(0, 8)} · v{s.version}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-slate-900">{s.obligation_title}</div>
                        <div className="font-mono text-xs text-slate-500">{s.reference}</div>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{s.submitted_by_name}</td>
                      <td className="px-3 py-2.5 text-slate-600">{s.department}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                        {s.submitted_at ? new Date(s.submitted_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{s.due_date ? fmtDate(s.due_date) : '—'}</td>
                      <td className="px-3 py-2.5"><Chip map={SUBMISSION_STATUS} value={s.status} /></td>
                      <td className="px-3 py-2.5 text-xs text-orange-800">
                        {s.correction_reason
                          || (s.status === 'returned_for_correction' ? 'Correction outstanding' : '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}


      {!loading && !error && tab === 'schedule' && workspace && (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Scheduled" value={schedule.length} />
            <Stat label="Overdue" value={schedule.filter((o) => o.sla_state === 'overdue').length} tone="red" />
            <Stat label="Due today" value={schedule.filter((o) => o.sla_state === 'due_today').length} tone="amber" />
            <Stat label="Recurring" value={schedule.filter((o) => o.recurrence_rule).length} />
            <Stat label="Completed" value={schedule.filter((o) => o.lifecycle === 'completed').length} tone="green" />
          </div>

          <div className={card}>
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-slate-800">Shared audit schedule</h2>
              <p className="text-xs text-slate-500">
                Derived from the canonical obligations - never written, so a refresh can never create a duplicate entry.
                Recurring obligations show their stored rule and next occurrence.
              </p>
            </div>
            {schedule.length === 0 ? (
              <EmptyState title="Nothing is scheduled"
                description="Obligations with a submission deadline, a next occurrence or a recurrence rule appear here." />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>{['Date', 'Reference', 'Obligation', 'Department', 'Recurrence', 'Responsible', 'Completion', 'SLA', 'Lifecycle'].map((h) => (
                      <th key={h} className="px-3 py-2 font-medium">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {schedule.map((o) => {
                      const summary = completionSummary(o)
                      const lifecycle = LIFECYCLE[o.lifecycle] || { label: o.lifecycle, chip: 'bg-slate-100 text-slate-600' }
                      return (
                        <tr key={o.id} className={o.sla_state === 'overdue' ? 'bg-red-50' : ''}>
                          <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                            {o.effective_deadline ? fmtDate(o.effective_deadline) : '—'}
                            {o.days_until_due != null && o.effective_deadline && (
                              <div className="text-[11px] text-slate-400">
                                {o.days_until_due >= 0 ? `in ${o.days_until_due}d` : `${Math.abs(o.days_until_due)}d late`}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{o.reference}</td>
                          <td className="px-3 py-2.5">
                            <button onClick={() => setDetailId(o.id)} className="text-left">
                              <div className="font-medium text-slate-900 hover:text-[#009944]">{o.title}</div>
                              <div className="text-xs text-slate-500">{OBLIGATION_TYPE[o.obligation_type] || o.obligation_type}</div>
                            </button>
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">{o.department}</td>
                          <td className="px-3 py-2.5 text-slate-600">{recurrenceLabel(o.recurrence_rule)}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <AvatarStack assignees={o.assignees} />
                              <span className="text-xs text-slate-500">{o.assigned_count}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-xs tabular-nums text-slate-600">
                            {summary.done}/{summary.total} · {Math.round(Number(o.completion_pct) || 0)}%
                          </td>
                          <td className="px-3 py-2.5"><Chip map={SLA_STATE} value={o.sla_state} /></td>
                          <td className="px-3 py-2.5"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${lifecycle.chip}`}>{lifecycle.label}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}


      {!loading && !error && tab === 'board' && workspace && (
        <div className={card}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-800">Obligation board</h2>
              <p className="text-xs text-slate-500">
                A card&apos;s column is its obligation&apos;s derived lifecycle, so it moves by itself when the work moves -
                no manual dragging, and never past the server&apos;s approval rules.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Users className="w-4 h-4" />
              {completion.obligations ?? obligations.length} obligations
              <span className="text-slate-300">|</span>
              <FileText className="w-4 h-4" />
              {completion.assigned ?? 0} assignments
            </div>
          </div>
          {obligations.filter(isBoardCard).length === 0 ? (
            <EmptyState title="The board is empty"
              description="Obligations appear here as soon as the audit office creates them, in the column that matches their state." />
          ) : (
            <>
              {byLifecycle.blocked > 0 && (
                <p className="mb-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertTriangle className="w-4 h-4" />
                  {byLifecycle.blocked} obligation{byLifecycle.blocked === 1 ? '' : 's'} cannot proceed.
                </p>
              )}
              <AuditBoard obligations={obligations} onOpen={setDetailId} />
            </>
          )}
        </div>
      )}


      {!loading && !error && tab === 'review' && workspace && (
        <div className={card}>
          <h2 className="mb-1 text-sm font-semibold text-slate-800">Submission review queue</h2>
          <p className="mb-3 text-xs text-slate-500">
            Responses waiting on an audit decision. A return for correction requires a reason and is recorded
            against the submission and the assignment - and keeps the responsible person outstanding until it is
            corrected and resubmitted.
          </p>
          {reviewQueue.length === 0 ? (
            <EmptyState title="Nothing awaiting review" description="Submissions will appear here the moment they arrive." />
          ) : (
            <div className="space-y-3">
              {reviewQueue.map((r) => (
                <div key={r.submission_id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-slate-900">{r.obligation_title}</div>
                      <div className="text-xs text-slate-500">
                        {r.reference} · v{r.version} · {r.submitted_by_name} · {r.department}
                      </div>
                    </div>
                    <Chip map={SUBMISSION_STATUS} value={r.status} />
                  </div>
                  {returning === r.submission_id ? (
                    <div className="mt-2 space-y-2">
                      <input value={returnReason} onChange={(e) => setReturnReason(e.target.value)}
                        placeholder="Correction reason (required) — exactly what must change and why"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                      <div className="flex gap-2">
                        <button disabled={busy || !returnReason.trim()}
                          onClick={() => reviewSubmission(r.submission_id, 'returned_for_correction')}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-3 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
                          <Gavel className="w-4 h-4" />Return for correction
                        </button>
                        <button onClick={() => { setReturning(null); setReturnReason('') }}
                          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button disabled={busy} onClick={() => reviewSubmission(r.submission_id, 'under_review')}
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">Start review</button>
                      <button disabled={busy} onClick={() => reviewSubmission(r.submission_id, 'accepted')}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50">
                        <CheckCircle2 className="w-4 h-4" />Accept
                      </button>
                      <button disabled={busy} onClick={() => setReturning(r.submission_id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-orange-300 px-3 py-2 text-sm text-orange-700 hover:bg-orange-50">
                        <Gavel className="w-4 h-4" />Return for correction
                      </button>
                      <button onClick={() => setDetailId(r.obligation_id)}
                        className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 hover:text-slate-800">
                        Obligation detail <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {detail && (
        <ObligationDrawer obligation={detail} submissions={submissions} onClose={() => setDetailId(null)} />
      )}

      {showReg && (
        <Modal title="Add regulatory item" onClose={() => setShowReg(false)}>
          <form onSubmit={saveReg} className="space-y-3">
            <label className="block">
              <span className={labelCls}>Item name</span>
              <input required className={inputCls} value={regForm.name}
                onChange={(e) => setRegForm({ ...regForm, name: e.target.value })} />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className={labelCls}>Due date</span>
                <input type="date" required className={inputCls} value={regForm.dueDate}
                  onChange={(e) => setRegForm({ ...regForm, dueDate: e.target.value })} />
              </label>
              <label className="block">
                <span className={labelCls}>Remind before (days)</span>
                <input type="number" min="0" max="365" className={inputCls} value={regForm.leadTimeDays}
                  onChange={(e) => setRegForm({ ...regForm, leadTimeDays: Number(e.target.value) })} />
              </label>
              <label className="block">
                <span className={labelCls}>Status</span>
                <select className={inputCls} value={regForm.status}
                  onChange={(e) => setRegForm({ ...regForm, status: e.target.value })}>
                  {Object.entries(REGULATORY_STATUS).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block">
              <span className={labelCls}>Process owner</span>
              <select className={inputCls} value={regForm.processOwnerEmployeeId}
                onChange={(e) => setRegForm({ ...regForm, processOwnerEmployeeId: e.target.value })}>
                <option value="">Unassigned</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls}>Description</span>
              <textarea className={inputCls} rows={2} value={regForm.description}
                onChange={(e) => setRegForm({ ...regForm, description: e.target.value })} />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowReg(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600">Cancel</button>
              <button type="submit" disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save item'}
              </button>
            </div>
          </form>
        </Modal>
      )}


      {showFinding && (
        <Modal title="Raise an audit finding" onClose={() => setShowFinding(false)}>
          <form onSubmit={saveFinding} className="space-y-3">
            <label className="block">
              <span className={labelCls}>Finding title</span>
              <input required className={inputCls} value={findForm.title}
                onChange={(e) => setFindForm({ ...findForm, title: e.target.value })} />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className={labelCls}>Severity</span>
                <select className={inputCls} value={findForm.severity}
                  onChange={(e) => setFindForm({ ...findForm, severity: e.target.value })}>
                  {['low', 'medium', 'high', 'critical'].map((s) => (
                    <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>Department</span>
                <input className={inputCls} value={findForm.department}
                onChange={(e) => setFindForm({ ...findForm, department: e.target.value })} />
              </label>
              <label className="block">
                <span className={labelCls}>Due date</span>
                <input type="date" className={inputCls} value={findForm.dueDate}
                  onChange={(e) => setFindForm({ ...findForm, dueDate: e.target.value })} />
              </label>
            </div>
            <label className="block">
              <span className={labelCls}>Process owner</span>
              <select className={inputCls} value={findForm.processOwnerEmployeeId}
                onChange={(e) => setFindForm({ ...findForm, processOwnerEmployeeId: e.target.value })}>
                <option value="">Unassigned</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls}>Description</span>
              <textarea className={inputCls} rows={3} value={findForm.description}
                onChange={(e) => setFindForm({ ...findForm, description: e.target.value })} />
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowFinding(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600">Cancel</button>
              <button type="submit" disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Raise finding'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {closeout && (
        <Modal title={`Closeout ${closeout.reference}`} onClose={() => setCloseout(null)}>
          <p className="mb-3 text-sm text-slate-600">
            Record what was actually done. A finding cannot be closed without this.
          </p>
          <textarea className={inputCls} rows={4} value={closeoutNotes}
            onChange={(e) => setCloseoutNotes(e.target.value)} />
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setCloseout(null)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600">Cancel</button>
            <button onClick={confirmCloseout} disabled={busy || closeoutNotes.trim().length < 5}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><CheckCircle2 className="w-4 h-4" />Close finding</>}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
