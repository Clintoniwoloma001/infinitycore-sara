import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, CheckCircle2, ClipboardCheck, FileText, Loader2, Mail, Phone, XCircle } from 'lucide-react'
import CareersShell from './CareersShell'
import { careerService } from '../../services/careerService'
import { ErrorState } from '../../components/PageStates'

const STATUS_LABELS = {
  received: 'Received',
  screening: 'Screening in progress',
  shortlisted: 'Shortlisted',
  assessment: 'Assessment in progress',
  assessment_passed: 'Assessment passed',
  interview: 'Interview stage',
  offer: 'Offer stage',
  offer_sent: 'Offer sent',
  offer_accepted: 'Offer accepted',
  offer_declined: 'Offer declined',
  hired: 'Hired',
  rejected: 'Not selected',
}

const STATUS_COLORS = {
  received: 'bg-slate-100 text-slate-700 border-slate-200',
  screening: 'bg-sky-50 text-sky-700 border-sky-200',
  shortlisted: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  assessment: 'bg-violet-50 text-violet-700 border-violet-200',
  assessment_passed: 'bg-teal-50 text-teal-700 border-teal-200',
  interview: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  offer: 'bg-amber-50 text-amber-700 border-amber-200',
  offer_sent: 'bg-amber-50 text-amber-700 border-amber-200',
  offer_accepted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  offer_declined: 'bg-rose-50 text-rose-700 border-rose-200',
  hired: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
}

function Pill({ status }) {
  return <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium border ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>{STATUS_LABELS[status] || status}</span>
}

export default function CandidatePortal() {
  const { token } = useParams()
  const [portal, setPortal] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const data = await careerService.getPortal(token)
        if (!active) return
        if (!data?.candidate) { setError('We could not find an application for this link.'); return }
        setPortal(data)
      } catch (e) {
        if (active) setError(e?.message || 'Your portal could not be loaded.')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [token])

  if (loading) {
    return <CareersShell compact><div className="flex items-center justify-center py-20 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading your portal…</div></CareersShell>
  }
  if (error) {
    return (
      <CareersShell compact>
        <ErrorState message={error}>
          <Link to="/careers" className="inline-flex items-center gap-1.5 mt-4 text-sm font-medium text-[#009944] hover:underline"><ArrowLeft className="w-4 h-4" /> Back to jobs</Link>
        </ErrorState>
      </CareersShell>
    )
  }

  const { candidate, job, status_history = [], assessments = [], offers = [] } = portal
  const attempts = assessments.flatMap((a) => (a.attempts || []).map((t) => ({ ...t, test_name: a.template_title || a.test_name, hasRetake: a.status === 'completed' || a.status === 'flagged' })))

  return (
    <CareersShell compact>
      <Link to="/careers" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#009944] mb-5"><ArrowLeft className="w-4 h-4" /> All roles</Link>

      <div className="bg-white border border-slate-200 rounded-2xl p-7 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <h1 className="text-xl font-bold text-slate-900">{candidate.full_name}</h1>
            <p className="text-sm text-slate-500 mt-1">Application for {job?.job_title || candidate.applied_role}</p>
            <div className="flex flex-wrap gap-4 mt-3 text-sm text-slate-500">
              {candidate.email && <span className="inline-flex items-center gap-1.5"><Mail className="w-4 h-4" /> {candidate.email}</span>}
              {candidate.phone && <span className="inline-flex items-center gap-1.5"><Phone className="w-4 h-4" /> {candidate.phone}</span>}
              <span className="inline-flex items-center gap-1.5"><CalendarDays className="w-4 h-4" /> Applied {new Date(candidate.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            </div>
          </div>
          <Pill status={candidate.application_status} />
        </div>
        {candidate.screening_notes && (
          <div className="mt-4 rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm text-slate-600">
            <span className="font-medium text-slate-700">Screening update: </span>{candidate.screening_notes}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200 rounded-2xl p-6">
          <h2 className="text-base font-bold text-slate-900 mb-4">Application progress</h2>
          {status_history.length === 0 && <p className="text-sm text-slate-400">Your application is being reviewed.</p>}
          <ol className="space-y-0">
            {[...status_history].reverse().map((h, i) => (
              <li key={h.id || i} className="relative pl-6 pb-5 last:pb-0">
                {i < status_history.length - 1 && <span className="absolute left-[7px] top-4 bottom-0 w-px bg-slate-200" />}
                <span className="absolute left-0 top-1.5 w-[15px] h-[15px] rounded-full border-2 border-[#009944] bg-white" />
                <p className="text-sm font-medium text-slate-800">{STATUS_LABELS[h.to_status] || h.to_status}</p>
                <p className="text-xs text-slate-400 mt-0.5">{new Date(h.changed_at || h.created_at).toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                {h.note && <p className="text-xs text-slate-500 mt-1">{h.note}</p>}
              </li>
            ))}
          </ol>
        </section>

        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-2xl p-6">
            <h2 className="text-base font-bold text-slate-900 mb-4 inline-flex items-center gap-2"><ClipboardCheck className="w-4 h-4 text-[#009944]" /> Assessments</h2>
            {attempts.length === 0 && <p className="text-sm text-slate-400">No assessments have been assigned yet.</p>}
            <div className="space-y-3">
              {assessments.map((a) => (
                <div key={a.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-slate-800">{a.template_title || a.test_name}</p>
                    <span className={`inline-flex items-center gap-1 text-xs font-medium ${a.status === 'completed' ? 'text-emerald-700' : a.status === 'in_progress' ? 'text-amber-700' : 'text-slate-500'}`}>
                      {a.status === 'completed' && <CheckCircle2 className="w-3.5 h-3.5" />}
                      {a.status === 'failed' && <XCircle className="w-3.5 h-3.5" />}
                      {a.status}
                    </span>
                  </div>
                  {(a.attempts || []).map((at) => (
                    <div key={at.id} className="mt-2 flex items-center justify-between text-xs text-slate-500 border-t border-slate-100 pt-2">
                      <span>Attempt {at.attempt_number}</span>
                      <span className="inline-flex items-center gap-1 font-medium">
                        {at.status}
                        {at.percentage != null && <span className={at.passed ? 'text-emerald-600' : 'text-rose-600'}>{at.percentage}%</span>}
                      </span>
                    </div>
                  ))}
                  {a.status === 'pending' && a.expires_at && (
                    <p className="text-xs text-slate-400 mt-2">Invitation sent — opens via your email link or student portal.</p>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="bg-white border border-slate-200 rounded-2xl p-6">
            <h2 className="text-base font-bold text-slate-900 mb-4 inline-flex items-center gap-2"><FileText className="w-4 h-4 text-[#009944]" /> Offer letters</h2>
            {offers.length === 0 && <p className="text-sm text-slate-400">No offers yet.</p>}
            <div className="space-y-3">
              {offers.map((o) => (
                <div key={o.id} className="rounded-lg border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{o.position}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {o.monthly_salary != null && <span>{o.monthly_salary.toLocaleString()} {o.currency || 'NGN'} monthly · </span>}
                      {o.issue_date && <>issued {new Date(o.issue_date).toLocaleDateString()}</>}
                    </p>
                  </div>
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${o.status === 'accepted' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : o.status === 'declined' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{o.status}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </CareersShell>
  )
}