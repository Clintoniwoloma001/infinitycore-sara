import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  AlertTriangle, ArrowLeft, Briefcase, Camera, Check, CheckCircle2, Clock,
  Copy, FileText, IdCard, Loader2, PenTool, Send, Sparkles, User, X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, ErrorState } from '../components/PageStates'
import { date, status, money } from './hrShared'
import { onboardingService } from '../services/onboardingService'
import { guarantorVerificationService } from '../services/guarantorVerificationService'
import { onboardingCorrectionService } from '../services/onboardingCorrectionService'
import { payrollService } from '../services/payrollService'
import { supabase } from '../supabaseClient'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const TABS = [
  { id: 'overview', label: 'Candidate Overview', icon: User },
  { id: 'personal', label: 'Personal', icon: User },
  { id: 'employment', label: 'Employment', icon: Briefcase },
  { id: 'kin', label: 'Next of Kin', icon: User },
  { id: 'education', label: 'Education', icon: FileText },
  { id: 'work', label: 'Previous Employment', icon: Briefcase },
  { id: 'guarantor', label: 'Guarantor', icon: IdCard },
  { id: 'bonds', label: 'Fidelity Bond', icon: CheckCircle2 },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'declaration', label: 'Declaration / Audit', icon: Clock },
]

function InfoRow({ label, value }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 py-1.5">
      <span className="text-xs text-slate-400 sm:w-44 flex-shrink-0">{label}</span>
      <span className="text-sm text-slate-800">{value || '—'}</span>
    </div>
  )
}

function Section({ title, icon: Icon, children, actions }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 mb-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4 text-slate-400" />}
          <h3 className="font-semibold text-slate-900">{title}</h3>
        </div>
        {actions}
      </div>
      {children}
    </div>
  )
}

const STATUS_BADGE = {
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

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  }
}

