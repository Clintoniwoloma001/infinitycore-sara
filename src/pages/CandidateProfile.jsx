import React, { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Bot, CalendarPlus, CheckCircle2, ClipboardList, Download, FileText, Loader2, MessageSquarePlus, Pencil, Plus, ShieldAlert, ShieldBan, Sparkles, Stethoscope, Trash2, Upload, UsersRound, X, XCircle } from 'lucide-react'
import { date } from './hrShared'
import { recruitmentService } from '../services/recruitmentService'
import { screeningService } from '../services/screeningService'
import { assessmentService } from '../services/assessmentService'
import { offerService } from '../services/offerService'
import { ErrorState, LoadingState } from '../components/PageStates'
import { StatusBadge, formatCurrency } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'
import { sendInterviewEmail } from '../services/interviewService'
import MedicalCardModal from '../components/medical/MedicalCardModal'
import MedicalScreeningHistory from '../components/medical/MedicalScreeningHistory'

const STAT = {
  new: 'blue', received: 'slate', screening: 'blue', shortlisted: 'violet',
  assessment: 'violet', assessment_passed: 'teal', interview: 'cyan',
  interviewed: 'cyan', recommended: 'teal', offer: 'amber',
  offer_accepted: 'emerald', offer_declined: 'rose', guarantor: 'amber',
  onboarding: 'slate', hired: 'emerald', withdrawn: 'slate', rejected: 'rose',
}

const PIPELINE_STEPS = ['received', 'screening', 'shortlisted', 'assessment', 'assessment_passed', 'interview', 'offer', 'offer_accepted', 'hired']

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'screening', label: 'Screening' },
  { id: 'assessment', label: 'Assessment' },
  { id: 'interviews', label: 'Interviews' },
  { id: 'offers', label: 'Offers' },
  { id: 'medical', label: 'Medical' },
  { id: 'timeline', label: 'Timeline & Notes' },
]

const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

