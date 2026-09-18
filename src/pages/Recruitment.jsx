import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarPlus, CheckCircle2, ClipboardList, Copy, FileText, Link2, Loader2, Plus, Stethoscope, Upload, Video, MapPin, X } from 'lucide-react'
import HRJobs from './HRJobs'
import { date, ModuleTable, status, useTable } from './hrShared'
import { ErrorState } from '../components/PageStates'
import { hrService } from '../services/hrService'
import { recruitmentService, validateResume } from '../services/recruitmentService'
import { onboardingService, DEFAULT_EXPIRY_DAYS } from '../services/onboardingService'
import { sendInterviewEmail } from '../services/interviewService'
import { useAuth } from '../hooks/useAuth'
import MedicalCardModal from '../components/medical/MedicalCardModal'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const PLATFORMS = ['Google Meet', 'Zoom', 'Microsoft Teams', 'Other']

const PIPELINE = ['received', 'screening', 'shortlisted', 'assessment', 'assessment_passed', 'interview', 'offer', 'hired']
const EMPTY_CANDIDATE_FORM = { full_name: '', email: '', phone: '', location: '', current_company: '', years_experience: '', applied_role: '', cover_letter: '', job_id: '' }
const APPLICANT_TABS = [
  ['all', 'All'], ['best_match', 'Best match'], ['talent_pool', 'Talent pool'], ['interview', 'Interview'],
  ['offer', 'Offer'], ['hired', 'Employed'], ['blacklisted', 'Blacklisted'], ['rejected', 'Rejected'],
  ['assessment_pending', 'Assessment pending'], ['assessment_completed', 'Assessment completed'],
]

