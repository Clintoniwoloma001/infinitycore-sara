import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Building2, CheckCircle2, FileText, IndianRupee, Loader2, MapPin, Upload } from 'lucide-react'
import CareersShell from './CareersShell'
import { careerService } from '../../services/careerService'
import { ErrorState, LoadingState } from '../../components/PageStates'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const textareaCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

function fmtMoney(currency, value) {
  if (value == null) return null
  return `${currency || 'NGN'} ${Number(value).toLocaleString()}`
}

export default function CareerJobDetail() {
  const { token } = useParams()
  const [job, setJob] = useState(null)
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [errorMsg, setErrorMsg] = useState('')
  const [showApply, setShowApply] = useState(false)
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', location: '', current_company: '', years_experience: '', skills: '', cover_letter: '' })
  const [cv, setCv] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [formError, setFormError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      setStatus('loading')
      try {
        const data = await careerService.getJobByToken(token)
        if (!data) {
          if (active) { setStatus('error'); setErrorMsg('This job is no longer open for applications, or the link is invalid.') }
          return
        }
        if (active) { setJob(data); setStatus('ready') }
      } catch (e) {
        if (active) { setStatus('error'); setErrorMsg(e?.message || 'Unable to load this role.') }
      }
    }
    load()
    return () => { active = false }
  }, [token])

  const handleFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { setFormError('CV must be under 8MB.'); e.target.value = ''; return }
    if (!/\.(pdf|doc|docx)$/i.test(file.name)) { setFormError('CV must be a PDF or Word document.'); e.target.value = ''; return }
    setFormError('')
    setCv(file)
  }

  const removeCV = () => setCv(null)

  const submit = async () => {
    setFormError('')
    if (!form.full_name.trim()) return setFormError('Full name is required.')
    if (!form.email.trim() && !form.phone.trim()) return setFormError('An email address or phone number is required.')
    const formConfig = job.application_form_config || {}
    if (formConfig.cv_required && !cv) return setFormError('Please upload your CV or resume.')
    setSubmitting(true)
    setUploadProgress(0)
    try {
      let cvPath = null
      let cvMeta = null
      if (cv) {
        const up = await careerService.uploadCV(cv, 'anon', setUploadProgress)
        cvPath = up.path
        cvMeta = { name: cv.name, size: cv.size, mime: up.mime }
      }
      const application = {
        full_name: form.full_name.trim(),
        email: (form.email || '').trim().toLowerCase(),
        phone: (form.phone || '').trim() || null,
        location: (form.location || '').trim() || null,
        current_company: (form.current_company || '').trim() || null,
        years_experience: Number(form.years_experience || 0),
        skills: (form.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
        cover_letter: (form.cover_letter || '').trim(),
        branch: job.branch || null,
      }
      const res = await careerService.apply(token, application, { path: cvPath, name: cvMeta?.name, size: cvMeta?.size, mime: cvMeta?.mime })
      setResult(res)
    } catch (e) {
      setFormError(e?.message || 'Your application could not be submitted. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (status === 'loading') {
    return <CareersShell compact><LoadingState label="Loading role…" /></CareersShell>
  }
  if (status === 'error') {
    return (
      <CareersShell compact>
        <ErrorState message={errorMsg}>
          <Link to="/careers" className="inline-flex items-center gap-1.5 mt-4 text-sm font-medium text-[#009944] hover:underline"><ArrowLeft className="w-4 h-4" /> Back to all roles</Link>
        </ErrorState>
      </CareersShell>
    )
  }

  if (result) {
    return (
      <CareersShell compact>
        <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl p-8 text-center">
          <CheckCircle2 className="w-14 h-14 text-[#009944] mx-auto mb-4" />
          <h1 className="text-xl font-bold text-slate-900">Application received</h1>
          <p className="text-sm text-slate-500 mt-2">
            Thanks, {form.full_name.split(' ')[0] || 'candidate'}. Your application for <span className="font-medium text-slate-700">{job.job_title}</span> has been submitted successfully.
          </p>
          {result.portal_token && (
            <p className="text-sm text-slate-500 mt-3">
              Track your application progress in your candidate portal.
            </p>
          )}
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            {result.portal_token && (
              <Link to={`/careers/portal/${result.portal_token}`} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#009944] text-white px-5 py-2.5 text-sm font-medium hover:bg-[#00813a]">
                Open my candidate portal
              </Link>
            )}
            <Link to="/careers" className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Browse more roles
            </Link>
          </div>
          {result.portal_token && (
            <p className="text-xs text-slate-400 mt-4 break-all">Portal link: {window.location.origin}{window.location.pathname}#/careers/portal/{result.portal_token}</p>
          )}
        </div>
      </CareersShell>
    )
  }

  return (
    <CareersShell compact>
      <Link to="/careers" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#009944] mb-5"><ArrowLeft className="w-4 h-4" /> All roles</Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{job.job_title}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-slate-500">
                  <span className="inline-flex items-center gap-1.5"><Building2 className="w-4 h-4" /> {job.department || 'General'}</span>
                  {job.location && <span className="inline-flex items-center gap-1.5"><MapPin className="w-4 h-4" /> {job.location}</span>}
                  <span className="inline-flex items-center gap-1.5"><FileText className="w-4 h-4" /> {job.employment_type || 'full_time'}</span>
                </div>
                {(job.salary_min || job.salary_max) && (
                  <p className="mt-3 text-sm text-slate-500 inline-flex items-center gap-1.5">
                    <IndianRupee className="w-4 h-4" />
                    {fmtMoney(job.salary_currency, job.salary_min)}{job.salary_max ? ` – ${fmtMoney(job.salary_currency, job.salary_max)}` : ''} <span className="text-xs text-slate-400">/ annum</span>
                  </p>
                )}
                {job.application_deadline && <p className="mt-2 text-xs text-amber-700">Applications close {new Date(job.application_deadline).toLocaleDateString()}</p>}
              </div>
              <button
                onClick={() => setShowApply(true)}
                className="rounded-lg bg-[#009944] text-white px-6 py-2.5 text-sm font-semibold hover:bg-[#00813a] transition"
              >
                Apply now
              </button>
            </div>

            <div className="mt-6 space-y-6 text-sm text-slate-600 leading-relaxed">
              {job.description && <section><h2 className="text-base font-semibold text-slate-900 mb-1.5">About the role</h2><p>{job.description}</p></section>}
              {job.responsibilities && <section><h2 className="text-base font-semibold text-slate-900 mb-1.5">Responsibilities</h2><p className="whitespace-pre-line">{job.responsibilities}</p></section>}
              {job.requirements && <section><h2 className="text-base font-semibold text-slate-900 mb-1.5">Requirements</h2><p className="whitespace-pre-line">{job.requirements}</p></section>}
              {job.qualifications && <section><h2 className="text-base font-semibold text-slate-900 mb-1.5">Qualification & Skills</h2><p className="whitespace-pre-line">{job.qualifications}</p></section>}
              {Array.isArray(job.required_skills) && job.required_skills.length > 0 && (
                <section>
                  <h2 className="text-base font-semibold text-slate-900 mb-2">Required skills</h2>
                  <div className="flex flex-wrap gap-2">
                    {job.required_skills.map((s, i) => <span key={i} className="px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-medium">{s}</span>)}
                  </div>
                </section>
              )}
              {job.benefits && <section><h2 className="text-base font-semibold text-slate-900 mb-1.5">Benefits</h2><p className="whitespace-pre-line">{job.benefits}</p></section>}
            </div>
          </div>
        </div>

        <div>
          {showApply && !result ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 sticky top-20">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Apply for {job.job_title}</h2>
              <div className="space-y-4">
                <div>
                  <label className={labelCls}>Full name *</label>
                  <input className={inputCls} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Your full name" />
                </div>
                <div>
                  <label className={labelCls}>Email</label>
                  <input className={inputCls} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" />
                </div>
                 <div>
                   <label className={labelCls}>Phone</label>
                   <input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+234…" />
                 </div>
                 {(job.application_form_config?.location !== false) && <div><label className={labelCls}>Location</label><input className={inputCls} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="City or region" /></div>}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Current company</label>
                    <input className={inputCls} value={form.current_company} onChange={(e) => setForm({ ...form, current_company: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Years experience</label>
                    <input className={inputCls} type="number" min="0" value={form.years_experience} onChange={(e) => setForm({ ...form, years_experience: e.target.value })} />
                  </div>
                </div>
                 {(job.application_form_config?.skills !== false) && <div>
                   <label className={labelCls}>Skills</label>
                   <input className={inputCls} value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} placeholder="Comma separated, e.g. Risk Analysis, SQL" />
                 </div>}
                 {(job.application_form_config?.cover_letter !== false) && <div>
                   <label className={labelCls}>Cover letter</label>
                   <textarea className={textareaCls} rows="4" value={form.cover_letter} onChange={(e) => setForm({ ...form, cover_letter: e.target.value })} placeholder="Introduce yourself and explain why you're the right fit…" />
                 </div>}
                <div>
                  <label className={labelCls}>CV / Resume</label>
                   <label className="flex items-center justify-center gap-2 min-h-24 rounded-lg border-2 border-dashed border-slate-300 hover:border-[#009944] cursor-pointer text-slate-500 text-sm p-3">
                     {cv ? (
                       <span className="flex flex-wrap items-center justify-center gap-2 text-[#009944] font-medium"><FileText className="w-4 h-4" /> {cv.name}<span className="text-xs text-slate-400">({Math.round(cv.size / 1024)} KB) — click to replace</span><button type="button" onClick={(event) => { event.preventDefault(); removeCV() }} className="text-xs text-rose-600 hover:underline">Remove</button></span>
                     ) : (<span className="flex items-center gap-2"><Upload className="w-4 h-4" /> Upload PDF or Word</span>)}
                     <input type="file" accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={handleFile} />
                   </label>
                   {submitting && cv && <div className="mt-2"><div className="h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-[#009944] transition-all" style={{ width: `${uploadProgress}%` }} /></div><p className="text-[11px] text-slate-400 mt-1">Uploading resume… {uploadProgress}%</p></div>}
                 </div>
                {formError && <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{formError}</p>}
                <div className="flex gap-3">
                  <button onClick={submit} disabled={submitting} className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-[#009944] text-white py-2.5 text-sm font-semibold hover:bg-[#00813a] disabled:opacity-60">
                    {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</> : 'Submit application'}
                  </button>
                  <button onClick={() => { setShowApply(false); setFormError('') }} className="rounded-lg border border-slate-300 px-4 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 sticky top-20">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Quick facts</h2>
              <dl className="space-y-3 text-sm">
                {job.employment_type && <div className="flex justify-between"><dt className="text-slate-400">Type</dt><dd className="text-slate-700">{job.employment_type.replace('_', ' ')}</dd></div>}
                {job.department && <div className="flex justify-between"><dt className="text-slate-400">Department</dt><dd className="text-slate-700">{job.department}</dd></div>}
                {job.location && <div className="flex justify-between"><dt className="text-slate-400">Location</dt><dd className="text-slate-700">{job.location}</dd></div>}
                {job.experience_years > 0 && <div className="flex justify-between"><dt className="text-slate-400">Experience</dt><dd className="text-slate-700">{job.experience_years}+ years</dd></div>}
                {Array.isArray(job.required_skills) && job.required_skills.length > 0 && <div className="flex justify-between"><dt className="text-slate-400">Skill level</dt><dd className="text-slate-700">Assessed</dd></div>}
              </dl>
              <button onClick={() => setShowApply(true)} className="mt-5 w-full rounded-lg bg-[#009944] text-white py-2.5 text-sm font-semibold hover:bg-[#00813a] transition">Apply now</button>
            </div>
          )}
        </div>
      </div>
    </CareersShell>
  )
}
