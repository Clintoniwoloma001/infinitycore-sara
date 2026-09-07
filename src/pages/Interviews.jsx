import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarPlus, CheckCircle2, Clock, Copy, Eye, Loader2, Mail, MailWarning, MapPin, Plus, Send, Video, X, Zap, AlertCircle } from 'lucide-react'
import { date, ModuleTable, status, useTable } from './hrShared'
import { hrService } from '../services/hrService'
import { useAuth } from '../hooks/useAuth'
import { logAction } from '../services/supabaseService'
import { sendInAppNotification } from '../services/notificationService'
import { scheduleInterviewWithMeeting, sendInterviewEmail, checkGoogleCalendar, checkZoom, connectGoogleCalendar, connectZoom } from '../services/interviewService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const INTERVIEW_TYPES = ['PHYSICAL', 'VIRTUAL']
const PLATFORMS = ['Google Meet', 'Zoom', 'Other']
const NOTIF_COLORS = {
  sent: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', icon: CheckCircle2, label: 'Sent' },
  failed: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', icon: AlertCircle, label: 'Failed' },
  pending: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', icon: Clock, label: 'Pending' },
  not_configured: { bg: 'bg-slate-100', text: 'text-slate-500', border: 'border-slate-200', icon: MailWarning, label: 'Not configured' },
}

function NotifBadge({ status }) {
  const cfg = NOTIF_COLORS[status] || NOTIF_COLORS.pending
  const Icon = cfg.icon
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.bg} ${cfg.text} ${cfg.border}`}><Icon className="w-3 h-3" /> {cfg.label}</span>
}

function ConnectionBadge({ connected, label, onClick }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${connected ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}>
      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-400'}`} />
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {connected ? (
        <span className="text-xs text-emerald-600 font-medium">Connected</span>
      ) : (
        <button onClick={onClick} className="ml-auto text-xs font-medium text-[#009944] hover:underline">Connect</button>
      )}
    </div>
  )
}

