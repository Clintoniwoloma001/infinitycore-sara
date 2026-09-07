import React, { useEffect, useState } from 'react'
import {
  AlertTriangle, Check, CheckCircle2, Copy, FileText, Loader2, Send, X,
  PenTool, Camera, IdCard, Home, User, Briefcase, Clock, History,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { guarantorVerificationService } from '../services/guarantorVerificationService'
import { payrollService } from '../services/payrollService'
import { date, status } from '../pages/hrShared'
import { LoadingState, ErrorState } from '../components/PageStates'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const FIELD_LABELS = {
  phone: 'Phone Number',
  residential_address: 'Residential Address',
  occupation: 'Occupation',
  employer: 'Employer / Business',
  bvn: 'BVN',
  nin: 'NIN',
  selfie_data: 'Selfie',
  signature_data: 'Signature',
}

const CORRECTABLE_FIELDS = [
  { key: 'phone', label: 'Phone Number' },
  { key: 'residential_address', label: 'Residential Address' },
  { key: 'occupation', label: 'Occupation' },
  { key: 'employer', label: 'Employer / Business' },
  { key: 'bvn', label: 'BVN' },
  { key: 'nin', label: 'NIN' },
]

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  }
}

function Section({ title, icon: Icon, children }) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-3">
        {Icon && <Icon className="w-4 h-4 text-slate-400" />}
        <h4 className="text-sm font-semibold text-slate-700">{title}</h4>
      </div>
      {children}
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 py-1.5">
      <span className="text-xs text-slate-400 sm:w-40 flex-shrink-0">{label}</span>
      <span className="text-sm text-slate-800">{value || '—'}</span>
    </div>
  )
}

const STATUS_BADGE_CLASSES = {
  submitted: 'bg-amber-50 text-amber-700 border-amber-200',
  under_review: 'bg-blue-50 text-blue-700 border-blue-200',
  pending_guarantor: 'bg-amber-50 text-amber-700 border-amber-200',
  guarantor_submitted: 'bg-blue-50 text-blue-700 border-blue-200',
  correction_requested: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending_link: 'bg-slate-100 text-slate-600 border-slate-200',
  link_sent: 'bg-amber-50 text-amber-700 border-amber-200',
  started: 'bg-blue-50 text-blue-700 border-blue-200',
}

