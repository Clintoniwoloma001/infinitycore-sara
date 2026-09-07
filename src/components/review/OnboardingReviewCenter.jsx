import React, { useEffect, useState, useCallback } from 'react'
import {
  AlertTriangle, Briefcase, Check, CheckCircle2, Clock, FileText,
  Loader2, Send, X,
} from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../supabaseClient'
import { onboardingService } from '../../services/onboardingService'
import { guarantorVerificationService } from '../../services/guarantorVerificationService'
import { payrollService } from '../../services/payrollService'
import { LoadingState, ErrorState } from '../PageStates'
import { REVIEW_SECTIONS, ALL_TABS, GUARANTOR_CORRECTABLE_FIELDS } from './sectionConfig'
import SectionPanel from './SectionPanel'
import CorrectionRequestModal from './CorrectionRequestModal'
import CorrectionsTab from './CorrectionsTab'
import GuarantorTab from './GuarantorTab'
import DocumentsTab from './DocumentsTab'
import TimelineTab from './TimelineTab'
import SaraPreReview from './SaraPreReview'

const STATUS_BADGE_CLASSES = {
  submitted: 'bg-amber-50 text-amber-700 border-amber-200',
  under_review: 'bg-blue-50 text-blue-700 border-blue-200',
  pending_guarantor: 'bg-amber-50 text-amber-700 border-amber-200',
  guarantor_submitted: 'bg-blue-50 text-blue-700 border-blue-200',
  correction_requested: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  }
}

function StatCard({ label, value, color = 'text-slate-900' }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-3">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  )
}

