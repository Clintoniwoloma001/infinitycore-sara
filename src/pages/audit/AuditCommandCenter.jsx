// ============================================================================
// Audit Command Centre - Head of Audit ONLY (server-enforced)
// ============================================================================
// The cross-department oversight workspace from the audit operating model:
// every obligation, acknowledgement coverage, SLA state, review queue,
// high-risk findings, department completion and the escalation picture.
//
// THE BOUNDARY IS THE SERVER, NOT THIS PAGE. The route guard hides the menu
// entry, but get_audit_command_center() re-checks the caller's role itself and
// raises AUDIT_FORBIDDEN for anyone who is not the Head of Audit (or a
// break-glass administrator). Deep-linking here without the role shows the
// "restricted" state below - the data is never fetched for them.
//
// Every figure below is counted REAL rows by the RPC. Nothing is typed in by
// hand and no chart is fabricated.
import React, { useCallback, useEffect, useState } from 'react'
import {
  SearchCheck, RefreshCw, Plus, AlertTriangle, Gavel, ClipboardCheck,
  CheckCircle2, MessageSquareWarning, Send, Building2, CalendarClock, Zap,
  Pencil, Pause, Undo2, Trash2, Loader2,
} from 'lucide-react'
import { auditService, ASSIGNMENT_STATUS, FINDING_STATUS, OBLIGATION_TYPE, SUBMISSION_STATUS } from '../../services/auditService'
import { LoadingState, ErrorState, EmptyState } from '../../components/PageStates'
import { KpiCard, SlaChip, StatusChip, SectionCard, Meter, DataTable } from './auditUi'
import { useAuth } from '../../hooks/useAuth'

const card = 'rounded-2xl border border-slate-200 bg-white'
const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1'
const primaryBtn = 'inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]'
const ghostBtn = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50'

const BLANK_OBLIGATION = {
  reference: '', title: '', department: 'audit', obligationType: 'regulatory_return',
  riskRating: 'high', priority: 'high', reportingPeriod: '', sourceDocument: '',
  sourceReference: '', description: '', instructions: '',
  acknowledgementDeadline: '', submissionDeadline: '', reviewDeadline: '',
}

const RISK_TONE = { critical: 'red', high: 'red', medium: 'amber', low: 'slate' }

// ---------------------------------------------------------------------------
// The obligation action vocabulary.
// ---------------------------------------------------------------------------
// Every status below is a value the obligations table ALREADY carries
// ('draft','active','paused','archived','closed'); none is invented here:
//   * "Send back" reuses 'draft', which is exactly the "Awaiting validation"
//     state the register already filters and displays.
//   * "Delete" reuses 'archived' (soft delete). There is no 'deleted' status
//     and no hard-delete path, because ON DELETE CASCADE would take the
//     obligation's assignments and submissions with it.
const OBLIGATION_ACTIONS = {
  paused: {
    key: 'paused',
    label: 'Pause',
    title: 'Pause this obligation?',
    body: 'A paused obligation stops the reminder sweep and drops out of the active register. Nothing is lost — you can reactivate it at any time.',
    confirmLabel: 'Pause obligation',
  },
  draft: {
    key: 'draft',
    label: 'Send back',
    title: 'Send this obligation back for validation?',
    body: 'The obligation returns to "Awaiting validation" so its statutory deadline can be re-checked by a Head of Audit before it goes live again.',
    confirmLabel: 'Send back',
  },
  archived: {
    key: 'archived',
    label: 'Delete',
    title: 'Delete this obligation?',
    body: 'The obligation is archived and hidden from the register. Its issued assignments and submissions are kept — this is a soft delete, not a hard one.',
    confirmLabel: 'Archive obligation',
  },
}

// Small action-button styling, shared by the register rows and the modal.
const actBtn = 'inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50'
const actBtnGreen = 'inline-flex items-center gap-1 rounded border border-emerald-300 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50'
const actBtnRed = 'inline-flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50'

// The editable shape of one obligation, filled from a register row.
const BLANK_EDIT = {
  id: null,
  reference: '', title: '', description: '', instructions: '',
  obligationType: 'regulatory_return', department: 'audit',
  reportingPeriod: '', sourceDocument: '', sourceReference: '',
  issueDate: '', acknowledgementDeadline: '', submissionDeadline: '',
  reviewDeadline: '', priority: 'medium', riskRating: 'medium',
  recurrenceRule: '', nextOccurrence: '',
  reminderLeadDays: 7, reminderIntervalDays: 3,
  escalationRole: '', escalationDelayDays: 3,
}