export default function CandidateProfile() {
  const { id } = useParams()
  const { user, isHR, actualRole, hasPermission } = useAuth()
  const [bundle, setBundle] = useState(null)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [tab, setTab] = useState('overview')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [edit, setEdit] = useState(false)
  const [form, setForm] = useState({})
  const [note, setNote] = useState('')
  const [templates, setTemplates] = useState([])
  const [invite, setInvite] = useState(null)
  const [activeAttempt, setActiveAttempt] = useState(null)
  const [showMedical, setShowMedical] = useState(false)
  const [medicalKey, setMedicalKey] = useState(0)
  const [showGenerateAssessment, setShowGenerateAssessment] = useState(false)
  const [generateOptions, setGenerateOptions] = useState({ count: 10, duration_minutes: 30, pass_mark: 60, category: 'technical' })
  const [showInterview, setShowInterview] = useState(false)
  const [interviewForm, setInterviewForm] = useState({ interview_type: 'PHYSICAL', scheduled_date: '', location: '', platform: '', meeting_url: '', duration_minutes: 30, notes: '' })
  const [feedbackTarget, setFeedbackTarget] = useState(null)
  const [feedbackForm, setFeedbackForm] = useState({ rating: 0, feedback: '', strengths: '', concerns: '', recommendation: 'hold', competency_scores: '{}' })

  const load = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const data = await recruitmentService.getCandidateBundle(id)
      setBundle(data)
      setForm({
        full_name: data.candidate?.full_name || '',
        email: data.candidate?.email || '',
        phone: data.candidate?.phone || '',
        location: data.candidate?.location || '',
        current_company: data.candidate?.current_company || '',
        years_experience: data.candidate?.years_experience ?? '',
      })
      setStatus('ready')
    } catch (e) {
      setError(e?.message || 'This candidate could not be loaded.')
      setStatus('error')
    }
  }, [id])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    assessmentService.listTemplates({ status: 'published' }).then(setTemplates).catch(() => setTemplates([]))
  }, [])

  const run = async (key, fn) => {
    setBusy(key)
    setMsg('')
    try {
      const res = await fn()
      setMsg(typeof res === 'string' ? res : res?.message || 'Done.')
      await load()
      return res
    } catch (e) {
      setMsg(e?.message || 'Action failed.')
    } finally {
      setBusy('')
    }
  }

  if (status === 'loading') return <LoadingState label="Loading candidate…" />
  if (status === 'error') return <ErrorState message={error} />
  if (!bundle?.candidate) return <ErrorState message="Candidate not found." />

  const cand = bundle.candidate
  const job = cand.hr_jobs

  const saveProfile = async () => {
    const ok = await run('save', async () => {
      await recruitmentService.updateProfile(id, {
        full_name: form.full_name,
        email: form.email,
        phone: form.phone || null,
        location: form.location || null,
        current_company: form.current_company || null,
        years_experience: form.years_experience === '' ? null : Number(form.years_experience),
      })
      setEdit(false)
      return 'Profile updated.'
    })
  }

  const generateAssessment = () => run('generate', async () => {
    if (!cand.job_id) throw new Error('This candidate is not linked to a job.')
    const result = await assessmentService.generateWithSara({
      jobId: cand.job_id,
      category: generateOptions.category,
      durationMinutes: Number(generateOptions.duration_minutes),
      passMark: Number(generateOptions.pass_mark),
      count: Number(generateOptions.count),
    })
    if (!result?.ok || !result.template_id) throw new Error(result?.error || 'Assessment generation failed.')
    await assessmentService.updateTemplate(result.template_id, { status: 'published' })
    setShowGenerateAssessment(false)
    await assessmentService.listTemplates({ status: 'published' }).then(setTemplates)
    return `Assessment generated and published (${result.questions_added || 0} questions).`
  })

  const scheduleCandidateInterview = () => run('interview-create', async () => {
    const interview = await recruitmentService.scheduleInterview(id, interviewForm)
    if (interview?.id && cand.email) sendInterviewEmail(interview.id).catch(() => {})
    setShowInterview(false)
    setInterviewForm({ interview_type: 'PHYSICAL', scheduled_date: '', location: '', platform: '', meeting_url: '', duration_minutes: 30, notes: '' })
    setTab('interviews')
    return cand.email ? 'Interview created. Candidate notification queued.' : 'Interview created. Candidate has no email address.'
  })

  const completeCandidateInterview = () => run(`interview-complete-${feedbackTarget?.id}`, async () => {
    if (!feedbackTarget || !feedbackForm.rating) throw new Error('A rating is required.')
    let competencyScores = {}
    try { competencyScores = feedbackForm.competency_scores ? JSON.parse(feedbackForm.competency_scores) : {} } catch { throw new Error('Competency scores must be valid JSON.') }
    await recruitmentService.completeInterview(feedbackTarget.id, { ...feedbackForm, competency_scores: competencyScores })
    setFeedbackTarget(null)
    return 'Interview outcome recorded in the recruitment timeline.'
  })

  const moveToTalentPool = () => run('talent-pool', () => recruitmentService.moveToTalentPool(id, 'Retained for future role review'))

  const blacklistCandidate = () => {
    const reason = window.prompt('Documented, job-related reason for blacklisting this candidate:')
    if (reason?.trim()) run('blacklist', () => recruitmentService.blacklistCandidate(id, reason.trim()))
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/applications" className="text-sm text-slate-500 hover:text-[#009944]">&larr; All applications</Link>
        <span className="text-slate-300">•</span>
        <h1 className="text-xl font-semibold text-slate-900">{cand.full_name}</h1>
        <StatusBadge label={cand.application_status.replace(/_/g, ' ')} color={STAT[cand.application_status] || 'slate'} />
      </div>

      {msg && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2">{msg}</div>}

      {/* header card */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
          <div className="space-y-1 text-sm">
            <p className="text-slate-500">{job?.job_title || cand.applied_role || 'Candidate'} {job?.department ? ` · ${job.department}` : ''} {job?.location ? ` · ${job.location}` : ''}</p>
            <p className="text-slate-500">{cand.email || 'No email'} {cand.phone ? ` · ${cand.phone}` : ''}</p>
            <p className="text-slate-400 text-xs">
              Applied {date(cand.created_at)} · Source: {cand.application_source || '—'} · {cand.years_experience ? `${cand.years_experience} yrs exp` : ''}
              {cand.current_company ? ` · ${cand.current_company}` : ''}
            </p>
            {bundle.cvSignedUrl && (
              <a href={bundle.cvSignedUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[#009944] font-medium mt-2">
                <Download className="w-4 h-4" /> View CV
              </a>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {cand.job_id && (
              <button onClick={() => run('ai', () => screeningService.runAI({ candidateId: id, jobId: cand.job_id }))} disabled={!!busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-700 disabled:opacity-50">
                {busy === 'ai' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />} Run AI screening
              </button>
            )}
            {cand.job_id && (
              <button onClick={() => run('cv-analysis', async () => {
                await screeningService.analyzeCV({ candidateId: id, jobId: cand.job_id })
                setTab('screening')
                return 'SARA analyzed the CV and compared it with the configured role criteria.'
              })} disabled={!!busy || !cand.cv_file_path} title={cand.cv_file_path ? 'Securely analyze this candidate’s stored CV against the role' : 'No CV is attached'} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-700 text-white text-xs font-medium hover:bg-violet-800 disabled:opacity-50">
                {busy === 'cv-analysis' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />} Analyse CV with SARA
              </button>
            )}
            {cand.job_id && <button onClick={() => setShowGenerateAssessment(true)} disabled={!!busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-violet-300 text-violet-700 text-xs font-medium hover:bg-violet-50 disabled:opacity-50"><Sparkles className="w-3.5 h-3.5" /> Generate Assessment</button>}
            <button onClick={() => setShowInterview(true)} disabled={!!busy || ['hired', 'blacklisted', 'rejected'].includes(cand.application_status)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-cyan-300 text-cyan-700 text-xs font-medium hover:bg-cyan-50 disabled:opacity-50"><CalendarPlus className="w-3.5 h-3.5" /> Invite to Interview</button>
            {cand.application_status !== 'talent_pool' && !['hired', 'blacklisted'].includes(cand.application_status) && <button onClick={moveToTalentPool} disabled={!!busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-amber-300 text-amber-700 text-xs font-medium hover:bg-amber-50 disabled:opacity-50"><UsersRound className="w-3.5 h-3.5" /> Move to Talent Pool</button>}
            {['super_admin', 'admin', 'hr_manager'].includes(actualRole) && cand.application_status !== 'blacklisted' && <button onClick={blacklistCandidate} disabled={!!busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-300 text-rose-700 text-xs font-medium hover:bg-rose-50 disabled:opacity-50"><ShieldBan className="w-3.5 h-3.5" /> Blacklist</button>}
            <button onClick={() => setTab('assessment')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs font-medium hover:bg-slate-50">
              <ClipboardList className="w-3.5 h-3.5" /> Assessments
            </button>
            <button onClick={() => setTab('offers')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-xs font-medium hover:bg-slate-50">
              <FileText className="w-3.5 h-3.5" /> Offers ({bundle.offers.length})
            </button>
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-slate-100">
          <p className="text-xs text-slate-400 mb-2">Advance pipeline</p>
          <div className="flex flex-wrap gap-1.5">
            {PIPELINE_STEPS.map((step) => (
              <button
                key={step}
                onClick={() => run(`adv-${step}`, () => recruitmentService.advanceStatus(id, step, `Moved to ${step.replace(/_/g, ' ')}`))}
                disabled={!!busy || cand.application_status === step}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${cand.application_status === step ? 'bg-[#009944] text-white border-[#009944]' : 'border-slate-200 text-slate-500 hover:border-[#009944] hover:text-[#009944] disabled:opacity-40'}`}
              >
                {step.replace(/_/g, ' ')}
              </button>
            ))}
            <button
              onClick={() => run('reject', () => recruitmentService.advanceStatus(id, 'rejected', 'Application rejected'))}
              disabled={!!busy || ['rejected', 'hired', 'offer_accepted'].includes(cand.application_status)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </div>
      </div>

      {(() => {
        const insight = bundle.screening?.[0]
        const components = insight?.components || {}
        const weights = insight?.config_snapshot?.weights || {}
        return (
          <div className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-6">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div><p className="text-xs font-semibold uppercase tracking-wide text-violet-700">SARA Candidate Insight</p><h2 className="text-lg font-semibold text-slate-900 mt-1">Job-related evidence review</h2><p className="text-xs text-slate-500 mt-1">Advisory analysis only. HR makes the final employment decision. Protected characteristics are not used.</p></div>
              <div className="text-right"><p className="text-3xl font-bold text-violet-700">{insight?.overall_score != null ? `${Number(insight.overall_score).toFixed(0)}%` : '—'}</p><p className="text-[11px] uppercase text-slate-400">configured match</p></div>
            </div>
            {!insight ? <p className="mt-4 text-sm text-slate-500">Run SARA screening to generate an explainable match from this candidate's documented profile, role requirements, assessment, and interview evidence.</p> : (
              <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 rounded-lg bg-white/80 border border-violet-100 p-4"><p className="text-xs font-semibold text-slate-500 uppercase">AI analysis</p><p className="text-sm text-slate-700 mt-2 whitespace-pre-line">{insight.summary || 'No summary recorded.'}</p>{insight.detailed_analysis?.reasoning && <p className="text-xs text-slate-500 mt-3">Reasoning: {insight.detailed_analysis.reasoning}</p>}</div>
                {insight.detailed_analysis?.cv_summary && <div className="lg:col-span-2 rounded-lg bg-white/80 border border-violet-100 p-4"><p className="text-xs font-semibold text-violet-700 uppercase">CV summary</p><p className="text-sm text-slate-700 mt-2 whitespace-pre-line">{insight.detailed_analysis.cv_summary}</p></div>}
                <div className="rounded-lg bg-white/80 border border-violet-100 p-4"><p className="text-xs font-semibold text-slate-500 uppercase mb-2">Transparent calculation</p><div className="space-y-1.5 text-xs">{Object.entries(weights).map(([key, weight]) => <div key={key} className="flex justify-between gap-2"><span className="text-slate-500">{key.replace(/_/g, ' ')}</span><span className="font-medium text-slate-700">{weight}% · {components[key] ?? components[`${key.replace('_score', '')}_match`] ?? '—'}</span></div>)}</div><p className="text-[11px] text-slate-400 mt-3">Missing evidence is shown as unavailable, not inferred.</p></div>
                <div className="rounded-lg bg-white/80 border border-emerald-100 p-4"><p className="text-xs font-semibold text-emerald-700 uppercase">Strengths</p><ul className="mt-2 space-y-1 text-sm text-slate-700">{(insight.strengths || []).map((item, index) => <li key={index}>+ {item}</li>)}</ul></div>
                <div className="rounded-lg bg-white/80 border border-amber-100 p-4"><p className="text-xs font-semibold text-amber-700 uppercase">Skill gaps / focus</p><ul className="mt-2 space-y-1 text-sm text-slate-700">{(insight.detailed_analysis?.missing_skills || insight.concerns || []).map((item, index) => <li key={index}>- {item}</li>)}</ul></div>
                {insight.detailed_analysis?.suggested_interview_focus?.length > 0 && <div className="rounded-lg bg-white/80 border border-cyan-100 p-4"><p className="text-xs font-semibold text-cyan-700 uppercase">Suggested interview focus</p><ul className="mt-2 space-y-1 text-sm text-slate-700">{insight.detailed_analysis.suggested_interview_focus.map((item, index) => <li key={index}>• {item}</li>)}</ul></div>}
                <div className="rounded-lg bg-white/80 border border-slate-200 p-4"><p className="text-xs font-semibold text-slate-500 uppercase">Recommendation</p><p className="text-sm font-medium text-slate-800 mt-2">{insight.recommended_action || 'manual_review'}</p><p className="text-xs text-slate-500 mt-1">This does not make or automate a hiring decision.</p></div>
              </div>
            )}
          </div>
        )
      })()}

      {/* tabs */}
      <div className="flex border-b border-slate-200 gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition ${tab === t.id ? 'border-[#009944] text-[#009944]' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Contact & background</h2>
              {!edit && <button onClick={() => setEdit(true)} className="inline-flex items-center gap-1 text-xs text-[#009944] font-medium"><Pencil className="w-3.5 h-3.5" /> Edit</button>}
            </div>
            {edit ? (
              <div className="space-y-4">
                <div><label className={labelCls}>Full name</label><input className={inputCls} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className={labelCls}>Email</label><input className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                   <div><label className={labelCls}>Phone</label><input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                   <div><label className={labelCls}>Location</label><input className={inputCls} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></div>
                   <div><label className={labelCls}>Current company</label><input className={inputCls} value={form.current_company} onChange={(e) => setForm({ ...form, current_company: e.target.value })} /></div>
                  <div><label className={labelCls}>Years experience</label><input type="number" className={inputCls} value={form.years_experience} onChange={(e) => setForm({ ...form, years_experience: e.target.value })} /></div>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveProfile} disabled={busy === 'save'} className="rounded-lg bg-[#009944] text-white px-4 py-2 text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">{busy === 'save' ? 'Saving…' : 'Save'}</button>
                  <button onClick={() => setEdit(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                </div>
              </div>
            ) : (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div><dt className="text-xs text-slate-400">Email</dt><dd className="text-slate-800">{cand.email || '—'}</dd></div>
                 <div><dt className="text-xs text-slate-400">Phone</dt><dd className="text-slate-800">{cand.phone || '—'}</dd></div>
                 <div><dt className="text-xs text-slate-400">Location</dt><dd className="text-slate-800">{cand.location || '—'}</dd></div>
                <div><dt className="text-xs text-slate-400">Current company</dt><dd className="text-slate-800">{cand.current_company || '—'}</dd></div>
                <div><dt className="text-xs text-slate-400">Experience</dt><dd className="text-slate-800">{cand.years_experience ? `${cand.years_experience} years` : '—'}</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs text-slate-400">Cover letter</dt><dd className="text-slate-700 whitespace-pre-line">{cand.cover_letter || '—'}</dd></div>
              </dl>
            )}
            <div className="pt-3 border-t border-slate-100">
              <p className="text-xs text-slate-400 mb-2">Skills</p>
              <div className="flex flex-wrap gap-1.5">
                {(!Array.isArray(cand.skills) || cand.skills.length === 0) && <span className="text-sm text-slate-400">—</span>}
                {(cand.skills || []).map((s, i) => <span key={i} className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-medium">{s}</span>)}
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Latest screening</h2>
              {bundle.screening.length === 0 ? (
                <p className="text-sm text-slate-400">No screening results yet.</p>
              ) : (
                <div className="space-y-3">
                  {bundle.screening.slice(0, 3).map((r) => (
                    <div key={r.id} className="text-sm border border-slate-100 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs uppercase text-slate-400">{r.mode || r.source || 'screen'}</span>
                        <span className="font-semibold">{r.overall_score != null ? `${Number(r.overall_score).toFixed(1)}%` : '—'}</span>
                      </div>
                      {r.summary && <p className="text-xs text-slate-500 mt-1">{r.summary}</p>}
                      {r.hr_decision && <p className="text-xs mt-1">{r.hr_decision}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-6">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Education</h2>
              {(cand.education?.length || 0) === 0 ? <p className="text-sm text-slate-400">—</p> : (
                <ul className="space-y-2 text-sm">
                  {cand.education.map((e, i) => <li key={i} className="text-slate-700">{e.institution ? `${e.institution} — ` : ''}{e.degree || e.course || ''}{e.year ? ` (${e.year})` : ''}</li>)}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'screening' && (
        <div className="space-y-4">
          {bundle.screening.length === 0 && <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">No screening results. Run an AI or manual screening from the header to begin.</div>}
          {bundle.screening.map((r) => (
            <div key={r.id} className="bg-white border border-slate-200 rounded-xl p-6">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-wide text-slate-400">{r.mode || r.source} · v{r.config_version || 1}</span>
                    {r.ai_generated && <span className="text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">AI</span>}
                    {r.hr_decision && <StatusBadge label={r.hr_decision} color={r.hr_decision === 'proceed' ? 'emerald' : r.hr_decision === 'reject' ? 'rose' : 'amber'} />}
                  </div>
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                    {[['Experience', r.experience_match], ['Skills', r.skills_match], ['CV', r.cv_match], ['Assessment', r.assessment_score], ['Interview', r.interview_score], ['Overall', r.overall_score]].filter(([, value]) => value != null).map(([k, v]) => (
                      <div key={k} className="rounded-lg bg-slate-50 border border-slate-100 py-2">
                        <p className="text-[11px] text-slate-400 uppercase">{k}</p>
                        <p className="text-lg font-bold text-slate-800">{v != null ? Number(v).toFixed(1) : '—'}</p>
                      </div>
                    ))}
                  </div>
                  {r.summary && <p className="mt-3 text-sm text-slate-600">{r.summary}</p>}
                  {r.detailed_analysis?.missing_skills?.length > 0 && <p className="mt-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 inline-block">Skill gaps: {r.detailed_analysis.missing_skills.join(', ')}</p>}
                  {r.evidence_scope && <p className="mt-2 text-[11px] text-slate-400">Evidence scope: {r.evidence_scope.replace(/_/g, ' ')}</p>}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => run(`dec-${r.id}`, () => screeningService.setDecision(r.id, 'proceed', 'HR approved progression'))} disabled={!!busy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 text-xs font-medium hover:bg-emerald-50 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5" /> Proceed</button>
                  <button onClick={() => run(`dec-${r.id}`, () => screeningService.setDecision(r.id, 'reject', 'HR rejected screening recommendation'))} disabled={!!busy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 text-xs font-medium hover:bg-rose-50 disabled:opacity-50"><XCircle className="w-3.5 h-3.5" /> Reject</button>
                  <button onClick={() => run(`dec-${r.id}`, () => screeningService.setDecision(r.id, 'hold', 'Requires manual review'))} disabled={!!busy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 text-xs font-medium hover:bg-amber-50 disabled:opacity-50"><ShieldAlert className="w-3.5 h-3.5" /> Hold</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'assessment' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
            <button onClick={() => setShowGenerateAssessment(true)} disabled={!!busy || !cand.job_id} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-violet-300 text-violet-700 text-sm font-medium hover:bg-violet-50 disabled:opacity-50"><Sparkles className="w-4 h-4" /> Generate Assessment</button>
            <select value={invite?.templateId || ''} onChange={(e) => setInvite({ templateId: e.target.value })} className={inputCls + ' !w-auto'}>
              <option value="">Select a published template…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <button
              onClick={() => run('invite', async () => {
                if (!invite?.templateId) throw new Error('Select a template first.')
                const res = await assessmentService.inviteCandidate({ candidateId: id, templateId: invite.templateId, jobId: cand.job_id })
                let emailStatus = 'link ready for HR to share'
                if (res?.assignment_id && res?.invitation_token && cand.email) {
                  const email = await assessmentService.sendInvitationEmail({ assignmentId: res.assignment_id, invitationToken: res.invitation_token }).catch(() => ({ status: 'not_configured' }))
                  emailStatus = email?.status === 'sent' ? 'candidate email sent' : 'link ready for HR to share'
                }
                return `Assessment invitation created; ${emailStatus}${res.url ? ` — ${res.url}` : ''}.`
              })}
              disabled={!!busy || !invite?.templateId}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
            >
              {busy === 'invite' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Send Assessment
            </button>
          </div>

          {bundle.assignments.length === 0 && <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">No assessment assignments yet.</div>}
          {bundle.assignments.map((a) => {
            const attempts = bundle.attemptsByAssignment[a.id] || []
            return (
              <div key={a.id} className="bg-white border border-slate-200 rounded-xl p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">{a.test_name}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Created {date(a.created_at)} · passes {a.retake_limit ?? 0} retake · template v{a.pass_score != null ? ` pass ${a.pass_score}%` : ''}
                      {a.expires_at ? ` · expires ${date(a.expires_at)}` : ''}
                    </p>
                  </div>
                  <StatusBadge label={a.status} color={a.status === 'completed' ? 'emerald' : a.status === 'flagged' ? 'rose' : a.status === 'in_progress' ? 'blue' : 'slate'} />
                </div>
                {attempts.length === 0 && <p className="mt-3 text-sm text-slate-400">No attempt started yet.</p>}
                <div className="mt-3 space-y-2">
                  {attempts.map((at) => (
                    <div key={at.id} className="rounded-lg border border-slate-100 bg-slate-50/50 p-3 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="font-medium text-slate-700">Attempt {at.attempt_number}</span>
                      <span className="text-slate-500">{at.status}{at.review_status ? ` · ${at.review_status}` : ''}</span>
                      {at.percentage != null && <span className={at.passed ? 'text-emerald-600 font-medium' : 'text-rose-600 font-medium'}>{at.percentage}%</span>}
                      {at.flagged && <span className="text-xs px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">flagged ({at.flags_count})</span>}
                      <div className="flex gap-1.5 ml-auto">
                        <button onClick={() => setActiveAttempt({ ...at, template: a, questions: bundle.questionsByTemplate[a.template_id] || [] })} className="px-2.5 py-1 rounded-md border border-slate-300 text-xs hover:bg-slate-100">Review</button>
                        <button onClick={() => run(`analyze-${at.id}`, () => assessmentService.analyzeAttempt(at.id))} disabled={!!busy} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-900 text-slate-700 text-xs hover:bg-slate-900 hover:text-white disabled:opacity-50"><Bot className="w-3.5 h-3.5" /> AI analysis</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'interviews' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-3">
            <div><h2 className="text-sm font-semibold text-slate-900">Interview workflow</h2><p className="text-xs text-slate-500 mt-1">Invite, record competency evidence, and preserve every outcome.</p></div>
            <button onClick={() => setShowInterview(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]"><CalendarPlus className="w-4 h-4" /> Invite to Interview</button>
          </div>
          {bundle.interviews.length === 0 && <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">No interview events yet.</div>}
          {bundle.interviews.map((interview) => (
            <div key={interview.id} className="bg-white border border-slate-200 rounded-xl p-6">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-slate-900">Round {interview.interview_round || 1} · {interview.interview_type || 'Interview'}</p><p className="text-xs text-slate-400 mt-1">{date(interview.scheduled_date)} · {interview.location || interview.platform || 'Details to be confirmed'}</p></div><StatusBadge label={interview.status} color={interview.status === 'completed' ? 'emerald' : interview.status === 'cancelled' ? 'rose' : 'amber'} /></div>
              {interview.status === 'completed' ? <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm"><div><p className="text-xs text-slate-400">Rating</p><p className="font-semibold">{interview.rating || 0}/5</p></div><div><p className="text-xs text-slate-400">Recommendation</p><p className="font-semibold">{interview.recommendation || '—'}</p></div><div><p className="text-xs text-slate-400">Outcome</p><p className="font-semibold">{interview.outcome || '—'}</p></div><div className="sm:col-span-3"><p className="text-xs text-slate-400">Feedback</p><p className="whitespace-pre-line text-slate-700">{interview.feedback || '—'}</p></div><div><p className="text-xs text-slate-400">Strengths</p><p className="text-slate-700">{interview.strengths || '—'}</p></div><div><p className="text-xs text-slate-400">Concerns</p><p className="text-slate-700">{interview.concerns || '—'}</p></div></div> : <button onClick={() => { setFeedbackTarget(interview); setFeedbackForm({ rating: 0, feedback: '', strengths: '', concerns: '', recommendation: 'hold', competency_scores: '{}' }) }} className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-cyan-300 text-cyan-700 text-sm font-medium hover:bg-cyan-50">Record interview outcome</button>}
            </div>
          ))}
        </div>
      )}

      {tab === 'offers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">Create and manage offer letters for this candidate.</p>
            <Link to="/offer-letters" className="text-sm font-medium text-[#009944] hover:underline">Open Offer Letters →</Link>
          </div>
          {bundle.offers.length === 0 && <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-400">No offers yet.</div>}
          {bundle.offers.map((o) => (
            <div key={o.id} className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="font-medium text-slate-900">{o.position} {o.version > 1 && <span className="text-xs text-slate-400">v{o.version}</span>}</p>
                <p className="text-xs text-slate-400 mt-0.5">{o.offer_number} · {formatCurrency(o.monthly_salary)}/mo · {o.start_date ? `start ${date(o.start_date)}` : ''}</p>
              </div>
              <StatusBadge label={o.status} color={o.status === 'accepted' ? 'emerald' : o.status === 'declined' || o.status === 'withdrawn' ? 'rose' : 'amber'} />
            </div>
          ))}
        </div>
      )}

      {tab === 'medical' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Medical & Screening</h2>
              <p className="text-xs text-slate-500 mt-0.5">Pre-employment medical, hospital referral cards and screening results for this candidate.</p>
            </div>
            {isHR && (
              <button onClick={() => setShowMedical(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
                <Stethoscope className="w-4 h-4" /> Generate Medical Screening Card
              </button>
            )}
          </div>
          <MedicalScreeningHistory key={medicalKey} subjectType="candidate" subjectId={id} />
        </div>
      )}

      {tab === 'timeline' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="mb-6 pb-5 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Documents</h2>
              {(bundle.documents || []).length === 0 ? <p className="text-sm text-slate-400">No uploaded documents.</p> : <div className="space-y-2">{bundle.documents.map((document) => <div key={document.id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate text-slate-700">{document.file_name}</span>{document.signedUrl ? <a href={document.signedUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-[#009944] hover:underline">Preview / download</a> : <span className="text-xs text-slate-400">Unavailable</span>}</div>)}</div>}
            </div>
            <h2 className="text-sm font-semibold text-slate-900 mb-3 inline-flex items-center gap-2"><MessageSquarePlus className="w-4 h-4 text-[#009944]" /> Add note</h2>
            <textarea rows="4" value={note} onChange={(e) => setNote(e.target.value)} className={inputCls + ' !h-auto py-2'} placeholder="Interview feedback, screening notes…" />
            <button
              onClick={() => run('note', async () => { if (!note.trim()) throw new Error('Note is empty.'); const res = await recruitmentService.addNote(id, note.trim()); setNote(''); return 'Note added.' })}
              disabled={!!busy || !note.trim()}
              className="mt-3 rounded-lg bg-[#009944] text-white px-4 py-2 text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
            >
              {busy === 'note' ? 'Saving…' : 'Add note'}
            </button>
            <div className="mt-6 space-y-3 max-h-96 overflow-y-auto">
              {bundle.notes.length === 0 && <p className="text-sm text-slate-400">No notes yet.</p>}
              {bundle.notes.map((n) => (
                <div key={n.id} className="rounded-lg border border-slate-100 bg-slate-50/50 p-3 text-sm">
                  <p className="text-slate-600 whitespace-pre-line">{n.note}</p>
                  <p className="text-xs text-slate-400 mt-1.5">{n.created_by_name || 'HR'} · {date(n.created_at)}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Status history</h2>
            <ol>
              {bundle.history.length === 0 && <p className="text-sm text-slate-400">No status changes recorded.</p>}
              {bundle.history.map((h) => (
                <li key={h.id} className="relative pl-6 pb-4 last:pb-0">
                  <span className="absolute left-0 top-1.5 w-3 h-3 rounded-full border-2 border-[#009944] bg-white" />
                  <p className="text-sm text-slate-700">{h.from_status || 'Application'} → {h.to_status}</p>
                  {h.note && <p className="text-xs text-slate-500">{h.note}</p>}
                  <p className="text-xs text-slate-400">{date(h.created_at)}</p>
                </li>
              ))}
            </ol>
            <div className="mt-6 pt-4 border-t border-slate-100">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">Immutable recruitment events</h3>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {(bundle.events || []).map((event) => <div key={event.id} className="rounded-lg bg-slate-50 border border-slate-100 p-3"><p className="text-sm text-slate-700">{event.action}</p><p className="text-xs text-slate-400 mt-1">{event.actor_name || event.actor_type || 'System'} · {date(event.created_at)}</p>{event.metadata && Object.keys(event.metadata).length > 0 && <p className="text-[11px] text-slate-500 mt-1">{JSON.stringify(event.metadata)}</p>}</div>)}
                {(!bundle.events || bundle.events.length === 0) && <p className="text-sm text-slate-400">No event records yet.</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {showGenerateAssessment && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5"><div><h3 className="text-lg font-semibold text-slate-900">Generate Assessment</h3><p className="text-xs text-slate-500 mt-1">SARA creates job-relevant questions for HR review.</p></div><button onClick={() => setShowGenerateAssessment(false)} className="text-slate-400"><X className="w-5 h-5" /></button></div>
            <div className="space-y-4">
              <div><label className={labelCls}>Question type</label><select className={inputCls} value={generateOptions.category} onChange={(e) => setGenerateOptions((current) => ({ ...current, category: e.target.value }))}><option value="technical">Technical</option><option value="behavioral">Behavioral</option><option value="practical">Practical</option><option value="aptitude">Aptitude</option></select></div>
              <div className="grid grid-cols-3 gap-3"><div><label className={labelCls}>Questions</label><input type="number" min="1" max="60" className={inputCls} value={generateOptions.count} onChange={(e) => setGenerateOptions((current) => ({ ...current, count: e.target.value }))} /></div><div><label className={labelCls}>Duration</label><input type="number" min="5" className={inputCls} value={generateOptions.duration_minutes} onChange={(e) => setGenerateOptions((current) => ({ ...current, duration_minutes: e.target.value }))} /></div><div><label className={labelCls}>Pass mark %</label><input type="number" min="1" max="100" className={inputCls} value={generateOptions.pass_mark} onChange={(e) => setGenerateOptions((current) => ({ ...current, pass_mark: e.target.value }))} /></div></div>
              <p className="text-xs text-slate-400">Generated questions are published to the existing assessment template system so every invitation and attempt remains linked to this candidate, application, and job.</p>
            </div>
            <div className="flex justify-end gap-2 mt-5"><button onClick={() => setShowGenerateAssessment(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600">Cancel</button><button onClick={generateAssessment} disabled={busy === 'generate'} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-700 text-white text-sm font-medium disabled:opacity-50">{busy === 'generate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Generate</button></div>
          </div>
        </div>
      )}

      {showInterview && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5"><div><h3 className="text-lg font-semibold text-slate-900">Invite to Interview</h3><p className="text-xs text-slate-500 mt-1">Create the event and queue the existing interview email flow.</p></div><button onClick={() => setShowInterview(false)} className="text-slate-400"><X className="w-5 h-5" /></button></div>
            <div className="space-y-4">
              <div><label className={labelCls}>Interview type</label><div className="flex gap-2"><button type="button" onClick={() => setInterviewForm((current) => ({ ...current, interview_type: 'PHYSICAL' }))} className={`flex-1 rounded-lg border px-3 py-2 text-sm ${interviewForm.interview_type === 'PHYSICAL' ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600'}`}>Physical</button><button type="button" onClick={() => setInterviewForm((current) => ({ ...current, interview_type: 'VIRTUAL' }))} className={`flex-1 rounded-lg border px-3 py-2 text-sm ${interviewForm.interview_type === 'VIRTUAL' ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600'}`}>Virtual</button></div></div>
              <div className="grid grid-cols-2 gap-3"><div><label className={labelCls}>Date & time *</label><input type="datetime-local" className={inputCls} value={interviewForm.scheduled_date} onChange={(e) => setInterviewForm((current) => ({ ...current, scheduled_date: e.target.value }))} /></div><div><label className={labelCls}>Duration (min)</label><input type="number" className={inputCls} value={interviewForm.duration_minutes} onChange={(e) => setInterviewForm((current) => ({ ...current, duration_minutes: e.target.value }))} /></div></div>
              {interviewForm.interview_type === 'PHYSICAL' ? <div><label className={labelCls}>Location</label><input className={inputCls} value={interviewForm.location} onChange={(e) => setInterviewForm((current) => ({ ...current, location: e.target.value }))} placeholder="Branch or meeting room" /></div> : <><div><label className={labelCls}>Platform</label><input className={inputCls} value={interviewForm.platform} onChange={(e) => setInterviewForm((current) => ({ ...current, platform: e.target.value }))} placeholder="Google Meet, Zoom, Teams" /></div><div><label className={labelCls}>Meeting link</label><input className={inputCls} value={interviewForm.meeting_url} onChange={(e) => setInterviewForm((current) => ({ ...current, meeting_url: e.target.value }))} placeholder="https://..." /></div></>}
              <div><label className={labelCls}>Candidate instructions / notes</label><textarea rows={3} className={inputCls + ' !h-auto py-2'} value={interviewForm.notes} onChange={(e) => setInterviewForm((current) => ({ ...current, notes: e.target.value }))} /></div>
            </div>
            <div className="flex justify-end gap-2 mt-5"><button onClick={() => setShowInterview(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600">Cancel</button><button onClick={scheduleCandidateInterview} disabled={busy === 'interview-create'} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium disabled:opacity-50">{busy === 'interview-create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />} Schedule & send</button></div>
          </div>
        </div>
      )}

      {feedbackTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5"><div><h3 className="text-lg font-semibold text-slate-900">Record interview outcome</h3><p className="text-xs text-slate-500 mt-1">This feedback becomes part of the candidate record and SARA evidence.</p></div><button onClick={() => setFeedbackTarget(null)} className="text-slate-400"><X className="w-5 h-5" /></button></div>
            <div className="space-y-4"><div><label className={labelCls}>Rating</label><div className="flex gap-2">{[1, 2, 3, 4, 5].map((rating) => <button type="button" key={rating} onClick={() => setFeedbackForm((current) => ({ ...current, rating }))} className={`w-10 h-10 rounded-lg border text-lg ${feedbackForm.rating >= rating ? 'border-amber-400 bg-amber-50 text-amber-600' : 'border-slate-300 text-slate-300'}`}>★</button>)}</div></div><div><label className={labelCls}>Recommendation</label><select className={inputCls} value={feedbackForm.recommendation} onChange={(e) => setFeedbackForm((current) => ({ ...current, recommendation: e.target.value }))}><option value="proceed">Proceed</option><option value="hold">Hold</option><option value="reject">Reject</option></select></div><div><label className={labelCls}>Feedback / notes</label><textarea rows={3} className={inputCls + ' !h-auto py-2'} value={feedbackForm.feedback} onChange={(e) => setFeedbackForm((current) => ({ ...current, feedback: e.target.value }))} /></div><div className="grid grid-cols-2 gap-3"><div><label className={labelCls}>Strengths</label><textarea rows={2} className={inputCls + ' !h-auto py-2'} value={feedbackForm.strengths} onChange={(e) => setFeedbackForm((current) => ({ ...current, strengths: e.target.value }))} /></div><div><label className={labelCls}>Concerns</label><textarea rows={2} className={inputCls + ' !h-auto py-2'} value={feedbackForm.concerns} onChange={(e) => setFeedbackForm((current) => ({ ...current, concerns: e.target.value }))} /></div></div><div><label className={labelCls}>Competency scores (JSON, optional)</label><input className={inputCls} value={feedbackForm.competency_scores} onChange={(e) => setFeedbackForm((current) => ({ ...current, competency_scores: e.target.value }))} placeholder='{"communication": 4, "technical": 3}' /></div></div>
            <div className="flex justify-end gap-2 mt-5"><button onClick={() => setFeedbackTarget(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600">Cancel</button><button onClick={completeCandidateInterview} disabled={busy?.startsWith('interview-complete')} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium disabled:opacity-50">Save outcome</button></div>
          </div>
        </div>
      )}

      {/* attempt review drawer */}
      {activeAttempt && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Attempt review</h3>
                <p className="text-sm text-slate-500 mt-0.5">{activeAttempt.template.test_name} — attempt {activeAttempt.attempt_number} ({activeAttempt.percentage != null ? activeAttempt.percentage + '%' : activeAttempt.status})</p>
              </div>
              <button onClick={() => setActiveAttempt(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="space-y-4">
              {activeAttempt.monitoring?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <p className="text-xs font-semibold text-amber-800 uppercase mb-2">Monitoring events</p>
                  <ul className="text-xs text-amber-900 space-y-1">
                    {activeAttempt.monitoring.map((ev, i) => (
                      <li key={ev.id || i}>#{ev.sequence_number} {ev.event_type} ({ev.severity}){ev.event_data ? ` — ${JSON.stringify(ev.event_data)}` : ''}</li>
                    ))}
                  </ul>
                </div>
              )}

              {(activeAttempt.answers || []).length === 0 && <p className="text-sm text-slate-400 text-center py-4">No answers recorded for this attempt.</p>}
              {(activeAttempt.answers || []).map((an) => {
                const q = (activeAttempt.questions || []).find((x) => x.id === an.question_id)
                return (
                  <div key={an.id} className="rounded-lg border border-slate-200 p-4">
                    <p className="text-sm font-medium text-slate-800">{q?.question_text || an.question_id}</p>
                    <p className="text-xs text-slate-400 mt-1">Candidate answer: <span className="text-slate-600">{typeof an.answer === 'object' ? JSON.stringify(an.answer) : String(an.answer ?? '—')}</span></p>
                    {q?.correct_answer != null && q.correct_answer !== '' && <p className="text-xs text-slate-400 mt-0.5">Correct: <span className="text-emerald-600">{typeof q.correct_answer === 'object' ? JSON.stringify(q.correct_answer) : String(q.correct_answer)}</span></p>}
                    <div className="flex items-center justify-between mt-2">
                      <span className={`text-xs font-medium ${an.is_correct === true ? 'text-emerald-600' : an.is_correct === false ? 'text-rose-600' : 'text-slate-400'}`}>
                        {an.is_correct === true ? 'Correct' : an.is_correct === false ? 'Incorrect' : 'Unmarked'} · {an.marks_earned ?? 0}/{q?.marks ?? '—'}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => run(`grade-${an.id}`, () => assessmentService.gradeQuestion(activeAttempt.id, an.question_id, q?.marks || 1, 'Overruled by HR'))} className="px-2 py-1 rounded-md border border-emerald-300 text-emerald-700 text-xs hover:bg-emerald-50 disabled:opacity-50" disabled={!!busy}>Give full marks</button>
                        <button onClick={() => run(`rg-${an.id}`, () => assessmentService.markAttemptReview(activeAttempt.id, 'approved', 'Reviewed by HR'))} className="px-2 py-1 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100 disabled:opacity-50" disabled={!!busy}>Approve attempt</button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    {/* medical card modal */}
      <MedicalCardModal
        open={showMedical}
        onClose={() => setShowMedical(false)}
        subjectType="candidate"
        subject={{
          id: cand.id,
          full_name: cand.full_name,
          email: cand.email || '',
          phone: cand.phone || '',
          position: job?.job_title || cand.applied_role || '',
          department: job?.department || '',
        }}
        onCreated={() => { setShowMedical(false); setMedicalKey((k) => k + 1) }}
      />
    </div>
  )
}