export default function OnboardingReviewCenter({ submission, onClose, onRefresh }) {
  const { hasPermission, user } = useAuth()
  const canManage = hasPermission('hr.onboarding.manage')

  const [activeTab, setActiveTab] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // Data
  const [verification, setVerification] = useState(null)
  const [onboardingCorrections, setOnboardingCorrections] = useState([])
  const [guarantorCorrections, setGuarantorCorrections] = useState([])
  const [events, setEvents] = useState([])
  const [guarantorDocuments, setGuarantorDocuments] = useState([])

  // Action state
  const [action, setAction] = useState(null) // null | 'approve' | 'reject' | 'payroll'
  const [rejectReason, setRejectReason] = useState('')
  const [generatedLink, setGeneratedLink] = useState(null)
  const [copied, setCopied] = useState(false)
  const [payrollPeriods, setPayrollPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState('')

  // Correction modal
  const [correctionField, setCorrectionField] = useState(null)
  const [correctionSection, setCorrectionSection] = useState(null)

  const payload = submission?.payload || {}
  const onboardingStatus = submission?.onboarding_status || 'submitted'

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [verifs, onbCorrs] = await Promise.all([
        guarantorVerificationService.listVerifications().catch(() => []),
        onboardingService.listOnboardingCorrections(submission?.id).catch(() => []),
      ])
      const subVerifs = verifs.filter((v) => v.submission_id === submission?.id)
      const verif = subVerifs[0] || null
      setVerification(verif)

      let gCorrs = []
      let evts = []
      let gDocs = []
      if (verif) {
        const [c, e, d] = await Promise.all([
          guarantorVerificationService.listCorrections(verif.id).catch(() => []),
          guarantorVerificationService.listEvents(verif.id).catch(() => []),
          guarantorVerificationService.listGuarantorDocuments(verif.id).catch(() => []),
        ])
        gCorrs = c
        evts = e
        gDocs = d
      }

      // Also load events for the onboarding link
      if (submission?.link_id) {
        try {
          const { data: linkEvents } = await supabase
            .from('onboarding_events')
            .select('*')
            .eq('onboarding_link_id', submission.link_id)
            .order('created_at', { ascending: false })
          if (linkEvents) evts = [...evts, ...linkEvents]
        } catch {}
      }

      setOnboardingCorrections(onbCorrs)
      setGuarantorCorrections(gCorrs)
      setEvents(evts)
      setGuarantorDocuments(gDocs)
    } catch (e) {
      setError(e?.message || 'Failed to load review data')
    } finally {
      setLoading(false)
    }
  }, [submission?.id, submission?.link_id])

  useEffect(() => { load() }, [load])

  // ---- Actions ----

  const sendGuarantorLink = async () => {
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      const result = await guarantorVerificationService.createVerification({
        onboardingLinkId: submission?.link_id,
        employeeId: submission?.employee_id,
        submissionId: submission?.id,
        guarantorName: payload.guarantor_full_name,
        guarantorEmail: payload.guarantor_email,
        guarantorRelationship: payload.guarantor_relationship,
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

  const handleRequestCorrection = (field) => {
    // Find which section this field belongs to
    const section = REVIEW_SECTIONS.find((s) => s.fields?.some((f) => f.key === field.key))
    setCorrectionSection(section)
    setCorrectionField(field)
  }

  const submitCorrectionRequest = async (correctionData) => {
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      await onboardingService.requestOnboardingCorrection(submission.id, [correctionData])
      setSuccessMsg(`Correction requested for ${correctionData.field_label}.`)
      setCorrectionField(null)
      await load()
      onRefresh?.()
    } catch (e) {
      setError(e?.message || 'Failed to request correction')
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

  // Correction approve/reject/submit
  const approveCorrection = async (correctionId, type) => {
    setBusy(true); setError('')
    try {
      if (type === 'onboarding') {
        await onboardingService.approveOnboardingCorrection(correctionId)
      } else {
        await guarantorVerificationService.approveCorrection(correctionId)
      }
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to approve correction')
    } finally {
      setBusy(false)
    }
  }

  const rejectCorrection = async (correctionId, type, reason) => {
    setBusy(true); setError('')
    try {
      if (type === 'onboarding') {
        await onboardingService.rejectOnboardingCorrection(correctionId, reason)
      } else {
        await guarantorVerificationService.rejectCorrection(correctionId)
      }
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to reject correction')
    } finally {
      setBusy(false)
    }
  }

  const submitCorrectionValue = async (correctionId, correctedValue) => {
    setBusy(true); setError('')
    try {
      await onboardingService.submitOnboardingCorrection(correctionId, correctedValue)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to submit correction value')
    } finally {
      setBusy(false)
    }
  }

  const handleGetSignedUrl = async (filePath) => {
    try {
      const url = await guarantorVerificationService.getSignedUrl(filePath)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setError(e?.message || 'Failed to generate document link')
    }
  }

  const copyLink = async (url) => {
    await copyText(url); setCopied(true); setTimeout(() => setCopied(false), 1500)
  }

  // Load payroll periods when needed
  useEffect(() => {
    if (action === 'payroll') {
      payrollService.listPeriods().then(setPayrollPeriods).catch(() => setPayrollPeriods([]))
    }
  }, [action])

  // ---- Computed stats ----
  const totalSections = REVIEW_SECTIONS.length
  const documents = payload?.documents || []
  const totalCorrections = onboardingCorrections.length + guarantorCorrections.length
  const pendingCorrections = [...onboardingCorrections, ...guarantorCorrections].filter((c) => c.status === 'pending' || c.status === 'submitted').length
  const guarantorStatus = verification?.status || 'pending_link'

  // Check if approval is blocked
  const hasUnresolvedCorrections = pendingCorrections > 0
  const guarantorApproved = verification?.status === 'approved'
  const canApprove = canManage && onboardingStatus !== 'completed' && onboardingStatus !== 'rejected' && !hasUnresolvedCorrections

  if (!submission) return null

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex flex-col">
      {/* ---- Header ---- */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[#009944] text-white flex items-center justify-center font-semibold text-sm">
            {submission.candidate_name?.charAt(0)?.toUpperCase() || '?'}
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900 truncate">Onboarding Review Center</h3>
            <p className="text-xs text-slate-500 truncate">
              {submission.candidate_name} — {submission.position || 'N/A'}
              {submission.department ? ` · ${submission.department}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${STATUS_BADGE_CLASSES[onboardingStatus] || STATUS_BADGE_CLASSES.submitted}`}>
            {onboardingStatus.replace(/_/g, ' ')}
          </span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* ---- Body: sidebar + main content ---- */}
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* Left sidebar (desktop) */}
        <div className="hidden lg:flex flex-col w-64 flex-shrink-0 border-r border-slate-200 bg-slate-50 overflow-y-auto p-4">
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Candidate</h4>
            <div className="space-y-1">
              <p className="text-sm text-slate-700"><span className="text-slate-400">Name:</span> {submission.candidate_name}</p>
              <p className="text-sm text-slate-700"><span className="text-slate-400">Email:</span> {submission.email || '—'}</p>
              <p className="text-sm text-slate-700"><span className="text-slate-400">Phone:</span> {submission.phone || '—'}</p>
              <p className="text-sm text-slate-700"><span className="text-slate-400">Position:</span> {submission.position || '—'}</p>
              <p className="text-sm text-slate-700"><span className="text-slate-400">Submitted:</span> {submission.submitted_at ? new Date(submission.submitted_at).toLocaleDateString() : '—'}</p>
            </div>
          </div>

          <div className="mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Review Summary</h4>
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Sections" value={totalSections} />
              <StatCard label="Documents" value={documents.length} color={documents.length > 0 ? 'text-emerald-600' : 'text-amber-600'} />
              <StatCard label="Corrections" value={totalCorrections} color={totalCorrections > 0 ? 'text-amber-600' : 'text-slate-900'} />
              <StatCard label="Pending" value={pendingCorrections} color={pendingCorrections > 0 ? 'text-rose-600' : 'text-emerald-600'} />
            </div>
          </div>

          <div className="mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Status</h4>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Onboarding</span>
                <span className={`text-xs font-medium capitalize ${onboardingStatus === 'completed' ? 'text-emerald-600' : onboardingStatus === 'rejected' ? 'text-rose-600' : 'text-amber-600'}`}>
                  {onboardingStatus.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Guarantor</span>
                <span className={`text-xs font-medium capitalize ${guarantorStatus === 'approved' ? 'text-emerald-600' : guarantorStatus === 'rejected' ? 'text-rose-600' : 'text-amber-600'}`}>
                  {guarantorStatus.replace(/_/g, ' ')}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-y-auto bg-white">
          {/* Mobile candidate info */}
          <div className="lg:hidden border-b border-slate-200 px-4 py-3 bg-slate-50">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-slate-400">Submitted:</span> {submission.submitted_at ? new Date(submission.submitted_at).toLocaleDateString() : '—'}</div>
              <div><span className="text-slate-400">Guarantor:</span> <span className="capitalize">{guarantorStatus.replace(/_/g, ' ')}</span></div>
              <div><span className="text-slate-400">Corrections:</span> {totalCorrections} ({pendingCorrections} pending)</div>
              <div><span className="text-slate-400">Documents:</span> {documents.length}</div>
            </div>
          </div>

          {/* Messages */}
          {error && <div className="px-4 sm:px-6 pt-4"><ErrorState message={error} /></div>}
          {successMsg && (
            <div className="px-4 sm:px-6 pt-4">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> {successMsg}
              </div>
            </div>
          )}

          {loading && <div className="px-6 py-8"><LoadingState label="Loading review data…" /></div>}

          {!loading && (
            <>
              {/* SARA Pre-Review */}
              {activeTab === 'overview' && (
                <div className="px-4 sm:px-6 pt-4">
                  <SaraPreReview
                    submission={submission}
                    verification={verification}
                    onboardingCorrections={onboardingCorrections}
                    guarantorCorrections={guarantorCorrections}
                    userName={user?.email?.split('@')[0] || 'HR'}
                    onContinueReview={() => setActiveTab('personal')}
                    onRequestCorrections={async (selectedRecs) => {
                      const corrections = selectedRecs.map((rec) => ({
                        field_name: rec.fieldKey,
                        field_label: rec.fieldLabel,
                        reason: rec.reason,
                        original_value: String(payload[rec.fieldKey] ?? ''),
                      }))
                      await onboardingService.requestOnboardingCorrection(submission.id, corrections)
                      await load()
                      onRefresh?.()
                    }}
                  />
                </div>
              )}

              {/* Tab bar */}
              <div className="sticky top-0 bg-white border-b border-slate-200 z-10">
                <div className="flex gap-1 overflow-x-auto px-4 sm:px-6 py-2">
                  {ALL_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                        activeTab === tab.id
                          ? 'bg-[#009944] text-white'
                          : 'text-slate-500 hover:bg-slate-100'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tab content */}
              <div className="p-4 sm:p-6 max-w-5xl">
                {/* Overview */}
                {activeTab === 'overview' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <StatCard label="Total Sections" value={totalSections} />
                      <StatCard label="Documents Submitted" value={documents.length} color={documents.length > 0 ? 'text-emerald-600' : 'text-amber-600'} />
                      <StatCard label="Corrections Requested" value={totalCorrections} color={totalCorrections > 0 ? 'text-amber-600' : 'text-slate-900'} />
                      <StatCard label="Corrections Pending" value={pendingCorrections} color={pendingCorrections > 0 ? 'text-rose-600' : 'text-emerald-600'} />
                    </div>
                    <div className="rounded-lg border border-slate-200 p-4">
                      <h4 className="text-sm font-semibold text-slate-700 mb-3">Employee Information</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                        <div className="flex py-1.5"><span className="text-xs text-slate-400 w-32 flex-shrink-0">Name</span><span className="text-sm text-slate-800">{submission.candidate_name}</span></div>
                        <div className="flex py-1.5"><span className="text-xs text-slate-400 w-32 flex-shrink-0">Email</span><span className="text-sm text-slate-800">{submission.email || '—'}</span></div>
                        <div className="flex py-1.5"><span className="text-xs text-slate-400 w-32 flex-shrink-0">Phone</span><span className="text-sm text-slate-800">{submission.phone || '—'}</span></div>
                        <div className="flex py-1.5"><span className="text-xs text-slate-400 w-32 flex-shrink-0">Position</span><span className="text-sm text-slate-800">{submission.position || '—'}</span></div>
                        <div className="flex py-1.5"><span className="text-xs text-slate-400 w-32 flex-shrink-0">Department</span><span className="text-sm text-slate-800">{submission.department || '—'}</span></div>
                        <div className="flex py-1.5"><span className="text-xs text-slate-400 w-32 flex-shrink-0">Employment Type</span><span className="text-sm text-slate-800">{submission.employment_type || '—'}</span></div>
                        <div className="flex py-1.5"><span className="text-xs text-slate-400 w-32 flex-shrink-0">Submitted</span><span className="text-sm text-slate-800">{submission.submitted_at ? new Date(submission.submitted_at).toLocaleString() : '—'}</span></div>
                        <div className="flex py-1.5"><span className="text-xs text-slate-400 w-32 flex-shrink-0">Declaration</span><span className="text-sm text-slate-800">{submission.declaration_accepted ? 'Accepted' : 'Not accepted'}</span></div>
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-4">
                      <h4 className="text-sm font-semibold text-slate-700 mb-3">Guarantor Status</h4>
                      <div className="flex items-center gap-3">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${STATUS_BADGE_CLASSES[guarantorStatus] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          {guarantorStatus.replace(/_/g, ' ')}
                        </span>
                        {payload.guarantor_full_name && <span className="text-sm text-slate-600">{payload.guarantor_full_name}</span>}
                      </div>
                    </div>
                  </div>
                )}

                {/* Section tabs (personal, family, etc.) */}
                {REVIEW_SECTIONS.some((s) => s.id === activeTab) && (
                  <SectionPanel
                    section={REVIEW_SECTIONS.find((s) => s.id === activeTab)}
                    payload={payload}
                    corrections={onboardingCorrections}
                    canManage={canManage}
                    onRequestCorrection={handleRequestCorrection}
                  />
                )}

                {/* Guarantor tab */}
                {activeTab === 'guarantor' && (
                  <GuarantorTab
                    payload={payload}
                    verification={verification}
                    guarantorDocuments={guarantorDocuments}
                    canManage={canManage}
                    busy={busy}
                    onSendLink={sendGuarantorLink}
                    onApproveVerification={approveVerification}
                    onGetSignedUrl={handleGetSignedUrl}
                    generatedLink={generatedLink}
                    copied={copied}
                    onCopyLink={copyLink}
                  />
                )}

                {/* Documents tab */}
                {activeTab === 'documents' && (
                  <DocumentsTab
                    documents={documents}
                    signatureData={submission.signature_data || payload.declaration_signature}
                    declarationAccepted={submission.declaration_accepted}
                    onGetSignedUrl={handleGetSignedUrl}
                    loading={false}
                  />
                )}

                {/* Corrections tab */}
                {activeTab === 'corrections' && (
                  <CorrectionsTab
                    onboardingCorrections={onboardingCorrections}
                    guarantorCorrections={guarantorCorrections}
                    canManage={canManage}
                    onApprove={approveCorrection}
                    onReject={rejectCorrection}
                    onSubmitValue={submitCorrectionValue}
                    busy={busy}
                  />
                )}

                {/* Timeline tab */}
                {activeTab === 'timeline' && (
                  <TimelineTab events={events} />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- Sticky action bar ---- */}
      {canManage && onboardingStatus !== 'completed' && onboardingStatus !== 'rejected' && !loading && (
        <div className="bg-white border-t border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-2 flex-shrink-0">
          <div className="text-xs text-slate-500 hidden sm:block">
            {hasUnresolvedCorrections && <span className="text-amber-600">⚠ {pendingCorrections} unresolved correction(s)</span>}
            {!hasUnresolvedCorrections && verification && verification.status !== 'approved' && <span className="text-amber-600">Guarantor verification pending</span>}
            {!hasUnresolvedCorrections && (!verification || verification.status === 'approved') && <span className="text-emerald-600">✓ Ready for approval</span>}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => setAction('reject')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-rose-300 text-rose-600 text-sm font-medium hover:bg-rose-50"
            >
              <X className="w-4 h-4" /> Reject
            </button>
            <button
              onClick={() => setAction('approve')}
              disabled={hasUnresolvedCorrections}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={hasUnresolvedCorrections ? 'Resolve all corrections first' : 'Approve onboarding'}
            >
              <CheckCircle2 className="w-4 h-4" /> Approve
            </button>
          </div>
        </div>
      )}

      {/* ---- Approval confirmation ---- */}
      {action === 'approve' && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <h4 className="text-base font-semibold text-slate-900 mb-3">Confirm Onboarding Approval</h4>
            <div className="space-y-1 text-sm text-slate-700 mb-4">
              <p><span className="text-slate-400">Employee:</span> {submission.candidate_name}</p>
              <p><span className="text-slate-400">Position:</span> {submission.position || 'N/A'}</p>
              <p><span className="text-slate-400">Department:</span> {submission.department || 'N/A'}</p>
              <p><span className="text-slate-400">Guarantor:</span> {verification?.status === 'approved' ? '✓ Verified' : 'Pending'}</p>
              <p><span className="text-slate-400">Corrections:</span> {hasUnresolvedCorrections ? `${pendingCorrections} pending` : '✓ None pending'}</p>
            </div>
            {hasUnresolvedCorrections && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 mb-4">
                <AlertTriangle className="w-4 h-4 inline mr-1" />
                There are {pendingCorrections} unresolved correction(s). All corrections must be resolved before approval.
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setAction(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button
                onClick={approveOnboarding}
                disabled={busy || hasUnresolvedCorrections}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve Employee
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Rejection modal ---- */}
      {action === 'reject' && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <h4 className="text-base font-semibold text-slate-900 mb-3">Reject Onboarding</h4>
            <p className="text-sm text-slate-500 mb-3">A reason is required and will be recorded in the audit trail.</p>
            <textarea
              className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Explain why this onboarding is being rejected…"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setAction(null); setRejectReason('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button
                onClick={rejectOnboarding}
                disabled={busy || !rejectReason.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />} Reject Onboarding
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Payroll modal ---- */}
      {action === 'payroll' && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <h4 className="text-base font-semibold text-slate-900 mb-3">Add to Payroll</h4>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Payroll Period</label>
            <select
              className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
            >
              <option value="">Select a period…</option>
              {payrollPeriods.map((p) => <option key={p.id} value={p.period_label}>{p.period_label} ({p.status})</option>)}
            </select>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setAction(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button
                onClick={addToPayroll}
                disabled={busy || !selectedPeriod}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Briefcase className="w-4 h-4" />} Add to Payroll
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Correction request modal ---- */}
      {correctionField && (
        <CorrectionRequestModal
          field={correctionField}
          section={correctionSection}
          currentValue={payload[correctionField.key]}
          onSubmit={submitCorrectionRequest}
          onCancel={() => { setCorrectionField(null); setCorrectionSection(null) }}
          busy={busy}
        />
      )}
    </div>
  )
}
