// ============================================================================
// My Department's Audit - Heads of Department (server-scoped)
// ============================================================================
// What the Head of Audit issued to THIS department: what is due, which staff
// have acknowledged, what has been submitted, what came back for correction
// and exactly why, plus the department's own audit findings.
//
// THE DEPARTMENT IS NOT CLIENT INPUT. get_my_department_audit() reads the
// caller's department from THEIR OWN profiles row server-side, so tampering
// with the request cannot surface another department's work - and the page
// renders whatever department the server resolved, never a remembered guess.
import React, { useCallback, useEffect, useState } from 'react'
import { Building2, RefreshCw, FileWarning, CalendarClock, MessageSquareWarning, Undo2 } from 'lucide-react'
import { auditService, ASSIGNMENT_STATUS, FINDING_STATUS, OBLIGATION_TYPE, SUBMISSION_STATUS } from '../../services/auditService'
import { LoadingState, ErrorState, EmptyState } from '../../components/PageStates'
import { KpiCard, SlaChip, StatusChip, SectionCard, Meter, DataTable } from './auditUi'

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1'
const ghostBtn = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50'

export default function DepartmentAudit() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [blocked, setBlocked] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null); setBlocked(false)
    try {
      setData(await auditService.myDepartmentAudit())
    } catch (e) {
      if (/AUDIT_FORBIDDEN/i.test(e.message || '')) setBlocked(true)
      else setError(e.message)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return <LoadingState label="Loading your department's audit position..." />
  if (blocked) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <Building2 className="mx-auto h-8 w-8 text-slate-300" />
          <h1 className="mt-3 text-lg font-semibold text-slate-900">Department audit is restricted</h1>
          <p className="mt-2 text-sm text-slate-600">
            This workspace is limited to Heads of Department. The server confirmed your account does not hold
            that access.
          </p>
        </div>
      </div>
    )
  }
  if (error) return <ErrorState title="Unable to load your department's audit position" message={error} />

  const s = data?.summary || {}
  const obligations = data?.obligations || []
  const submissions = data?.submissions || []
  const findings = data?.findings || []
  const dept = data?.viewer?.department || 'your department'
  const ackPct = s.assignments > 0 ? Math.round((s.acknowledged / s.assignments) * 100) : null

  // The correction trail, newest first, so the reason is one glance away.
  const returned = submissions.filter((x) => x.status === 'returned_for_correction')

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <Building2 className="h-6 w-6 text-[#009944]" />My Department&apos;s Audit
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Everything the Audit office issued to <span className="font-medium text-slate-700">{dept}</span>:
            deadlines, acknowledgements, submissions, corrections and findings.
          </p>
        </div>
        <button onClick={load} className={ghostBtn}><RefreshCw className="h-4 w-4" />Refresh</button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Obligations issued" value={s.obligations_issued} icon={CalendarClock} />
        <KpiCard label="Assignments" value={s.assignments} hint={ackPct == null ? null : `${ackPct}% acknowledged`} />
        <KpiCard label="Acknowledged" value={s.acknowledged} tone="green" icon={MessageSquareWarning} />
        <KpiCard label="Submitted" value={s.submitted} tone="green" />
        <KpiCard label="Overdue" value={s.overdue} tone={(s.overdue ?? 0) > 0 ? 'red' : 'slate'} icon={FileWarning} />
        <KpiCard label="Returned for correction" value={s.returned_for_correction} tone="amber" icon={Undo2} />
      </div>

      <SectionCard
        title="Acknowledgement position"
        description="Receipt of the notice, and completion, for this department.">
        <div className="flex flex-wrap items-center gap-6">
          <div className="min-w-[160px] flex-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-slate-600">Acknowledged</span>
              <span className="tabular-nums font-medium">{s.acknowledged ?? 0}/{s.assignments ?? 0}</span>
            </div>
            <div className="mt-1"><Meter pct={ackPct} tone={ackPct >= 80 ? 'green' : ackPct >= 50 ? 'amber' : 'red'} /></div>
          </div>
          <div className="min-w-[160px] flex-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-slate-600">Submitted</span>
              <span className="tabular-nums font-medium">{s.submitted ?? 0}/{s.assignments ?? 0}</span>
            </div>
            <div className="mt-1"><Meter pct={s.assignments > 0 ? Math.round((s.submitted / s.assignments) * 100) : null} tone="green" /></div>
          </div>
          <div className="min-w-[160px] flex-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-slate-600">Due today / next 30 days</span>
              <span className="tabular-nums font-medium">{s.due_today ?? 0} / {s.due_next_30 ?? 0}</span>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Obligations assigned to this department" description="Ordered by the server's SLA urgency.">
        <DataTable
          columns={[
            { key: 'ob', label: 'Obligation' },
            { key: 'owner', label: 'Assigned to' },
            { key: 'ack', label: 'Acknowledgement' },
            { key: 'due', label: 'Submission due' },
            { key: 'days', label: 'Days' },
            { key: 'sla', label: 'SLA state' },
            { key: 'assign', label: 'Assignment' },
          ]}
          rowCount={obligations.length}
          empty="The Audit office has not issued anything to your department yet.">
          {obligations.map((o) => (
            <tr key={o.assignment_id} className={o.sla_state === 'overdue' ? 'bg-red-50' : ''}>
              <td className="px-3 py-2.5">
                <div className="font-medium text-slate-900">{o.title}</div>
                <div className="text-xs text-slate-500">
                  {o.reference} · {OBLIGATION_TYPE[o.obligation_type] || o.obligation_type}
                  {o.risk_rating && ` · risk ${o.risk_rating}`}
                </div>
                {o.instructions && <div className="mt-0.5 max-w-md text-xs text-slate-400">{o.instructions}</div>}
              </td>
              <td className="px-3 py-2.5 text-slate-600">
                <div>{o.owner_name || o.source_owner_label || 'Unassigned'}</div>
                {o.owner_email && <div className="text-xs text-slate-400">{o.owner_email}</div>}
              </td>
              <td className="px-3 py-2.5 text-slate-600">
                {o.acknowledged_at
                  ? <span className="text-emerald-700">Acknowledged</span>
                  : <span className="text-amber-700">Awaiting</span>}
                {!o.acknowledged_at && o.acknowledgement_deadline && (
                  <div className="text-xs text-slate-400">by {o.acknowledgement_deadline}</div>
                )}
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                {o.submission_deadline || '—'}
                {o.recurrence_rule && o.recurrence_rule !== 'none' && (
                  <div className="text-xs text-slate-400">{o.recurrence_rule}</div>
                )}
                {o.original_submission_deadline && o.original_submission_deadline !== o.submission_deadline && (
                  <div className="text-xs text-amber-700">
                    extended from {o.original_submission_deadline}
                  </div>
                )}
              </td>
              <td className="px-3 py-2.5 tabular-nums text-slate-600">
                {o.sla_state === 'overdue'
                  ? <span className="font-medium text-red-700">{Math.abs(o.days_until_due ?? 0)}d late</span>
                  : (o.days_until_due ?? '—')}
              </td>
              <td className="px-3 py-2.5"><SlaChip slaState={o.sla_state} daysUntilDue={o.days_until_due} /></td>
              <td className="px-3 py-2.5">
                {o.assignment_id
                  ? <StatusChip map={ASSIGNMENT_STATUS} value={o.assignment_status} />
                  : <span className="text-xs text-slate-400">awaiting issue</span>}
              </td>
            </tr>
          ))}
        </DataTable>
      </SectionCard>

      <SectionCard
        title="Submitted, returned and accepted"
        description="Every response from this department, with the exact correction reasons.">
        {submissions.length === 0 ? (
          <EmptyState title="No submissions yet" description="Responses from your department will appear here as they arrive." />
        ) : (
          <div className="space-y-3">
            {returned.map((r) => (
              <div key={r.id} className="rounded-xl border border-orange-200 bg-orange-50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{r.obligation_title}</div>
                    <div className="text-xs text-slate-600">
                      {r.reference} · v{r.version} · returned by {r.submitted_by_name}
                    </div>
                  </div>
                  <StatusChip map={SUBMISSION_STATUS} value={r.status} />
                </div>
                <label className={labelCls}>Correction reason</label>
                <p className="text-sm text-slate-800">{r.correction_reason}</p>
                {r.correction_fields?.length > 0 && (
                  <p className="mt-1 text-xs text-slate-500">
                    Fields to correct: {r.correction_fields.join(', ')}
                  </p>
                )}
                <textarea className={`${inputCls} mt-2`} rows={2}
                  placeholder="Add the department's correction action, then ask the owner to resubmit from the shared workspace." />
                <div className="mt-2 flex justify-end">
                  <button className={ghostBtn}><Undo2 className="h-4 w-4" />Record correction action</button>
                </div>
              </div>
            ))}
            <DataTable
              columns={[
                { key: 'ob', label: 'Obligation' },
                { key: 'who', label: 'Submitted by' },
                { key: 'ver', label: 'Version' },
                { key: 'when', label: 'When' },
                { key: 'status', label: 'Status' },
              ]}
              rowCount={submissions.length}
              empty="No submissions yet.">
              {submissions.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-slate-900">{r.obligation_title}</div>
                    <div className="text-xs text-slate-500">{r.reference}</div>
                  </td>
                  <td className="px-3 py-2.5 text-slate-600">{r.submitted_by_name}</td>
                  <td className="px-3 py-2.5 tabular-nums text-slate-600">v{r.version}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
                    {r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2.5"><StatusChip map={SUBMISSION_STATUS} value={r.status} /></td>
                </tr>
              ))}
            </DataTable>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Department findings" description="Findings raised against this department, straight from the audit register.">
        <DataTable
          columns={[
            { key: 'f', label: 'Finding' },
            { key: 'sev', label: 'Severity' },
            { key: 'due', label: 'Due' },
            { key: 'status', label: 'Status' },
          ]}
          rowCount={findings.length}
          empty="No findings have been raised against your department.">
          {findings.map((f) => (
            <tr key={f.id}>
              <td className="px-3 py-2.5">
                <div className="font-medium text-slate-900">{f.title}</div>
                {f.reference && <div className="text-xs text-slate-500">{f.reference}</div>}
              </td>
              <td className="px-3 py-2.5">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                  f.severity === 'critical' ? 'bg-red-100 text-red-800'
                    : f.severity === 'high' ? 'bg-orange-100 text-orange-800'
                      : 'bg-slate-100 text-slate-700'}`}>{f.severity}</span>
              </td>
              <td className="px-3 py-2.5 text-slate-600">{f.due_date || '—'}</td>
              <td className="px-3 py-2.5"><StatusChip map={FINDING_STATUS} value={f.status} /></td>
            </tr>
          ))}
        </DataTable>
      </SectionCard>
    </div>
  )
}