export default function OnboardingReviewModal({ submission, onClose, onRefresh }) {
  const { hasPermission, user } = useAuth()
  const canManage = hasPermission('hr.onboarding.manage')

  const [verifications, setVerifications] = useState([])
  const [corrections, setCorrections] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('overview')
  const [action, setAction] = useState(null) // null | 'send-link' | 'request-correction' | 'approve' | 'reject' | 'payroll'
  const [busy, setBusy] = useState(false)
  const [generatedLink, setGeneratedLink] = useState(null)
  const [copied, setCopied] = useState(false)
  const [correctionForm, setCorrectionForm] = useState({})
  const [correctionComment, setCorrectionComment] = useState('')
  const [payrollPeriods, setPayrollPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  const payload = submission?.payload || {}
  const guarantorName = payload.guarantor_full_name || ''
  const guarantorEmail = payload.guarantor_email || ''
  const guarantorRelationship = payload.guarantor_relationship || ''

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [verifs, corrs, evts] = await Promise.all([
        guarantorVerificationService.listVerifications().catch(() => []),
        Promise.resolve([]),
        Promise.resolve([]),
      ])
      const submissionVerifs = verifs.filter((v) => v.submission_id === submission?.id)
      setVerifications(submissionVerifs)
      if (submissionVerifs.length > 0) {
        const vId = submissionVerifs[0].id
        const [c, e] = await Promise.all([
          guarantorVerificationService.listCorrections(vId).catch(() => []),
          guarantorVerificationService.listEvents(vId).catch(() => []),
        ])
        setCorrections(c)
        setEvents(e)
      }
    } catch (e) {
      setError(e?.message || 'Failed to load review data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [submission?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const verification = verifications[0] || null
  const onboardingStatus = submission?.onboarding_status || 'submitted'

  const sendGuarantorLink = async () => {
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      const result = await guarantorVerificationService.createVerification({
        onboardingLinkId: submission?.link_id,
        employeeId: submission?.employee_id,
        submissionId: submission?.id,
        guarantorName,
        guarantorEmail,
        guarantorRelationship,
      })
      setGeneratedLink(result)
      setSuccessMsg('Guarantor verification link generated.')
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to create verification link')
    } finally {
      setBusy(false)
    }
  }

  const requestCorrections = async () => {
    if (!verification) return
    const selected = Object.entries(correctionForm).filter(([_, v]) => v === true)
    if (selected.length === 0) { setError('Select at least one field to correct.'); return }
    const correctionsArr = selected.map(([field]) => ({
      field_name: field,
      field_label: FIELD_LABELS[field] || field,
      hr_comment: correctionComment,
    }))
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      await guarantorVerificationService.requestCorrection(verification.id, correctionsArr)
      setSuccessMsg(`${selected.length} correction(s) requested.`)
      setAction(null); setCorrectionForm({}); setCorrectionComment('')
      await load()
      onRefresh?.()
    } catch (e) {
      setError(e?.message || 'Failed to request corrections')
    } finally {
      setBusy(false)
    }
  }

  const approveVerification = async () => {
    if (!verification) return
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      await guarantorVerificationService.approveVerification(verification.id)
      setSuccessMsg('Guarantor verification approved.')
      setAction(null)
      await load()
      onRefresh?.()
    } catch (e) {
      setError(e?.message || 'Failed to approve verification')
    } finally {
      setBusy(false)
    }
  }

  const approveOnboarding = async () => {
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      await guarantorVerificationService.approveOnboarding(submission.id)
      setSuccessMsg('Onboarding approved! Employee is now active.')
      setAction(null)
      await load()
      onRefresh?.()
    } catch (e) {
      setError(e?.message || 'Failed to approve onboarding')
    } finally {
      setBusy(false)
    }
  }

  const rejectOnboarding = async () => {
    if (!rejectReason.trim()) { setError('Please provide a reason for rejection.'); return }
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      await guarantorVerificationService.rejectOnboarding(submission.id, rejectReason)
      setSuccessMsg('Onboarding rejected.')
      setAction(null); setRejectReason('')
      await load()
      onRefresh?.()
    } catch (e) {
      setError(e?.message || 'Failed to reject onboarding')
    } finally {
      setBusy(false)
    }
  }

  const addToPayroll = async () => {
    if (!selectedPeriod) { setError('Select a payroll period.'); return }
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      await guarantorVerificationService.addToPayroll(submission.employee_id, selectedPeriod, payload.salary || null)
      setSuccessMsg('Employee added to payroll.')
      setAction(null)
      onRefresh?.()
    } catch (e) {
      setError(e?.message || 'Failed to add to payroll')
    } finally {
      setBusy(false)
    }
  }

  const approveCorrection = async (correctionId) => {
    setBusy(true); setError('')
    try {
      await guarantorVerificationService.approveCorrection(correctionId)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to approve correction')
    } finally {
      setBusy(false)
    }
  }

  const rejectCorrection = async (correctionId) => {
    setBusy(true); setError('')
    try {
      await guarantorVerificationService.rejectCorrection(correctionId)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to reject correction')
    } finally {
      setBusy(false)
    }
  }

  const loadPayrollPeriods = async () => {
    try {
      const periods = await payrollService.listPeriods()
      setPayrollPeriods(periods)
    } catch { setPayrollPeriods([]) }
  }

  useEffect(() => {
    if (action === 'payroll') loadPayrollPeriods()
  }, [action]) // eslint-disable-line react-hooks/exhaustive-deps

  const copyLink = async (url) => {
    await copyText(url); setCopied(true); setTimeout(() => setCopied(false), 1500)
  }

  if (!submission) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Onboarding Review</h3>
            <p className="text-sm text-slate-500">{submission.candidate_name} — {submission.position || 'N/A'}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6">
          {error && <div className="mb-4"><ErrorState message={error} /></div>}
          {successMsg && (
            <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> {successMsg}
            </div>
          )}
          {loading && <LoadingState label="Loading review data…" />}

          {!loading && (
            <>
              {/* Status badge */}
              <div className="flex items-center gap-3 mb-5">
                <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border ${STATUS_BADGE_CLASSES[onboardingStatus] || STATUS_BADGE_CLASSES.submitted}`}>
                  Onboarding: {onboardingStatus.replace(/_/g, ' ')}
                </span>
                {verification && (
                  <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border ${STATUS_BADGE_CLASSES[verification.status] || STATUS_BADGE_CLASSES.pending_link}`}>
                    Guarantor: {verification.status.replace(/_/g, ' ')}
                  </span>
                )}
              </div>

              {/* Tabs */}
              <div className="flex gap-2 overflow-x-auto pb-3 mb-4 border-b border-slate-200">
                {['overview', 'guarantor', 'corrections', 'timeline'].map((t) => (
                  <button key={t} onClick={() => setActiveTab(t)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border capitalize ${activeTab === t ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
                    {t}
                  </button>
                ))}
              </div>

              {/* Overview tab */}
              {activeTab === 'overview' && (
                <div>
                  <Section title="Employee Information" icon={User}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                      <InfoRow label="Name" value={submission.candidate_name} />
                      <InfoRow label="Email" value={submission.email} />
                      <InfoRow label="Phone" value={submission.phone} />
                      <InfoRow label="Position" value={submission.position} />
                      <InfoRow label="Department" value={submission.department} />
                      <InfoRow label="Employment Type" value={submission.employment_type} />
                      <InfoRow label="Submitted" value={date(submission.submitted_at)} />
                      <InfoRow label="Declaration" value={submission.declaration_accepted ? 'Accepted' : 'Not accepted'} />
                    </div>
                  </Section>

                  {/* Action buttons */}
                  {canManage && onboardingStatus !== 'completed' && onboardingStatus !== 'rejected' && (
                    <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-slate-200">
                      {!verification && guarantorName && (
                        <button onClick={() => { setAction('send-link'); sendGuarantorLink() }} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                          <Send className="w-4 h-4" /> Send Guarantor Link
                        </button>
                      )}
                      {verification && verification.status === 'submitted' && (
                        <>
                          <button onClick={() => setAction('request-correction')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-amber-300 text-amber-700 text-sm font-medium hover:bg-amber-50">
                            <AlertTriangle className="w-4 h-4" /> Request Correction
                          </button>
                          <button onClick={approveVerification} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
                            <Check className="w-4 h-4" /> Approve Verification
                          </button>
                        </>
                      )}
                      {verification && verification.status === 'approved' && onboardingStatus !== 'completed' && (
                        <button onClick={() => setAction('approve')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
                          <CheckCircle2 className="w-4 h-4" /> Approve Onboarding
                        </button>
                      )}
                      {onboardingStatus === 'completed' && (
                        <button onClick={() => setAction('payroll')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700">
                          <Briefcase className="w-4 h-4" /> Add to Payroll
                        </button>
                      )}
                      {onboardingStatus !== 'completed' && (
                        <button onClick={() => setAction('reject')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-rose-300 text-rose-600 text-sm font-medium hover:bg-rose-50">
                          <X className="w-4 h-4" /> Reject
                        </button>
                      )}
                    </div>
                  )}

                  {/* Generated link display */}
                  {generatedLink && (
                    <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                      <p className="text-sm font-medium text-emerald-900 mb-2">Guarantor verification link generated:</p>
                      <div className="flex items-center gap-2">
                        <input readOnly value={generatedLink.url} className={inputCls} />
                        <button onClick={() => copyLink(generatedLink.url)} className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] whitespace-nowrap">
                          <Copy className="w-4 h-4" /> {copied ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                      <p className="text-xs text-emerald-700 mt-2">Send this link to the guarantor. They will complete the verification form securely.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Guarantor tab */}
              {activeTab === 'guarantor' && (
                <div>
                  <Section title="Guarantor Information" icon={IdCard}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                      <InfoRow label="Name" value={guarantorName || 'Not provided'} />
                      <InfoRow label="Email" value={guarantorEmail || 'Not provided'} />
                      <InfoRow label="Relationship" value={guarantorRelationship || '—'} />
                    </div>
                  </Section>
                  {verification ? (
                    <>
                      <Section title="Verification Details" icon={CheckCircle2}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                          <InfoRow label="Status" value={verification.status.replace(/_/g, ' ')} />
                          <InfoRow label="Phone" value={verification.phone} />
                          <InfoRow label="Residential Address" value={verification.residential_address} />
                          <InfoRow label="Occupation" value={verification.occupation} />
                          <InfoRow label="Employer" value={verification.employer} />
                          <InfoRow label="BVN" value={verification.bvn} />
                          <InfoRow label="NIN" value={verification.nin} />
                          <InfoRow label="Selfie" value={verification.selfie_data ? 'Captured' : 'Not captured'} />
                          <InfoRow label="Signature" value={verification.signature_data ? 'Captured' : 'Not captured'} />
                          <InfoRow label="Submitted" value={date(verification.submitted_at)} />
                        </div>
                        {verification.selfie_data && (
                          <div className="mt-3">
                            <p className="text-xs text-slate-400 mb-1">Selfie:</p>
                            <img src={verification.selfie_data} alt="Selfie" className="w-32 h-32 rounded-lg border border-slate-300 object-cover" />
                          </div>
                        )}
                        {verification.signature_data && (
                          <div className="mt-3">
                            <p className="text-xs text-slate-400 mb-1">Signature:</p>
                            <img src={verification.signature_data} alt="Signature" className="max-w-xs rounded-lg border border-slate-300" />
                          </div>
                        )}
                      </Section>
                    </>
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-sm text-slate-400">No guarantor verification has been initiated yet.</p>
                      {canManage && guarantorName && (
                        <button onClick={() => { setAction('send-link'); sendGuarantorLink() }} disabled={busy} className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                          <Send className="w-4 h-4" /> Send Guarantor Link
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Corrections tab */}
              {activeTab === 'corrections' && (
                <div>
                  {corrections.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-8">No corrections have been requested.</p>
                  ) : (
                    <div className="space-y-3">
                      {corrections.map((c) => (
                        <div key={c.id} className={`rounded-lg border p-4 ${c.status === 'approved' ? 'border-emerald-200 bg-emerald-50' : c.status === 'rejected' ? 'border-rose-200 bg-rose-50' : c.status === 'submitted' ? 'border-blue-200 bg-blue-50' : 'border-amber-200 bg-amber-50'}`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-slate-800">{c.field_label || FIELD_LABELS[c.field_name] || c.field_name}</span>
                            <span className="text-xs font-medium capitalize text-slate-500">{c.status}</span>
                          </div>
                          <div className="text-sm space-y-1">
                            <p className="text-xs text-slate-400">Previous: <span className="font-mono text-xs text-slate-600">{c.previous_value || '(empty)'}</span></p>
                            <p className="text-xs text-slate-400">HR comment: <span className="text-amber-800">{c.hr_comment || '—'}</span></p>
                            {c.corrected_value && <p className="text-xs text-slate-400">Corrected: <span className="font-mono text-xs text-emerald-700">{c.corrected_value}</span></p>}
                            {c.submitted_at && <p className="text-xs text-slate-400">Submitted: {date(c.submitted_at)}</p>}
                          </div>
                          {c.status === 'submitted' && canManage && (
                            <div className="flex gap-2 mt-3">
                              <button onClick={() => approveCorrection(c.id)} disabled={busy} className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60">Approve</button>
                              <button onClick={() => rejectCorrection(c.id)} disabled={busy} className="text-xs px-3 py-1.5 rounded-md border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-60">Reject</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Timeline tab */}
              {activeTab === 'timeline' && (
                <div>
                  {events.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-8">No events recorded yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {events.map((e) => (
                        <div key={e.id} className="flex items-start gap-3 py-2 border-b border-slate-100">
                          <div className="w-2 h-2 rounded-full bg-[#009944] mt-1.5 flex-shrink-0" />
                          <div>
                            <p className="text-sm font-medium text-slate-700">{e.event_type.replace(/_/g, ' ')}</p>
                            <p className="text-xs text-slate-400">{e.details} — {date(e.created_at)}{e.actor ? ` · ${e.actor}` : ''}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Action panels */}
              {action === 'request-correction' && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <h4 className="text-sm font-semibold text-amber-900 mb-3">Request Corrections</h4>
                  <p className="text-xs text-amber-700 mb-3">Select the fields that need correction. The guarantor will only need to update these fields.</p>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {CORRECTABLE_FIELDS.map((f) => (
                      <label key={f.key} className="flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" checked={!!correctionForm[f.key]} onChange={(e) => setCorrectionForm((prev) => ({ ...prev, [f.key]: e.target.checked }))} className="w-4 h-4 accent-[#009944]" />
                        {f.label}
                      </label>
                    ))}
                  </div>
                  <div className="mb-3">
                    <label className={labelCls}>Comment / Reason</label>
                    <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={correctionComment} onChange={(e) => setCorrectionComment(e.target.value)} placeholder="Explain what needs to be corrected…" />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => { setAction(null); setCorrectionForm({}); setCorrectionComment('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                    <button onClick={requestCorrections} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-60">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Request Corrections
                    </button>
                  </div>
                </div>
              )}

              {action === 'approve' && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                  <h4 className="text-sm font-semibold text-emerald-900 mb-3">Confirm Onboarding Approval</h4>
                  <div className="space-y-1 text-sm text-slate-700 mb-4">
                    <p><span className="text-slate-400">Employee:</span> {submission.candidate_name}</p>
                    <p><span className="text-slate-400">Position:</span> {submission.position || 'N/A'}</p>
                    <p><span className="text-slate-400">Department:</span> {submission.department || 'N/A'}</p>
                    <p><span className="text-slate-400">Guarantor:</span> {guarantorName || 'N/A'}</p>
                    <p><span className="text-slate-400">Verification:</span> {verification?.status === 'approved' ? 'Completed' : 'Pending'}</p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setAction(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                    <button onClick={approveOnboarding} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-60">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve Employee
                    </button>
                  </div>
                </div>
              )}

              {action === 'reject' && (
                <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4">
                  <h4 className="text-sm font-semibold text-rose-900 mb-3">Reject Onboarding</h4>
                  <div className="mb-3">
                    <label className={labelCls}>Reason for rejection</label>
                    <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500" rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Explain why this onboarding is being rejected…" />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => { setAction(null); setRejectReason('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                    <button onClick={rejectOnboarding} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-60">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />} Reject
                    </button>
                  </div>
                </div>
              )}

              {action === 'payroll' && (
                <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-4">
                  <h4 className="text-sm font-semibold text-violet-900 mb-3">Add to Payroll</h4>
                  <div className="mb-3">
                    <label className={labelCls}>Payroll Period</label>
                    <select className={inputCls} value={selectedPeriod} onChange={(e) => setSelectedPeriod(e.target.value)}>
                      <option value="">Select a period…</option>
                      {payrollPeriods.map((p) => <option key={p.id} value={p.period_label}>{p.period_label} ({p.status})</option>)}
                    </select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setAction(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                    <button onClick={addToPayroll} disabled={busy || !selectedPeriod} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-60">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Briefcase className="w-4 h-4" />} Add to Payroll
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