export default function OnboardingReview() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { hasPermission, user, profile } = useAuth()
  const canManage = hasPermission('hr.onboarding.manage')

  const [submission, setSubmission] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('overview')
  const [verification, setVerification] = useState(null)
  const [corrections, setCorrections] = useState([])
  const [events, setEvents] = useState([])
  const [childrenData, setChildrenData] = useState({})
  const [busy, setBusy] = useState(false)
  const [successMsg, setSuccessMsg] = useState('')
  const [generatedLink, setGeneratedLink] = useState(null)
  const [copied, setCopied] = useState(false)
  const [showCorrection, setShowCorrection] = useState(null) // field key being corrected
  const [correctionComment, setCorrectionComment] = useState('')
  const [showPayroll, setShowPayroll] = useState(false)
  const [payrollPeriods, setPayrollPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [showReject, setShowReject] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      // Fetch the submission
      const { data: sub, error: subErr } = await supabase
        .from('employee_onboarding_submissions')
        .select('*')
        .eq('id', id)
        .single()
      if (subErr) throw subErr
      setSubmission(sub)

      // Fetch verification
      const { data: verifs } = await supabase
        .from('guarantor_verifications')
        .select('*')
        .eq('submission_id', id)
        .order('created_at', { ascending: false })
      const verif = verifs?.[0] || null
      setVerification(verif)

      // Fetch corrections
      try {
        const corrs = await onboardingCorrectionService.listCorrections(id)
        setCorrections(corrs)
      } catch { setCorrections([]) }

      // Fetch events
      if (verif) {
        const { data: evts } = await supabase
          .from('onboarding_events')
          .select('*')
          .or(`guarantor_verification_id.eq.${verif.id},submission_id.eq.${id}`)
          .order('created_at', { ascending: false })
        setEvents(evts || [])
      } else {
        const { data: evts } = await supabase
          .from('onboarding_events')
          .select('*')
          .eq('submission_id', id)
          .order('created_at', { ascending: false })
        setEvents(evts || [])
      }

      // Fetch child records (education, work history, guarantors, bonds)
      if (sub?.employee_id) {
        const [edu, work, guars, bonds] = await Promise.all([
          supabase.from('employee_education').select('*').eq('employee_id', sub.employee_id).then(r => r.data || []),
          supabase.from('employee_work_history').select('*').eq('employee_id', sub.employee_id).then(r => r.data || []),
          supabase.from('employee_guarantors').select('*').eq('employee_id', sub.employee_id).then(r => r.data || []),
          supabase.from('employee_fidelity_bonds').select('*').eq('employee_id', sub.employee_id).then(r => r.data || []),
        ])
        setChildrenData({ employee_education: edu, employee_work_history: work, employee_guarantors: guars, employee_fidelity_bonds: bonds })
      }
    } catch (e) {
      setError(e?.message || 'Failed to load onboarding review')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  const payload = submission?.payload || {}
  const onboardingStatus = submission?.onboarding_status || 'submitted'
  const guarantorName = payload.guarantor_full_name || ''
  const guarantorEmail = payload.guarantor_email || ''
  const guarantorRelationship = payload.guarantor_relationship || ''

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

  const requestFieldCorrection = async (fieldKey, fieldLabel, originalValue) => {
    if (!correctionComment.trim()) { setError('Please provide a comment for the correction request.'); return }
    setBusy(true); setError(''); setSuccessMsg('')
    try {
      await onboardingCorrectionService.requestCorrection({
        submissionId: submission.id,
        verificationId: verification?.id,
        fieldName: fieldKey,
        fieldLabel,
        originalValue: String(originalValue || ''),
        hrComment: correctionComment,
        requestedById: user?.id,
        requestedByName: profile?.full_name || user?.email,
      })
      setSuccessMsg(`Correction requested for "${fieldLabel}".`)
      setShowCorrection(null)
      setCorrectionComment('')
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to request correction')
    } finally {
      setBusy(false)
    }
  }

  const approveCorrection = async (correctionId) => {
    setBusy(true); setError('')
    try {
      await onboardingCorrectionService.approveCorrection(correctionId, user?.id, profile?.full_name || user?.email)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to approve correction')
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
      await load()
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
      setShowReject(false); setRejectReason('')
      await load()
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
      setShowPayroll(false)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to add to payroll')
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
    if (showPayroll) loadPayrollPeriods()
  }, [showPayroll])

  const copyLink = async (url) => {
    await copyText(url); setCopied(true); setTimeout(() => setCopied(false), 1500)
  }

  if (loading) return <LoadingState label="Loading onboarding review…" />
  if (error && !submission) return <ErrorState message={error} />

  const CorrectionButton = ({ fieldKey, fieldLabel, value }) => {
    if (!canManage) return null
    const existing = corrections.find((c) => c.field_name === fieldKey && c.status !== 'rejected')
    if (existing) {
      return (
        <span className={`text-xs px-2 py-0.5 rounded-full border ${existing.status === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
          {existing.status === 'approved' ? 'Corrected' : `Correction ${existing.status}`}
        </span>
      )
    }
    return (
      <button
        onClick={() => { setShowCorrection(fieldKey); setCorrectionComment('') }}
        className="text-xs text-amber-600 hover:text-amber-800 hover:underline"
      >
        Request Correction
      </button>
    )
  }

  const CorrectableRow = ({ label, fieldKey, value }) => (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 py-1.5 group">
      <span className="text-xs text-slate-400 sm:w-44 flex-shrink-0">{label}</span>
      <span className="text-sm text-slate-800 flex-1">{value || '—'}</span>
      <CorrectionButton fieldKey={fieldKey} fieldLabel={label} value={value} />
    </div>
  )

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => navigate('/onboarding-links')} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#009944]">
          <ArrowLeft className="w-4 h-4" /> Back to Onboarding
        </button>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-slate-900">{submission?.candidate_name || 'Unknown'}</h2>
            <p className="text-sm text-slate-500 mt-1">{submission?.position || 'No position'} {submission?.department ? `· ${submission.department}` : ''}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border ${STATUS_BADGE[onboardingStatus] || STATUS_BADGE.submitted}`}>
                Onboarding: {onboardingStatus.replace(/_/g, ' ')}
              </span>
              {verification && (
                <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border ${STATUS_BADGE[verification.status] || STATUS_BADGE.pending_link}`}>
                  Guarantor: {verification.status.replace(/_/g, ' ')}
                </span>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400">Submitted</p>
            <p className="text-sm text-slate-600">{date(submission?.submitted_at)}</p>
          </div>
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {successMsg && (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {successMsg}
        </div>
      )}

      {/* SARA Pre-Review */}
      {(() => {
        const saraFindings = []
        const p = payload
        // Check for missing required fields
        if (!p.residential_address) saraFindings.push({ severity: 'warning', text: 'Residential address not provided' })
        if (!p.bvn) saraFindings.push({ severity: 'warning', text: 'BVN not provided' })
        if (!p.nin) saraFindings.push({ severity: 'warning', text: 'NIN not provided' })
        if (!p.next_of_kin_name) saraFindings.push({ severity: 'warning', text: 'Next of kin name missing' })
        if (!p.next_of_kin_phone) saraFindings.push({ severity: 'warning', text: 'Next of kin phone missing' })
        if (!guarantorName) saraFindings.push({ severity: 'warning', text: 'Guarantor information not provided' })
        if (!verification) saraFindings.push({ severity: 'info', text: 'Guarantor verification link not yet sent' })
        else if (verification.status !== 'approved' && verification.status !== 'submitted')
          saraFindings.push({ severity: 'info', text: `Guarantor verification status: ${verification.status.replace(/_/g, ' ')}` })
        if ((childrenData.employee_education || []).length === 0) saraFindings.push({ severity: 'warning', text: 'No education records' })
        if ((childrenData.employee_work_history || []).length === 0) saraFindings.push({ severity: 'warning', text: 'No previous work history records' })
        if ((childrenData.employee_fidelity_bonds || []).length === 0) saraFindings.push({ severity: 'info', text: 'No fidelity bond records' })
        const pendingCorrections = corrections.filter((c) => c.status === 'requested' || c.status === 'submitted')
        if (pendingCorrections.length > 0) saraFindings.push({ severity: 'warning', text: `${pendingCorrections.length} correction(s) pending resolution` })
        if (!p.bank_name && !p.account_number) saraFindings.push({ severity: 'info', text: 'Bank details not yet completed' })
        if (!p.start_date) saraFindings.push({ severity: 'warning', text: 'Employment start date not specified' })

        if (saraFindings.length === 0) return null

        return (
          <div className="mb-6 rounded-lg border border-violet-200 bg-violet-50 p-5">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-5 h-5 text-violet-600" />
              <h3 className="font-semibold text-violet-900">SARA Pre-Review</h3>
            </div>
            <p className="text-sm text-violet-700 mb-3">SARA has reviewed this submission. The following items may require HR attention:</p>
            <div className="space-y-1.5">
              {saraFindings.map((f, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span className={f.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'}>
                    {f.severity === 'warning' ? '⚠' : 'ℹ'}
                  </span>
                  <span className={f.severity === 'warning' ? 'text-amber-800' : 'text-blue-800'}>{f.text}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-violet-500 mt-3 italic">SARA does not invent facts — items marked ⚠ require HR review, items marked ℹ are informational.</p>
          </div>
        )
      })()}

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-6">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'overview' && (
        <Section title="Candidate Overview" icon={User}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <InfoRow label="Name" value={submission?.candidate_name} />
            <InfoRow label="Email" value={submission?.email} />
            <InfoRow label="Phone" value={submission?.phone} />
            <InfoRow label="Position" value={submission?.position} />
            <InfoRow label="Department" value={submission?.department} />
            <InfoRow label="Branch" value={submission?.branch} />
            <InfoRow label="Employment Type" value={submission?.employment_type} />
            <InfoRow label="Start Date" value={date(payload?.start_date)} />
            <InfoRow label="Declaration Accepted" value={submission?.declaration_accepted ? 'Yes' : 'No'} />
          </div>

          {canManage && onboardingStatus !== 'completed' && onboardingStatus !== 'rejected' && (
            <div className="flex flex-wrap gap-2 mt-5 pt-4 border-t border-slate-200">
              {!verification && guarantorName && (
                <button onClick={sendGuarantorLink} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                  <Send className="w-4 h-4" /> Send Guarantor Link
                </button>
              )}
              {verification && verification.status === 'submitted' && (
                <>
                  <button onClick={approveVerification} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
                    <Check className="w-4 h-4" /> Approve Verification
                  </button>
                </>
              )}
              {verification && verification.status === 'approved' && onboardingStatus !== 'completed' && (
                <button onClick={approveOnboarding} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-60">
                  <CheckCircle2 className="w-4 h-4" /> Approve Onboarding
                </button>
              )}
              {onboardingStatus === 'completed' && (
                <button onClick={() => setShowPayroll(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700">
                  <Briefcase className="w-4 h-4" /> Add to Payroll
                </button>
              )}
              {onboardingStatus !== 'completed' && (
                <button onClick={() => setShowReject(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-rose-300 text-rose-600 text-sm font-medium hover:bg-rose-50">
                  <X className="w-4 h-4" /> Reject
                </button>
              )}
            </div>
          )}

          {generatedLink && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-medium text-emerald-900 mb-2">Guarantor verification link generated:</p>
              <div className="flex items-center gap-2">
                <input readOnly value={generatedLink.url} className={inputCls} />
                <button onClick={() => copyLink(generatedLink.url)} className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] whitespace-nowrap">
                  <Copy className="w-4 h-4" /> {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </Section>
      )}

      {tab === 'personal' && (
        <Section title="Personal Information" icon={User}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <CorrectableRow label="Full Name" fieldKey="full_name" value={payload?.full_name} />
            <CorrectableRow label="Email" fieldKey="email" value={payload?.email} />
            <CorrectableRow label="Phone" fieldKey="phone" value={payload?.phone} />
            <CorrectableRow label="Date of Birth" fieldKey="date_of_birth" value={date(payload?.date_of_birth)} />
            <CorrectableRow label="Sex" fieldKey="sex" value={payload?.sex} />
            <CorrectableRow label="State of Origin" fieldKey="state_of_origin" value={payload?.state_of_origin} />
            <CorrectableRow label="LGA" fieldKey="lga" value={payload?.lga} />
            <CorrectableRow label="Town" fieldKey="town" value={payload?.town} />
            <CorrectableRow label="Residential Address" fieldKey="residential_address" value={payload?.residential_address} />
            <CorrectableRow label="Nationality" fieldKey="nationality" value={payload?.nationality} />
            <CorrectableRow label="Marital Status" fieldKey="marital_status" value={payload?.marital_status} />
            <CorrectableRow label="Religion" fieldKey="religion" value={payload?.religion} />
            <CorrectableRow label="BVN" fieldKey="bvn" value={payload?.bvn} />
            <CorrectableRow label="NIN" fieldKey="nin" value={payload?.nin} />
          </div>
        </Section>
      )}

      {tab === 'employment' && (
        <Section title="Employment Information" icon={Briefcase}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <InfoRow label="Position" value={submission?.position} />
            <InfoRow label="Department" value={submission?.department} />
            <InfoRow label="Branch" value={submission?.branch} />
            <InfoRow label="Employment Type" value={submission?.employment_type} />
            <InfoRow label="Start Date" value={date(payload?.start_date)} />
            <InfoRow label="Salary" value={money(payload?.salary)} />
            <InfoRow label="Employee Code" value={payload?.employee_code} />
            <InfoRow label="Bank Name" value={payload?.bank_name} />
            <InfoRow label="Account Number" value={payload?.account_number} />
          </div>
        </Section>
      )}

      {tab === 'kin' && (
        <Section title="Next of Kin & Beneficiary" icon={User}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <InfoRow label="Next of Kin Name" value={payload?.next_of_kin_name} />
            <InfoRow label="Relationship" value={payload?.next_of_kin_relationship} />
            <InfoRow label="Phone" value={payload?.next_of_kin_phone} />
            <InfoRow label="Address" value={payload?.next_of_kin_address} />
            <InfoRow label="Beneficiary Name" value={payload?.beneficiary_name} />
            <InfoRow label="Beneficiary Relationship" value={payload?.beneficiary_relationship} />
            <InfoRow label="Beneficiary Phone" value={payload?.beneficiary_phone} />
            <InfoRow label="Emergency Contact" value={payload?.emergency_contact_name} />
            <InfoRow label="Emergency Phone" value={payload?.emergency_contact_phone} />
          </div>
        </Section>
      )}

      {tab === 'education' && (
        <Section title="Education Records" icon={FileText}>
          {(childrenData.employee_education || []).length === 0 ? (
            <p className="text-sm text-slate-400">No education records.</p>
          ) : (
            <div className="space-y-3">
              {(childrenData.employee_education || []).map((edu) => (
                <div key={edu.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="grid grid-cols-2 gap-x-4 text-sm">
                    <InfoRow label="Institution" value={edu.institution} />
                    <InfoRow label="Level" value={edu.education_level} />
                    <InfoRow label="Field" value={edu.field_of_study} />
                    <InfoRow label="Years" value={`${edu.from_year || ''} — ${edu.to_year || ''}`} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {tab === 'work' && (
        <Section title="Previous Employment" icon={Briefcase}>
          {(childrenData.employee_work_history || []).length === 0 ? (
            <p className="text-sm text-slate-400">No work history records.</p>
          ) : (
            <div className="space-y-3">
              {(childrenData.employee_work_history || []).map((w) => (
                <div key={w.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="grid grid-cols-2 gap-x-4 text-sm">
                    <InfoRow label="Company" value={w.company_name} />
                    <InfoRow label="Position" value={w.position} />
                    <InfoRow label="Period" value={`${date(w.start_date)} — ${date(w.end_date)}`} />
                    <InfoRow label="Salary" value={money(w.salary)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {tab === 'guarantor' && (
        <>
          <Section title="Guarantor Information (Submitted by Employee)" icon={IdCard}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
              <InfoRow label="Name" value={guarantorName || 'Not provided'} />
              <InfoRow label="Email" value={guarantorEmail || 'Not provided'} />
              <InfoRow label="Relationship" value={guarantorRelationship || '—'} />
            </div>
            {canManage && !verification && guarantorName && (
              <button onClick={sendGuarantorLink} disabled={busy} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                <Send className="w-4 h-4" /> Send Guarantor Verification Link
              </button>
            )}
          </Section>

          {verification && (
            <Section title="Guarantor Verification Details" icon={CheckCircle2}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                <CorrectableRow label="Phone" fieldKey="phone" value={verification.phone} />
                <CorrectableRow label="Residential Address" fieldKey="residential_address" value={verification.residential_address} />
                <CorrectableRow label="Occupation" fieldKey="occupation" value={verification.occupation} />
                <CorrectableRow label="Employer" fieldKey="employer" value={verification.employer} />
                <CorrectableRow label="BVN" fieldKey="bvn" value={verification.bvn} />
                <CorrectableRow label="NIN" fieldKey="nin" value={verification.nin} />
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

              {verification.status === 'submitted' && canManage && (
                <div className="flex gap-2 mt-4 pt-4 border-t border-slate-200">
                  <button onClick={approveVerification} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
                    <Check className="w-4 h-4" /> Approve Verification
                  </button>
                </div>
              )}
            </Section>
          )}

          {corrections.length > 0 && (
            <Section title="Field Corrections" icon={AlertTriangle}>
              <div className="space-y-3">
                {corrections.map((c) => (
                  <div key={c.id} className={`rounded-lg border p-4 ${c.status === 'approved' ? 'border-emerald-200 bg-emerald-50' : c.status === 'rejected' ? 'border-rose-200 bg-rose-50' : c.status === 'submitted' ? 'border-blue-200 bg-blue-50' : 'border-amber-200 bg-amber-50'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-slate-800">{c.field_label || c.field_name}</span>
                      <span className="text-xs font-medium capitalize text-slate-500">{c.status}</span>
                    </div>
                    <div className="text-sm space-y-1">
                      <p className="text-xs text-slate-400">Original: <span className="font-mono text-slate-600">{c.original_value || '(empty)'}</span></p>
                      <p className="text-xs text-slate-400">HR comment: <span className="text-amber-800">{c.hr_comment || '—'}</span></p>
                      {c.corrected_value && <p className="text-xs text-slate-400">Corrected: <span className="font-mono text-emerald-700">{c.corrected_value}</span></p>}
                    </div>
                    {c.status === 'submitted' && canManage && (
                      <div className="flex gap-2 mt-3">
                        <button onClick={() => approveCorrection(c.id)} disabled={busy} className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60">Approve</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {tab === 'bonds' && (
        <Section title="Fidelity Bond" icon={CheckCircle2}>
          {(childrenData.employee_fidelity_bonds || []).length === 0 ? (
            <p className="text-sm text-slate-400">No fidelity bonds recorded.</p>
          ) : (
            <div className="space-y-3">
              {(childrenData.employee_fidelity_bonds || []).map((b) => (
                <div key={b.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="grid grid-cols-2 gap-x-4 text-sm">
                    <InfoRow label="Surety Name" value={b.surety_name} />
                    <InfoRow label="Occupation" value={b.occupation} />
                    <InfoRow label="Relationship" value={b.relationship} />
                    <InfoRow label="Verification" value={b.verification_status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {tab === 'documents' && (
        <Section title="Documents" icon={FileText}>
          <p className="text-sm text-slate-400">Uploaded documents from onboarding and guarantor verification will appear here with preview/download controls.</p>
        </Section>
      )}

      {tab === 'declaration' && (
        <Section title="Declaration & Audit Trail" icon={Clock}>
          <div className="mb-4">
            <InfoRow label="Declaration Accepted" value={submission?.declaration_accepted ? 'Yes' : 'No'} />
            <InfoRow label="Submitted At" value={date(submission?.submitted_at)} />
            <InfoRow label="Onboarding Status" value={onboardingStatus.replace(/_/g, ' ')} />
          </div>
          {events.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-slate-700 mb-3">Audit Timeline</h4>
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
            </div>
          )}
        </Section>
      )}

      {/* Correction Request Panel */}
      {showCorrection && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">Request Correction</h3>
              <button onClick={() => { setShowCorrection(null); setCorrectionComment('') }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-slate-400">Field</p>
                <p className="text-sm font-medium text-slate-800">{showCorrection}</p>
              </div>
              <div>
                <label className={labelCls}>HR Comment / Reason</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={correctionComment} onChange={(e) => setCorrectionComment(e.target.value)} placeholder="Explain what needs to be corrected…" />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => { setShowCorrection(null); setCorrectionComment('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={() => requestFieldCorrection(showCorrection, showCorrection, '')} disabled={busy || !correctionComment.trim()} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-60">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Request
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {showReject && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">Reject Onboarding</h3>
              <button onClick={() => { setShowReject(false); setRejectReason('') }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500" rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Reason for rejection…" />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => { setShowReject(false); setRejectReason('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={rejectOnboarding} disabled={busy || !rejectReason.trim()} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />} Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payroll Modal */}
      {showPayroll && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">Add to Payroll</h3>
              <button onClick={() => setShowPayroll(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-slate-500 mb-4">Select a payroll session. The employee will be added to this period.</p>
            <select className={inputCls} value={selectedPeriod} onChange={(e) => setSelectedPeriod(e.target.value)}>
              <option value="">Select a period…</option>
              {payrollPeriods.map((p) => <option key={p.id} value={p.period_label}>{p.period_label} ({p.status})</option>)}
            </select>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowPayroll(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={addToPayroll} disabled={busy || !selectedPeriod} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Briefcase className="w-4 h-4" />} Add to Payroll
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
