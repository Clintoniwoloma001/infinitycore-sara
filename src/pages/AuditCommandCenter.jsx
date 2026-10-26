// ============================================================================
// Audit Command Centre — Head of Audit review UI (Phase 7)
// ============================================================================
// Per-assignee review workspace for an audit cycle. Every status transition is
// performed through the server's RPCs; the browser never decides whether an
// assignee, a department, or a whole cycle may be marked complete.
import React, { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Clock, FileText, Loader2, Mail, MessageSquare,
  RefreshCw, Send, ShieldCheck, X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, ErrorState, EmptyState } from '../components/PageStates'
import { auditCommandCenterService } from '../services/auditCommandCenterService'

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'
const card = 'bg-white rounded-2xl border border-slate-200 p-5'

const STATUS_CHIP = {
  submitted: 'bg-amber-100 text-amber-800',
  info_requested: 'bg-sky-100 text-sky-800',
  completed: 'bg-emerald-100 text-emerald-800',
  reopened: 'bg-rose-100 text-rose-800',
  late: 'bg-red-100 text-red-800',
}

function fmtDate(d) {
  if (!d) return '—'
  try { return new Date(d).toLocaleString() } catch { return String(d) }
}

function daysLate(row) {
  if (!row?.submitted_at || !row?.due_at) return 0
  const diff = new Date(row.submitted_at) - new Date(row.due_at)
  return diff > 0 ? Math.ceil(diff / (24 * 60 * 60 * 1000)) : 0
}

function onTime(row) {
  return daysLate(row) === 0
}

