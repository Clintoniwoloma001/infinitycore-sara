import React, { useEffect, useState } from 'react'
import { AlertCircle, Filter, Loader2, MessageSquare, RefreshCw, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { date, money, status } from './hrShared'
import { reconciliationService, RECON_STATUS_LABELS, EXCEPTION_TYPES } from '../services/reconciliationService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function Reconciliation() {
  const { user, profile, hasPermission } = useAuth()
  const canManage = hasPermission('reconciliation.manage')

  const [cases, setCases] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterException, setFilterException] = useState('')
  const [selectedCase, setSelectedCase] = useState(null)
  const [caseEvents, setCaseEvents] = useState([])
  const [eventsLoading, setEventsLoading] = useState(false)
  const [actionMode, setActionMode] = useState(null) // assign | comment | resolve | close | reopen
  const [actionText, setActionText] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [metrics, setMetrics] = useState(null)

  const loadCases = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await reconciliationService.listCases({
        status: filterStatus || undefined,
        exceptionType: filterException || undefined,
      })
      setCases(data)
      const m = await reconciliationService.getDashboardMetrics()
      setMetrics(m)
    } catch (e) {
      setError(e?.message || 'Failed to load reconciliation cases')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadCases() }, [filterStatus, filterException])

  const openCase = async (c) => {
    setSelectedCase(c)
    setEventsLoading(true)
    try {
      setCaseEvents(await reconciliationService.getCaseEvents(c.id))
    } catch (e) {
      setError(e?.message)
    } finally {
      setEventsLoading(false)
    }
  }

  const doAction = async () => {
    if (!selectedCase || !actionMode) return
    setActionBusy(true)
    setError('')
    try {
      const uid = user?.id
      const uname = profile?.full_name || user?.email

      if (actionMode === 'comment') {
        await reconciliationService.addComment(selectedCase.id, actionText, uid, uname)
      } else if (actionMode === 'resolve') {
        await reconciliationService.submitResolution(selectedCase.id, actionText, uid, uname)
      } else if (actionMode === 'close') {
        await reconciliationService.closeCase(selectedCase.id, uid, uname)
      } else if (actionMode === 'reopen') {
        await reconciliationService.reopenCase(selectedCase.id, actionText, uid, uname)
      }

      setActionMode(null)
      setActionText('')
      await loadCases()
      const updated = cases.find((c) => c.id === selectedCase.id)
      if (updated) openCase({ ...selectedCase, ...updated })
      else openCase(selectedCase)
    } catch (e) {
      setError(e?.message || 'Action failed')
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">🧑‍💼 Reconciliation</h2>
          <p className="text-sm text-slate-500 mt-1">Exception detection, reversal protection, and case management for BankOne transactions.</p>
        </div>
        <button onClick={loadCases} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {error && <div className="mb-5"><ErrorState message={error} /></div>}

      {/* Dashboard Metrics */}
      {metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
          {[
            { label: 'Total Cases', value: metrics.total, cls: 'text-slate-900' },
            { label: 'Resolved', value: metrics.resolvedCount, cls: 'text-[#009944]' },
            { label: 'Resolution Rate', value: `${metrics.resolutionRate}%`, cls: 'text-blue-600' },
            { label: 'Unresolved Value', value: money(metrics.unresolvedValue), cls: 'text-rose-600' },
            { label: 'Resolved Value', value: money(metrics.resolvedValue), cls: 'text-emerald-600' },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-lg border border-slate-200 p-3">
              <div className={`text-lg font-bold ${s.cls}`}>{s.value}</div>
              <div className="text-xs text-slate-400">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-6">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex items-center gap-1.5 text-sm text-slate-500"><Filter className="w-4 h-4" /> Filters:</div>
          <div>
            <select className={inputCls} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">All Statuses</option>
              {Object.entries(RECON_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <select className={inputCls} value={filterException} onChange={(e) => setFilterException(e.target.value)}>
              <option value="">All Exception Types</option>
              {Object.entries(EXCEPTION_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Cases Table */}
      {loading && <div className="text-sm text-slate-500">Loading cases…</div>}
      {!loading && cases.length === 0 && <EmptyState title="No reconciliation cases" description="Cases are auto-created when failed, pending, or reversed transactions are imported." />}
      {!loading && cases.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Case Ref</th>
                <th className="px-4 py-3 font-medium">Txn Ref</th>
                <th className="px-4 py-3 font-medium">Officer</th>
                <th className="px-4 py-3 font-medium">Branch</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Exception</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Detected</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cases.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{c.case_reference || c.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">{c.transaction_reference || '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{c.employee_name || '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{c.branch || '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{money(c.amount)}</td>
                  <td className="px-4 py-3 text-xs">{EXCEPTION_TYPES[c.exception_type] || c.exception_type}</td>
                  <td className="px-4 py-3">{status(c.status)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{date(c.detected_date)}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openCase(c)} className="text-xs text-[#009944] hover:underline">Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Case Detail Modal */}
      {selectedCase && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Case {selectedCase.case_reference || selectedCase.id.slice(0, 8)}</h3>
                <p className="text-sm text-slate-500">{EXCEPTION_TYPES[selectedCase.exception_type] || selectedCase.exception_type} · {RECON_STATUS_LABELS[selectedCase.status] || selectedCase.status}</p>
              </div>
              <button onClick={() => { setSelectedCase(null); setActionMode(null) }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
              <div><span className="text-xs text-slate-400">Transaction Ref: </span><span className="text-sm text-slate-700">{selectedCase.transaction_reference || '—'}</span></div>
              <div><span className="text-xs text-slate-400">Officer: </span><span className="text-sm text-slate-700">{selectedCase.employee_name || '—'}</span></div>
              <div><span className="text-xs text-slate-400">Branch: </span><span className="text-sm text-slate-700">{selectedCase.branch || '—'}</span></div>
              <div><span className="text-xs text-slate-400">Amount: </span><span className="text-sm text-slate-700">{money(selectedCase.amount)}</span></div>
              <div><span className="text-xs text-slate-400">Date: </span><span className="text-sm text-slate-700">{date(selectedCase.transaction_date)}</span></div>
              <div><span className="text-xs text-slate-400">Priority: </span><span className="text-sm text-slate-700">{selectedCase.priority}</span></div>
              <div><span className="text-xs text-slate-400">Assigned: </span><span className="text-sm text-slate-700">{selectedCase.assigned_to_name || 'Unassigned'}</span></div>
              <div><span className="text-xs text-slate-400">Resolved by: </span><span className="text-sm text-slate-700">{selectedCase.resolved_by_name || '—'}</span></div>
              <div><span className="text-xs text-slate-400">Closed by: </span><span className="text-sm text-slate-700">{selectedCase.closed_by_name || '—'}</span></div>
            </div>

            {selectedCase.resolution_notes && (
              <div className="mb-4 rounded-lg bg-slate-50 border border-slate-200 p-3">
                <p className="text-xs text-slate-400 mb-1">Resolution Notes</p>
                <p className="text-sm text-slate-700">{selectedCase.resolution_notes}</p>
              </div>
            )}

            {selectedCase.related_reversal_ref && (
              <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3">
                <p className="text-xs text-amber-600 mb-1">Related Reversal</p>
                <p className="text-sm text-amber-800">{selectedCase.related_reversal_ref}</p>
              </div>
            )}

            {/* Events Timeline */}
            <div className="mb-6">
              <h4 className="font-medium text-slate-900 mb-3">Activity Timeline</h4>
              {eventsLoading && <div className="text-sm text-slate-500">Loading…</div>}
              {!eventsLoading && caseEvents.length === 0 && <p className="text-sm text-slate-400">No events recorded.</p>}
              {!eventsLoading && caseEvents.length > 0 && (
                <div className="space-y-2">
                  {caseEvents.map((e) => (
                    <div key={e.id} className="flex items-start gap-3 py-2 border-b border-slate-100">
                      <div className="w-2 h-2 rounded-full bg-[#009944] mt-1.5 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-slate-700">{e.event_type.replace(/_/g, ' ')}</p>
                        {e.comment && <p className="text-xs text-slate-500 mt-0.5">{e.comment}</p>}
                        <p className="text-xs text-slate-400 mt-0.5">{date(e.created_at)} {e.created_by_name ? `· ${e.created_by_name}` : ''}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Actions */}
            {canManage && (
              <div className="border-t border-slate-200 pt-4">
                {!actionMode ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedCase.status !== 'closed' && (
                      <>
                        <button onClick={() => { setActionMode('comment'); setActionText('') }} className="px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
                          <MessageSquare className="w-4 h-4 inline mr-1" /> Comment
                        </button>
                        {!selectedCase.resolution_notes && (
                          <button onClick={() => { setActionMode('resolve'); setActionText('') }} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700">
                            Submit Resolution
                          </button>
                        )}
                        {selectedCase.resolution_notes && selectedCase.status !== 'closed' && (
                          <button onClick={() => { setActionMode('close'); setActionText('') }} className="px-3 py-2 rounded-lg bg-[#009944] text-white text-sm hover:bg-[#007a36]">
                            Close Case
                          </button>
                        )}
                      </>
                    )}
                    {selectedCase.status === 'closed' && (
                      <button onClick={() => { setActionMode('reopen'); setActionText('') }} className="px-3 py-2 rounded-lg border border-amber-300 text-amber-600 text-sm hover:bg-amber-50">
                        Reopen Case
                      </button>
                    )}
                  </div>
                ) : (
                  <div>
                    <textarea
                      className="w-full h-24 rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
                      placeholder={actionMode === 'resolve' ? 'Describe the resolution…' : actionMode === 'reopen' ? 'Reason for reopening…' : 'Add a comment…'}
                      value={actionText}
                      onChange={(e) => setActionText(e.target.value)}
                    />
                    <div className="flex gap-2 mt-3">
                      <button onClick={doAction} disabled={actionBusy || (actionMode === 'resolve' && !actionText.trim())} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                        {actionBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                        {actionMode === 'close' ? 'Close Case' : actionMode === 'reopen' ? 'Reopen' : 'Submit'}
                      </button>
                      <button onClick={() => { setActionMode(null); setActionText('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
