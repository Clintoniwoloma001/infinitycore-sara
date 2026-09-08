import React, { useEffect, useState } from 'react'
import { CalendarPlus, Clock, Link2, MapPin, Video, X, Loader2, CheckCircle2, User, Building2 } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { logAction } from '../services/supabaseService'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import { date, status } from './hrShared'
import { sendEmailNotification } from '../services/notificationService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const INTERVIEW_TYPES = [
  { value: 'in_person', label: 'Physical (In-Person)' },
  { value: 'video', label: 'Virtual (Video)' },
  { value: 'phone', label: 'Phone' },
  { value: 'panel', label: 'Panel' },
]

const PROVIDERS = [
  { value: 'manual', label: 'Manual Link' },
  { value: 'google_meet', label: 'Google Meet' },
  { value: 'zoom', label: 'Zoom' },
]

export default function Interviews() {
  const { user, profile, name: userName } = useAuth()
  const [interviews, setInterviews] = useState([])
  const [candidates, setCandidates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState('')
  const [form, setForm] = useState({
    candidate_id: '',
    interview_type: 'video',
    meeting_provider: 'manual',
    meeting_url: '',
    location: '',
    interview_date: '',
    interview_time: '',
    duration: '30',
    interviewer_name: '',
    notes: '',
  })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [intData, candData] = await Promise.all([
        supabase.from('hr_interviews').select('*').order('created_at', { ascending: false }),
        supabase.from('hr_candidates').select('id, full_name, email, phone, application_status').order('created_at', { ascending: false }),
      ])
      if (intData.error) throw intData.error
      setInterviews(intData.data || [])
      setCandidates(candData.data || [])
    } catch (e) {
      setError(e?.message || 'Failed to load interviews')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const create = async () => {
    setError('')
    setSuccess('')
    if (!form.candidate_id) { setError('Select a candidate.'); return }
    if (!form.interview_date) { setError('Select a date.'); return }
    setBusy(true)
    try {
      const candidate = candidates.find((c) => c.id === form.candidate_id)
      const scheduledDate = new Date(`${form.interview_date}T${form.interview_time || '09:00'}:00`).toISOString()

      const payload = {
        candidate_id: form.candidate_id,
        interview_type: form.interview_type,
        scheduled_date: scheduledDate,
        status: 'scheduled',
        interviewer_id: user?.id,
        feedback: form.notes || null,
      }

      // Add meeting fields if the columns exist (Phase 9 recovery migration)
      try {
        payload.meeting_provider = form.meeting_provider
        payload.meeting_url = form.meeting_url || null
        payload.interview_date = form.interview_date
        payload.interview_time = form.interview_time
      } catch { /* columns may not exist yet */ }

      const { data, error: insertErr } = await supabase.from('hr_interviews').insert([payload]).select().single()
      if (insertErr) throw insertErr

      // Update candidate status
      await supabase.from('hr_candidates').update({ application_status: 'interview' }).eq('id', form.candidate_id)

      await logAction({ action: 'INTERVIEW_SCHEDULED', entityType: 'Interview', entityId: data.id, details: `Interview scheduled for ${candidate?.full_name}`, userName })

      // Try to send email notification (fallback if not configured)
      if (candidate?.email) {
        await sendEmailNotification({
          recipientEmail: candidate.email,
          subject: 'Interview Invitation - InfinityCore',
          message: `Dear ${candidate.full_name},\n\nYou have been invited for an interview.\n\nDate: ${form.interview_date}\nTime: ${form.interview_time}\nType: ${INTERVIEW_TYPES.find(t => t.value === form.interview_type)?.label}\n${form.meeting_url ? `Meeting Link: ${form.meeting_url}` : form.location ? `Location: ${form.location}` : ''}\n\nPlease confirm your availability.\n\nRegards,\nHR Team`,
        })
      }

      setSuccess(`Interview scheduled for ${candidate?.full_name}.`)
      setShowForm(false)
      setForm({ candidate_id: '', interview_type: 'video', meeting_provider: 'manual', meeting_url: '', location: '', interview_date: '', interview_time: '', duration: '30', interviewer_name: '', notes: '' })
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to schedule interview')
    } finally {
      setBusy(false)
    }
  }

  const cancelInterview = async (id) => {
    if (!confirm('Cancel this interview?')) return
    try {
      await supabase.from('hr_interviews').update({ status: 'cancelled' }).eq('id', id)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to cancel')
    }
  }

  const completeInterview = async (id) => {
    try {
      await supabase.from('hr_interviews').update({ status: 'completed' }).eq('id', id)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to update')
    }
  }

  const isVirtual = form.interview_type === 'video' || form.interview_type === 'phone'

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Interviews</h2>
          <p className="text-sm text-slate-500 mt-1">Schedule and manage candidate interviews</p>
        </div>
        <button onClick={() => { setShowForm(true); setSuccess(''); setError('') }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
          <CalendarPlus className="w-4 h-4" /> Schedule Interview
        </button>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {success && (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {success}
        </div>
      )}

      {loading && <LoadingState label="Loading interviews..." />}
      {!loading && !error && interviews.length === 0 && <EmptyState title="No interviews scheduled" description="Schedule an interview to get started." />}
      {!loading && !error && interviews.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium">Candidate</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Date / Time</th>
                <th className="px-6 py-3 font-medium">Meeting</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {interviews.map((r) => {
                const candidate = candidates.find((c) => c.id === r.candidate_id)
                const isVid = r.meeting_provider && r.meeting_provider !== 'manual'
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-900">{candidate?.full_name || 'Unknown'}</div>
                      <div className="text-xs text-slate-400">{candidate?.email || '-'}</div>
                    </td>
                    <td className="px-6 py-3">
                      <span className="inline-flex items-center gap-1.5 text-slate-600">
                        {r.interview_type === 'in_person' ? <Building2 className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
                        {INTERVIEW_TYPES.find(t => t.value === r.interview_type)?.label || r.interview_type}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-slate-600">
                      {date(r.interview_date || r.scheduled_date)}
                      {r.interview_time && <div className="text-xs text-slate-400">{r.interview_time}</div>}
                    </td>
                    <td className="px-6 py-3">
                      {r.meeting_url ? (
                        <a href={r.meeting_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#009944] hover:underline text-xs">
                          <Link2 className="w-3.5 h-3.5" /> {r.meeting_provider || 'Join'}
                        </a>
                      ) : r.feedback ? (
                        <span className="text-xs text-slate-400">{r.feedback.substring(0, 30)}</span>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3">{status(r.status, ['completed'])}</td>
                    <td className="px-6 py-3 text-right">
                      {r.status === 'scheduled' && (
                        <div className="flex justify-end gap-1">
                          <button onClick={() => completeInterview(r.id)} className="text-xs px-2.5 py-1.5 rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100">Complete</button>
                          <button onClick={() => cancelInterview(r.id)} className="text-xs px-2.5 py-1.5 rounded-md bg-rose-50 text-rose-700 hover:bg-rose-100">Cancel</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Schedule Interview Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Schedule Interview</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="space-y-4">
              <div>
                <label className={labelCls}>Candidate *</label>
                <select className={inputCls} value={form.candidate_id} onChange={set('candidate_id')}>
                  <option value="">Select candidate…</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>{c.full_name} {c.email ? `(${c.email})` : ''}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Interview Type *</label>
                  <select className={inputCls} value={form.interview_type} onChange={set('interview_type')}>
                    {INTERVIEW_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Duration (mins)</label>
                  <select className={inputCls} value={form.duration} onChange={set('duration')}>
                    {['15', '30', '45', '60', '90'].map((d) => <option key={d} value={d}>{d} minutes</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Date *</label>
                  <input type="date" className={inputCls} value={form.interview_date} onChange={set('interview_date')} />
                </div>
                <div>
                  <label className={labelCls}>Time</label>
                  <input type="time" className={inputCls} value={form.interview_time} onChange={set('interview_time')} />
                </div>
              </div>

              {isVirtual ? (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Platform</label>
                    <select className={inputCls} value={form.meeting_provider} onChange={set('meeting_provider')}>
                      {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Meeting Link</label>
                    <input className={inputCls} value={form.meeting_url} onChange={set('meeting_url')} placeholder="https://meet.google.com/…" />
                  </div>
                </div>
              ) : (
                <div>
                  <label className={labelCls}>Location</label>
                  <input className={inputCls} value={form.location} onChange={set('location')} placeholder="Office address or room" />
                </div>
              )}

              <div>
                <label className={labelCls}>Notes / Instructions</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.notes} onChange={set('notes')} placeholder="Interview instructions for the candidate…" />
              </div>

              {form.meeting_provider !== 'manual' && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  ⚠ {form.meeting_provider === 'google_meet' ? 'Google Meet' : 'Zoom'} API integration requires server-side credentials. Enter the meeting link manually above, or select "Manual Link".
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={create} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />} Schedule
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
