import React, { useEffect, useMemo, useState } from 'react'
import { BarChart3, BookOpen, CalendarDays, CheckCircle2, ClipboardCheck, Clock3, Download, Plus, RefreshCw, Users, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { trainingService, TRAINING_TYPES, buildQuestionSets, calculateTrainingManHours, formatTrainingType, hours } from '../services/trainingService'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { formatDate } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5'
const today = new Date().toISOString().slice(0, 10)

const blankForm = {
  title: '', training_type: 'internal', description: '', facilitator: '', training_date: today,
  start_time: '09:00', end_time: '11:00', duration_minutes: 120, location: '', virtual_link: '',
  department: '', area: '', branch_id: '', assessment_required: false, certificate_enabled: false,
  is_mandatory: false, employee_ids: [], question_text: '',
}

export default function Training() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('hr.training.manage')
  const [tab, setTab] = useState('dashboard')
  const [form, setForm] = useState(blankForm)
  const [sessions, setSessions] = useState([])
  const [employees, setEmployees] = useState([])
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
      const [sessionRows, employeeRows, filterOptions, dashboardData] = await Promise.all([
        trainingService.listSessions(),
        canManage ? trainingService.listEmployees() : Promise.resolve([]),
        trainingService.getFilterOptions(),
        trainingService.getDashboard(dateRange),
      ])
      setSessions(sessionRows)
      setEmployees(employeeRows)
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
    return sessions.filter((session) => [session.title, session.facilitator, session.training_type, session.department, session.area, session.branches?.branch_name].some((value) => String(value || '').toLowerCase().includes(q)))
  }, [sessions, sessionSearch])

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const createSession = async (event) => {
    event.preventDefault()
    setBusy(true); setError(''); setMessage('')
    try {
      if (!form.title.trim() || !form.facilitator.trim()) throw new Error('Title and facilitator are required.')
      if (form.employee_ids.length === 0) throw new Error('Assign at least one participant.')
      const isKss = form.training_type === 'kss' || form.assessment_required
      const needsAssessment = isKss || form.assessment_required
      const questionBank = needsAssessment ? parseQuestionBank(form.question_text) : []
      const payload = {
        title: form.title.trim(), training_type: form.training_type, description: form.description.trim() || null,
        facilitator: form.facilitator.trim(), training_date: form.training_date, start_time: form.start_time || null,
        end_time: form.end_time || null, duration_minutes: Number(form.duration_minutes), location: form.location.trim() || null,
        virtual_link: form.virtual_link.trim() || null, department: form.department || null, area: form.area || null,
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
      {tab === 'sessions' && <SessionsTab sessions={filteredSessions} search={sessionSearch} setSearch={setSessionSearch} />}
      {tab === 'create' && (canManage ? <CreateTraining form={form} set={set} employees={employees} options={options} busy={busy} onSubmit={createSession} /> : <ErrorState title="Training management restricted" message="Your role can view training intelligence but cannot create or assign sessions." />)}
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

function SessionsTab({ sessions, search, setSearch }) {
  return <div className="space-y-4"><div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3"><div><h2 className="text-lg font-semibold text-slate-900">Training sessions</h2><p className="text-sm text-slate-500">Each row is a scheduled training event; participants and completions remain separate records.</p></div><input className={`${inputCls} sm:w-80`} placeholder="Search title, facilitator, branch..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>{sessions.length === 0 ? <EmptyState title="No training sessions" description="Create a session to start assigning training." /> : <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-slate-500"><tr>{['Training', 'Type', 'Date', 'Organisation', 'Duration', 'Status'].map((label) => <th key={label} className="px-4 py-3 font-medium whitespace-nowrap">{label}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{sessions.map((session) => <tr key={session.id} className="hover:bg-slate-50"><td className="px-4 py-3"><p className="font-medium text-slate-900">{session.title}</p><p className="text-xs text-slate-400">{session.facilitator}</p></td><td className="px-4 py-3 capitalize">{formatTrainingType(session.training_type)}</td><td className="px-4 py-3 whitespace-nowrap">{formatDate(session.training_date)}</td><td className="px-4 py-3"><span>{session.branches?.branch_name || 'All branches'}</span><span className="block text-xs text-slate-400">{session.department || session.area || 'Organisation-wide'}</span></td><td className="px-4 py-3">{hours(session.duration_minutes)}h</td><td className="px-4 py-3"><span className={`inline-flex px-2 py-1 rounded-full text-xs border ${session.status === 'completed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : session.status === 'cancelled' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{session.status}</span></td></tr>)}</tbody></table></div>}</div>
}

function CreateTraining({ form, set, employees, options, busy, onSubmit }) {
  const selected = new Set(form.employee_ids)
  const toggleEmployee = (id) => set('employee_ids', selected.has(id) ? form.employee_ids.filter((item) => item !== id) : [...form.employee_ids, id])
  const isKss = form.training_type === 'kss' || form.assessment_required
  return <form onSubmit={onSubmit} className="space-y-6"><div className="bg-white border border-slate-200 rounded-xl p-5"><div className="flex items-start gap-3 mb-5"><div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center"><BookOpen className="w-5 h-5 text-[#009944]" /></div><div><h2 className="font-semibold text-slate-900">Create training session</h2><p className="text-sm text-slate-500 mt-1">KSS sessions automatically receive three rotated question sets before assignment.</p></div></div><div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"><Field label="Title" value={form.title} onChange={(v) => set('title', v)} required /><Field label="Training type" type="select" value={form.training_type} onChange={(v) => set('training_type', v)} options={TRAINING_TYPES.map((item) => ({ value: item.value, label: item.label }))} /><Field label="Facilitator" value={form.facilitator} onChange={(v) => set('facilitator', v)} required /><Field label="Date" type="date" value={form.training_date} onChange={(v) => set('training_date', v)} /><Field label="Start time" type="time" value={form.start_time} onChange={(v) => set('start_time', v)} /><Field label="End time" type="time" value={form.end_time} onChange={(v) => set('end_time', v)} /><Field label="Duration (minutes)" type="number" value={form.duration_minutes} onChange={(v) => set('duration_minutes', v)} /><Field label="Location" value={form.location} onChange={(v) => set('location', v)} /><Field label="Virtual link" value={form.virtual_link} onChange={(v) => set('virtual_link', v)} /><Field label="Department" type="select" value={form.department} onChange={(v) => set('department', v)} options={[{ value: '', label: 'All departments' }, ...options.departments.map((d) => ({ value: d.name, label: d.name }))]} /><Field label="Area" type="select" value={form.area} onChange={(v) => set('area', v)} options={[{ value: '', label: 'All areas' }, ...options.areas.map((a) => ({ value: a.area_code, label: a.area_name || a.area_code }))]} /><Field label="Branch" type="select" value={form.branch_id} onChange={(v) => set('branch_id', v)} options={[{ value: '', label: 'All branches' }, ...options.branches.map((b) => ({ value: b.id, label: b.branch_name }))]} /></div><label className={`${labelCls} mt-5`}>Description</label><textarea className={`${inputCls} !h-auto py-2`} rows="3" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What should participants take away?" /><div className="flex flex-wrap gap-4 mt-5">{[['assessment_required', 'Assessment required'], ['certificate_enabled', 'Issue certificate after passing'], ['is_mandatory', 'Mandatory training']].map(([key, label]) => <label key={key} className="inline-flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="accent-[#009944]" checked={form[key]} onChange={(e) => set(key, e.target.checked || (key === 'assessment_required' && isKss))} disabled={key === 'assessment_required' && isKss} />{label}</label>)}</div></div><div className="bg-white border border-slate-200 rounded-xl p-5"><div className="flex items-center justify-between gap-3 mb-3"><div><h3 className="font-semibold text-slate-900">Participants</h3><p className="text-xs text-slate-500 mt-1">{form.employee_ids.length} selected. The server assigns KSS sets round-robin.</p></div><button type="button" onClick={() => set('employee_ids', form.employee_ids.length === employees.length ? [] : employees.map((employee) => employee.id))} className="text-xs font-medium text-[#009944]">{form.employee_ids.length === employees.length ? 'Clear all' : 'Select all'}</button></div>{employees.length === 0 ? <EmptyState title="No employees available" /> : <div className="max-h-64 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{employees.map((employee) => <label key={employee.id} className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${selected.has(employee.id) ? 'border-[#009944] bg-emerald-50/60' : 'border-slate-200 hover:bg-slate-50'}`}><input type="checkbox" className="mt-0.5 accent-[#009944]" checked={selected.has(employee.id)} onChange={() => toggleEmployee(employee.id)} /><span className="min-w-0"><span className="block text-sm font-medium text-slate-800 truncate">{employee.full_name}</span><span className="block text-xs text-slate-400 truncate">{employee.employee_number || employee.employee_code || employee.staff_id || 'No ID'} · {employee.department || 'Unassigned'}</span></span></label>)}</div>}</div>{isKss && <div className="bg-white border border-slate-200 rounded-xl p-5"><h3 className="font-semibold text-slate-900">KSS question bank</h3><p className="text-xs text-slate-500 mt-1 mb-3">One question per line: <code>question | correct answer | option 1, option 2, option 3</code>. The bank is reviewed, then split into three rotated sets.</p><textarea className={`${inputCls} !h-auto py-2 font-mono text-xs`} rows="8" value={form.question_text} onChange={(e) => set('question_text', e.target.value)} placeholder="What is our customer privacy principle? | Protect customer data | Protect customer data, Share customer data, Ignore customer data" required /></div>}<div className="flex justify-end"><button disabled={busy} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">{busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create and assign</button></div></form>
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