export default function AuditCommandCenter() {
  const { hasPermission, profile } = useAuth()
  const canManage = hasPermission('audit.command_center.manage')
    || ['super_admin', 'admin', 'head_of_audit'].includes(profile?.role)

  const [cycleId, setCycleId] = useState(null)
  const [cycles, setCycles] = useState([])
  const [rows, setRows] = useState([])
  const [unmatched, setUnmatched] = useState([])
  const [threads, setThreads] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState(null)
  const [requestTarget, setRequestTarget] = useState(null)
  const [requestMsg, setRequestMsg] = useState('')
  const [threadTarget, setThreadTarget] = useState(null)
  const [overrideReason, setOverrideReason] = useState('')

  const loadCycles = useCallback(async () => {
    try {
      const data = await auditCommandCenterService.listCycles()
      setCycles(data || [])
      if (!cycleId && (data || []).length) setCycleId(data[0].id)
    } catch (e) { setError(e.message) }
  }, [cycleId])

  const load = useCallback(async () => {
    if (!cycleId) return
    setLoading(true); setError(null)
    try {
      const data = await auditCommandCenterService.listAssignees(cycleId)
      setRows(data?.assignees || data || [])
      const u = await auditCommandCenterService.listUnmatchedReplies(cycleId)
      setUnmatched(u?.replies || u || [])
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [cycleId])

  useEffect(() => { loadCycles() }, [loadCycles])
  useEffect(() => { load() }, [load])

  const openThread = async (row) => {
    setThreadTarget(row)
    if (threads[row.id]) return
    try {
      const t = await auditCommandCenterService.getThread(row.id)
      setThreads((prev) => ({ ...prev, [row.id]: t?.messages || t || [] }))
    } catch (e) { setRowError(e.message) }
  }

  const openSignedUrl = async (path) => {
    try {
      const url = await auditCommandCenterService.getSignedUrl(path)
      if (url) window.open(url, '_blank')
    } catch (e) { setRowError(e.message) }
  }

  const requestMoreInfo = async () => {
    if (!requestTarget) return
    if (!requestMsg.trim()) { setRowError('A message is required to request more info.'); return }
    setBusy(true); setRowError(null)
    try {
      await auditCommandCenterService.requestMoreInfo({
        assigneeId: requestTarget.id,
        message: requestMsg.trim(),
      })
      setRequestTarget(null); setRequestMsg('')
      await load()
    } catch (e) { setRowError(e.message) } finally { setBusy(false) }
  }

  const markPersonCompleted = async (row) => {
    setBusy(true); setRowError(null)
    try {
      await auditCommandCenterService.markPersonCompleted(row.id)
      await load()
    } catch (e) { setRowError(e.message) } finally { setBusy(false) }
  }

  const reopen = async (row) => {
    setBusy(true); setRowError(null)
    try {
      await auditCommandCenterService.reopen(row.id)
      await load()
    } catch (e) { setRowError(e.message) } finally { setBusy(false) }
  }

  const markDepartmentCompleted = async (dept) => {
    setBusy(true); setRowError(null)
    try {
      await auditCommandCenterService.markDepartmentCompleted({ cycleId, department: dept })
      await load()
    } catch (e) { setRowError(e.message) } finally { setBusy(false) }
  }

  const markCycleCompleted = async () => {
    setBusy(true); setRowError(null)
    try {
      await auditCommandCenterService.markCycleCompleted({ cycleId, overrideReason: overrideReason.trim() || null })
      await load()
    } catch (e) { setRowError(e.message) } finally { setBusy(false) }
  }

  const rolloverNextCycle = async () => {
    setBusy(true); setRowError(null)
    try {
      await auditCommandCenterService.rolloverNextCycle(cycleId)
      await loadCycles()
      await load()
    } catch (e) { setRowError(e.message) } finally { setBusy(false) }
  }

  if (loading && rows.length === 0) return <LoadingState label="Loading audit command centre..." />
  if (error) return <ErrorState title="Unable to load audit command centre" message={error} />

  const departments = [...new Set(rows.map((r) => r.department || r.dept).filter(Boolean))]

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <ShieldCheck className="w-6 h-6 text-[#009944]" />Audit Command Centre
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Head of Audit review workspace — per-assignee submission status, timeliness and full thread.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={cycleId || ''}
            onChange={(e) => setCycleId(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700">
            {cycles.map((c) => <option key={c.id} value={c.id}>{c.label || c.name || c.id}</option>)}
          </select>
          <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" />Refresh
          </button>
        </div>
      </header>

      {rowError && <p className="text-sm text-red-700">{rowError}</p>}

      <section className={card}>
        <h2 className="mb-4 text-sm font-semibold text-slate-800">Per-assignee review table</h2>
        {rows.length === 0 ? (
          <EmptyState title="No assignees" description="No submissions for this cycle." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Dept</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Submitted At</th>
                  <th className="px-3 py-2 text-left">Timeliness</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-left">Comment</th>
                  <th className="px-3 py-2 text-left">Attachments</th>
                  <th className="px-3 py-2 text-left">Thread</th>
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const late = !onTime(r)
                  const dLate = daysLate(r)
                  return (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-medium text-slate-800">{r.name || r.full_name || r.assignee_name || '—'}</td>
                      <td className="px-3 py-2 text-slate-600">{r.department || r.dept || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CHIP[r.status] || 'bg-slate-100 text-slate-600'}`}>
                          {r.status || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{fmtDate(r.submitted_at)}</td>
                      <td className="px-3 py-2">
                        {late ? (
                          <span className="text-red-700 font-medium">LATE {dLate} days late</span>
                        ) : (
                          <span className="text-emerald-700 font-medium">ON TIME</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{r.source || '—'}</td>
                      <td className="px-3 py-2 text-slate-600">{r.comment || r.hr_comment || '—'}</td>
                      <td className="px-3 py-2">
                        {(r.attachments || r.documents || []).length === 0 ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <div className="space-y-1">
                            {(r.attachments || r.documents || []).map((a, i) => (
                              <button key={i}
                                onClick={() => openSignedUrl(a.file_path || a.path)}
                                className="block text-xs text-[#009944] hover:underline">
                                {a.file_name || a.name || 'attachment'} (signed URL)
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => openThread(r)}
                          className="text-xs text-slate-700 hover:underline">
                          Full thread
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {canManage && (
                            <>
                              <button onClick={() => { setRequestTarget(r); setRequestMsg('') }}
                                className="rounded-md bg-sky-600 px-2 py-1 text-xs text-white">
                                Request more info
                              </button>
                              <button onClick={() => markPersonCompleted(r)}
                                className="rounded-md bg-emerald-600 px-2 py-1 text-xs text-white">
                                Mark person completed
                              </button>
                              <button onClick={() => reopen(r)}
                                className="rounded-md bg-rose-600 px-2 py-1 text-xs text-white">
                                Reopen
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Department & cycle actions</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          {departments.map((d) => (
            <button key={d} disabled={!canManage || busy}
              onClick={() => markDepartmentCompleted(d)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              Mark department completed — {d}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            placeholder="Logged override reason (optional)"
            className={inputCls + ' max-w-md'} />
          <button disabled={!canManage || busy} onClick={markCycleCompleted}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            Mark cycle completed (all completed or logged override)
          </button>
          <button disabled={!canManage || busy} onClick={rolloverNextCycle}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            rollover next cycle
          </button>
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Unmatched replies queue</h2>
        {unmatched.length === 0 ? (
          <p className="text-sm text-slate-500">No unmatched replies.</p>
        ) : (
          <ul className="space-y-2">
            {unmatched.map((u) => (
              <li key={u.id} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
                <span className="font-medium">{u.from_name || u.sender || 'Unknown'}</span>
                {' — '}{u.subject || u.message || 'reply'}
                {u.received_at && <span className="text-xs text-slate-400"> ({fmtDate(u.received_at)})</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Full thread modal */}
      {threadTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Full thread — {threadTarget.name || threadTarget.assignee_name}</h3>
              <button onClick={() => setThreadTarget(null)} aria-label="Close" className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              {(threads[threadTarget.id] || []).length === 0 ? (
                <p className="text-sm text-slate-400">No messages yet.</p>
              ) : (
                (threads[threadTarget.id] || []).map((m, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-700">{m.sender || m.author || '—'}</span>
                      <span className="text-xs text-slate-400">{fmtDate(m.created_at || m.sent_at)}</span>
                    </div>
                    <p className="text-sm text-slate-800 whitespace-pre-wrap">{m.message || m.body || m.content || ''}</p>
                    {(m.attachments || []).length > 0 && (
                      <div className="mt-2 space-y-1">
                        {m.attachments.map((a, j) => (
                          <button key={j} onClick={() => openSignedUrl(a.file_path || a.path)}
                            className="block text-xs text-[#009944] hover:underline">
                            {a.file_name || a.name || 'attachment'} (signed URL)
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Request more info modal */}
      {requestTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Request more info</h3>
              <button onClick={() => setRequestTarget(null)} aria-label="Close" className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-slate-500 mb-3">
              Sends an email + in-app notification. Status becomes info_requested; a response returns it to submitted.
            </p>
            <textarea
              value={requestMsg}
              onChange={(e) => setRequestMsg(e.target.value)}
              rows={4}
              placeholder="Required message..."
              className={inputCls + ' resize-none'} />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setRequestTarget(null)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600">Cancel</button>
              <button onClick={requestMoreInfo} disabled={busy || !requestMsg.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
                <Send className="w-4 h-4" />Send request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
