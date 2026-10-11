// ============================================================================
// Audit & Compliance - department workspace
// ============================================================================
// Two registers, each read from the server in one call:
//   REGULATORY MONITORING - what is due and who owns it. Overdue and
//     "days until due" are computed server-side so they can never disagree with
//     what the reminder job acted on.
//   AUDIT FINDINGS - Open -> In Progress -> Pending Closeout -> Closed, with
//     age derived from opened_at.
//
// This screen renders the server's state and calls the server's RPCs. It never
// decides whether a finding may close or an item is overdue.
import React, { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ShieldCheck, Plus, CalendarClock, ClipboardList, CheckCircle2, Loader2, X,
  ListChecks, Gavel, MessageSquareWarning,
} from 'lucide-react'
import { auditService, REGULATORY_STATUS, FINDING_STATUS, ASSIGNMENT_STATUS, SUBMISSION_STATUS, fmtDate } from '../services/auditService'
import { employeeService } from '../services/employeeService'
import { LoadingState, ErrorState, EmptyState } from '../components/PageStates'
import { useAuth } from '../hooks/useAuth'

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'
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
// The shared audit board: the same assignments the table shows, as the
// workflow the audit team actually works - new, acknowledged, submitted,
// under review, returned, done. One column per assignment status, so a card's
// position IS its state and nothing can drift between the two.
// ===========================================================================
const BOARD_COLUMNS = [
  { key: 'new', label: 'New', header: 'bg-slate-100 text-slate-700', statuses: ['not_started'] },
  { key: 'acknowledged', label: 'Acknowledged', header: 'bg-sky-100 text-sky-800', statuses: ['acknowledged'] },
  { key: 'submitted', label: 'Submitted', header: 'bg-indigo-100 text-indigo-800', statuses: ['submitted'] },
  { key: 'review', label: 'Under review', header: 'bg-amber-100 text-amber-800', statuses: ['under_review', 'resubmitted'] },
  { key: 'returned', label: 'Returned for correction', header: 'bg-orange-100 text-orange-800', statuses: ['returned_for_correction'] },
  { key: 'done', label: 'Accepted / Closed', header: 'bg-emerald-100 text-emerald-800', statuses: ['accepted', 'closed', 'rejected'] },
]

