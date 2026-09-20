import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Clock, Download, FileSpreadsheet, Loader2,
  PenLine, RefreshCw, Send, ShieldCheck, Wallet, XCircle,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import SignaturePad from '../components/SignaturePad'
import CompensationEditorModal from '../components/payroll/CompensationEditorModal'
import { payrollService } from '../services/payrollService'
import { payrollPushService, PUSH_STATUS } from '../services/payrollPushService'
import { date, money } from './hrShared'

const cardCls = 'bg-white rounded-lg border border-slate-200 p-5 mb-6'
const btn = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium'
const btnPrimary = `${btn} bg-[#009944] text-white hover:bg-[#007a36] disabled:opacity-50`
const btnGhost = `${btn} border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50`
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

const STATE_STYLE = {
  PRODUCTION_ENABLED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  TEST_MODE: 'bg-amber-50 text-amber-700 border-amber-200',
  NOT_CONFIGURED: 'bg-slate-100 text-slate-600 border-slate-200',
}

function StatusPill({ value }) {
  const meta = PUSH_STATUS[value] || { label: value || '—', color: 'slate' }
  const colors = {
    slate: 'bg-slate-100 text-slate-600',
    amber: 'bg-amber-100 text-amber-700',
    emerald: 'bg-emerald-100 text-emerald-700',
    rose: 'bg-rose-100 text-rose-700',
    blue: 'bg-blue-100 text-blue-700',
    violet: 'bg-violet-100 text-violet-700',
  }
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${colors[meta.color] || colors.slate}`}>{meta.label}</span>
}

export default function PayrollBankOne() {
  const { hasPermission, role, isAdmin, user } = useAuth()
  const canPush = hasPermission('payroll.push') || isAdmin
  const canApprove = hasPermission('payroll.approve') || isAdmin
  const canEditCompensation = hasPermission('payroll.manage') || isAdmin

  const [tab, setTab] = useState('master')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const [configState, setConfigState] = useState(null)
  const [master, setMaster] = useState([])
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [preview, setPreview] = useState(null)
  const [requests, setRequests] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [approvals, setApprovals] = useState([])
  const [events, setEvents] = useState([])

  const [signAction, setSignAction] = useState('')
  const [signature, setSignature] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [showReject, setShowReject] = useState(false)
  const [editEmployeeId, setEditEmployeeId] = useState('')

  const selected = useMemo(() => requests.find((r) => r.id === selectedId) || null, [requests, selectedId])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [cfg, mast, per, reqs] = await Promise.all([
        payrollPushService.configState().catch(() => ({ state: 'NOT_CONFIGURED' })),
        payrollPushService.listMaster().catch(() => []),
        payrollService.listPeriods().catch(() => []),
        payrollPushService.listRequests().catch(() => []),
      ])
      setConfigState(cfg)
      setMaster(mast)
      setPeriods(per)
      setRequests(reqs)
      if (!selectedId && reqs[0]) setSelectedId(reqs[0].id)
      setSelectedPeriod((p) => p || (per[0]?.period_label || ''))
    } catch (e) {
      setError(e?.message || 'Unable to load payroll data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (canPush) load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedId) { setApprovals([]); setEvents([]); return }
    Promise.all([
      payrollPushService.listApprovals(selectedId).catch(() => []),
      payrollPushService.listEvents(selectedId).catch(() => []),
    ]).then(([a, e]) => { setApprovals(a); setEvents(e) })
  }, [selectedId])

  const runPreview = async () => {
    if (!selectedPeriod) return
    setBusy('preview'); setActionError(''); setNotice('')
    try {
      setPreview(await payrollPushService.preview(selectedPeriod))
    } catch (e) {
      setActionError(e?.message || 'Calculation failed')
    } finally { setBusy('') }
  }

  const createRequest = async () => {
    if (!selectedPeriod) return
    setBusy('create'); setActionError(''); setNotice('')
    try {
      const req = await payrollPushService.createRequest(selectedPeriod)
      await load()
      if (req?.id) setSelectedId(req.id)
      setTab('push')
      setNotice('Payroll request prepared. Sign and submit for HR approval.')
    } catch (e) {
      setActionError(e?.message || 'Could not create payroll request')
    } finally { setBusy('') }
  }

  const doSigned = async () => {
    if (!selected || !signature) { setActionError('A signature is required.'); return }
    setBusy(signAction); setActionError('')
    try {
      if (signAction === 'submit') await payrollPushService.submit(selected.id, signature)
      else if (signAction === 'approve') await payrollPushService.approve(selected.id, signature)
      else if (signAction === 'resubmit') await payrollPushService.resubmit(selected.id, signature)
      setSignAction(''); setSignature(null)
      await load()
      setNotice('Signature recorded.')
    } catch (e) {
      setActionError(e?.message || 'Action failed')
    } finally { setBusy('') }
  }

  const doReject = async () => {
    if (!rejectReason.trim()) { setActionError('A rejection reason is required.'); return }
    setBusy('reject'); setActionError('')
    try {
      await payrollPushService.reject(selected.id, rejectReason.trim())
      setShowReject(false); setRejectReason('')
      await load()
      setNotice('Request rejected and returned to the sender.')
    } catch (e) {
      setActionError(e?.message || 'Rejection failed')
    } finally { setBusy('') }
  }

  const doSend = async () => {
    setBusy('send'); setActionError(''); setNotice('')
    try {
      const res = await payrollPushService.send(selected.id)
      await load()
      if (res?.ok) setNotice('Payroll queued for BankOne.')
      else setNotice(`BankOne is not configured (${res?.state || 'NOT_CONFIGURED'}). The approved payroll file is ready for manual upload.`)
    } catch (e) {
      setActionError(e?.message || 'Send failed')
    } finally { setBusy('') }
  }

  if (!canPush) {
    return <div className="p-6"><ErrorState title="Not authorized" message="You do not have permission to manage payroll push." /></div>
  }

  const totals = selected || preview

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Wallet className="w-6 h-6 text-[#009944]" />
          <h1 className="text-xl font-semibold text-slate-900">Payroll &amp; BankOne</h1>
        </div>
        <div className="flex items-center gap-2">
          {configState && (
            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium ${STATE_STYLE[configState.state] || STATE_STYLE.NOT_CONFIGURED}`}>
              <ShieldCheck className="w-3.5 h-3.5" />
              BankOne: {configState.state?.replace(/_/g, ' ')}
            </span>
          )}
          <button onClick={load} className={btnGhost} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-6">
        {[{ id: 'master', label: 'Payroll Master' }, { id: 'push', label: 'BankOne Push' }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px ${tab === t.id ? 'border-[#009944] text-[#009944]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4"><ErrorState title="Something went wrong" message={error} /></div>}
      {actionError && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <AlertTriangle className="w-4 h-4 mt-0.5" /> <span>{actionError}</span>
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          <CheckCircle2 className="w-4 h-4 mt-0.5" /> <span>{notice}</span>
        </div>
      )}

      {loading ? <LoadingState /> : tab === 'master' ? (
        <>
          <div className={cardCls}>
            <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
              <div>
                <h3 className="font-semibold text-slate-900">Payroll Master</h3>
                <p className="text-xs text-slate-500 mt-0.5">Active workforce with bank details and salary, ready for BankOne upload.</p>
              </div>
              <div className="flex items-center gap-2">
                <button className={btnGhost} disabled={!master.length} onClick={() => payrollPushService.downloadMasterCsv(master, selectedPeriod)}>
                  <Download className="w-4 h-4" /> CSV
                </button>
                <button className={btnPrimary} disabled={!master.length} onClick={() => payrollPushService.downloadMasterExcel(master, selectedPeriod)}>
                  <FileSpreadsheet className="w-4 h-4" /> Export for BankOne (Excel)
                </button>
              </div>
            </div>
            {master.length === 0 ? <EmptyState title="No active employees" description="Employees with an active status will appear here." /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-200">
                      <th className="py-2 pr-3">Staff ID</th>
                      <th className="py-2 pr-3">Name</th>
                      <th className="py-2 pr-3">Department</th>
                      <th className="py-2 pr-3">Bank</th>
                      <th className="py-2 pr-3">Account</th>
                      <th className="py-2 pr-3 text-right">Basic</th>
                      <th className="py-2 pr-3 text-right">Allowances</th>
                      <th className="py-2 pr-3 text-right">Gross</th>
                      <th className="py-2 pr-3 text-right">Deductions</th>
                      <th className="py-2 pr-3 text-right">Net</th>
                      {canEditCompensation && <th className="py-2 text-right">Compensation</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {master.map((m) => (
                      <tr key={m.employee_id}>
                        <td className="py-2 pr-3 font-mono text-xs">{m.employee_code || '—'}</td>
                        <td className="py-2 pr-3">{m.employee_name}</td>
                        <td className="py-2 pr-3">{m.department || '—'}</td>
                        <td className="py-2 pr-3">{m.bank_name || '—'}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{m.account_number || '—'}</td>
                        <td className="py-2 pr-3 text-right">{m.salary != null ? money(m.salary) : '—'}</td>
                        <td className="py-2 pr-3 text-right">{m.allowances != null ? money(m.allowances) : '—'}</td>
                        <td className="py-2 pr-3 text-right">{m.gross != null ? money(m.gross) : '—'}</td>
                        <td className="py-2 pr-3 text-right">{m.deductions_total != null ? money(m.deductions_total) : '—'}</td>
                        <td className="py-2 pr-3 text-right font-semibold text-slate-800">{m.net != null ? money(m.net) : '—'}</td>
                        {canEditCompensation && (
                          <td className="py-2 text-right">
                            <button
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50"
                              onClick={() => setEditEmployeeId(m.employee_id)}
                              title={m.has_compensation ? 'Edit compensation' : 'Set compensation (basic + allowances + deductions)'}
                            >
                              <PenLine className="w-3.5 h-3.5" /> {m.has_compensation ? 'Edit' : 'Set'}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className={cardCls}>
            <h3 className="font-semibold text-slate-900 mb-2">1. Prepare payroll</h3>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px]">
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Payroll period</label>
                <select className={inputCls} value={selectedPeriod} onChange={(e) => { setSelectedPeriod(e.target.value); setPreview(null) }}>
                  <option value="">Select period…</option>
                  {periods.map((p) => <option key={p.id} value={p.period_label}>{p.period_label} · {p.status}</option>)}
                </select>
              </div>
              <button className={btnGhost} onClick={runPreview} disabled={!selectedPeriod || busy === 'preview'}>
                {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Preview calculation
              </button>
              <button className={btnPrimary} onClick={createRequest} disabled={!selectedPeriod || busy === 'create'}>
                {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />} Create request
              </button>
            </div>
            {totals && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                {[
                  ['Employees', totals.employee_count],
                  ['Net total', money(totals.total_payroll ?? totals.net_total, totals.currency)],
                  ['Mid-month', money(totals.mid_month_total, totals.currency)],
                  ['Month-end', money(totals.month_end_total, totals.currency)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-slate-50 p-3">
                    <div className="text-xs text-slate-400">{label}</div>
                    <div className="text-sm font-semibold mt-0.5">{value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className={`${cardCls} lg:col-span-1 mb-0`}>
              <h3 className="font-semibold text-slate-900 mb-3">Requests</h3>
              {requests.length === 0 ? <EmptyState title="No requests yet" description="Create a payroll request to start the approval chain." /> : (
                <ul className="divide-y divide-slate-100">
                  {requests.map((r) => (
                    <li key={r.id}>
                      <button onClick={() => setSelectedId(r.id)}
                        className={`w-full text-left py-3 px-2 rounded-lg ${r.id === selectedId ? 'bg-[#009944]/5' : 'hover:bg-slate-50'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-800">{r.period_label}</span>
                          <StatusPill value={r.status} />
                        </div>
                        <div className="text-xs text-slate-400 mt-1">
                          {r.employee_count} staff · {money(r.total_payroll, r.currency)} · {date(r.created_at)}
                        </div>
                        <div className="text-xs text-slate-400 truncate">By {r.sender_name || '—'}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={`${cardCls} lg:col-span-2 mb-0`}>
              {!selected ? <EmptyState title="No request selected" description="Select a request to view its approval chain." /> : (
                <>
                  <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
                    <div>
                      <h3 className="font-semibold text-slate-900">{selected.period_label}</h3>
                      <div className="text-xs text-slate-400 mt-0.5">Request {selected.id.slice(0, 8)} · environment: {selected.bankone_environment?.replace(/_/g, ' ')}</div>
                    </div>
                    <StatusPill value={selected.status} />
                  </div>

                  {selected.rejection_reason && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 mb-4">
                      <span className="font-medium">Returned:</span> {selected.rejection_reason}
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                    <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Net</div><div className="text-sm font-semibold">{money(selected.total_payroll, selected.currency)}</div></div>
                    <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Mid-month</div><div className="text-sm font-semibold">{money(selected.mid_month_total, selected.currency)}</div></div>
                    <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Month-end</div><div className="text-sm font-semibold">{money(selected.month_end_total, selected.currency)}</div></div>
                  </div>

                  <div className="flex flex-wrap gap-2 mb-4">
                    {['draft', 'calculated'].includes(selected.status) && canPush && (
                      <button className={btnPrimary} onClick={() => { setSignAction('submit'); setSignature(null); setActionError('') }}>
                        <PenLine className="w-4 h-4" /> Sign &amp; submit
                      </button>
                    )}
                    {selected.status === 'pending_hr_approval' && canApprove && selected.sender_id !== user?.id && (
                      <>
                        <button className={btnPrimary} onClick={() => { setSignAction('approve'); setSignature(null); setActionError('') }}>
                          <CheckCircle2 className="w-4 h-4" /> Approve
                        </button>
                        <button className={btnGhost} onClick={() => { setShowReject(true); setRejectReason(''); setActionError('') }}>
                          <XCircle className="w-4 h-4" /> Reject
                        </button>
                      </>
                    )}
                    {selected.status === 'pending_hr_approval' && selected.sender_id === user?.id && (
                      <span className="text-xs text-amber-600 inline-flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Awaiting a different HR approver (you submitted this request).</span>
                    )}
                    {selected.status === 'approved' && canApprove && (
                      <button className={btnPrimary} onClick={doSend} disabled={busy === 'send'}>
                        {busy === 'send' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send to BankOne
                      </button>
                    )}
                    {['rejected', 'correction_required'].includes(selected.status) && canPush && (
                      <button className={btnPrimary} onClick={() => { setSignAction('resubmit'); setSignature(null); setActionError('') }}>
                        <RefreshCw className="w-4 h-4" /> Correct &amp; resubmit
                      </button>
                    )}
                    <button className={btnGhost} onClick={() => payrollPushService.downloadPushCsv(selected)}>
                      <Download className="w-4 h-4" /> CSV
                    </button>
                    <button className={btnGhost} onClick={() => payrollPushService.downloadPushExcel(selected)}>
                      <FileSpreadsheet className="w-4 h-4" /> Excel
                    </button>
                  </div>

                  {signAction && (
                    <div className="rounded-lg border border-slate-200 p-4 mb-4">
                      <div className="flex items-center gap-2 mb-2 text-sm font-medium text-slate-700">
                        <PenLine className="w-4 h-4" /> Sign to {signAction}
                      </div>
                      <SignaturePad onChange={setSignature} height={140} />
                      <div className="flex gap-2 mt-3">
                        <button className={btnPrimary} onClick={doSigned} disabled={!signature || !!busy}>
                          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Confirm
                        </button>
                        <button className={btnGhost} onClick={() => { setSignAction(''); setSignature(null) }}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {showReject && (
                    <div className="rounded-lg border border-rose-200 p-4 mb-4">
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Reason for rejection</label>
                      <textarea className="w-full rounded-lg border border-slate-300 p-2 text-sm" rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                      <div className="flex gap-2 mt-3">
                        <button className={btnPrimary} onClick={doReject} disabled={busy === 'reject'}>
                          {busy === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Confirm rejection
                        </button>
                        <button className={btnGhost} onClick={() => setShowReject(false)}>Cancel</button>
                      </div>
                    </div>
                  )}

                  {selected.api_status !== 'not_sent' && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 mb-4">
                      BankOne API: <span className="font-medium">{selected.api_status?.replace(/_/g, ' ')}</span>
                      {selected.bankone_reference ? ` · ref ${selected.bankone_reference}` : ''}
                      {selected.api_response?.message ? ` · ${selected.api_response.message}` : ''}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <h4 className="text-sm font-medium text-slate-700 mb-2">Approval trail</h4>
                      {approvals.length === 0 ? <p className="text-xs text-slate-400">No signatures recorded yet.</p> : (
                        <ul className="space-y-2">
                          {approvals.map((a) => (
                            <li key={a.id} className="text-xs text-slate-600 flex items-start gap-2">
                              <Clock className="w-3.5 h-3.5 mt-0.5 text-slate-400" />
                              <span><span className="font-medium capitalize">{a.action}</span> by {a.actor_name || a.actor_email || '—'} ({a.actor_role}) · {date(a.created_at)}{a.reason ? ` · ${a.reason}` : ''}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-slate-700 mb-2">Events</h4>
                      {events.length === 0 ? <p className="text-xs text-slate-400">No events yet.</p> : (
                        <ul className="space-y-2">
                          {events.map((ev) => (
                            <li key={ev.id} className="text-xs text-slate-600 flex items-start gap-2">
                              <Clock className="w-3.5 h-3.5 mt-0.5 text-slate-400" />
                              <span><span className="font-medium">{ev.event_type}</span> · {date(ev.created_at)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {editEmployeeId && (
        <CompensationEditorModal
          employeeId={editEmployeeId}
          onClose={() => setEditEmployeeId('')}
          onSaved={() => { setNotice('Compensation updated.'); load() }}
        />
      )}
    </div>
  )
}