export default function Interviews() {
  const navigate = useNavigate()
  const { hasPermission, user } = useAuth()
  const canManage = hasPermission('hr.interviews.schedule') || hasPermission('hr.applications.read')
  const { rows, loading, error, reload } = useTable('hr_interviews', 'scheduled_date')
  const [candidates, setCandidates] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [showDetails, setShowDetails] = useState(null)
  const [showResendConfirm, setShowResendConfirm] = useState(null)
  const [creating, setCreating] = useState(false)
  const [createStep, setCreateStep] = useState('')
  const [formError, setFormError] = useState('')
  const [createResult, setCreateResult] = useState(null)
  const [form, setForm] = useState({ interview_type: 'PHYSICAL', platform: 'Google Meet', duration_minutes: 30 })
  const [googleConnected, setGoogleConnected] = useState(null)
  const [zoomConnected, setZoomConnected] = useState(null)
  const [resending, setResending] = useState(false)

  useEffect(() => {
    hrService.listCandidates().then(setCandidates).catch(() => {})
    // Check integration status
    checkGoogleCalendar().then(r => setGoogleConnected(r.connected)).catch(() => setGoogleConnected(false))
    checkZoom().then(r => setZoomConnected(r.connected)).catch(() => setZoomConnected(false))
  }, [])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const onCandidateChange = (e) => {
    const candidateId = e.target.value
    const candidate = candidates.find((c) => c.id === candidateId)
    setForm((f) => ({
      ...f,
      candidate_id: candidateId,
      candidate_name: candidate?.full_name || '',
      candidate_email: candidate?.email || '',
      original_candidate_email: candidate?.email || '',
      position: candidate?.applied_role || f.position || '',
      email_override: false,
    }))
  }

  const onEmailChange = (e) => {
    const newEmail = e.target.value
    setForm((f) => ({
      ...f,
      candidate_email: newEmail,
      email_override: newEmail !== f.original_candidate_email,
    }))
  }

  const handleConnectGoogle = () => {
    const { url, error } = connectGoogleCalendar(user?.id)
    if (error) { setFormError(error); return }
    if (url) window.open(url, '_blank', 'width=500,height=600')
  }

  const handleConnectZoom = () => {
    const { url, error } = connectZoom(user?.id)
    if (error) { setFormError(error); return }
    if (url) window.open(url, '_blank', 'width=500,height=600')
  }

  const create = async () => {
    if (!form.candidate_id) { setFormError('Please select a candidate.'); return }
    if (!form.scheduled_date) { setFormError('Please select a date and time.'); return }
    if (form.interview_type === 'VIRTUAL' && !form.platform) { setFormError('Please select a platform.'); return }
    setFormError('')
    setCreating(true)
    setCreateResult(null)

    try {
      setCreateStep('Creating interview...')

      // Build interview data
      const interviewData = {
        candidate_id: form.candidate_id,
        candidate_name: form.candidate_name || '',
        candidate_email: form.candidate_email || '',
        position: form.position || '',
        interview_type: form.interview_type || 'PHYSICAL',
        location: form.interview_type === 'PHYSICAL' ? form.location : null,
        platform: form.interview_type === 'VIRTUAL' ? form.platform : null,
        meeting_url: form.interview_type === 'VIRTUAL' && form.platform === 'Other' ? form.meeting_url : null,
        scheduled_date: form.scheduled_date,
        duration_minutes: parseInt(form.duration_minutes) || 30,
        status: 'scheduled',
        interviewer_id: user?.id,
        interview_instructions: form.interview_instructions || null,
        email_override: form.email_override || false,
        original_candidate_email: form.original_candidate_email || null,
        notification_status: 'pending',
      }

      // For Google Meet/Zoom with manual fallback, check if connected
      if (form.interview_type === 'VIRTUAL' && form.platform === 'Google Meet' && !googleConnected) {
        // Use manual link if provided, otherwise leave for manual entry
        if (form.meeting_url) {
          interviewData.meeting_url = form.meeting_url
        }
        interviewData.external_provider = null
      }
      if (form.interview_type === 'VIRTUAL' && form.platform === 'Zoom' && !zoomConnected) {
        if (form.meeting_url) {
          interviewData.meeting_url = form.meeting_url
        }
        interviewData.external_provider = null
      }

      const { steps, errors } = await scheduleInterviewWithMeeting({
        hrService,
        interviewData,
        user,
        candidates,
      })

      // Update candidate status
      if (steps.interview) {
        setCreateStep('Updating candidate status...')
        await hrService.updateCandidate(form.candidate_id, { application_status: 'interview' }).catch(() => {})
        logAction({ action: 'INTERVIEW_CREATED', entityType: 'Interview', entityId: steps.interview.id, details: `Interview scheduled for ${form.candidate_name}`, userName: user?.email })

        // In-app notification to HR
        sendInAppNotification({
          userId: user.id,
          title: 'Interview Scheduled',
          message: `Interview scheduled for ${form.candidate_name} — ${form.position || 'Position'}`,
          link: '#/interviews',
          type: 'interview',
        }).catch(() => {})
      }

      setCreateResult({ steps, errors })
      setCreateStep('')

      // If no critical errors, close after showing confirmation
      if (steps.interview && errors.length === 0) {
        setTimeout(() => {
          setShowCreate(false)
          setForm({ interview_type: 'PHYSICAL', platform: 'Google Meet', duration_minutes: 30 })
          setCreateResult(null)
          reload()
        }, 2500)
      }
    } catch (e) {
      setFormError(e?.message || 'Failed to schedule interview')
    } finally {
      setCreating(false)
      setCreateStep('')
    }
  }

  const resendEmail = async (interviewId) => {
    setResending(true)
    try {
      const result = await sendInterviewEmail(interviewId, true)
      if (result?.status === 'sent') {
        setShowResendConfirm(null)
        reload()
      } else {
        setFormError(result?.error || 'Failed to resend email')
      }
    } catch (e) {
      setFormError(e?.message || 'Failed to resend')
    } finally {
      setResending(false)
    }
  }

  const copyLink = (url) => {
    if (url) navigator.clipboard.writeText(url).catch(() => {})
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Interviews</h2>
          <p className="text-sm text-slate-500 mt-1">Schedule and track candidate interviews with meeting integration.</p>
        </div>
        {canManage && (
          <button onClick={() => { setShowCreate(true); setFormError(''); setCreateResult(null); setForm({ interview_type: 'PHYSICAL', platform: 'Google Meet', duration_minutes: 30 }) }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
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
          { key: 'platform', label: 'Platform', render: (r) => r.platform || r.location || '-' },
          { key: 'notification_status', label: 'Email', render: (r) => <NotifBadge status={r.notification_status} /> },
          { key: 'status', label: 'Status', render: (r) => status(r.status, ['completed', 'confirmed', 'passed']) },
          { key: 'actions', label: '', render: (r) => (
            <button onClick={() => { setShowDetails(r); setFormError('') }} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
              <Eye className="w-3.5 h-3.5" /> Details
            </button>
          ) },
        ]}
      />

      {/* Create Interview Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Schedule Interview</h3>
              <button onClick={() => { setShowCreate(false); setCreateResult(null) }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            {/* Loading overlay */}
            {creating && (
              <div className="flex items-center gap-3 p-4 rounded-lg bg-blue-50 border border-blue-100 mb-4">
                <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                <div>
                  <p className="text-sm font-medium text-blue-900">{createStep || 'Processing...'}</p>
                  <p className="text-xs text-blue-500">Please wait while we set up the interview.</p>
                </div>
              </div>
            )}

            {/* Success/Error result */}
            {createResult && (
              <div className={`p-4 rounded-lg border mb-4 ${createResult.errors.length === 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                <div className="flex items-center gap-2 mb-2">
                  {createResult.errors.length === 0 ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <AlertCircle className="w-5 h-5 text-amber-600" />}
                  <p className="text-sm font-medium text-slate-900">{createResult.errors.length === 0 ? 'Interview scheduled successfully!' : 'Interview created with warnings'}</p>
                </div>
                <div className="space-y-1 text-xs text-slate-600">
                  <p>✓ Interview record created</p>
                  {createResult.steps.meeting?.status === 'created' && <p>✓ {form.platform} meeting created — {createResult.steps.meeting.meetingUrl?.slice(0, 50)}...</p>}
                  {createResult.steps.meeting?.status === 'not_connected' && <p>⚠ {form.platform} not connected — manual link needed</p>}
                  {createResult.steps.meeting?.status === 'not_configured' && <p>⚠ {form.platform} not configured — manual link needed</p>}
                  {createResult.steps.email?.status === 'sent' && <p>✓ Candidate notification sent</p>}
                  {createResult.steps.email?.status === 'not_configured' && <p>⚠ Email provider not configured</p>}
                  {createResult.steps.email?.status === 'failed' && <p>⚠ Email failed — you can resend later</p>}
                  {createResult.errors.map((e, i) => <p key={i} className="text-amber-600">⚠ {e}</p>)}
                </div>
              </div>
            )}

            {formError && <p className="text-sm text-rose-600 mb-3">{formError}</p>}

            {!createResult && (
              <div className="space-y-4">
                {/* Step 1: Candidate */}
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase mb-2">Step 1 — Candidate</label>
                  <select className={inputCls} value={form.candidate_id || ''} onChange={onCandidateChange} disabled={creating}>
                    <option value="">Select candidate…</option>
                    {candidates.map((c) => <option key={c.id} value={c.id}>{c.full_name} — {c.email || 'No email'}</option>)}
                  </select>
                </div>

                {form.candidate_id && (
                  <>
                    <div>
                      <label className={labelCls}>Candidate Email</label>
                      <input className={inputCls} value={form.candidate_email || ''} onChange={onEmailChange} placeholder="Auto-filled — editable" disabled={creating} />
                      {form.email_override && <p className="text-xs text-amber-600 mt-1">⚠ Email manually overridden</p>}
                    </div>
                    <div><label className={labelCls}>Position</label><input className={inputCls} value={form.position || ''} onChange={set('position')} placeholder="Auto-filled from candidate" disabled={creating} /></div>
                  </>
                )}

                {/* Step 2: Interview details */}
                {form.candidate_id && (
                  <>
                    <div className="border-t border-slate-100 pt-4">
                      <label className="block text-xs font-semibold text-slate-400 uppercase mb-2">Step 2 — Interview Details</label>
                      <div>
                        <label className={labelCls}>Interview Type</label>
                        <div className="flex gap-2">
                          {INTERVIEW_TYPES.map((t) => (
                            <button key={t} type="button" onClick={() => setForm((f) => ({ ...f, interview_type: t }))} disabled={creating}
                              className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium ${form.interview_type === t ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600'}`}>
                              {t === 'VIRTUAL' ? <Video className="w-4 h-4 inline mr-1" /> : <MapPin className="w-4 h-4 inline mr-1" />}
                              {t.charAt(0) + t.slice(1).toLowerCase()}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {form.interview_type === 'PHYSICAL' && (
                      <div><label className={labelCls}>Location</label><input className={inputCls} value={form.location || ''} onChange={set('location')} placeholder="Office address or meeting room" disabled={creating} /></div>
                    )}

                    {form.interview_type === 'VIRTUAL' && (
                      <>
                        {/* Step 3: Meeting setup */}
                        <div className="border-t border-slate-100 pt-4">
                          <label className="block text-xs font-semibold text-slate-400 uppercase mb-2">Step 3 — Meeting Setup</label>
                          <div className="mb-3">
                            <label className={labelCls}>Platform</label>
                            <div className="flex gap-2">
                              {PLATFORMS.map((p) => (
                                <button key={p} type="button" onClick={() => setForm((f) => ({ ...f, platform: p }))} disabled={creating}
                                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium ${form.platform === p ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600'}`}>
                                  {p}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Connection status */}
                          {form.platform === 'Google Meet' && (
                            <div className="space-y-2">
                              <ConnectionBadge connected={googleConnected} label="Google Calendar" onClick={handleConnectGoogle} />
                              {!googleConnected && (
                                <div>
                                  <p className="text-xs text-slate-400 mb-1">Google Calendar not connected. Enter a meeting link manually:</p>
                                  <input className={inputCls} value={form.meeting_url || ''} onChange={set('meeting_url')} placeholder="Manual meeting link" disabled={creating} />
                                </div>
                              )}
                              {googleConnected && <p className="text-xs text-emerald-600">✓ Meeting will be created automatically via Google Calendar.</p>}
                            </div>
                          )}

                          {form.platform === 'Zoom' && (
                            <div className="space-y-2">
                              <ConnectionBadge connected={zoomConnected} label="Zoom" onClick={handleConnectZoom} />
                              {!zoomConnected && (
                                <div>
                                  <p className="text-xs text-slate-400 mb-1">Zoom not connected. Enter a meeting link manually:</p>
                                  <input className={inputCls} value={form.meeting_url || ''} onChange={set('meeting_url')} placeholder="Manual meeting link" disabled={creating} />
                                </div>
                              )}
                              {zoomConnected && <p className="text-xs text-emerald-600">✓ Meeting will be created automatically via Zoom.</p>}
                            </div>
                          )}

                          {form.platform === 'Other' && (
                            <div>
                              <input className={inputCls} value={form.meeting_url || ''} onChange={set('meeting_url')} placeholder="Enter meeting URL" disabled={creating} />
                              <p className="text-xs text-slate-400 mt-1">Manual meeting link</p>
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                      <div><label className={labelCls}>Date & Time *</label><input type="datetime-local" className={inputCls} value={form.scheduled_date || ''} onChange={set('scheduled_date')} disabled={creating} /></div>
                      <div><label className={labelCls}>Duration (min)</label><input type="number" className={inputCls} value={form.duration_minutes || 30} onChange={set('duration_minutes')} disabled={creating} /></div>
                    </div>

                    <div><label className={labelCls}>Interview Instructions (optional)</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.interview_instructions || ''} onChange={set('interview_instructions')} placeholder="Instructions for the candidate..." disabled={creating} /></div>
                  </>
                )}
              </div>
            )}

            {/* Action buttons */}
            {!createResult && (
              <div className="flex justify-end gap-2 pt-4">
                <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={create} disabled={creating || !form.candidate_id} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarPlus className="w-4 h-4" />} Schedule
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Interview Details Modal */}
      {showDetails && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Interview Details</h3>
              <button onClick={() => setShowDetails(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            {formError && <p className="text-sm text-rose-600 mb-3">{formError}</p>}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div><p className="text-xs font-semibold text-slate-400 uppercase">Candidate</p><p className="text-sm text-slate-800 font-medium">{showDetails.candidate_name || '-'}</p></div>
                <div><p className="text-xs font-semibold text-slate-400 uppercase">Email</p><p className="text-sm text-slate-800">{showDetails.candidate_email || '-'}</p></div>
                <div><p className="text-xs font-semibold text-slate-400 uppercase">Position</p><p className="text-sm text-slate-800">{showDetails.position || '-'}</p></div>
                <div><p className="text-xs font-semibold text-slate-400 uppercase">Type</p><p className="text-sm text-slate-800">{showDetails.interview_type === 'VIRTUAL' ? 'Virtual' : 'Physical'}</p></div>
                <div><p className="text-xs font-semibold text-slate-400 uppercase">Date & Time</p><p className="text-sm text-slate-800">{date(showDetails.scheduled_date)}</p></div>
                <div><p className="text-xs font-semibold text-slate-400 uppercase">Duration</p><p className="text-sm text-slate-800">{showDetails.duration_minutes || 30} min</p></div>
                {showDetails.interview_type === 'PHYSICAL' && <div><p className="text-xs font-semibold text-slate-400 uppercase">Location</p><p className="text-sm text-slate-800">{showDetails.location || '-'}</p></div>}
                {showDetails.interview_type === 'VIRTUAL' && <div><p className="text-xs font-semibold text-slate-400 uppercase">Platform</p><p className="text-sm text-slate-800">{showDetails.platform || '-'}</p></div>}
                <div><p className="text-xs font-semibold text-slate-400 uppercase">Status</p><div>{status(showDetails.status, ['completed', 'confirmed', 'passed'])}</div></div>
                <div><p className="text-xs font-semibold text-slate-400 uppercase">Notification</p><NotifBadge status={showDetails.notification_status} /></div>
              </div>

              {showDetails.meeting_url && (
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                  <p className="text-xs font-semibold text-slate-400 uppercase mb-1">Meeting Link</p>
                  <div className="flex items-center gap-2">
                    <a href={showDetails.meeting_url} target="_blank" rel="noreferrer" className="text-sm text-[#009944] hover:underline flex-1 truncate">{showDetails.meeting_url}</a>
                    <button onClick={() => copyLink(showDetails.meeting_url)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 text-xs text-slate-600 hover:bg-slate-100"><Copy className="w-3 h-3" /> Copy</button>
                  </div>
                  {showDetails.external_provider && <p className="text-xs text-slate-400 mt-1">Provider: {showDetails.external_provider} {showDetails.external_event_id && `· Event ID: ${showDetails.external_event_id.slice(0, 12)}...`}</p>}
                </div>
              )}

              {showDetails.interview_instructions && (
                <div><p className="text-xs font-semibold text-slate-400 uppercase mb-1">Instructions</p><p className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3">{showDetails.interview_instructions}</p></div>
              )}

              {showDetails.notification_error && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 p-3"><p className="text-xs text-rose-600">{showDetails.notification_error}</p></div>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-4 border-t border-slate-100 mt-4">
              {showDetails.meeting_url && (
                <a href={showDetails.meeting_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700">
                  <Video className="w-4 h-4" /> Join Meeting
                </a>
              )}
              <button onClick={() => copyLink(showDetails.meeting_url)} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-sm font-medium hover:bg-slate-50">
                <Copy className="w-4 h-4" /> Copy Link
              </button>
              <button onClick={() => setShowResendConfirm(showDetails)} disabled={resending} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-sm font-medium hover:bg-slate-50 disabled:opacity-60">
                {resending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Resend Invitation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resend Confirmation */}
      {showResendConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center"><MailWarning className="w-5 h-5 text-amber-600" /></div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Resend Invitation?</h3>
                <p className="text-sm text-slate-500">This will send another email to {showResendConfirm.candidate_email}.</p>
              </div>
            </div>
            {formError && <p className="text-sm text-rose-600 mb-3">{formError}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowResendConfirm(null); setFormError('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={() => resendEmail(showResendConfirm.id)} disabled={resending} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {resending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Confirm Resend
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