function PipelineStepper({ current }) {
  const idx = PIPELINE.indexOf(current)
  if (idx < 0) return null
  return (
    <div className="flex items-center gap-0.5">
      {PIPELINE.map((stage, i) => (
        <React.Fragment key={stage}>
          {i > 0 && <span className={`w-1 h-1 rounded-full flex-shrink-0 ${i <= idx ? 'bg-[#009944]' : 'bg-slate-300'}`} />}
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${i === idx ? 'bg-[#009944] text-white' : i < idx ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-400'}`}>
            {stage}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  }
}

export default function Recruitment() {
  const { user } = useAuth()
  const candidates = useTable('hr_candidates')
  const [jobs, setJobs] = useState([])
  const [dashboard, setDashboard] = useState(null)
  const [activeTab, setActiveTab] = useState('all')
  const [jobFilter, setJobFilter] = useState('')
  const [sortBy, setSortBy] = useState('newest')
  const [scheduleTarget, setScheduleTarget] = useState(null)
  const [form, setForm] = useState({ interview_type: 'PHYSICAL' })
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')
  const [onboardTarget, setOnboardTarget] = useState(null)
  const [generatedLink, setGeneratedLink] = useState(null)
  const [onboardBusy, setOnboardBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showAddCandidate, setShowAddCandidate] = useState(false)
  const [medicalTarget, setMedicalTarget] = useState(null)
  const [addCandidateForm, setAddCandidateForm] = useState(EMPTY_CANDIDATE_FORM)
  const [addCandidateLoading, setAddCandidateLoading] = useState(false)
  const [candidateCV, setCandidateCV] = useState(null)
  const [cvProgress, setCVProgress] = useState(0)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const setAdd = (k) => (e) => setAddCandidateForm((f) => ({ ...f, [k]: e.target.value }))

  useEffect(() => {
    hrService.listJobs().then(setJobs).catch(() => {})
    recruitmentService.getDashboardStats().then(setDashboard).catch(() => setDashboard(null))
  }, [])

  const addCandidate = async () => {
    if (!addCandidateForm.full_name.trim()) { setFormError('Candidate name is required.'); return }
    setFormError('')
    setAddCandidateLoading(true)
    try {
      const candidate = await recruitmentService.addManualCandidate({
        full_name: addCandidateForm.full_name.trim(),
        email: addCandidateForm.email || null,
        phone: addCandidateForm.phone || null,
        location: addCandidateForm.location || null,
        current_company: addCandidateForm.current_company || null,
        years_experience: addCandidateForm.years_experience ? parseInt(addCandidateForm.years_experience) : null,
        cover_letter: addCandidateForm.cover_letter || null,
        job_id: addCandidateForm.job_id || null,
      })
      if (candidateCV) {
        setCVProgress(0)
        await recruitmentService.uploadCandidateCV(candidateCV, candidate.id, setCVProgress)
      }
      setShowAddCandidate(false)
      setAddCandidateForm(EMPTY_CANDIDATE_FORM)
      setCandidateCV(null)
      setCVProgress(0)
      candidates.reload()
      recruitmentService.getDashboardStats().then(setDashboard).catch(() => {})
    } catch (e) {
      setFormError(e?.message || 'Failed to add candidate')
    } finally {
      setAddCandidateLoading(false)
    }
  }

  const selectCandidateCV = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const validationError = validateResume(file)
    if (validationError) { setFormError(validationError); event.target.value = ''; return }
    setFormError('')
    setCandidateCV(file)
  }

  const visibleCandidates = candidates.rows
    .filter((candidate) => !jobFilter || candidate.job_id === jobFilter)
    .filter((candidate) => {
      if (activeTab === 'all') return true
      if (activeTab === 'best_match') return Number(candidate.match_score ?? candidate.screening_score ?? 0) >= 70
      if (activeTab === 'talent_pool') return candidate.application_status === 'talent_pool'
      if (activeTab === 'interview') return ['interview', 'interviewed', 'recommended'].includes(candidate.application_status)
      if (activeTab === 'offer') return ['offer', 'offer_accepted', 'offer_declined'].includes(candidate.application_status)
      if (activeTab === 'hired') return candidate.application_status === 'hired'
      if (activeTab === 'assessment_pending') return candidate.application_status === 'assessment'
      if (activeTab === 'assessment_completed') return ['assessment_passed', 'interview', 'interviewed', 'recommended', 'offer', 'hired'].includes(candidate.application_status)
      return candidate.application_status === activeTab
    })
    .sort((a, b) => {
      if (sortBy === 'match') return Number(b.match_score ?? b.screening_score ?? -1) - Number(a.match_score ?? a.screening_score ?? -1)
      if (sortBy === 'experience') return Number(b.years_experience || 0) - Number(a.years_experience || 0)
      if (sortBy === 'oldest') return new Date(a.created_at) - new Date(b.created_at)
      return new Date(b.created_at) - new Date(a.created_at)
    })

  const openScheduler = (candidate) => {
    setScheduleTarget(candidate)
    setForm({ interview_type: 'PHYSICAL', position: candidate.applied_role || '' })
    setFormError('')
  }

  const schedule = async () => {
    if (!scheduleTarget) return
    if (!form.scheduled_date) { setFormError('Please select a date and time.'); return }
    setFormError('')
    setCreating(true)
    try {
      const interview = await recruitmentService.scheduleInterview(scheduleTarget.id, {
        position: form.position || scheduleTarget.applied_role || '',
        interview_type: form.interview_type || 'PHYSICAL',
        location: form.interview_type === 'PHYSICAL' ? form.location : null,
        platform: form.interview_type === 'VIRTUAL' ? form.platform : null,
        meeting_url: form.interview_type === 'VIRTUAL' ? form.meeting_url : null,
        scheduled_date: form.scheduled_date,
        interviewer_id: user?.id,
      })
      if (interview?.id && scheduleTarget.email) sendInterviewEmail(interview.id).catch(() => {})
      setScheduleTarget(null)
      setForm({ interview_type: 'PHYSICAL' })
      candidates.reload()
    } catch (e) {
      setFormError(e?.message || 'Failed to schedule interview')
    } finally {
      setCreating(false)
    }
  }

  const createOnboardingLink = async (candidate) => {
    setOnboardBusy(true)
    setFormError('')
    try {
      const link = await onboardingService.createLink({
        candidateName: candidate.full_name,
        candidateEmail: candidate.email || '',
        candidatePhone: candidate.phone || '',
        position: candidate.applied_role || '',
        department: candidate.department || '',
        branch: '',
        employmentType: 'full_time',
        expiresInDays: DEFAULT_EXPIRY_DAYS,
        createdBy: user?.id,
      })
      setGeneratedLink(link)
    } catch (e) {
      setFormError(e?.message || 'Failed to create onboarding link')
    } finally {
      setOnboardBusy(false)
    }
  }

  const copyGeneratedLink = async () => {
    if (!generatedLink?.url) return
    await copyText(generatedLink.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-8">
      <HRJobs />
      {dashboard && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {[
            ['Open jobs', dashboard.open_jobs], ['Applications', dashboard.applications], ['New today', dashboard.new_applicants],
            ['Assessment pending', dashboard.assessment_pending], ['Interviews pending', dashboard.interview_pending], ['Offers pending', dashboard.offers_pending],
            ['Hired', dashboard.hired], ['Talent pool', dashboard.talent_pool], ['Rejected', dashboard.rejected], ['Blacklisted', dashboard.blacklisted],
          ].map(([label, value]) => <div key={label} className="bg-white border border-slate-200 rounded-xl p-4"><p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p><p className="text-2xl font-semibold text-slate-900 mt-1">{value ?? 0}</p></div>)}
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold text-slate-900">Applicants</h2><p className="text-sm text-slate-500">Evidence-based recruitment pipeline. Every stage change remains auditable.</p></div>
        <div className="flex items-center gap-2">
          <Link to="/applications" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-slate-600 text-sm font-medium hover:bg-slate-50">
            <ClipboardList className="w-4 h-4" /> Application Management
          </Link>
          <button onClick={() => { setShowAddCandidate(true); setFormError(''); setCandidateCV(null); setCVProgress(0); setAddCandidateForm(EMPTY_CANDIDATE_FORM) }} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> Add Candidate
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2">
        {APPLICANT_TABS.map(([key, label]) => <button key={key} onClick={() => setActiveTab(key)} className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${activeTab === key ? 'bg-[#009944] text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{label}{key !== 'all' && <span className="ml-1 opacity-70">{key === 'best_match' ? candidates.rows.filter((c) => Number(c.match_score ?? c.screening_score ?? 0) >= 70).length : key === 'talent_pool' ? candidates.rows.filter((c) => c.application_status === 'talent_pool').length : ''}</span>}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} className="h-9 rounded-lg border border-slate-300 px-3 text-xs bg-white"><option value="">All jobs</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.job_title}</option>)}</select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="h-9 rounded-lg border border-slate-300 px-3 text-xs bg-white"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="match">Match score</option><option value="experience">Experience</option></select>
        <span className="text-xs text-slate-400 ml-auto">{visibleCandidates.length} candidate{visibleCandidates.length === 1 ? '' : 's'}</span>
      </div>
      <ModuleTable
        title=""
        subtitle="Candidate profiles and recruitment pipeline"
        rows={visibleCandidates}
        loading={candidates.loading}
        error={candidates.error}
        searchKeys={['full_name', 'email', 'current_company', 'application_status']}
        columns={[
          { key: 'full_name', label: 'Candidate', render: (r) => <div><div className="font-medium text-slate-900"><Link to={`/candidate/${r.id}`} className="hover:text-[#009944]">{r.full_name}</Link></div><div className="text-xs text-slate-400">{r.email || r.phone || '-'}</div></div> },
          { key: 'current_company', label: 'Current Company' },
          { key: 'years_experience', label: 'Experience', render: (r) => `${r.years_experience || 0} yrs` },
          { key: 'application_status', label: 'Pipeline', render: (r) => ['talent_pool', 'blacklisted', 'rejected'].includes(r.application_status) ? status(r.application_status) : <PipelineStepper current={r.application_status} /> },
          { key: 'screening_score', label: 'Match', render: (r) => <span className="font-medium">{r.match_score ?? r.screening_score ?? '—'}{(r.match_score ?? r.screening_score) != null ? '%' : ''}</span> },
          { key: 'assessment_score', label: 'Assessment', render: (r) => r.assessment_score != null ? `${r.assessment_score}%` : '—' },
          { key: 'created_at', label: 'Applied', render: (r) => date(r.created_at) },
          { key: 'actions', label: 'Actions', render: (r) => (
            <div className="flex justify-end gap-1.5">
              {(r.application_status === 'offer' || r.application_status === 'hired') && (
                <button onClick={() => setMedicalTarget(r)} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
                  <Stethoscope className="w-3.5 h-3.5" /> Medical
                </button>
              )}
              {r.application_status === 'hired' && (
                <button onClick={() => { setOnboardTarget(r); setGeneratedLink(null); setFormError(''); createOnboardingLink(r) }} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-emerald-300 text-emerald-600 text-xs hover:bg-emerald-50">
                  <Link2 className="w-3.5 h-3.5" /> Onboard
                </button>
              )}
              <button onClick={() => openScheduler(r)} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
                <CalendarPlus className="w-3.5 h-3.5" /> Schedule Interview
              </button>
            </div>
          ) },
        ]}
      />

      {scheduleTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Schedule Interview</h3>
                <p className="text-sm text-slate-500 mt-0.5">{scheduleTarget.full_name} — {scheduleTarget.email || 'No email'}</p>
              </div>
              <button onClick={() => setScheduleTarget(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            {formError && <p className="text-sm text-rose-600 mb-3">{formError}</p>}
            <div className="space-y-4">
              <div><label className={labelCls}>Position</label><input className={inputCls} value={form.position || ''} onChange={set('position')} placeholder="Interview position" /></div>
              <div>
                <label className={labelCls}>Interview Type</label>
                <div className="flex gap-2">
                  {['PHYSICAL', 'VIRTUAL'].map((t) => (
                    <button key={t} type="button" onClick={() => setForm((f) => ({ ...f, interview_type: t }))}
                      className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium ${form.interview_type === t ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600'}`}>
                      {t === 'VIRTUAL' ? <Video className="w-4 h-4 inline mr-1" /> : <MapPin className="w-4 h-4 inline mr-1" />}
                      {t.charAt(0) + t.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>
              {form.interview_type === 'PHYSICAL' && (
                <div><label className={labelCls}>Location</label><input className={inputCls} value={form.location || ''} onChange={set('location')} placeholder="Office address or meeting room" /></div>
              )}
              {form.interview_type === 'VIRTUAL' && (
                <>
                  <div>
                    <label className={labelCls}>Platform</label>
                    <select className={inputCls} value={form.platform || ''} onChange={set('platform')}>
                      <option value="">Select platform…</option>
                      {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Meeting URL</label>
                    <input className={inputCls} value={form.meeting_url || ''} onChange={set('meeting_url')} placeholder="Paste meeting link manually" />
                    <p className="text-xs text-slate-400 mt-1">No video provider integration configured. Enter the meeting URL manually.</p>
                  </div>
                </>
              )}
              <div><label className={labelCls}>Date & Time *</label><input type="datetime-local" className={inputCls} value={form.scheduled_date || ''} onChange={set('scheduled_date')} /></div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setScheduleTarget(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={schedule} disabled={creating} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />} Schedule
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Onboard (generate onboarding link for hired candidate) ---- */}
      {onboardTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{generatedLink ? 'Onboarding link generated' : 'Onboard Candidate'}</h3>
                <p className="text-sm text-slate-500 mt-0.5">{onboardTarget.full_name} — {onboardTarget.email || 'No email'}</p>
              </div>
              <button onClick={() => setOnboardTarget(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            {formError && <div className="mb-4"><ErrorState message={formError} /></div>}

            {generatedLink ? (
              <div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 mb-4 flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>Onboarding link created. Copy this link and send it to the candidate — it expires {date(generatedLink.expiry)} and then appears in Onboarding Links for review.</span>
                </div>
                <div className="flex items-center gap-2">
                  <input readOnly value={generatedLink.url} className={inputCls} />
                  <button onClick={copyGeneratedLink} className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] whitespace-nowrap">
                    <Copy className="w-4 h-4" /> {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div className="flex justify-end mt-4">
                  <button onClick={() => setOnboardTarget(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Done</button>
                </div>
              </div>
            ) : (
              <div className="py-2">
                {onboardBusy ? (
                  <div className="flex items-center justify-center py-8 text-slate-500 text-sm">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Creating onboarding link…
                  </div>
                ) : (
                  <button onClick={() => createOnboardingLink(onboardTarget)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
                    <Link2 className="w-4 h-4" /> Generate Onboarding Link
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- Add Candidate Modal ---- */}
      {showAddCandidate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Add Candidate</h3>
                <p className="text-sm text-slate-500 mt-0.5">Enter candidate details to add them to the recruitment pipeline</p>
              </div>
              <button onClick={() => setShowAddCandidate(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            {formError && <p className="text-sm text-rose-600 mb-3">{formError}</p>}
            <div className="space-y-4">
              <div><label className={labelCls}>Full Name *</label><input className={inputCls} value={addCandidateForm.full_name} onChange={setAdd('full_name')} placeholder="John Doe" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Email</label><input type="email" className={inputCls} value={addCandidateForm.email} onChange={setAdd('email')} placeholder="john@example.com" /></div>
                <div><label className={labelCls}>Phone</label><input className={inputCls} value={addCandidateForm.phone} onChange={setAdd('phone')} placeholder="+234 800 000 0000" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Current Company</label><input className={inputCls} value={addCandidateForm.current_company} onChange={setAdd('current_company')} placeholder="Acme Corp" /></div>
                <div><label className={labelCls}>Years of Experience</label><input type="number" className={inputCls} value={addCandidateForm.years_experience} onChange={setAdd('years_experience')} placeholder="3" min="0" /></div>
              </div>
              <div><label className={labelCls}>Location</label><input className={inputCls} value={addCandidateForm.location} onChange={setAdd('location')} placeholder="City or region" /></div>
              <div>
                <label className={labelCls}>Apply for Role</label>
                <select className={inputCls} value={addCandidateForm.job_id} onChange={(e) => {
                  const job = jobs.find((j) => j.id === e.target.value)
                  setAddCandidateForm((f) => ({ ...f, job_id: e.target.value, applied_role: job?.job_title || f.applied_role }))
                }}>
                  <option value="">Select a job (optional)</option>
                  {jobs.filter((j) => j.status === 'published').map((j) => <option key={j.id} value={j.id}>{j.job_title} — {j.department || j.location || ''}</option>)}
                </select>
              </div>
              {!addCandidateForm.job_id && <div><label className={labelCls}>Applied Role</label><input className={inputCls} value={addCandidateForm.applied_role} onChange={setAdd('applied_role')} placeholder="Software Engineer" /></div>}
              <div><label className={labelCls}>Cover Letter / Notes</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={addCandidateForm.cover_letter} onChange={setAdd('cover_letter')} placeholder="Brief cover letter or HR notes..." /></div>
              <div>
                <label className={labelCls}>CV / Resume</label>
                <label className="flex items-center justify-center gap-2 min-h-20 rounded-lg border-2 border-dashed border-slate-300 hover:border-[#009944] cursor-pointer text-slate-500 text-sm px-3 text-center">
                  {candidateCV ? <span className="flex flex-wrap items-center justify-center gap-2 text-[#009944] font-medium"><FileText className="w-4 h-4" /> {candidateCV.name}<span className="text-xs text-slate-400">({Math.round(candidateCV.size / 1024)} KB)</span><button type="button" onClick={(event) => { event.preventDefault(); setCandidateCV(null) }} className="text-xs text-rose-600 hover:underline">Remove</button></span> : <span className="inline-flex items-center gap-2"><Upload className="w-4 h-4" /> Upload PDF or Word (max 10 MB)</span>}
                  <input type="file" accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={selectCandidateCV} />
                </label>
                {addCandidateLoading && candidateCV && <div className="mt-2"><div className="h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-[#009944] transition-all" style={{ width: `${cvProgress}%` }} /></div><p className="text-[11px] text-slate-400 mt-1">Uploading CV… {cvProgress}%</p></div>}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setShowAddCandidate(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={addCandidate} disabled={addCandidateLoading} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {addCandidateLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add Candidate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Medical Screening Card Modal ---- */}
      <MedicalCardModal
        open={!!medicalTarget}
        onClose={() => setMedicalTarget(null)}
        subjectType="candidate"
        subject={medicalTarget ? {
          id: medicalTarget.id,
          full_name: medicalTarget.full_name,
          email: medicalTarget.email || '',
          phone: medicalTarget.phone || '',
          position: medicalTarget.applied_role || '',
          department: medicalTarget.department || '',
        } : {}}
        onCreated={() => candidates.reload()}
      />
    </div>
  )
}
