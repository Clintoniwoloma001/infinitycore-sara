import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarPlus, Loader2, Plus, Video, MapPin, X } from 'lucide-react'
import { date, ModuleTable, status, useTable } from './hrShared'
import { hrService } from '../services/hrService'
import { useAuth } from '../hooks/useAuth'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const INTERVIEW_TYPES = ['PHYSICAL', 'VIRTUAL']
const PLATFORMS = ['Google Meet', 'Zoom', 'Microsoft Teams', 'Other']

export default function Interviews() {
  const navigate = useNavigate()
  const { hasPermission, user } = useAuth()
  const canManage = hasPermission('hr.interviews.schedule') || hasPermission('hr.applications.read')
  const { rows, loading, error, reload } = useTable('hr_interviews', 'scheduled_date')
  const [candidates, setCandidates] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')
  const [form, setForm] = useState({ interview_type: 'PHYSICAL' })

  useEffect(() => {
    hrService.listCandidates().then(setCandidates).catch(() => {})
  }, [])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const create = async () => {
    if (!form.candidate_id) { setFormError('Please select a candidate.'); return }
    if (!form.scheduled_date) { setFormError('Please select a date and time.'); return }
    setFormError('')
    setCreating(true)
    try {
      const candidate = candidates.find((c) => c.id === form.candidate_id)
      await hrService.scheduleInterview({
        candidate_id: form.candidate_id,
        candidate_name: candidate?.full_name || '',
        candidate_email: candidate?.email || '',
        position: form.position || candidate?.applied_role || '',
        interview_type: form.interview_type || 'PHYSICAL',
        location: form.interview_type === 'PHYSICAL' ? form.location : null,
        platform: form.interview_type === 'VIRTUAL' ? form.platform : null,
        meeting_url: form.interview_type === 'VIRTUAL' ? form.meeting_url : null,
        scheduled_date: form.scheduled_date,
        status: 'scheduled',
        interviewer_id: user?.id,
      })
      setShowCreate(false)
      setForm({ interview_type: 'PHYSICAL' })
      reload()
    } catch (e) {
      setFormError(e?.message || 'Failed to schedule interview')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Interviews</h2>
          <p className="text-sm text-slate-500 mt-1">Schedule and track candidate interviews.</p>
        </div>
        {canManage && (
          <button onClick={() => { setShowCreate(true); setFormError(''); setForm({ interview_type: 'PHYSICAL' }) }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <CalendarPlus className="w-4 h-4" /> Schedule Interview
          </button>
        )}
      </div>

      <ModuleTable
        title=""
        subtitle=""
        rows={rows}
        loading={loading}
        error={error}
        searchKeys={['candidate_name', 'interview_type', 'status', 'position', 'platform']}
        columns={[
          { key: 'candidate_name', label: 'Candidate', render: (r) => (
            <div>
              <div className="font-medium text-slate-900">{r.candidate_name || r.candidate_id?.slice(0, 8) || '-'}</div>
              {r.candidate_email && <div className="text-xs text-slate-400">{r.candidate_email}</div>}
            </div>
          ) },
          { key: 'position', label: 'Position', render: (r) => r.position || '-' },
          { key: 'interview_type', label: 'Type', render: (r) => (
            <span className="inline-flex items-center gap-1 text-xs">
              {r.interview_type === 'VIRTUAL' ? <Video className="w-3 h-3 text-violet-500" /> : <MapPin className="w-3 h-3 text-blue-500" />}
              {String(r.interview_type || '-').replace(/_/g, ' ')}
            </span>
          ) },
          { key: 'scheduled_date', label: 'Date/Time', render: (r) => date(r.scheduled_date) },
          { key: 'location', label: 'Location/Platform', render: (r) => {
            if (r.interview_type === 'VIRTUAL') return r.platform || r.meeting_url || '-'
            return r.location || '-'
          } },
          { key: 'status', label: 'Status', render: (r) => status(r.status, ['completed', 'passed']) },
        ]}
      />

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Schedule Interview</h3>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            {formError && <p className="text-sm text-rose-600 mb-3">{formError}</p>}
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Candidate *</label>
                <select className={inputCls} value={form.candidate_id || ''} onChange={set('candidate_id')}>
                  <option value="">Select candidate…</option>
                  {candidates.map((c) => <option key={c.id} value={c.id}>{c.full_name} — {c.email || 'No email'}</option>)}
                </select>
              </div>
              <div><label className={labelCls}>Position</label><input className={inputCls} value={form.position || ''} onChange={set('position')} placeholder="Auto-filled from candidate" /></div>
              <div>
                <label className={labelCls}>Interview Type</label>
                <div className="flex gap-2">
                  {INTERVIEW_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, interview_type: t }))}
                      className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium ${form.interview_type === t ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600'}`}
                    >
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
                    <input className={inputCls} value={form.meeting_url || ''} onChange={set('meeting_url')} placeholder="Paste meeting link (manual — no auto-integration configured)" />
                    <p className="text-xs text-slate-400 mt-1">No video provider integration is configured. Enter the meeting URL manually, or connect Google Meet/Zoom OAuth to auto-generate links.</p>
                  </div>
                </>
              )}
              <div>
                <label className={labelCls}>Date & Time *</label>
                <input type="datetime-local" className={inputCls} value={form.scheduled_date || ''} onChange={set('scheduled_date')} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={create} disabled={creating} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />} Schedule
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
