import React, { useEffect, useMemo, useState } from 'react'
import { BarChart3, BookOpen, CalendarDays, CheckCircle2, ClipboardCheck, Clock3, Copy, Download, ExternalLink, Link2, MapPin, Plus, RefreshCw, Share2, Users, Video, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { trainingService, TRAINING_TYPES, buildQuestionSets, calculateTrainingManHours, formatTrainingType, hours } from '../services/trainingService'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { formatDate } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5'
const today = new Date().toISOString().slice(0, 10)

const MEETING_PLATFORMS = [
  { value: 'google_meet', label: 'Google Meet' },
  { value: 'zoom', label: 'Zoom' },
]

const blankForm = {
  title: '', training_type: 'internal', description: '', facilitator: '', training_date: today,
  start_time: '09:00', end_time: '11:00', duration_minutes: 120,
  delivery_type: 'physical', venue_id: '', venue_name: '', venue_address: '', location: '',
  meeting_platform: 'google_meet', meeting_url: '', meeting_provider_id: '', meeting_created_at: null, virtual_link: '',
  department: '', area: '', branch_id: '', assessment_required: false, certificate_enabled: false,
  is_mandatory: false, employee_ids: [], question_text: '',
}

function copyText(text, onDone) {
  const fallback = () => {
    const el = document.createElement('textarea')
    el.value = text
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    document.body.removeChild(el)
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(fallback)
  } else {
    fallback()
  }
  onDone?.()
}

// Build an ISO start/end for meeting providers from the session date + times.
function meetingStartEnd(form) {
  const start = new Date(`${form.training_date}T${form.start_time || '09:00'}`)
  const end = new Date(`${form.training_date}T${form.end_time || '11:00'}`)
  if (!Number.isNaN(end.getTime()) && end > start) return { startDateTime: start.toISOString(), endDateTime: end.toISOString() }
  const fallbackEnd = new Date(start.getTime() + (Number(form.duration_minutes) || 120) * 60000)
  return { startDateTime: start.toISOString(), endDateTime: fallbackEnd.toISOString() }
}

function sessionNotStarted(session) {
  const key = String(session.training_date || '9999-12-31')
  const todayKey = new Date().toISOString().slice(0, 10)
  if (key < todayKey) return false
  if (key > todayKey) return true
  const now = new Date().toTimeString().slice(0, 5)
  return now < (session.start_time || '23:59')
}

export default function Training() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('hr.training.manage')
  const [tab, setTab] = useState('dashboard')
  const [form, setForm] = useState(blankForm)
  const [sessions, setSessions] = useState([])
  const [employees, setEmployees] = useState([])
  const [venues, setVenues] = useState([])
  const [options, setOptions] = useState({ areas: [], branches: [], departments: [] })
  const [dashboard, setDashboard] = useState(null)
  const [dateRange, setDateRange] = useState({ startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10), endDate: today })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [sessionSearch, setSessionSearch] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [sessionRows, employeeRows, venueRows, filterOptions, dashboardData] = await Promise.all([
        trainingService.listSessions(),
        canManage ? trainingService.listEmployees() : Promise.resolve([]),
        canManage ? trainingService.listVenues() : Promise.resolve([]),
        trainingService.getFilterOptions(),
        trainingService.getDashboard(dateRange),
      ])
      setSessions(sessionRows)
      setEmployees(employeeRows)
      setVenues(venueRows)
      setOptions(filterOptions)
      setDashboard(dashboardData)
    } catch (e) {
      setError(e?.message || 'Training data could not be loaded. Run the Phase 51 migration first if this is a new environment.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((session) => [session.title, session.facilitator, session.training_type, session.department, session.area, session.venue_name, session.branches?.branch_name].some((value) => String(value || '').toLowerCase().includes(q)))
  }, [sessions, sessionSearch])

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const createSession = async (event) => {
    event.preventDefault()
    setBusy(true); setError(''); setMessage('')
    try {
      if (!form.title.trim() || !form.facilitator.trim()) throw new Error('Title and facilitator are required.')
      if (form.employee_ids.length === 0) throw new Error('Assign at least one participant.')
      if (form.delivery_type === 'physical' && !form.venue_id && !form.venue_name.trim()) {
        throw new Error('Select a physical location/venue for this training.')
      }
      if (form.delivery_type === 'virtual') {
        if (!form.meeting_platform) throw new Error('Select a meeting platform (Google Meet or Zoom).')
        if (!form.meeting_url.trim()) throw new Error('Generate a real meeting link before creating the session. A free-typed link is not accepted.')
      }
      const isKss = form.training_type === 'kss' || form.assessment_required
      const needsAssessment = isKss || form.assessment_required
      const questionBank = needsAssessment ? parseQuestionBank(form.question_text) : []
      const isVirtual = form.delivery_type === 'virtual'
      const payload = {
        title: form.title.trim(), training_type: form.training_type, description: form.description.trim() || null,
        facilitator: form.facilitator.trim(), training_date: form.training_date, start_time: form.start_time || null,
        end_time: form.end_time || null, duration_minutes: Number(form.duration_minutes),
        delivery_type: form.delivery_type,
        venue_id: form.venue_id || null,
        venue_name: isVirtual ? null : (form.venue_name.trim() || form.location.trim() || null),
        venue_address: isVirtual ? null : (form.venue_address.trim() || null),
        location: isVirtual ? null : (form.venue_name.trim() || form.location.trim() || null),
        meeting_platform: isVirtual ? form.meeting_platform : null,
        meeting_url: isVirtual ? form.meeting_url.trim() : null,
        meeting_provider_id: isVirtual ? form.meeting_provider_id || null : null,
        meeting_created_at: isVirtual ? form.meeting_created_at || null : null,
        virtual_link: isVirtual ? form.meeting_url.trim() : null,
        department: form.department || null, area: form.area || null,
        branch_id: form.branch_id || null, assessment_required: isKss || form.assessment_required,
        certificate_enabled: form.certificate_enabled, is_mandatory: form.is_mandatory, status: 'scheduled',
      }
      const created = await trainingService.createSession(payload)
      if (needsAssessment) {
        const questionSets = buildQuestionSets(questionBank)
        await trainingService.generateQuestionSets(created.id, isKss ? questionSets : [questionSets[0]])
      }
      await trainingService.assignParticipants(created.id, form.employee_ids)
      setForm(blankForm)
      setMessage(`Training session created and assigned to ${form.employee_ids.length} employee${form.employee_ids.length === 1 ? '' : 's'}.`)
      setTab('sessions')
      await load()
    } catch (e) {
      setError(e?.message || 'Training session could not be created.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading training intelligence..." />

  const summary = dashboard?.summary || {}

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#009944]">HR / Training &amp; Development</p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">Training intelligence</h1>
          <p className="text-sm text-slate-500 mt-1">Individual training hours and training man-hours are reported as separate measures.</p>
        </div>
        {canManage && <button onClick={() => { setTab('create'); setError(''); setMessage('') }} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]"><Plus className="w-4 h-4" /> New training session</button>}
      </div>

      {error && <ErrorState message={error} />}
      {message && <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 px-4 py-3 text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />{message}</div>}

      <div className="flex gap-2 overflow-x-auto pb-1">
        {[
          ['dashboard', 'Dashboard'], ['sessions', 'Sessions'], ...(canManage ? [['create', 'Create training']] : []),
        ].map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${tab === id ? 'bg-[#009944] text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{label}</button>)}
        <Link to="/man-hour-intelligence" className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944] whitespace-nowrap"><BarChart3 className="w-4 h-4" /> Workforce man-hours</Link>
      </div>

      {tab === 'dashboard' && <TrainingDashboard summary={summary} dashboard={dashboard} dateRange={dateRange} setDateRange={setDateRange} onRefresh={async () => { setLoading(true); try { setDashboard(await trainingService.getDashboard(dateRange)) } catch (e) { setError(e?.message || 'Dashboard could not be refreshed.') } finally { setLoading(false) } }} onOpenSessions={() => setTab('sessions')} />}
      {tab === 'sessions' && <SessionsTab sessions={filteredSessions} search={sessionSearch} setSearch={setSessionSearch} onRefresh={load} canManage={canManage} />}
      {tab === 'create' && (canManage ? <CreateTraining form={form} set={set} employees={employees} venues={venues} options={options} busy={busy} onSubmit={createSession} /> : <ErrorState title="Training management restricted" message="Your role can view training intelligence but cannot create or assign sessions." />)}
    </div>
  )
}

function TrainingDashboard({ summary, dashboard, dateRange, setDateRange, onRefresh, onOpenSessions }) {
  const cards = [
    { label: 'Employee training hours', value: `${summary.training_hours || 0}h`, icon: Clock3, hint: 'Completed per employee' },
    { label: 'Training man-hours', value: `${summary.training_man_hours || 0}h`, icon: Users, hint: 'Duration x participants' },
    { label: 'Employees trained', value: summary.employees_trained || 0, icon: Users, hint: 'Distinct employees' },
    { label: 'Trainings conducted', value: summary.trainings_conducted || 0, icon: BookOpen, hint: 'Sessions delivered' },
    { label: 'KSS sessions', value: summary.kss_sessions || 0, icon: ClipboardCheck, hint: 'Knowledge sharing' },
    { label: 'Certificates issued', value: summary.certificates_issued || 0, icon: CheckCircle2, hint: 'Valid certificates' },
    { label: 'Average assessment', value: summary.average_assessment_score == null ? '—' : `${summary.average_assessment_score}%`, icon: BarChart3, hint: 'Submitted assessments' },
    { label: 'Completion percentage', value: `${summary.completion_percentage || 0}%`, icon: CalendarDays, hint: 'Assigned participants' },
  ]
  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row gap-3 sm:items-end">
        <div><label className={labelCls}>From</label><input type="date" className={inputCls} value={dateRange.startDate} onChange={(e) => setDateRange((r) => ({ ...r, startDate: e.target.value }))} /></div>
        <div><label className={labelCls}>To</label><input type="date" className={inputCls} value={dateRange.endDate} onChange={(e) => setDateRange((r) => ({ ...r, endDate: e.target.value }))} /></div>
        <button onClick={onRefresh} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-600 hover:bg-slate-50"><RefreshCw className="w-4 h-4" /> Apply</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map(({ label, value, icon: Icon, hint }) => <button key={label} onClick={onOpenSessions} className="text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-[#009944]/50 hover:shadow-sm transition"><div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="text-2xl font-semibold text-slate-900 mt-2">{value}</p><p className="text-xs text-slate-400 mt-1">{hint}</p></div><div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center"><Icon className="w-5 h-5 text-[#009944]" /></div></div><p className="text-[11px] text-[#009944] mt-3">View underlying sessions</p></button>)}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <ChartCard title="Training hours by month" rows={dashboard?.monthly || []} labelKey="month" valueKey="hours" suffix="h" />
        <ChartCard title="Training hours by area" rows={dashboard?.by_area || []} labelKey="area" valueKey="hours" suffix="h" />
        <ChartCard title="Training hours by branch" rows={dashboard?.by_branch || []} labelKey="branch" valueKey="hours" suffix="h" />
        <ChartCard title="Training hours by department" rows={dashboard?.by_department || []} labelKey="department" valueKey="hours" suffix="h" />
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-5"><div className="flex items-center justify-between gap-3 mb-4"><div><h2 className="font-semibold text-slate-900">Mandatory training completion</h2><p className="text-xs text-slate-500 mt-1">Completion is based on assigned participants, not attendance rows.</p></div><Link to="/man-hour-intelligence" className="text-sm text-[#009944] hover:underline">Open man-hour intelligence</Link></div>{(dashboard?.mandatory || []).length === 0 ? <EmptyState title="No mandatory training in this range" /> : <div className="space-y-3">{dashboard.mandatory.map((row) => <div key={row.session_id} className="flex flex-col sm:flex-row sm:items-center gap-2"><div className="flex-1 min-w-0"><p className="text-sm font-medium text-slate-800 truncate">{row.title}</p><p className="text-xs text-slate-400">{row.completed} of {row.assigned} participants completed</p></div><div className="w-full sm:w-48 h-2 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-[#009944]" style={{ width: `${Math.min(100, row.completion_percentage || 0)}%` }} /></div><span className="text-sm font-semibold text-slate-700 w-14 text-right">{row.completion_percentage || 0}%</span></div>)}</div>}</div>
    </div>
  )
}

function ChartCard({ title, rows, labelKey, valueKey, suffix }) {
  const max = Math.max(...rows.map((row) => Number(row[valueKey] || 0)), 1)
  return <div className="bg-white border border-slate-200 rounded-xl p-5"><div className="flex items-center justify-between mb-5"><h2 className="font-semibold text-slate-900">{title}</h2><BarChart3 className="w-4 h-4 text-[#009944]" /></div>{rows.length === 0 ? <div className="h-40 flex items-center justify-center text-sm text-slate-400">No records in this range.</div> : <div className="h-40 flex items-end gap-2 overflow-x-auto pb-5">{rows.slice(-12).map((row) => { const value = Number(row[valueKey] || 0); return <div key={row[labelKey]} className="h-full min-w-[48px] flex-1 flex flex-col items-center justify-end gap-2"><span className="text-[10px] text-slate-500">{value}{suffix}</span><div className="w-full max-w-10 rounded-t-md bg-gradient-to-t from-[#007a4a] to-[#00a85a]" style={{ height: `${Math.max(5, (value / max) * 100)}%` }} /><span className="text-[10px] text-slate-400 truncate max-w-16" title={row[labelKey]}>{row[labelKey]}</span></div> })}</div>}</div>
}

function SessionsTab({ sessions, search, setSearch, onRefresh, canManage }) {
  const [meetingSession, setMeetingSession] = useState(null)
  const [attendanceSession, setAttendanceSession] = useState(null)
  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Training sessions</h2>
          <p className="text-sm text-slate-500">Each row is a scheduled training event; participants and completions remain separate records.</p>
        </div>
        <input className={`${inputCls} sm:w-80`} placeholder="Search title, facilitator, branch, venue..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {sessions.length === 0 ? <EmptyState title="No training sessions" description="Create a session to start assigning training." /> :
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>{['Training', 'Type', 'Date', 'Organisation', 'Duration', 'Delivery', 'Status', ...(canManage ? ['Meeting'] : [])].map((label) => <th key={label} className="px-4 py-3 font-medium whitespace-nowrap">{label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sessions.map((session) => (
                <tr key={session.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3"><p className="font-medium text-slate-900">{session.title}</p><p className="text-xs text-slate-400">{session.facilitator}</p></td>
                  <td className="px-4 py-3 capitalize">{formatTrainingType(session.training_type)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDate(session.training_date)}</td>
                  <td className="px-4 py-3"><span>{session.branches?.branch_name || 'All branches'}</span><span className="block text-xs text-slate-400">{session.department || session.area || 'Organisation-wide'}</span></td>
                  <td className="px-4 py-3">{hours(session.duration_minutes)}h</td>
                  <td className="px-4 py-3"><DeliveryCell session={session} /></td>
                  <td className="px-4 py-3"><span className={`inline-flex px-2 py-1 rounded-full text-xs border ${session.status === 'completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : session.status === 'cancelled' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{session.status}</span></td>
                  {canManage && <td className="px-4 py-3"><div className="flex flex-wrap gap-1.5"><button onClick={() => setMeetingSession(session)} title="Manage meeting/venue" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]">{session.meeting_url ? <Link2 className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}{session.meeting_url ? 'Meeting' : session.delivery_type === 'virtual' ? 'Generate' : 'Venue'}</button><button onClick={() => setAttendanceSession(session)} title="Manage attendance link and completion" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]">{session.attendance_token ? <CheckCircle2 className="w-3.5 h-3.5 text-[#009944]" /> : <Link2 className="w-3.5 h-3.5" />}Attendance</button></div></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      {meetingSession && canManage && <SessionMeetingPanel session={meetingSession} onClose={() => setMeetingSession(null)} onRefresh={async () => { await onRefresh(); setMeetingSession(null) }} />}
      {attendanceSession && canManage && <SessionAttendancePanel session={attendanceSession} onClose={() => setAttendanceSession(null)} onRefresh={async () => { await onRefresh(); setAttendanceSession(null) }} />}
    </div>
  )
}

function DeliveryCell({ session }) {
  if (session.delivery_type === 'virtual') {
    return <span className="inline-flex items-center gap-1.5 text-slate-700"><Video className="w-3.5 h-3.5 text-[#009944]" />{session.meeting_platform === 'zoom' ? 'Zoom' : 'Google Meet'}{!session.meeting_url && <span className="text-slate-400"> · no link</span>}</span>
  }
  return <span className="inline-flex items-center gap-1.5 text-slate-700"><MapPin className="w-3.5 h-3.5 text-[#009944]" />{session.venue_name || session.location || 'Physical'}</span>
}

function SessionMeetingPanel({ session, onClose, onRefresh }) {
  const [platform, setPlatform] = useState(session.meeting_platform || 'google_meet')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const hasMeeting = Boolean(session.meeting_url)

  const generate = async (regenerate = false) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const { startDateTime, endDateTime } = meetingStartEnd(session)
      const result = await trainingService.generateMeetingLink({
        platform,
        title: session.title,
        description: session.description || '',
        startDateTime,
        endDateTime,
        durationMinutes: session.duration_minutes,
        sessionId: session.id,
      })
      if (result.status !== 'created' || !result.meetingUrl) {
        if (result.status === 'not_configured') throw new Error('Provider integration is not configured. Connect Google Calendar/Meet or Zoom before generating a meeting link.')
        if (result.status === 'not_connected') throw new Error('Your provider account is not connected. Complete the OAuth connection first.')
        throw new Error(result.error || 'The meeting could not be created by the provider.')
      }
      await trainingService.attachMeeting(session.id, { ...result, platform })
      setNotice(regenerate ? 'Meeting regenerated and saved.' : 'Meeting created and saved.')
      await onRefresh()
    } catch (e) {
      setError(e?.message || 'Meeting could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  if (session.delivery_type !== 'virtual') {
    return (
      <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <h3 className="font-semibold text-slate-900">Venue — {session.title}</h3>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
          </div>
          <div className="p-5 space-y-3 text-sm">
            <p className="flex items-center gap-2 text-slate-700"><MapPin className="w-4 h-4 text-[#009944]" />{session.venue_name || session.location || 'Not specified'}</p>
            {session.venue_address && <p className="text-slate-500 pl-6">{session.venue_address}</p>}
            <p className="text-slate-500">Physical training uses the existing attendance workflow (participant attendance + signature).</p>
            <div className="flex justify-end gap-2 pt-2"><button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50">Close</button></div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">Meeting — {session.title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          {error && <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 text-sm">{error}</div>}
          {notice && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 px-3 py-2 text-sm">{notice}</div>}

          {hasMeeting ? (
            <>
              <div>
                <label className={labelCls}>Meeting platform</label>
                <p className="text-sm font-medium text-slate-800">{session.meeting_platform === 'zoom' ? 'Zoom' : 'Google Meet'}</p>
              </div>
              <div>
                <label className={labelCls}>Meeting link</label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-700 break-all">{session.meeting_url}</code>
                  <button onClick={() => copyText(session.meeting_url, () => setNotice('Link copied.'))} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><Copy className="w-3.5 h-3.5" /> Copy</button>
                  <a href={session.meeting_url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><ExternalLink className="w-3.5 h-3.5" /> Open</a>
                </div>
              </div>
              {sessionNotStarted(session) && (
                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <span className="text-xs text-slate-500">Regenerate (current meeting already created)</span>
                  <button onClick={() => generate(true)} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#009944] px-3 text-xs font-medium text-white hover:bg-[#007a36] disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Regenerate</button>
                </div>
              )}
            </>
          ) : (
            <>
              <div>
                <label className={labelCls}>Meeting platform</label>
                <select className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value)}>
                  {MEETING_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <button onClick={() => generate(false)} disabled={busy} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#009944] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-50"><Video className="w-4 h-4" /> {busy ? 'Creating meeting...' : 'Generate Meeting Link'}</button>
              <p className="text-xs text-slate-400">Creates a real {platform === 'zoom' ? 'Zoom' : 'Google Meet'} meeting via the server-side provider integration using this session's date and time.</p>
            </>
          )}
          <div className="flex justify-end gap-2 pt-2"><button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50">Close</button></div>
        </div>
      </div>
    </div>
  )
}

function SessionAttendancePanel({ session, onClose, onRefresh }) {
  const [token, setToken] = useState(session.attendance_token || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [completion, setCompletion] = useState(null)
  const link = token ? trainingService.buildTrainingAttendanceUrl(token) : ''

  const loadCompletion = async () => {
    if (!session.id) return
    setError('')
    try {
      setCompletion(await trainingService.getTrainingSessionCompletion(session.id))
    } catch (e) {
      setError(e?.message || 'Completion statistics could not be loaded.')
    }
  }

  useEffect(() => { loadCompletion() }, [session.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async (regenerate = false) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await trainingService.generateTrainingAttendanceLink(session.id, regenerate)
      setToken(result.token)
      setNotice(regenerate ? 'A new attendance link was generated. The previous link is no longer valid.' : 'Attendance link generated.')
      await onRefresh()
    } catch (e) {
      setError(e?.message || 'The attendance link could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  const share = async () => {
    if (!link) return
    if (navigator.share) {
      try { await navigator.share({ title: `Training attendance — ${session.title}`, text: 'Complete your training attendance here:', url: link }) } catch { setNotice('Share cancelled.') }
    } else {
      copyText(link, () => setNotice('Link copied to clipboard.'))
    }
  }

  const summary = completion?.summary || {}
  const rows = completion?.participants || []

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">Attendance link — {session.title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-5">
          {error && <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 text-sm">{error}</div>}
          {notice && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 px-3 py-2 text-sm">{notice}</div>}

          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Public training attendance</p>
            {link ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-700 break-all">{link}</code>
                  <button onClick={() => copyText(link, () => setNotice('Link copied.'))} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><Copy className="w-3.5 h-3.5" /> Copy</button>
                  <a href={link} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><ExternalLink className="w-3.5 h-3.5" /> Open</a>
                  <button onClick={share} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><Share2 className="w-3.5 h-3.5" /> Share</button>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <span className="text-xs text-slate-500">Regenerate (previous link stops working)</span>
                  <button onClick={() => generate(true)} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#009944] px-3 text-xs font-medium text-white hover:bg-[#007a36] disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Regenerate</button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button onClick={() => generate(false)} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-[#009944] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-50"><Link2 className="w-4 h-4" /> {busy ? 'Generating...' : 'Generate Attendance Link'}</button>
                <p className="text-xs text-slate-400">Opens a public page where assigned employees enter their Employee ID, answer three assigned questions, sign and complete the training. No login required.</p>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Training completion</p>
              <button onClick={loadCompletion} className="inline-flex items-center gap-1.5 text-xs font-medium text-[#009944] hover:underline"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[['Assigned', summary.assigned ?? 0, 'text-slate-900'], ['Started', summary.started ?? 0, 'text-slate-900'], ['Completed', summary.completed ?? 0, 'text-emerald-600'], ['Pending', summary.pending ?? 0, 'text-amber-600'], ['Passed', summary.passed ?? 0, 'text-emerald-600'], ['Failed', summary.failed ?? 0, 'text-rose-600'], ['Certificates', summary.certificates ?? 0, 'text-[#009944]']].map(([label, value, tone]) => (
                <div key={label} className={`rounded-lg border border-slate-200 px-3 py-2.5`}><p className={`text-lg font-semibold leading-tight ${tone}`}>{value}</p><p className="text-[11px] uppercase tracking-wide text-slate-500 mt-0.5">{label}</p></div>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>{['Participant', 'Employee ID', 'Assessment', 'Score', 'Status', 'Signature', 'Certificate', 'Completed'].map((label) => <th key={label} className="px-4 py-3 font-medium whitespace-nowrap text-xs">{label}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-sm text-slate-400">No participants assigned yet.</td></tr>}
                {rows.map((row) => (
                  <tr key={row.participant_id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><p className="font-medium text-slate-800">{row.full_name}</p><p className="text-xs text-slate-400">{row.department || '—'}{row.branch ? ` · ${row.branch}` : ''}</p></td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{row.employee_number || '—'}</td>
                    <td className="px-4 py-3">{row.assessment_status ? <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] border border-slate-200 bg-slate-50 text-slate-600 capitalize">{row.assessment_status}</span> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="px-4 py-3">{row.percentage == null ? <span className="text-xs text-slate-400">—</span> : <span className={row.passed ? 'text-emerald-600 font-semibold' : 'text-rose-600 font-semibold'}>{row.percentage}%</span>}</td>
                    <td className="px-4 py-3"><span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] border capitalize ${row.participant_status === 'completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : row.participant_status === 'failed' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{row.participant_status}</span></td>
                    <td className="px-4 py-3">{row.signature_submitted ? <span className="inline-flex items-center gap-1 text-emerald-600 text-xs"><CheckCircle2 className="w-3.5 h-3.5" /> Signed</span> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="px-4 py-3">{row.certificate_number ? <span className="font-mono text-[11px] text-[#009944]">{row.certificate_number}</span> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{row.completed_at ? new Date(row.completed_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end pt-1"><button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50">Close</button></div>
        </div>
      </div>
    </div>
  )
}

function CreateTraining({ form, set, employees, venues, options, busy, onSubmit }) {
  const selected = new Set(form.employee_ids)
  const toggleEmployee = (id) => set('employee_ids', selected.has(id) ? form.employee_ids.filter((item) => item !== id) : [...form.employee_ids, id])
  const isKss = form.training_type === 'kss' || form.assessment_required
  const [meetingBusy, setMeetingBusy] = useState(false)
  const [meetingError, setMeetingError] = useState('')
  const [meetingOk, setMeetingOk] = useState('')

  const selectVenue = (branchId) => {
    const branch = venues.find((b) => b.id === branchId)
    set('venue_id', branchId || '')
    set('venue_name', branch?.branch_name || '')
    set('venue_address', branch?.location || '')
  }

  const generateMeeting = async () => {
    setMeetingError(''); setMeetingOk('')
    if (!form.title.trim()) { setMeetingError('Enter the training title before generating a meeting link.'); return }
    if (!form.training_date || !form.start_time) { setMeetingError('Enter the training date and start time before generating a meeting link.'); return }
    setMeetingBusy(true)
    try {
      const { startDateTime, endDateTime } = meetingStartEnd(form)
      const result = await trainingService.generateMeetingLink({
        platform: form.meeting_platform,
        title: form.title.trim(),
        description: form.description.trim(),
        startDateTime,
        endDateTime,
        durationMinutes: form.duration_minutes,
      })
      if (result.status !== 'created' || !result.meetingUrl) {
        if (result.status === 'not_configured') throw new Error(form.meeting_platform === 'zoom' ? 'Zoom integration is not configured. Connect Zoom before generating a meeting link.' : 'Google Meet integration is not configured. Connect Google Calendar/Meet before generating a meeting link.')
        if (result.status === 'not_connected') throw new Error('Your provider account is not connected. Complete the OAuth connection first.')
        throw new Error(result.error || 'The meeting could not be created by the provider.')
      }
      set('meeting_platform', form.meeting_platform)
      set('meeting_url', result.meetingUrl)
      set('meeting_provider_id', result.externalMeetingId || result.externalEventId || '')
      set('meeting_created_at', new Date().toISOString())
      setMeetingOk(`Real ${form.meeting_platform === 'zoom' ? 'Zoom' : 'Google Meet'} meeting created via the provider API.`)
    } catch (e) {
      setMeetingError(e?.message || 'Meeting could not be generated.')
    } finally {
      setMeetingBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-start gap-3 mb-5">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center"><BookOpen className="w-5 h-5 text-[#009944]" /></div>
          <div><h2 className="font-semibold text-slate-900">Create training session</h2><p className="text-sm text-slate-500 mt-1">KSS sessions automatically receive three rotated question sets before assignment.</p></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <Field label="Title" value={form.title} onChange={(v) => set('title', v)} required />
          <Field label="Training type" type="select" value={form.training_type} onChange={(v) => set('training_type', v)} options={TRAINING_TYPES.map((item) => ({ value: item.value, label: item.label }))} />
          <Field label="Facilitator" value={form.facilitator} onChange={(v) => set('facilitator', v)} required />
          <Field label="Date" type="date" value={form.training_date} onChange={(v) => set('training_date', v)} />
          <Field label="Start time" type="time" value={form.start_time} onChange={(v) => set('start_time', v)} />
          <Field label="End time" type="time" value={form.end_time} onChange={(v) => set('end_time', v)} />
          <Field label="Duration (minutes)" type="number" value={form.duration_minutes} onChange={(v) => set('duration_minutes', v)} />
          <Field label="Training delivery" type="select" value={form.delivery_type} onChange={(v) => set('delivery_type', v)} options={[{ value: 'physical', label: 'Physical' }, { value: 'virtual', label: 'Virtual' }]} required />
          {form.delivery_type === 'physical' ? (
            <div className="md:col-span-2">
              <label className={labelCls}>Location / Venue<span className="text-rose-500"> *</span></label>
              <select className={inputCls} value={form.venue_id} onChange={(e) => selectVenue(e.target.value)}>
                <option value="">Select a physical location or venue...</option>
                {venues.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_name}</option>)}
              </select>
              {form.venue_address && <p className="text-xs text-slate-400 mt-1.5">Address: {form.venue_address}</p>}
            </div>
          ) : (
            <div className="md:col-span-2 space-y-3">
              <Field label="Meeting platform" type="select" value={form.meeting_platform} onChange={(v) => set('meeting_platform', v)} options={MEETING_PLATFORMS} />
              {form.meeting_url ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2">
                  <p className="text-xs font-semibold text-emerald-700">Meeting link (created via provider API)</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-lg bg-white border border-emerald-200 px-3 py-2 text-xs text-slate-700 break-all">{form.meeting_url}</code>
                    <button type="button" onClick={() => copyText(form.meeting_url, () => setMeetingOk('Link copied.'))} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><Copy className="w-3.5 h-3.5" /> Copy</button>
                    <a href={form.meeting_url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><ExternalLink className="w-3.5 h-3.5" /> Open</a>
                  </div>
                  <button type="button" onClick={generateMeeting} disabled={meetingBusy} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${meetingBusy ? 'animate-spin' : ''}`} /> Regenerate meeting link</button>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                  <button type="button" onClick={generateMeeting} disabled={meetingBusy} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#009944] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-50"><Video className="w-4 h-4" /> {meetingBusy ? 'Creating meeting...' : 'Generate Meeting Link'}</button>
                  <p className="text-xs text-slate-400">Creates a real meeting using the training title, date and time through the secure server-side provider integration.</p>
                </div>
              )}
              {meetingOk && <p className="text-xs text-emerald-600">{meetingOk}</p>}
              {meetingError && <p className="text-xs text-rose-600">{meetingError}</p>}
            </div>
          )}
          <Field label="Department" type="select" value={form.department} onChange={(v) => set('department', v)} options={[{ value: '', label: 'All departments' }, ...options.departments.map((d) => ({ value: d.name, label: d.name }))]} />
          <Field label="Area" type="select" value={form.area} onChange={(v) => set('area', v)} options={[{ value: '', label: 'All areas' }, ...options.areas.map((a) => ({ value: a.area_code, label: a.area_name || a.area_code }))]} />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div><h2 className="font-semibold text-slate-900">Participants</h2><p className="text-sm text-slate-500 mt-1">Pick individuals or use the filters below.</p></div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 text-emerald-700 px-3 py-1 text-xs font-semibold"><Users className="w-3.5 h-3.5" /> {form.employee_ids.length} selected</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className={labelCls}>Department</label>
            <select className={inputCls} value={form.department} onChange={(e) => set('department', e.target.value)}>
              <option value="">All departments</option>
              {options.departments.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Branch</label>
            <select className={inputCls} value={form.branch_id} onChange={(e) => set('branch_id', e.target.value)}>
              <option value="">All branches</option>
              {options.branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Area</label>
            <select className={inputCls} value={form.area} onChange={(e) => set('area', e.target.value)}>
              <option value="">All areas</option>
              {options.areas.map((a) => <option key={a.area_code} value={a.area_code}>{a.area_name || a.area_code}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button type="button" onClick={() => set('employee_ids', employees.map((e) => e.id))} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><Users className="w-3.5 h-3.5" /> Select all ({employees.length})</button>
          <button type="button" onClick={() => set('employee_ids', [])} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-rose-400 hover:text-rose-600"><X className="w-3.5 h-3.5" /> Clear</button>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 max-h-64 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {employees.length === 0 && <p className="col-span-full text-sm text-slate-400 py-6 text-center">No employees available to assign.</p>}
          {employees.map((employee) => (
            <label key={employee.id} className="flex items-start gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm cursor-pointer hover:border-[#009944]/50 hover:bg-slate-50">
              <input type="checkbox" className="mt-0.5 accent-[#009944]" checked={form.employee_ids.includes(employee.id)} onChange={() => toggleEmployee(employee.id)} />
              <span className="min-w-0"><span className="block font-medium text-slate-800 truncate">{employee.full_name}</span><span className="block text-xs text-slate-400 truncate">{employee.employee_number || employee.staff_id || employee.employee_code}{employee.department ? ` · ${employee.department}` : ''}</span></span>
            </label>
          ))}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center"><ClipboardCheck className="w-5 h-5 text-[#009944]" /></div>
          <div><h2 className="font-semibold text-slate-900">Assessment and certificate</h2><p className="text-sm text-slate-500 mt-1">Enable assessment today and the three rotated question sets are generated at creation.</p></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-3 text-sm cursor-pointer"><input type="checkbox" className="mt-0.5 accent-[#009944]" checked={form.assessment_required || isKss} onChange={(e) => set('assessment_required', e.target.checked)} /><span className="text-slate-700">Assessment required</span></label>
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-3 text-sm cursor-pointer"><input type="checkbox" className="mt-0.5 accent-[#009944]" checked={form.certificate_enabled} onChange={(e) => set('certificate_enabled', e.target.checked)} /><span className="text-slate-700">Issue certificate after passing</span></label>
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-3 text-sm cursor-pointer"><input type="checkbox" className="mt-0.5 accent-[#009944]" checked={form.is_mandatory} onChange={(e) => set('is_mandatory', e.target.checked)} /><span className="text-slate-700">Mandatory training</span></label>
        </div>
        <div className="mt-4">
          <label className={labelCls}>KSS question bank (one question per line: Question | Correct answer | Option 1, Option 2, Option 3)</label>
          <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={6} placeholder={'What is the confidentiality rule? | All customer data is confidential | We can share internally, It should be posted on social media, Only managers may access'} value={form.question_text} onChange={(e) => set('question_text', e.target.value)} />
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button type="button" onClick={() => set('employee_ids', [])} className="px-4 py-2.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50">Reset selection</button>
        <button disabled={busy} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">{busy ? 'Creating...' : 'Create and assign'}</button>
      </div>
    </form>
  )
}

function Field({ label, value, onChange, type = 'text', options = [], required = false }) {
  return <div><label className={labelCls}>{label}{required && <span className="text-rose-500"> *</span>}</label>{type === 'select' ? <select className={inputCls} value={value || ''} onChange={(e) => onChange(e.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input className={inputCls} type={type} required={required} value={value ?? ''} onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)} />}</div>
}

function parseQuestionBank(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [prompt, correct_answer, optionText] = line.split('|').map((part) => part.trim())
    const options = optionText ? optionText.split(',').map((part) => part.trim()).filter(Boolean) : [correct_answer]
    return { prompt, correct_answer, options, question_type: options.length > 1 ? 'multiple_choice' : 'short_text', marks: 1 }
  })
}