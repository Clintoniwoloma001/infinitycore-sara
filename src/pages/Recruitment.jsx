import React, { useState } from 'react'
import { CalendarPlus, CheckCircle2, Copy, Link2, Loader2, Video, MapPin, X } from 'lucide-react'
import HRJobs from './HRJobs'
import { date, ModuleTable, status, useTable } from './hrShared'
import { ErrorState } from '../components/PageStates'
import { hrService } from '../services/hrService'
import { onboardingService, DEFAULT_EXPIRY_DAYS } from '../services/onboardingService'
import { useAuth } from '../hooks/useAuth'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const PLATFORMS = ['Google Meet', 'Zoom', 'Microsoft Teams', 'Other']

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  }
}

export default function Recruitment() {
  const { user } = useAuth()
  const candidates = useTable('hr_candidates')
  const [scheduleTarget, setScheduleTarget] = useState(null)
  const [form, setForm] = useState({ interview_type: 'PHYSICAL' })
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')
  const [onboardTarget, setOnboardTarget] = useState(null)
  const [generatedLink, setGeneratedLink] = useState(null)
  const [onboardBusy, setOnboardBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

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
      await hrService.scheduleInterview({
        candidate_id: scheduleTarget.id,
        candidate_name: scheduleTarget.full_name,
        candidate_email: scheduleTarget.email || '',
        position: form.position || scheduleTarget.applied_role || '',
        interview_type: form.interview_type || 'PHYSICAL',
        location: form.interview_type === 'PHYSICAL' ? form.location : null,
        platform: form.interview_type === 'VIRTUAL' ? form.platform : null,
        meeting_url: form.interview_type === 'VIRTUAL' ? form.meeting_url : null,
        scheduled_date: form.scheduled_date,
        status: 'scheduled',
        interviewer_id: user?.id,
      })
      // Update candidate status to interview
      await hrService.updateCandidate(scheduleTarget.id, { application_status: 'interview' }).catch(() => {})
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
      <ModuleTable
        title="Applicants"
        subtitle="Candidate profiles and recruitment pipeline"
        rows={candidates.rows}
        loading={candidates.loading}
        error={candidates.error}
        searchKeys={['full_name', 'email', 'current_company', 'application_status']}
        columns={[
          { key: 'full_name', label: 'Candidate', render: (r) => <div><div className="font-medium text-slate-900">{r.full_name}</div><div className="text-xs text-slate-400">{r.email || r.phone || '-'}</div></div> },
          { key: 'current_company', label: 'Current Company' },
          { key: 'years_experience', label: 'Experience', render: (r) => `${r.years_experience || 0} yrs` },
          { key: 'application_status', label: 'Status', render: (r) => status(r.application_status, ['shortlisted', 'interview', 'offer', 'hired']) },
          { key: 'screening_score', label: 'Screening', render: (r) => r.screening_score ?? '-' },
          { key: 'created_at', label: 'Applied', render: (r) => date(r.created_at) },
          { key: 'actions', label: 'Actions', render: (r) => (
            <div className="flex justify-end gap-1.5">
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
    </div>
  )
}
