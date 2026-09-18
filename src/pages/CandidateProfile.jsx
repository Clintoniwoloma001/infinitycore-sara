import React, { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Bot, CheckCircle2, ClipboardList, Download, FileText, Loader2, MessageSquarePlus, Pencil, Plus, ShieldAlert, Stethoscope, X, XCircle } from 'lucide-react'
import { date } from './hrShared'
import { recruitmentService } from '../services/recruitmentService'
import { screeningService } from '../services/screeningService'
import { assessmentService } from '../services/assessmentService'
import { offerService } from '../services/offerService'
import { ErrorState, LoadingState } from '../components/PageStates'
import { StatusBadge, formatCurrency } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'
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
  { id: 'offers', label: 'Offers' },
  { id: 'medical', label: 'Medical' },
  { id: 'notes', label: 'Notes & History' },
]

const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

export default function CandidateProfile() {
  const { id } = useParams()
  const { user, isHR } = useAuth()
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
        current_company: form.current_company || null,
        years_experience: form.years_experience === '' ? null : Number(form.years_experience),
      })
      setEdit(false)
      return 'Profile updated.'
    })
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
                      {r.ai_recommendation && <p className="text-xs text-slate-500 mt-1">{r.ai_recommendation}</p>}
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
                    {r.ai_recommendation && <span className="text-xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">AI</span>}
                    {r.hr_decision && <StatusBadge label={r.hr_decision} color={r.hr_decision === 'approved' ? 'emerald' : r.hr_decision === 'rejected' ? 'rose' : 'amber'} />}
                  </div>
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                    {[['Experience', r.experience_score], ['Skills', r.skills_score], ['Education', r.education_score], ['Certifications', r.certifications_score], ['Overall', r.overall_score]].filter(([k]) => k === 'Overall' || r[['experience_score', 'skills_score', 'education_score', 'certifications_score'][[['Experience', 0], ['Skills', 1], ['Education', 2], ['Certifications', 3]].find(([l]) => l === k)[1]]] != null).map(([k, v]) => (
                      <div key={k} className="rounded-lg bg-slate-50 border border-slate-100 py-2">
                        <p className="text-[11px] text-slate-400 uppercase">{k}</p>
                        <p className="text-lg font-bold text-slate-800">{v != null ? Number(v).toFixed(1) : '—'}</p>
                      </div>
                    ))}
                  </div>
                  {r.ai_summary && <p className="mt-3 text-sm text-slate-600">{r.ai_summary}</p>}
                  {r.missing_requirements?.length > 0 && <p className="mt-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 inline-block">Missing: {r.missing_requirements.join(', ')}</p>}
                  {r.rules_feedback && <p className="mt-2 text-xs text-slate-500">Rules: {r.rules_feedback}</p>}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => run(`dec-${r.id}`, () => screeningService.setDecision(r.id, 'approved', 'Screening approved'))} disabled={!!busy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 text-xs font-medium hover:bg-emerald-50 disabled:opacity-50"><CheckCircle2 className="w-3.5 h-3.5" /> Approve</button>
                  <button onClick={() => run(`dec-${r.id}`, () => screeningService.setDecision(r.id, 'rejected', 'Screening rejected'))} disabled={!!busy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 text-xs font-medium hover:bg-rose-50 disabled:opacity-50"><XCircle className="w-3.5 h-3.5" /> Reject</button>
                  <button onClick={() => run(`dec-${r.id}`, () => screeningService.setDecision(r.id, 'flag', 'Requires manual review'))} disabled={!!busy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 text-xs font-medium hover:bg-amber-50 disabled:opacity-50"><ShieldAlert className="w-3.5 h-3.5" /> Flag</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'assessment' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center gap-3">
            <select value={invite?.templateId || ''} onChange={(e) => setInvite({ templateId: e.target.value })} className={inputCls + ' !w-auto'}>
              <option value="">Select a published template…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            <button
              onClick={() => run('invite', async () => {
                if (!invite?.templateId) throw new Error('Select a template first.')
                const res = await assessmentService.inviteCandidate({ candidateId: id, templateId: invite.templateId, jobId: cand.job_id })
                return `Invitation created${res.url ? ' — ' + res.url : ''}.`
              })}
              disabled={!!busy || !invite?.templateId}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
            >
              {busy === 'invite' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Invite to assessment
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

      {tab === 'notes' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6">
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