function AuditBoard({ schedule }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {BOARD_COLUMNS.map((col) => {
        const cards = schedule.filter((s) => col.statuses.includes(s.assignment_status))
        return (
          <section key={col.key} className="flex min-h-[120px] flex-col rounded-2xl bg-slate-50/80 p-2">
            <header className={`mb-2 flex items-center justify-between rounded-xl px-3 py-2 ${col.header}`}>
              <span className="text-xs font-semibold">{col.label}</span>
              <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-bold tabular-nums">{cards.length}</span>
            </header>
            <div className="space-y-2">
              {cards.map((c) => {
                const initials = (c.owner_name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
                const overdue = c.sla_state === 'overdue'
                return (
                  <article key={c.assignment_id}
                    className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-slate-400">{c.reference}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        c.risk_rating === 'critical' ? 'bg-red-100 text-red-700'
                          : c.risk_rating === 'high' ? 'bg-orange-100 text-orange-700'
                            : c.risk_rating === 'medium' ? 'bg-amber-50 text-amber-700'
                              : 'bg-slate-100 text-slate-600'}`}>{c.risk_rating || '—'}</span>
                    </div>
                    <h4 className="mt-1 text-sm font-medium leading-snug text-slate-900">{c.title}</h4>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                      <span className="truncate">{c.department}</span>
                      <span className="ml-2 flex items-center gap-1.5">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-600">
                          {initials}
                        </span>
                        <span className={`whitespace-nowrap ${overdue ? 'font-semibold text-red-600' : ''}`}>
                          {c.submission_deadline
                            ? `${new Date(`${String(c.submission_deadline).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}${c.days_until_due != null ? (c.days_until_due >= 0 ? ` · ${c.days_until_due}d` : ` · ${Math.abs(c.days_until_due)}d late`) : ''}`
                            : 'No date'}
                        </span>
                      </span>
                    </div>
                  </article>
                )
              })}
              {cards.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">
                  Nothing here
                </p>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

export default function Audit() {
  const { hasPermission, profile } = useAuth()
  const [params, setParams] = useSearchParams()

  // The shared Audit Workspace (Phase 72): obligations, my assignments and the
  // review queue. The server refuses non-members with AUDIT_FORBIDDEN; that is
  // NOT an error here - it simply means this account keeps the two registers
  // below and loses the two shared tabs. Nothing else about the page changes.
  const [workspace, setWorkspace] = useState(null)

  // Shared-workspace tabs ('obligations' / 'review') are only offered when the
  // server admitted this account; otherwise the param falls back to the first
  // register so a bookmarked link never lands on an unavailable tab.
  const rawTab = params.get('tab')
  const tab = (rawTab === 'obligations' || rawTab === 'review') && !workspace
    ? 'regulatory'
    : rawTab || 'regulatory'
  const [draft, setDraft] = useState({})
  const [returning, setReturning] = useState(null)
  const [returnReason, setReturnReason] = useState('')
  // View toggle on the obligations tab: the same assignments as a table or as
  // the board the audit team works from day to day.
  const [view, setView] = useState('board')

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
      if (w && w.ok !== false) setWorkspace(w)
    } catch { setWorkspace(null) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadWorkspace() }, [loadWorkspace])
  useEffect(() => { employeeService.list().then(setEmployees).catch(() => setEmployees([])) }, [])

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

  const regSummary = reg?.summary || {}
  const findSummary = findings?.summary || {}
  // Derived from the workspace payload; empty until the server admits us.
  const myAssignments = workspace?.my_assignments || []
  const schedule = workspace?.schedule || []
  const reviewQueue = workspace?.review_queue || []
  // The two shared tabs appear only for workspace members. `workspace` is null
  // for an account the server refuses (or a fetch failure), so a refused role
  // sees exactly what it saw before Phase 72 - the two registers.
  const tabs = [
    ...(workspace ? [
      { id: 'obligations', label: 'Obligations & submissions', icon: ListChecks },
      ...(reviewQueue.length > 0 ? [{ id: 'review', label: 'Review queue', icon: Gavel }] : []),
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
          Regulatory deadlines with named process owners, and audit findings tracked to closeout.
        </p>
      </header>

      <nav className="flex gap-1 border-b border-slate-200">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setParams(id === 'regulatory' ? {} : { tab: id })}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === id
              ? 'border-[#009944] text-[#009944]'
              : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </nav>

      {error && <ErrorState title="Unable to load audit data" message={error} />}
      {formError && <p className="text-sm text-red-700">{formError}</p>}
      {loading && <LoadingState label="Loading audit registers..." />}


      {!loading && !error && tab === 'regulatory' && (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Total items" value={regSummary.total ?? 0} />
            <Stat label="Advance" value={regSummary.advance ?? 0} tone="green" />
            <Stat label="Pending" value={regSummary.pending ?? 0} tone="amber" />
            <Stat label="Outstanding" value={regSummary.outstanding ?? 0} tone="red" />
            <Stat label="Overdue" value={regSummary.overdue ?? 0} tone="red" />
            <Stat label="Due in 30 days" value={regSummary.due_next_30 ?? 0} />
          </div>

          {canManage && (
            <div className="flex justify-end">
              <button onClick={() => setShowReg(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
                <Plus className="w-4 h-4" />Add regulatory item
              </button>
            </div>
          )}

          {(reg?.items || []).length === 0 ? (
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
                  {reg.items.map((r) => (
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
          )}
        </>
      )}


      {!loading && !error && tab === 'findings' && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Open actions" value={findSummary.open_total ?? 0} tone="amber" />
            <Stat label="Open" value={findSummary.by_status?.open ?? 0} tone="red" />
            <Stat label="Pending closeout" value={findSummary.by_status?.pending_closeout ?? 0} />
            <Stat label="Closed" value={findSummary.by_status?.closed ?? 0} tone="green" />
          </div>

          {canManage && (
            <div className="flex justify-end">
              <button onClick={() => setShowFinding(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
                <Plus className="w-4 h-4" />Raise finding
              </button>
            </div>
          )}

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

          {(findings?.findings || []).length === 0 ? (
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
                  {findings.findings.map((f) => (
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
      )}


      {!loading && !error && tab === 'obligations' && workspace && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="My assignments" value={myAssignments.length} />
            <Stat label="Awaiting acknowledgement"
              value={myAssignments.filter((a) => a.assignment_status === 'not_started').length} tone="amber" />
            <Stat label="Awaiting my response"
              value={myAssignments.filter((a) => ['not_started', 'acknowledged', 'returned_for_correction'].includes(a.assignment_status)).length} tone="amber" />
          </div>

          <div className={card}>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">Assigned to me</h2>
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
                      <Chip map={ASSIGNMENT_STATUS} value={a.assignment_status} />
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
              <h2 className="text-sm font-semibold text-slate-800">Shared audit schedule</h2>
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
            {schedule.length === 0 ? (
              <EmptyState title="No active obligations"
                description="The Assurance office has not issued any obligations yet." />
            ) : view === 'board' ? (
              <AuditBoard schedule={schedule} />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>{['Reference', 'Obligation', 'Department', 'Owner', 'Due', 'SLA'].map((h) => (
                      <th key={h} className="px-4 py-2 font-medium">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {schedule.map((o) => (
                      <tr key={o.assignment_id} className={o.sla_state === 'overdue' ? 'bg-red-50' : ''}>
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{o.reference}</td>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-900">{o.title}</div>
                          <div className="text-xs text-slate-500">{o.obligation_type}</div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{o.department}</td>
                        <td className="px-4 py-2.5 text-slate-600">{o.owner_name || 'Unassigned'}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{o.submission_deadline || '—'}</td>
                        <td className="px-4 py-2.5"><Chip map={ASSIGNMENT_STATUS} value={o.assignment_status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {!loading && !error && tab === 'review' && workspace && (
        <div className={card}>
          <h2 className="mb-1 text-sm font-semibold text-slate-800">Submission review queue</h2>
          <p className="mb-3 text-xs text-slate-500">
            Responses waiting on an audit decision. A return for correction requires a reason and is recorded
            against the submission and the assignment.
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
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
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