// A register row -> the editable form. `effective_deadline` is the server's
// coalesce(submission_deadline, next_occurrence): when a row is recurring,
// next_occurrence is what the register is showing, so the submission-deadline
// box is deliberately left empty and the recurrence drives the date instead.
function editFormFromRow(o) {
  const isRecurringDriven = Boolean(o.next_occurrence) && o.next_occurrence === o.effective_deadline
  return {
    id: o.id,
    reference: o.reference || '',
    title: o.title || '',
    description: o.description || '',
    instructions: o.instructions || '',
    obligationType: o.obligation_type || 'regulatory_return',
    department: o.department || 'audit',
    reportingPeriod: o.reporting_period || '',
    sourceDocument: o.source_document || '',
    sourceReference: o.source_reference || '',
    issueDate: o.issue_date || '',
    acknowledgementDeadline: o.acknowledgement_deadline || '',
    submissionDeadline: isRecurringDriven ? '' : (o.effective_deadline || ''),
    reviewDeadline: o.review_deadline || '',
    priority: o.priority || 'medium',
    riskRating: o.risk_rating || 'medium',
    recurrenceRule: o.recurrence_rule || '',
    nextOccurrence: o.next_occurrence || '',
    reminderLeadDays: o.reminder_lead_days ?? 7,
    reminderIntervalDays: o.reminder_interval_days ?? 3,
    escalationRole: o.escalation_role || '',
    escalationDelayDays: o.escalation_delay_days ?? 3,
  }
}

