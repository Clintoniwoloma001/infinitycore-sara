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
} from 'lucide-react'
import { auditService, REGULATORY_STATUS, FINDING_STATUS, fmtDate } from '../services/auditService'
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

export default function Audit() {
  const { hasPermission, profile } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'findings' ? 'findings' : 'regulatory'

  // Read is gated server-side too; this only decides whether to show buttons.
  const canManage = hasPermission('audit.monitoring.manage')
    || ['super_admin', 'admin', 'head_of_audit'].includes(profile?.role)

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

  useEffect(() => { load() }, [load])
  useEffect(() => { employeeService.list().then(setEmployees).catch(() => setEmployees([])) }, [])

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
  const tabs = [
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

