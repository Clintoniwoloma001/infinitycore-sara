import React, { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Download, FileText, Loader2, Plus, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react'
import medicalScreeningService from '../../services/medicalScreeningService'
import { medicalStatusBadge, medicalOutcomeBadge, screeningTypeLabel, formatMedDate, isReferralExpired } from './medicalUi'

const REVIEW_OUTCOMES = [
  { value: 'cleared', label: 'Cleared — Fit for Work' },
  { value: 'cleared_with_restrictions', label: 'Cleared with Restrictions' },
  { value: 'further_review', label: 'Further Medical Review' },
  { value: 'not_cleared', label: 'Not Cleared' },
]

const AMENDABLE_STATUSES = ['submitted', 'under_review', 'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared']
const EXTENDABLE_STATUSES = ['draft', 'issued', 'qr_opened', 'screening_started']

function humanize(key) {
  return String(key || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Shows every medical screening referral for a candidate or employee with an
// audited drill-down: submitted result (all versions), amendments, supporting
// documents and HR actions (review / amend / revoke / extend expiry).
export default function MedicalScreeningHistory({ subjectType = 'candidate', subjectId, photoUrl = null }) {
  const [referrals, setReferrals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null) // expanded referral
  const [detail, setDetail] = useState(null) // { referral, screenings, documents, amendments, events }
  const [screening, setScreening] = useState(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [action, setAction] = useState(null) // { type, referral }
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionForm, setActionForm] = useState({})

  const load = useCallback(async () => {
    if (!subjectId) return
    setLoading(true)
    setError('')
    try {
      const all = await medicalScreeningService.listReferrals()
      const mine = (all || []).filter((r) =>
        subjectType === 'candidate' ? r.candidate_id === subjectId : r.employee_id === subjectId
      )
      setReferrals(mine)
    } catch (e) {
      setError(e?.message || 'Failed to load medical screening history')
    } finally {
      setLoading(false)
    }
  }, [subjectId, subjectType])

  useEffect(() => {
    load()
  }, [load])

  const open = async (referral, toggle = true) => {
    if (toggle && selected?.id === referral.id) { setSelected(null); setDetail(null); setScreening(null); return }
    setSelected(referral)
    setDetail(null)
    setScreening(null)
    setDetailBusy(true)
    try {
      const d = await medicalScreeningService.getResult(referral.id)
      const versions = [...(d?.screenings || [])].sort((a, b) => (a.version || 0) - (b.version || 0))
      setDetail({ ...d, versions })
      setScreening(versions[versions.length - 1] || null)
    } catch (e) {
      setError(e?.message || 'Failed to load referral details')
    } finally {
      setDetailBusy(false)
    }
  }

  const downloadDoc = async (doc) => {
    if (!doc.file_path) return
    try {
      const url = await medicalScreeningService.getSignedUrl(doc.file_path)
      if (url) window.open(url, '_blank')
    } catch {
      /* ignore */
    }
  }

  const openAction = (type) => {
    if (!selected) return
    setAction({ type, referral: selected })
    setActionError('')
    setActionForm({})
  }

  const runAction = async () => {
    if (!action) return
    setBusy(true)
    setActionError('')
    try {
      const r = action.referral
      if (action.type === 'review') {
        if (!actionForm.outcome) { setActionError('Select a review outcome.'); setBusy(false); return }
        await medicalScreeningService.setStatus(r.id, actionForm.outcome, actionForm.note)
      } else if (action.type === 'amend') {
        if (!screening) { setActionError('No screening selected.'); setBusy(false); return }
        if (!actionForm.outcome) { setActionError('Select the corrected outcome.'); setBusy(false); return }
        if (!actionForm.reason?.trim()) { setActionError('An amendment reason is required.'); setBusy(false); return }
        let results
        if (actionForm.results?.trim()) {
          try { results = JSON.parse(actionForm.results) } catch { setActionError('Corrected results must be valid JSON.'); setBusy(false); return }
        }
        const created = await medicalScreeningService.requestAmendment(screening.id, actionForm.reason)
        await medicalScreeningService.approveAmendment(created.amendment_id, {
          outcome: actionForm.outcome,
          outcome_notes: actionForm.outcome_notes || '',
          results,
          decision_notes: actionForm.decision_notes || '',
        })
      } else if (action.type === 'revoke') {
        await medicalScreeningService.revoke(r.id, actionForm.reason)
      } else if (action.type === 'extend') {
        if (!actionForm.expiry_date) { setActionError('Choose a new expiry date.'); setBusy(false); return }
        await medicalScreeningService.extendExpiry(r.id, actionForm.expiry_date)
      }
      setAction(null)
      await load()
      if (selected) await open(selected, false)
    } catch (e) {
      setActionError(e?.message || 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const sectionBlock = (rows) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <p className="text-[10px] text-slate-400 uppercase tracking-wide">{humanize(label)}</p>
          {value !== undefined && value !== null && value !== '' ? (
            <p className="text-xs text-slate-700 mt-0.5 whitespace-pre-wrap break-words">{String(value)}</p>
          ) : (
            <p className="text-xs text-slate-300 mt-0.5">—</p>
          )}
        </div>
      ))}
    </div>
  )

  const resultsBlock = (results) => {
    const sections = Object.entries(results || {})
    if (!sections.length) return null
    return (
      <div className="space-y-4">
        {sections.map(([key, value]) => (
          <div key={key}>
            <p className="text-xs font-semibold text-slate-800 mb-2">{humanize(key)}</p>
            {value && typeof value === 'object' && !Array.isArray(value)
              ? sectionBlock(Object.entries(value))
              : <p className="text-xs text-slate-600 whitespace-pre-wrap">{String(value)}</p>}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">{error}</div>}

      {/* Referral list */}
      {loading ? (
        <div className="flex items-center justify-center py-10 text-slate-500 text-sm">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading medical screening history…
        </div>
      ) : referrals.length === 0 ? (
        <div className="text-center py-10">
          <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
            <FileText className="w-7 h-7 text-slate-400" />
          </div>
          <h4 className="font-medium text-slate-700">No medical screenings yet</h4>
          <p className="text-sm text-slate-400 mt-1">Generate a referral card to start a hospital screening.</p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
          {referrals.map((r) => (
            <div key={r.id} className={`px-4 py-3 ${selected?.id === r.id ? 'bg-emerald-50/40' : 'hover:bg-slate-50'}`}>
              <button onClick={() => (selected?.id === r.id ? setSelected(null) : open(r))} className="w-full flex items-center gap-3 text-left">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-semibold text-slate-900">{r.reference}</span>
                    {medicalStatusBadge(isReferralExpired(r) ? 'revoked' : r.status)}
                    {isReferralExpired(r) && <span className="text-[10px] font-medium text-rose-600">Expired</span>}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {screeningTypeLabel(r.screening_type, r.other_screening_type)} · Issued {formatMedDate(r.issued_at)}
                    {r.expires_at ? ` · Expires ${formatMedDate(r.expires_at)}` : ''}
                  </p>
                </div>
                <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${selected?.id === r.id ? 'rotate-90' : ''}`} />
              </button>

              {selected?.id === r.id && (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  {detailBusy ? (
                    <div className="flex items-center justify-center py-8 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</div>
                  ) : (
                    <div className="space-y-4">
                      {/* Actions */}
                      {['submitted', 'under_review'].includes(r.status) && (
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => openAction('review')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36]">
                            <ShieldCheck className="w-3.5 h-3.5" /> Review Result
                          </button>
                        </div>
                      )}
                      {AMENDABLE_STATUSES.includes(r.status) && screening && (
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => openAction('amend')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-amber-300 text-amber-700 text-xs font-medium hover:bg-amber-50">
                            <RefreshCw className="w-3.5 h-3.5" /> Amend Result
                          </button>
                        </div>
                      )}
                      {EXTENDABLE_STATUSES.includes(r.status) && (
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => openAction('extend')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-300 text-blue-700 text-xs font-medium hover:bg-blue-50">
                            <ShieldX className="w-3.5 h-3.5" /> Extend Expiry
                          </button>
                          <button onClick={() => openAction('revoke')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-300 text-rose-700 text-xs font-medium hover:bg-rose-50">
                            <ShieldX className="w-3.5 h-3.5" /> Revoke
                          </button>
                        </div>
                      )}

                      {screening ? (
                        <>
                          {/* Version selector */}
                          {detail?.versions?.length > 1 && (
                            <div>
                              <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Version</p>
                              <div className="flex flex-wrap gap-2">
                                {detail.versions.map((v) => (
                                  <button key={v.id} onClick={() => setScreening(v)} className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${screening.id === v.id ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                                    v{v.version}{v.version === detail.versions[detail.versions.length - 1].version ? ' (current)' : ''}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="rounded-xl border border-slate-200 overflow-hidden">
                            <div className="bg-slate-50 px-4 py-2 flex items-center justify-between">
                              <p className="text-xs font-semibold text-slate-800">Medical Screening Result{screening.version > 1 ? ` — v${screening.version}` : ''}</p>
                              {medicalOutcomeBadge(screening.outcome)}
                            </div>
                            <div className="p-4 space-y-5">
                              {sectionBlock([
                                ['Medical Officer', screening.medical_officer],
                                ['Screening Date', formatMedDate(screening.screening_date)],
                                ['Hospital', screening.hospital_name],
                              ])}

                              {resultsBlock(screening.results)}

                              {screening.outcome_notes && (
                                <div>
                                  <p className="text-xs font-semibold text-slate-800 mb-1">Outcome Notes</p>
                                  <p className="text-xs text-slate-600 whitespace-pre-wrap">{screening.outcome_notes}</p>
                                </div>
                              )}
                              {screening.amendment_reason && (
                                <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
                                  <p className="text-[10px] text-violet-700 uppercase tracking-wide font-semibold">Amendment Reason</p>
                                  <p className="text-xs text-violet-800 mt-0.5 whitespace-pre-wrap">{screening.amendment_reason}</p>
                                </div>
                              )}

                              {screening.signature_data && (
                                <div>
                                  <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Electronic Signature</p>
                                  <img src={screening.signature_data} alt="Signature" className="h-16 border border-slate-200 rounded-lg bg-white" />
                                </div>
                              )}
                            </div>
                          </div>

                          {detail?.documents?.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-slate-800 mb-2">Supporting Documents</p>
                              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 overflow-hidden">
                                {detail.documents.map((d) => (
                                  <div key={d.id} className="flex items-center justify-between px-3 py-2.5">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                                      <div className="min-w-0">
                                        <p className="text-sm text-slate-800 truncate">{d.file_name}</p>
                                        {d.file_size > 0 && <p className="text-[10px] text-slate-400">{(d.file_size / 1024).toFixed(0)} KB</p>}
                                      </div>
                                    </div>
                                    <button onClick={() => downloadDoc(d)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 text-xs text-slate-600 hover:bg-slate-50">
                                      <Download className="w-3.5 h-3.5" /> Download
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {detail?.amendments?.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-slate-800 mb-2">Amendment History</p>
                              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 overflow-hidden">
                                {detail.amendments.map((a) => (
                                  <div key={a.id} className="px-3 py-2.5">
                                    <div className="flex items-center justify-between">
                                      <p className="text-xs font-semibold text-slate-700 capitalize">{a.status}</p>
                                      <p className="text-[10px] text-slate-400">{formatMedDate(a.requested_at)} · {a.requested_by_name || 'HR'}</p>
                                    </div>
                                    <p className="text-xs text-slate-500 mt-0.5">{a.reason}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-slate-400 py-4 text-center">
                          {r.status === 'revoked' ? 'This referral was revoked — no screening result exists.' : isReferralExpired(r) ? 'This referral expired before a screening was submitted.' : 'No screening result submitted yet.'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Action modal */}
      {action && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-1 capitalize">
              {action.type === 'review' ? 'Review Medical Result' : action.type === 'amend' ? 'Amend Medical Result' : action.type === 'revoke' ? 'Revoke Referral' : 'Extend Expiry'}
            </h3>
            <p className="text-sm text-slate-500 mb-4">{action.referral.subject_name} — <span className="font-mono">{action.referral.reference}</span></p>

            {action.type === 'review' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Decision *</label>
                  <select className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" value={actionForm.outcome || ''} onChange={(e) => setActionForm((f) => ({ ...f, outcome: e.target.value }))}>
                    <option value="">Select decision…</option>
                    {REVIEW_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Review Note</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={actionForm.note || ''} onChange={(e) => setActionForm((f) => ({ ...f, note: e.target.value }))} placeholder="Optional note attached to the decision…" />
                </div>
              </div>
            )}

            {action.type === 'amend' && (
              <div className="space-y-4">
                <p className="text-sm text-slate-600">The original record is preserved; approving creates a new immutable version.</p>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Corrected Outcome *</label>
                  <select className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" value={actionForm.outcome || ''} onChange={(e) => setActionForm((f) => ({ ...f, outcome: e.target.value }))}>
                    <option value="">Select outcome…</option>
                    <option value="fit_for_work">Fit for Work</option>
                    <option value="fit_with_restrictions">Fit with Restrictions</option>
                    <option value="further_review">Further Medical Review Required</option>
                    <option value="not_cleared">Not Cleared</option>
                    <option value="pending">Pending</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Outcome Notes</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={actionForm.outcome_notes || ''} onChange={(e) => setActionForm((f) => ({ ...f, outcome_notes: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Corrected Results (JSON, optional)</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={4} value={actionForm.results ?? JSON.stringify(screening?.results || {}, null, 2)} onChange={(e) => setActionForm((f) => ({ ...f, results: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Reason *</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={actionForm.reason || ''} onChange={(e) => setActionForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Why is this record being amended?" />
                </div>
              </div>
            )}

            {action.type === 'revoke' && (
              <div>
                <p className="text-sm text-slate-600 mb-3">Revoking disables the QR immediately. Already-submitted results are not affected.</p>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Reason</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={actionForm.reason || ''} onChange={(e) => setActionForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Why is this referral being revoked?" />
              </div>
            )}

            {action.type === 'extend' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">New Expiry Date *</label>
                <input type="date" className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" value={actionForm.expiry_date || ''} onChange={(e) => setActionForm((f) => ({ ...f, expiry_date: e.target.value }))} />
                <p className="text-xs text-slate-400 mt-2">The referral remains valid until this new date.</p>
              </div>
            )}

            {actionError && <p className="text-sm text-rose-600 mt-3">{actionError}</p>}

            <div className="flex justify-end gap-2 pt-5">
              <button onClick={() => setAction(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={runAction} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
