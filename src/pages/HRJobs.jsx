import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { formatDate } from '../lib/utils'
import { Briefcase, Plus, Search, Loader2, Copy, ExternalLink, Send, Archive, RotateCcw, Users, MapPin, CheckCircle2, XCircle } from 'lucide-react'
import { StatusBadge } from '../lib/utils'
import { screeningService } from '../services/screeningService'
import { QRCodeCanvas } from 'qrcode.react'

const STATUS_COLOR = { draft: 'amber', published: 'emerald', closed: 'slate' }

const EMPTY_FORM = {
  job_title: '',
  department: '',
  designation: '',
  branch: '',
  location: '',
  employment_type: 'full_time',
  openings: 1,
  experience_years: 0,
  salary_min: '',
  salary_max: '',
  salary_currency: 'NGN',
  description: '',
  responsibilities: '',
  requirements: '',
  qualifications: '',
  benefits: '',
  application_deadline: '',
  assessment_required: false,
  interview_required: true,
  ai_screening_enabled: true,
  screening_min_score: 60,
  required_skills: '',
  preferred_skills: '',
  required_qualifications: '',
  required_certifications: '',
  criteria_notes: '',
  weight_cv: 30,
  weight_skills: 25,
  weight_assessment: 25,
  weight_interview: 20,
}

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 h-10 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-white'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

/**
 * HR Jobs — full job-advert lifecycle.
 * Create (draft) → publish (issues a public_token + application URL)
 * → close/unpublish → reopen. Publishing is enforced to be safe: the
 * public_token is always generated server-side first.
 */