export default function AuditCommandCenter() {
  const { hasPermission, profile } = useAuth()
  const [data, setData] = useState(null)
  const [register, setRegister] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [blocked, setBlocked] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(BLANK_OBLIGATION)
  const [formError, setFormError] = useState(null)
  const [returning, setReturning] = useState(null) // submission awaiting a correction reason
  const [returnReason, setReturnReason] = useState('')
  const [registerFilter, setRegisterFilter] = useState('draft')
  const [sweepResult, setSweepResult] = useState(null)

  // Obligation editing / validation (Phase 72c). `editMode` is 'edit' for a
  // plain field edit and 'validate' for the pre-activation review, which is
  // the same form with an "Activate" footer instead of "Save changes".
  const [editMode, setEditMode] = useState('edit')
  const [editForm, setEditForm] = useState(BLANK_EDIT)
  const [editError, setEditError] = useState(null)
  // A pending status action awaiting confirmation: { kind, obligation }.
  const [confirm, setConfirm] = useState(null)

  // Who may act on an obligation. This is the SAME permission the server
  // enforces on create/update (audit.obligations.manage, granted to the Head
  // of Audit and the break-glass admins) - it widens nothing, it only decides
  // whether the buttons are drawn for someone who could not use them anyway.
  const canManage = hasPermission('audit.obligations.manage')
    || ['super_admin', 'admin', 'head_of_audit'].includes(profile?.role)

  const load = useCallback(async () => {
    setLoading(true); setError(null); setBlocked(false)
    try {
      const res = await auditService.commandCenter()
      setData(res)
    } catch (e) {
      // The RPC raises AUDIT_FORBIDDEN for anyone without the role. This page
      // is the UI echo of that refusal - never a client-side decision.
      if (/AUDIT_FORBIDDEN/i.test(e.message || '')) setBlocked(true)
      else setError(e.message)
    } finally { setLoading(false) }
  }, [])

  // The register is a separate, restricted read: it fails with the same
  // AUDIT_FORBIDDEN if the caller is not a command-centre reader, and is
  // simply absent (not an error) otherwise.
  const loadRegister = useCallback(async (status = registerFilter) => {
    try {
      setRegister(await auditService.obligationRegister(status))
    } catch (e) {
      if (/AUDIT_FORBIDDEN/i.test(e.message || '')) setRegister(null)
      else setActionError(e.message)
    }
  }, [registerFilter])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadRegister(registerFilter) }, [loadRegister, registerFilter])

  const createObligation = async (e) => {
    e.preventDefault(); setFormError(null)
    if (!form.reference.trim() || !form.title.trim()) {
      setFormError('A reference and a title are required.'); return
    }
    setBusy(true)
    try {
      await auditService.createObligation({
        ...form,
        reference: form.reference.trim(),
        title: form.title.trim(),
        acknowledgementDeadline: form.acknowledgementDeadline || null,
        submissionDeadline: form.submissionDeadline || null,
        reviewDeadline: form.reviewDeadline || null,
        requiredDocuments: [],
      })
      setShowForm(false); setForm(BLANK_OBLIGATION); load()
    } catch (err) { setFormError(err.message) } finally { setBusy(false) }
  }

  const review = async (submissionId, decision, reason = null) => {
    setActionError(null); setBusy(true)
    try {
      await auditService.reviewSubmission(submissionId, decision, reason, [])
      setReturning(null); setReturnReason(''); load()
    } catch (err) { setActionError(err.message) } finally { setBusy(false) }
  }

  // Activating an imported obligation is the validation gate: the statutory
  // deadline has been confirmed as the current position by a Head of Audit.
  const activate = async (obligationId, status) => {
    setActionError(null); setBusy(true)
    try {
      await auditService.activateObligation(obligationId, status)
      loadRegister(registerFilter); load()
    } catch (err) { setActionError(err.message) } finally { setBusy(false) }
  }

  // ---- Obligation editing + status actions (Phase 72c) --------------------
  const openEdit = (o, mode = 'edit') => {
    setEditMode(mode)
    setEditError(null)
    setEditForm(editFormFromRow(o))
  }

  // The one write path for both saving an edit and activating from the review
  // modal. Passing `status: 'active'` saves the field edits AND activates in a
  // single call, so validation is one decision rather than two.
  const saveObligation = async (status = null) => {
    setEditError(null)
    if (!editForm.reference.trim() || !editForm.title.trim()) {
      setEditError('A reference and a title are required.'); return
    }
    setActionError(null); setBusy(true)
    try {
      await auditService.updateObligation(editForm.id, {
        ...editForm,
        reference: editForm.reference.trim(),
        title: editForm.title.trim(),
        // An emptied date box must clear the column, not be ignored.
        submissionDeadline: editForm.submissionDeadline || null,
        nextOccurrence: editForm.nextOccurrence || null,
        acknowledgementDeadline: editForm.acknowledgementDeadline || null,
        reviewDeadline: editForm.reviewDeadline || null,
        issueDate: editForm.issueDate || null,
        recurrenceRule: editForm.recurrenceRule || null,
        escalationRole: editForm.escalationRole || null,
        status,
      })
      setEditForm(BLANK_EDIT)
      loadRegister(registerFilter); load()
      return true
    } catch (err) {
      setEditError(err.message)
      return false
    } finally { setBusy(false) }
  }

  // Pause / Send back / Delete: a status-only change, no fields touched.
  const applyStatus = async (obligation, status) => {
    setActionError(null); setBusy(true)
    try {
      await auditService.updateObligation(obligation.id, { status })
      setConfirm(null)
      loadRegister(registerFilter); load()
    } catch (err) {
      setActionError(err.message)
      setConfirm(null)
    } finally { setBusy(false) }
  }

  // The reminder sweep normally runs on pg_cron; this is the manual trigger
  // for the same server job (same idempotency, same notifications).
  const runSweep = async () => {
    setActionError(null); setBusy(true)
    try {
      const r = await auditService.runReminderSweep()
      setSweepResult(r); load()
    } catch (err) { setActionError(err.message) } finally { setBusy(false) }
  }

  if (loading) return <LoadingState label="Loading the Audit Command Centre..." />
  if (blocked) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className={`${card} p-6 text-center`}>
          <SearchCheck className="mx-auto h-8 w-8 text-slate-300" />
          <h1 className="mt-3 text-lg font-semibold text-slate-900">Audit Command Centre is restricted</h1>
          <p className="mt-2 text-sm text-slate-600">
            This workspace is limited to the Head of Audit. The server confirmed your account does not hold
            that access, so no oversight data was loaded.
          </p>
          <p className="mt-3 text-xs text-slate-400">
            If you believe you should have access, ask an administrator to grant the{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5">audit.command_center.read</code> permission to
            your role. This restriction is enforced in the database, not by this page.
          </p>
        </div>
      </div>
    )
  }
  if (error) return <ErrorState title="Unable to load the Audit Command Centre" message={error} />

  const s = data?.summary || {}
  const coverage = data?.acknowledgement_coverage || []
  const departments = data?.department_completion || []
  const horizon = data?.deadline_horizon || []
  const reviewQueue = data?.review_queue || []
  const findings = data?.high_risk_findings || []
  const obligations = data?.obligations || []
  const ackPct = s.issued_assignments > 0
    ? Math.round((s.acknowledged / s.issued_assignments) * 100) : null

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <SearchCheck className="h-6 w-6 text-[#009944]" />Audit Command Centre
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Cross-department audit oversight: obligations, acknowledgements, SLA state, review queues and
            high-risk findings. Restricted to the Head of Audit.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className={ghostBtn}><RefreshCw className="h-4 w-4" />Refresh</button>
          <button onClick={() => setShowForm(true)} className={primaryBtn}><Plus className="h-4 w-4" />New obligation</button>
        </div>
      </header>

      {actionError && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Active obligations" value={s.active_obligations} icon={ClipboardCheck} />
        <KpiCard label="Open findings" value={s.open_findings}
          hint={`${s.critical_findings ?? 0} critical · ${s.high_risk_findings ?? 0} high`}
          tone={s.critical_findings > 0 ? 'red' : 'slate'} icon={AlertTriangle} />
        <KpiCard label="Overdue submissions" value={s.overdue_submissions} tone={(s.overdue_submissions ?? 0) > 0 ? 'red' : 'slate'} icon={CalendarClock} />
        <KpiCard label="Pending acknowledgement" value={s.pending_acknowledgement}
          hint={`${s.overdue_acknowledgement ?? 0} past deadline`}
          tone={(s.overdue_acknowledgement ?? 0) > 0 ? 'amber' : 'slate'} icon={MessageSquareWarning} />
        <KpiCard label="Awaiting review" value={s.awaiting_review} icon={Send} />
        <KpiCard label="Returned for correction" value={s.returned_for_correction} tone="amber" icon={Gavel} />
      </div>

      <SectionCard
        title="Obligation register (source documents)"
        description="Imported from the audit department's working documents. Every row keeps its provenance; a draft row must be validated before it drives live notices."
        action={(
          <div className="flex items-center gap-2">
            <select value={registerFilter} onChange={(e) => setRegisterFilter(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700">
              <option value="draft">Awaiting validation</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
              <option value="">All</option>
            </select>
            <button onClick={runSweep} disabled={busy} className={ghostBtn} title="Run the reminder/escalation job now (the same idempotent job pg_cron runs)">
              <Zap className="h-4 w-4" />Run reminder sweep
            </button>
          </div>
        )}>
        {sweepResult && (
          <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Sweep completed: {sweepResult.reminded ?? 0} reminded, {sweepResult.overdue_flagged ?? 0} overdue
            flagged, {sweepResult.escalated ?? 0} escalated (as of {sweepResult.as_of}).
          </p>
        )}
        <DataTable
          columns={[
            { key: 'ref', label: 'Reference' },
            { key: 'title', label: 'Obligation' },
            { key: 'type', label: 'Type' },
            { key: 'dept', label: 'Department' },
            { key: 'owner', label: 'Owner (source)' },
            { key: 'recur', label: 'Recurrence' },
            { key: 'next', label: 'Next / due' },
            { key: 'remind', label: 'Reminder' },
            { key: 'sla', label: 'SLA state' },
            { key: 'status', label: 'Status' },
            { key: 'act', label: '' },
          ]}
          rowCount={(register?.obligations || []).length}
          empty="No obligations in this view.">
          {(register?.obligations || []).map((o) => (
            <tr key={o.id}>
              <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{o.reference}</td>
              <td className="px-3 py-2.5">
                <div className="font-medium text-slate-900">{o.title}</div>
                <div className="text-xs text-slate-500">
                  {o.source_document_type === 'audit_followup_report' ? 'Audit follow-up report'
                    : o.source_document_type === 'regulatory_master_board' ? 'Regulatory master board'
                      : o.source_document_type === 'regulatory_compliance_board' ? 'Regulatory compliance board'
                        : o.source_document_type === 'regulatory_circular_tracker' ? 'Regulatory circular tracker'
                          : 'Manual entry'}
                  {o.source_document ? ` · ${o.source_document}` : ''}
                </div>
              </td>
              <td className="px-3 py-2.5 text-slate-600">{OBLIGATION_TYPE[o.obligation_type] || o.obligation_type}</td>
              <td className="px-3 py-2.5 text-slate-600">{o.department}</td>
              <td className="px-3 py-2.5 text-slate-600">{o.source_owner_label || '—'}</td>
              <td className="px-3 py-2.5 text-slate-600">{o.recurrence_rule || 'one-off'}</td>
              <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{o.effective_deadline || '—'}</td>
              <td className="px-3 py-2.5 text-slate-600">
                <div>{o.reminder_lead_days}d lead</div>
                <div className="text-xs text-slate-400">every {o.reminder_interval_days}d</div>
              </td>
              <td className="px-3 py-2.5"><SlaChip slaState={o.sla_state} /></td>
              <td className="px-3 py-2.5">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  o.status === 'active' ? 'bg-emerald-100 text-emerald-800'
                    : o.status === 'draft' ? 'bg-amber-100 text-amber-800'
                      : 'bg-slate-100 text-slate-600'}`}>{o.status}</span>
              </td>
              <td className="px-3 py-2.5 text-right">
                {canManage && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {o.status === 'draft' && (
                      <button disabled={busy} onClick={() => activate(o.id, 'active')}
                        className={actBtnGreen}>
                        <ClipboardCheck className="h-3.5 w-3.5" />Validate &amp; activate
                      </button>
                    )}
                    {o.status === 'active' && (
                      <>
                        <button disabled={busy} onClick={() => openEdit(o, 'edit')} className={actBtn}>
                          <Pencil className="h-3.5 w-3.5" />Edit
                        </button>
                        <button disabled={busy} onClick={() => setConfirm({ kind: 'paused', obligation: o })} className={actBtn}>
                          <Pause className="h-3.5 w-3.5" />Pause
                        </button>
                        <button disabled={busy} onClick={() => setConfirm({ kind: 'draft', obligation: o })} className={actBtn}>
                          <Undo2 className="h-3.5 w-3.5" />Send back
                        </button>
                        <button disabled={busy} onClick={() => setConfirm({ kind: 'archived', obligation: o })} className={actBtnRed}>
                          <Trash2 className="h-3.5 w-3.5" />Delete
                        </button>
                      </>
                    )}
                    {!['draft', 'active'].includes(o.status) && (
                      <span className="text-xs text-slate-400">No actions</span>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Acknowledgement coverage"
          description="Per obligation: who has acknowledged their receipt of the notice.">
          <div className="space-y-3">
            {coverage.length === 0 && <p className="text-sm text-slate-500">No active obligations are being tracked yet.</p>}
            {coverage.map((c) => {
              const pct = c.recipients > 0 ? Math.round((c.acknowledged / c.recipients) * 100) : 0
              return (
                <div key={c.id}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate font-medium text-slate-800">{c.title}</span>
                    <span className="shrink-0 tabular-nums text-xs text-slate-500">
                      {c.acknowledged}/{c.recipients} · {pct}%
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex-1"><Meter pct={pct} tone={pct >= 100 ? 'green' : pct >= 50 ? 'amber' : 'red'} /></div>
                    <span className="w-20 shrink-0 text-right text-xs text-slate-400">{c.department}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>

        <SectionCard
          title="Department completion"
          description="Share of each department's issued obligations that reached accepted or closed.">
          <div className="space-y-3">
            {departments.length === 0 && <p className="text-sm text-slate-500">No assignments issued to any department yet.</p>}
            {departments.map((d) => (
              <div key={d.department}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-800">{d.department}</span>
                  <span className="tabular-nums text-xs text-slate-500">
                    {d.completed}/{d.assignments} · {d.completion_pct == null ? '—' : `${d.completion_pct}%`}
                  </span>
                </div>
                <div className="mt-1"><Meter pct={d.completion_pct} tone={d.completion_pct >= 80 ? 'green' : d.completion_pct >= 50 ? 'amber' : 'red'} /></div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Deadline horizon"
        description="Everything due within 30 days, with the server-computed SLA state.">
        <DataTable
          columns={[
            { key: 'ob', label: 'Obligation' },
            { key: 'dept', label: 'Department' },
            { key: 'owner', label: 'Owner' },
            { key: 'due', label: 'Submission due' },
            { key: 'days', label: 'Days' },
            { key: 'sla', label: 'SLA state' },
          ]}
          rowCount={horizon.length}
          empty="Nothing is due in the next 30 days.">
          {horizon.map((h) => (
            <tr key={`${h.id}-${h.reference}`} className={h.sla_state === 'overdue' ? 'bg-red-50' : ''}>
              <td className="px-3 py-2.5">
                <div className="font-medium text-slate-900">{h.title}</div>
                <div className="text-xs text-slate-500">{h.reference}</div>
              </td>
              <td className="px-3 py-2.5 text-slate-600">{h.department}</td>
              <td className="px-3 py-2.5 text-slate-600">{h.owner_name || 'Unassigned'}</td>
              <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{h.submission_deadline || '—'}</td>
              <td className="px-3 py-2.5 tabular-nums text-slate-600">
                {h.sla_state === 'overdue' ? <span className="font-medium text-red-700">{Math.abs(h.days_until_due)}d late</span> : h.days_until_due}
              </td>
              <td className="px-3 py-2.5"><SlaChip slaState={h.sla_state} daysUntilDue={h.days_until_due} /></td>
            </tr>
          ))}
        </DataTable>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Submission review queue" description="Responses waiting on an audit decision.">
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
                    <StatusChip map={SUBMISSION_STATUS} value={r.status} />
                  </div>
                  {returning === r.submission_id ? (
                    <div className="mt-3 space-y-2">
                      <label className={labelCls}>Correction reason (required and recorded)</label>
                      <textarea className={inputCls} rows={2} value={returnReason}
                        onChange={(e) => setReturnReason(e.target.value)}
                        placeholder="Exactly which fields or documents need correcting, and why" />
                      <div className="flex gap-2">
                        <button disabled={busy || !returnReason.trim()}
                          onClick={() => review(r.submission_id, 'returned_for_correction', returnReason.trim())}
                          className={primaryBtn}>Return for correction</button>
                        <button onClick={() => { setReturning(null); setReturnReason('') }} className={ghostBtn}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex gap-2">
                      <button disabled={busy} onClick={() => review(r.submission_id, 'under_review')} className={ghostBtn}>
                        <ClipboardCheck className="h-4 w-4" />Start review
                      </button>
                      <button disabled={busy} onClick={() => review(r.submission_id, 'accepted')} className={ghostBtn}>
                        <CheckCircle2 className="h-4 w-4" />Accept
                      </button>
                      <button disabled={busy} onClick={() => setReturning(r.submission_id)} className={ghostBtn}>
                        <Gavel className="h-4 w-4" />Return
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="High-risk findings" description="Open high and critical findings from the audit register.">
          <DataTable
            columns={[
              { key: 'f', label: 'Finding' },
              { key: 'dept', label: 'Department' },
              { key: 'sev', label: 'Severity' },
              { key: 'due', label: 'Due' },
              { key: 'status', label: 'Status' },
            ]}
            rowCount={findings.length}
            empty="No open high-risk findings.">
            {findings.map((f) => (
              <tr key={f.id} className={f.is_overdue ? 'bg-red-50' : ''}>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-slate-900">{f.title}</div>
                  <div className="text-xs text-slate-500">{f.reference || ''}</div>
                </td>
                <td className="px-3 py-2.5 text-slate-600">{f.department}</td>
                <td className="px-3 py-2.5">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                    f.severity === 'critical' ? 'bg-red-100 text-red-800' : 'bg-orange-100 text-orange-800'}`}>{f.severity}</span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                  {f.due_date || '—'}{f.is_overdue && <span className="ml-1 text-xs text-red-700">overdue</span>}
                </td>
                <td className="px-3 py-2.5"><StatusChip map={FINDING_STATUS} value={f.status} /></td>
              </tr>
            ))}
          </DataTable>
        </SectionCard>
      </div>

      <SectionCard
        title="All issued obligations"
        description={`${obligations.length} assignments across every department.`}>
        <DataTable
          columns={[
            { key: 'ob', label: 'Obligation' },
            { key: 'type', label: 'Type' },
            { key: 'dept', label: 'Department' },
            { key: 'owner', label: 'Owner' },
            { key: 'risk', label: 'Risk' },
            { key: 'ack', label: 'Ack' },
            { key: 'due', label: 'Due' },
            { key: 'sla', label: 'SLA state' },
            { key: 'assign', label: 'Assignment' },
          ]}
          rowCount={obligations.length}
          empty="No obligations have been issued yet.">
          {obligations.map((o) => (
            <tr key={o.assignment_id}>
              <td className="px-3 py-2.5">
                <div className="font-medium text-slate-900">{o.title}</div>
                <div className="text-xs text-slate-500">{o.reference}</div>
              </td>
              <td className="px-3 py-2.5 text-slate-600">{OBLIGATION_TYPE[o.obligation_type] || o.obligation_type}</td>
              <td className="px-3 py-2.5 text-slate-600">{o.department}</td>
              <td className="px-3 py-2.5 text-slate-600">{o.owner_name || 'Unassigned'}</td>
              <td className="px-3 py-2.5">
                <span className={`text-xs font-medium ${RISK_TONE[o.risk_rating] === 'red' ? 'text-red-600' : 'text-slate-600'}`}>
                  {o.risk_rating}
                </span>
              </td>
              <td className="px-3 py-2.5 text-slate-600">{o.acknowledged_at ? 'Yes' : 'No'}</td>
              <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{o.submission_deadline || '—'}</td>
              <td className="px-3 py-2.5"><SlaChip slaState={o.sla_state} daysUntilDue={o.days_until_due} /></td>
              <td className="px-3 py-2.5"><StatusChip map={ASSIGNMENT_STATUS} value={o.assignment_status} /></td>
            </tr>
          ))}
        </DataTable>
      </SectionCard>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className={`${card} w-full max-w-2xl p-5`}>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <Building2 className="h-5 w-5 text-[#009944]" />New audit obligation
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Creates the requirement once. Issue it to individuals afterwards from the shared workspace.
            </p>
            <form onSubmit={createObligation} className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>Reference *</label>
                <input className={inputCls} value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="AUD-2026-014" />
              </div>
              <div>
                <label className={labelCls}>Title *</label>
                <input className={inputCls} value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Regulatory return — Q4 filing" />
              </div>
              <div>
                <label className={labelCls}>Department</label>
                <input className={inputCls} value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Type</label>
                <select className={inputCls} value={form.obligationType}
                  onChange={(e) => setForm({ ...form, obligationType: e.target.value })}>
                  {Object.entries(OBLIGATION_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Risk rating</label>
                <select className={inputCls} value={form.riskRating}
                  onChange={(e) => setForm({ ...form, riskRating: e.target.value })}>
                  {['low', 'medium', 'high', 'critical'].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Reporting period</label>
                <input className={inputCls} value={form.reportingPeriod}
                  onChange={(e) => setForm({ ...form, reportingPeriod: e.target.value })} placeholder="FY2026 Q4" />
              </div>
              <div>
                <label className={labelCls}>Acknowledgement deadline</label>
                <input type="date" className={inputCls} value={form.acknowledgementDeadline}
                  onChange={(e) => setForm({ ...form, acknowledgementDeadline: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Submission deadline</label>
                <input type="date" className={inputCls} value={form.submissionDeadline}
                  onChange={(e) => setForm({ ...form, submissionDeadline: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Instructions to recipients</label>
                <textarea className={inputCls} rows={2} value={form.instructions}
                  onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
              </div>
              {formError && <p className="sm:col-span-2 text-sm text-red-700">{formError}</p>}
              <div className="flex justify-end gap-2 sm:col-span-2">
                <button type="button" onClick={() => setShowForm(false)} className={ghostBtn}>Cancel</button>
                <button type="submit" disabled={busy} className={primaryBtn}>Create obligation</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* ---- Obligation edit / validate-and-activate modal (Phase 72c) ------- */}
      {editForm.id && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
          <div className={`${card} my-8 w-full max-w-3xl p-5`}>
            {(() => {
              // The register row behind the form, for the read-only provenance
              // and the server-computed SLA state (which is never editable).
              const row = (register?.obligations || []).find((o) => o.id === editForm.id) || {}
              return (
                <>
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                    <Pencil className="h-5 w-5 text-[#009944]" />
                    Edit obligation
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Edit the obligation. Deadlines and reminder windows are the live legal position; the imported source wording below is preserved unchanged.
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    <span className="font-medium text-slate-700">{row.reference}</span>
                    <span className="text-slate-300">·</span>
                    <span>{OBLIGATION_TYPE[row.obligation_type] || row.obligation_type}</span>
                    <span className="text-slate-300">·</span>
                    <span>{row.department}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-slate-400">Owner (source)</span>
                      <span className="font-medium text-slate-700">{row.source_owner_label || '—'}</span>
                      <span className="text-slate-300">·</span>
                      <SlaChip slaState={row.sla_state} />
                    </span>
                  </div>

                  <form onSubmit={(e) => { e.preventDefault(); saveObligation(null) }}
                    className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelCls}>Reference</label>
                      <input className={inputCls} value={editForm.reference}
                        onChange={(e) => setEditForm({ ...editForm, reference: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Title</label>
                      <input className={inputCls} value={editForm.title}
                        onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Type</label>
                      <select className={inputCls} value={editForm.obligationType}
                        onChange={(e) => setEditForm({ ...editForm, obligationType: e.target.value })}>
                        {Object.entries(OBLIGATION_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Department</label>
                      <input className={inputCls} value={editForm.department}
                        onChange={(e) => setEditForm({ ...editForm, department: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Priority</label>
                      <select className={inputCls} value={editForm.priority}
                        onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}>
                        {['low', 'medium', 'high', 'critical'].map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Risk rating</label>
                      <select className={inputCls} value={editForm.riskRating}
                        onChange={(e) => setEditForm({ ...editForm, riskRating: e.target.value })}>
                        {['low', 'medium', 'high', 'critical'].map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Reporting period</label>
                      <input className={inputCls} value={editForm.reportingPeriod}
                        onChange={(e) => setEditForm({ ...editForm, reportingPeriod: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Recurrence rule</label>
                      <input className={inputCls} value={editForm.recurrenceRule} placeholder="monthly:5"
                        onChange={(e) => setEditForm({ ...editForm, recurrenceRule: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Next occurrence</label>
                      <input type="date" className={inputCls} value={editForm.nextOccurrence}
                        onChange={(e) => setEditForm({ ...editForm, nextOccurrence: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Submission deadline</label>
                      <input type="date" className={inputCls} value={editForm.submissionDeadline}
                        onChange={(e) => setEditForm({ ...editForm, submissionDeadline: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Acknowledgement deadline</label>
                      <input type="date" className={inputCls} value={editForm.acknowledgementDeadline}
                        onChange={(e) => setEditForm({ ...editForm, acknowledgementDeadline: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Review deadline</label>
                      <input type="date" className={inputCls} value={editForm.reviewDeadline}
                        onChange={(e) => setEditForm({ ...editForm, reviewDeadline: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Issue date</label>
                      <input type="date" className={inputCls} value={editForm.issueDate}
                        onChange={(e) => setEditForm({ ...editForm, issueDate: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Source document</label>
                      <input className={inputCls} value={editForm.sourceDocument}
                        onChange={(e) => setEditForm({ ...editForm, sourceDocument: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>Source reference</label>
                      <input className={inputCls} value={editForm.sourceReference} placeholder="Master Board S/N 1"
                        onChange={(e) => setEditForm({ ...editForm, sourceReference: e.target.value })} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className={labelCls}>Obligation text</label>
                      <textarea className={inputCls} rows={2} value={editForm.description}
                        onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className={labelCls}>Instructions to recipients</label>
                      <textarea className={inputCls} rows={2} value={editForm.instructions}
                        onChange={(e) => setEditForm({ ...editForm, instructions: e.target.value })} />
                    </div>

                    <div className="sm:col-span-2 border-t border-slate-100 pt-3">
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Reminder &amp; escalation
                      </h3>
                      <div className="grid gap-3 sm:grid-cols-4">
                        <div>
                          <label className={labelCls}>Lead days</label>
                          <input type="number" min="0" max="365" className={inputCls} value={editForm.reminderLeadDays}
                            onChange={(e) => setEditForm({ ...editForm, reminderLeadDays: Number(e.target.value) })} />
                        </div>
                        <div>
                          <label className={labelCls}>Every days</label>
                          <input type="number" min="1" max="365" className={inputCls} value={editForm.reminderIntervalDays}
                            onChange={(e) => setEditForm({ ...editForm, reminderIntervalDays: Number(e.target.value) })} />
                        </div>
                        <div>
                          <label className={labelCls}>Escalation role</label>
                          <input className={inputCls} value={editForm.escalationRole}
                            onChange={(e) => setEditForm({ ...editForm, escalationRole: e.target.value })} />
                        </div>
                        <div>
                          <label className={labelCls}>Escalate after days</label>
                          <input type="number" min="0" max="365" className={inputCls} value={editForm.escalationDelayDays}
                            onChange={(e) => setEditForm({ ...editForm, escalationDelayDays: Number(e.target.value) })} />
                        </div>
                      </div>
                    </div>

                    {editError && <p className="sm:col-span-2 text-sm text-red-700">{editError}</p>}
                    <div className="flex justify-end gap-2 sm:col-span-2">
                      <button type="button" onClick={() => setEditForm(BLANK_EDIT)} className={ghostBtn}>Cancel</button>
                      <button type="submit" disabled={busy} className={primaryBtn}>
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        Save changes
                      </button>
                    </div>
                  </form>
                </>
              )
            })()}
          </div>
        </div>
      )}

      {/* ---- Status-action confirmation (Pause / Send back / Delete) --------- */}
      {confirm && (() => {
        const a = OBLIGATION_ACTIONS[confirm.kind]
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
            <div className={`${card} w-full max-w-md p-5`}>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                <AlertTriangle className="h-5 w-5 text-amber-500" />{a.title}
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                <span className="font-medium text-slate-800">{confirm.obligation.reference}</span>
                {' — '}{confirm.obligation.title}
              </p>
              <p className="mt-1 text-sm text-slate-500">{a.body}</p>
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setConfirm(null)} className={ghostBtn}>Cancel</button>
                <button disabled={busy} onClick={() => applyStatus(confirm.obligation, a.key)}
                  className={confirm.kind === 'archived' ? actBtnRed : primaryBtn}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}{a.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