export default function HRJobs() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [formData, setFormData] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const [qrJob, setQrJob] = useState(null)

  const load = async () => {
    try {
      const { data } = await supabase
        .from('hr_jobs')
        .select('*')
        .order('created_at', { ascending: false })
      setJobs(data || [])
    } catch (e) {
      console.error('Failed to load jobs:', e)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const run = async (jobId, patch) => {
    setBusyId(jobId)
    const { error } = await supabase.from('hr_jobs').update(patch).eq('id', jobId)
    setBusyId('')
    if (error) throw error
    await load()
  }

  const ensureToken = async (job) => {
    if (job.public_token) return job.public_token
    const { data, error } = await supabase.rpc('generate_secure_token')
    if (error) throw error
    return data
  }

  const publish = async (job) => {
    try {
      const token = await ensureToken(job)
      setFormError('')
      await run(job.id, { status: 'published', public_token: token, published_at: new Date().toISOString(), closed_at: null })
      setFormSuccess(`"${job.job_title}" published with a public application URL.`)
      setTimeout(() => setFormSuccess(''), 4000)
    } catch (e) {
      setFormError(e?.message || 'Failed to publish job.')
    }
  }

  const closeJob = async (job) => {
    try {
      setFormError('')
      await run(job.id, { status: 'closed', closed_at: new Date().toISOString() })
      setFormSuccess(`"${job.job_title}" closed.`)
      setTimeout(() => setFormSuccess(''), 4000)
    } catch (e) {
      setFormError(e?.message || 'Failed to close job.')
    }
  }

  const reopen = async (job) => {
    try {
      const token = await ensureToken(job)
      setFormError('')
      await run(job.id, { status: 'published', public_token: token, published_at: new Date().toISOString(), closed_at: null })
      setFormSuccess(`"${job.job_title}" reopened for applications.`)
      setTimeout(() => setFormSuccess(''), 4000)
    } catch (e) {
      setFormError(e?.message || 'Failed to reopen job.')
    }
  }

  const unpublish = async (job) => {
    try {
      setFormError('')
      await run(job.id, { status: 'draft' })
      setFormSuccess(`"${job.job_title}" saved as draft.`)
      setTimeout(() => setFormSuccess(''), 4000)
    } catch (e) {
      setFormError(e?.message || 'Failed to unpublish job.')
    }
  }

  const jobUrl = (job) => (job.public_token
    ? `${window.location.origin}${window.location.pathname}#/careers/jobs/${job.public_token}`
    : null)

  const copyUrl = async (job) => {
    const url = jobUrl(job)
    if (!url) return
    await navigator.clipboard.writeText(url)
    setCopiedId(job.id)
    setTimeout(() => setCopiedId(''), 1500)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setFormError('')
    if (!formData.job_title?.trim()) { setFormError('Job title is required.'); return }
    if (!formData.department?.trim()) { setFormError('Department is required.'); return }
    if (!formData.description?.trim()) { setFormError('Job description is required.'); return }
    if (!formData.employment_type) { setFormError('Employment type is required.'); return }

    const expYears = formData.experience_years ? parseInt(formData.experience_years) : null
    if (expYears !== null && isNaN(expYears)) { setFormError('Experience years must be a valid number.'); return }
    const salaryMin = formData.salary_min ? parseFloat(formData.salary_min) : null
    const salaryMax = formData.salary_max ? parseFloat(formData.salary_max) : null
    if (salaryMin !== null && isNaN(salaryMin)) { setFormError('Minimum salary must be a valid number.'); return }
    if (salaryMax !== null && isNaN(salaryMax)) { setFormError('Maximum salary must be a valid number.'); return }
    if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) { setFormError('Minimum salary cannot exceed maximum salary.'); return }
    const weightTotal = Number(formData.weight_cv || 0) + Number(formData.weight_skills || 0) + Number(formData.weight_assessment || 0) + Number(formData.weight_interview || 0)
    if (weightTotal !== 100) { setFormError(`SARA match criteria weights must total 100 (currently ${weightTotal}).`); return }

    setSubmitting(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setFormError('Authentication required. Please sign in again.'); return }

      const { data, error } = await supabase
        .from('hr_jobs')
        .insert([{
          job_title: formData.job_title.trim(),
          department: formData.department.trim(),
          designation: formData.designation?.trim() || null,
          branch: formData.branch?.trim() || null,
          location: formData.location?.trim() || null,
          employment_type: formData.employment_type,
          openings: Math.max(1, parseInt(formData.openings || 1)),
          experience_years: expYears,
          salary_min: salaryMin,
          salary_max: salaryMax,
          salary_currency: formData.salary_currency || 'NGN',
          description: formData.description.trim(),
          responsibilities: formData.responsibilities?.trim() || null,
          requirements: formData.requirements?.trim() || null,
          qualifications: formData.qualifications?.trim() || null,
          benefits: formData.benefits?.trim() || null,
          application_deadline: formData.application_deadline || null,
          assessment_required: !!formData.assessment_required,
          interview_required: formData.interview_required !== false,
          ai_screening_enabled: formData.ai_screening_enabled !== false,
          screening_min_score: Number(formData.screening_min_score || 60),
           required_skills: (formData.required_skills || '').split(',').map((s) => s.trim()).filter(Boolean),
           preferred_skills: (formData.preferred_skills || '').split(',').map((s) => s.trim()).filter(Boolean),
           recruitment_criteria: {
             weights: {
               cv_relevance: Number(formData.weight_cv || 0),
               technical_skills: Number(formData.weight_skills || 0),
               assessment_score: Number(formData.weight_assessment || 0),
               interview_score: Number(formData.weight_interview || 0),
             },
             required_qualifications: (formData.required_qualifications || '').split(',').map((s) => s.trim()).filter(Boolean),
             required_certifications: (formData.required_certifications || '').split(',').map((s) => s.trim()).filter(Boolean),
             experience_threshold: expYears || 0,
             criteria_notes: formData.criteria_notes || null,
           },
           created_by: user.id,
          status: 'draft',
        }])
        .select()

      if (error) throw error
      let criteriaWarning = ''
      try {
        await screeningService.saveConfig(data?.[0]?.id, {
          weights: {
            cv_relevance: Number(formData.weight_cv || 0),
            technical_skills: Number(formData.weight_skills || 0),
            assessment_score: Number(formData.weight_assessment || 0),
            interview_score: Number(formData.weight_interview || 0),
          },
          min_overall: Number(formData.screening_min_score || 60),
          required_qualifications: (formData.required_qualifications || '').split(',').map((s) => s.trim()).filter(Boolean),
          required_certifications: (formData.required_certifications || '').split(',').map((s) => s.trim()).filter(Boolean),
          required_skills: (formData.required_skills || '').split(',').map((s) => s.trim()).filter(Boolean),
          preferred_skills: (formData.preferred_skills || '').split(',').map((s) => s.trim()).filter(Boolean),
          experience_threshold: expYears || 0,
          criteria_notes: formData.criteria_notes || null,
        })
      } catch (criteriaError) {
        criteriaWarning = ` Criteria could not be saved: ${criteriaError?.message || 'check your HR permissions'}`
      }
      setFormData(EMPTY_FORM)
      setShowForm(false)
      setFormSuccess(`Job posting saved as draft. Publish it to open applications.${criteriaWarning}`)
      setTimeout(() => setFormSuccess(''), 4000)
      await load()
    } catch (err) {
      const msg = err?.message || 'Failed to create job posting. Please try again.'
      setFormError(msg.includes('policy') ? 'Not authorized to create job postings. Contact your administrator.' : msg)
    } finally {
      setSubmitting(false)
    }
  }

  const filteredJobs = jobs.filter((job) => {
    const q = searchTerm.toLowerCase()
    const matchesSearch = [job.job_title, job.department, job.designation, job.location].some((v) => String(v || '').toLowerCase().includes(q))
    const matchesStatus = filterStatus === 'all' || job.status === filterStatus
    return matchesSearch && matchesStatus
  })

  return (
    <div>
      {formSuccess && (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-700 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {formSuccess}
        </div>
      )}
      {formError && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 p-3 text-sm text-rose-700 flex items-center gap-2">
          <XCircle className="w-4 h-4" /> {formError}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Job Postings</h2>
          <p className="text-slate-500 mt-1">Create adverts, publish a public application URL, close and reopen roles.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/applications" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-slate-600 text-sm font-medium hover:bg-slate-50">
            <Users className="w-4 h-4" /> Applications
          </Link>
          <button onClick={() => { setShowForm(true); setFormError(''); setFormData(EMPTY_FORM) }} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> New Job
          </button>
        </div>
      </div>

      <div className="flex gap-3 mb-6 flex-wrap">
        <div className="flex-1 min-w-[220px] relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input type="text" placeholder="Search jobs…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${inputCls} pl-9`} />
        </div>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={`${inputCls} w-40`}>
          <option value="all">All Status</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-slate-400"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading job postings…</div>
      ) : filteredJobs.length === 0 ? (
        <div className="text-center py-12 bg-slate-50 rounded-lg border border-slate-200">
          <Briefcase className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600 text-sm">No job postings found.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {filteredJobs.map((job) => {
            const url = jobUrl(job)
            return (
              <div key={job.id} className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-sm transition">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-slate-900 truncate">{job.job_title}</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {job.department}{job.designation ? ` · ${job.designation}` : ''}{job.branch ? ` · ${job.branch}` : ''}
                    </p>
                  </div>
                  <StatusBadge label={job.status} color={STATUS_COLOR[job.status] || 'slate'} />
                </div>

                <p className="text-sm text-slate-600 mb-3 line-clamp-2">{job.description}</p>

                <div className="space-y-1.5 text-xs text-slate-500 mb-3">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span>Experience: {job.experience_years || 0}+ yrs</span>
                    <span className="capitalize">{String(job.employment_type || '').replace(/_/g, ' ')}</span>
                    <span>{job.openings || 1} opening(s)</span>
                    {job.location && <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" /> {job.location}</span>}
                  </div>
                  {job.salary_min != null && (
                    <div>{job.salary_currency || 'NGN'} {Number(job.salary_min).toLocaleString()}{job.salary_max != null ? ` – ${Number(job.salary_max).toLocaleString()}` : ''}</div>
                  )}
                  {job.application_deadline && <div>Closes {formatDate(job.application_deadline)}</div>}
                  {job.published_at && <div>Published {formatDate(job.published_at)}</div>}
                </div>

                {url && (
                  <div className="flex items-center gap-2 mb-3 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
                    <ExternalLink className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="text-[11px] text-slate-500 truncate flex-1">{url}</span>
                    <button onClick={() => copyUrl(job)} className="text-xs font-medium text-[#009944] hover:underline inline-flex items-center gap-1 shrink-0">
                      {copiedId === job.id ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copiedId === job.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                )}

                <div className="flex gap-2 pt-3 border-t border-slate-100 flex-wrap">
                  {job.status === 'draft' && (
                    <button onClick={() => publish(job)} disabled={busyId === job.id} className="flex-1 min-w-28 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-[#009944] hover:bg-[#007a36] rounded-lg disabled:opacity-60">
                      {busyId === job.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Publish
                    </button>
                  )}
                  {job.status === 'published' && (
                    <>
                      <button onClick={() => closeJob(job)} disabled={busyId === job.id} className="flex-1 min-w-28 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 border border-slate-300 hover:bg-slate-50 rounded-lg disabled:opacity-60">
                        <Archive className="w-3.5 h-3.5" /> Close
                      </button>
                      <button onClick={() => unpublish(job)} disabled={busyId === job.id} className="flex-1 min-w-28 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 border border-slate-300 hover:bg-slate-50 rounded-lg disabled:opacity-60">
                        <Briefcase className="w-3.5 h-3.5" /> Unpublish
                      </button>
                    </>
                  )}
                  {job.status === 'closed' && (
                    <button onClick={() => reopen(job)} disabled={busyId === job.id} className="flex-1 min-w-28 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-[#009944] hover:bg-[#007a36] rounded-lg disabled:opacity-60">
                      {busyId === job.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Reopen
                    </button>
                  )}
                  {url && (
                    <>
                      <button onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} className="flex-1 min-w-28 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 border border-slate-300 hover:bg-slate-50 rounded-lg">
                        <ExternalLink className="w-3.5 h-3.5" /> Open public page
                      </button>
                      <button onClick={() => setQrJob(job)} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 border border-slate-300 hover:bg-slate-50 rounded-lg">QR</button>
                    </>
                  )}
                  <Link to={`/applications`} className="flex-1 min-w-28 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 border border-slate-300 hover:bg-slate-50 rounded-lg">
                    <Users className="w-3.5 h-3.5" /> View applications
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-xl w-full max-w-3xl my-8 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 sticky top-0 bg-white rounded-t-xl">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">New Job Posting</h3>
                <p className="text-xs text-slate-500 mt-0.5">Saved as a draft. Publish to open the advert to the public.</p>
              </div>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><XCircle className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleSubmit} className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                ['job_title', 'Job title *'],
                ['department', 'Department *'],
                ['designation', 'Designation'],
                ['branch', 'Branch'],
                ['location', 'Job location'],
                ['employment_type', 'Employment type'],
              ].map(([key, label]) => (
                <div key={key} className={key === 'job_title' || key === 'department' ? 'sm:col-span-1' : ''}>
                  {key === 'employment_type' ? (
                    <>
                      <label className={labelCls}>{label}</label>
                      <select value={formData[key]} onChange={(e) => setFormData((f) => ({ ...f, [key]: e.target.value }))} className={inputCls}>
                        <option value="full_time">Full time</option>
                        <option value="part_time">Part time</option>
                        <option value="contract">Contract</option>
                        <option value="intern">Intern</option>
                      </select>
                    </>
                  ) : (
                    <>
                      <label className={labelCls}>{label}</label>
                      <input value={formData[key]} onChange={(e) => setFormData((f) => ({ ...f, [key]: e.target.value }))} className={inputCls} />
                    </>
                  )}
                </div>
              ))}

              <div>
                <label className={labelCls}>Number of openings</label>
                <input type="number" min="1" value={formData.openings} onChange={(e) => setFormData((f) => ({ ...f, openings: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Experience required (years)</label>
                <input type="number" min="0" value={formData.experience_years} onChange={(e) => setFormData((f) => ({ ...f, experience_years: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Salary min ({formData.salary_currency})</label>
                <input type="number" min="0" value={formData.salary_min} onChange={(e) => setFormData((f) => ({ ...f, salary_min: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Salary max ({formData.salary_currency})</label>
                <input type="number" min="0" value={formData.salary_max} onChange={(e) => setFormData((f) => ({ ...f, salary_max: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Currency</label>
                <input value={formData.salary_currency} onChange={(e) => setFormData((f) => ({ ...f, salary_currency: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Application deadline</label>
                <input type="date" value={formData.application_deadline} onChange={(e) => setFormData((f) => ({ ...f, application_deadline: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Minimum screening score</label>
                <input type="number" min="0" max="100" value={formData.screening_min_score} onChange={(e) => setFormData((f) => ({ ...f, screening_min_score: e.target.value }))} className={inputCls} />
              </div>

              <div className="sm:col-span-2">
                <label className={labelCls}>Job description *</label>
                <textarea rows={3} value={formData.description} onChange={(e) => setFormData((f) => ({ ...f, description: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-white" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Responsibilities</label>
                <textarea rows={3} value={formData.responsibilities} onChange={(e) => setFormData((f) => ({ ...f, responsibilities: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-white" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Requirements</label>
                <textarea rows={3} value={formData.requirements} onChange={(e) => setFormData((f) => ({ ...f, requirements: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-white" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Qualifications</label>
                <textarea rows={2} value={formData.qualifications} onChange={(e) => setFormData((f) => ({ ...f, qualifications: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-white" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Benefits</label>
                <input value={formData.benefits} onChange={(e) => setFormData((f) => ({ ...f, benefits: e.target.value }))} className={inputCls} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Required skills (comma separated)</label>
                <input value={formData.required_skills} onChange={(e) => setFormData((f) => ({ ...f, required_skills: e.target.value }))} className={inputCls} placeholder="SQL, React, Risk Analysis" />
              </div>
              <div className="sm:col-span-2">
                <label className={labelCls}>Preferred skills (comma separated)</label>
                <input value={formData.preferred_skills} onChange={(e) => setFormData((f) => ({ ...f, preferred_skills: e.target.value }))} className={inputCls} placeholder="Python, Payroll, Supabase" />
              </div>

              <div className="sm:col-span-2 rounded-xl border border-emerald-100 bg-emerald-50/50 p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">SARA match criteria</p>
                    <p className="text-xs text-slate-500 mt-0.5">Weights must total 100%. SARA uses documented, job-related evidence only and remains advisory.</p>
                  </div>
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full ${Number(formData.weight_cv || 0) + Number(formData.weight_skills || 0) + Number(formData.weight_assessment || 0) + Number(formData.weight_interview || 0) === 100 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                    {Number(formData.weight_cv || 0) + Number(formData.weight_skills || 0) + Number(formData.weight_assessment || 0) + Number(formData.weight_interview || 0)} / 100
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ['weight_cv', 'CV / evidence'],
                    ['weight_skills', 'Skills'],
                    ['weight_assessment', 'Assessment'],
                    ['weight_interview', 'Interview'],
                  ].map(([key, label]) => (
                    <div key={key}>
                      <label className={labelCls}>{label} %</label>
                      <input type="number" min="0" max="100" value={formData[key]} onChange={(e) => setFormData((f) => ({ ...f, [key]: e.target.value }))} className={inputCls} />
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <div><label className={labelCls}>Required qualifications</label><input value={formData.required_qualifications} onChange={(e) => setFormData((f) => ({ ...f, required_qualifications: e.target.value }))} className={inputCls} placeholder="Degree, diploma, licence" /></div>
                  <div><label className={labelCls}>Required certifications</label><input value={formData.required_certifications} onChange={(e) => setFormData((f) => ({ ...f, required_certifications: e.target.value }))} className={inputCls} placeholder="Relevant certifications" /></div>
                </div>
                <div className="mt-3"><label className={labelCls}>Criteria notes</label><textarea rows={2} value={formData.criteria_notes} onChange={(e) => setFormData((f) => ({ ...f, criteria_notes: e.target.value }))} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-white" placeholder="Documented job-related criteria for HR review" /></div>
              </div>

              <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  ['assessment_required', 'Assessment required'],
                  ['interview_required', 'Interview required'],
                  ['ai_screening_enabled', 'AI screening enabled'],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-slate-700 rounded-lg border border-slate-200 px-3 py-2.5 cursor-pointer">
                    <input type="checkbox" checked={!!formData[key]} onChange={(e) => setFormData((f) => ({ ...f, [key]: e.target.checked }))} className="accent-[#009944]" />
                    {label}
                  </label>
                ))}
              </div>

              {formError && <div className="sm:col-span-2 text-sm text-rose-600">{formError}</div>}

              <div className="sm:col-span-2 flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Save as Draft
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {qrJob && jobUrl(qrJob) && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setQrJob(null)}>
          <div className="bg-white rounded-xl p-6 text-center shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-slate-900">Share {qrJob.job_title}</h3>
            <p className="text-xs text-slate-500 mt-1 mb-4">Scan to open the public application page</p>
            <div className="inline-flex p-3 bg-white border border-slate-200 rounded-lg"><QRCodeCanvas value={jobUrl(qrJob)} size={220} includeMargin /></div>
            <div className="flex gap-2 justify-center mt-4">
              <button onClick={() => copyUrl(qrJob)} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium">Copy link</button>
              <button onClick={() => setQrJob(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
