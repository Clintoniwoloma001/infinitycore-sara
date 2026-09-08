import React, { useEffect, useState, useRef } from 'react'
import { CalendarClock, Clock, LogIn, LogOut, MapPin, AlertCircle, X, Loader2, Send, CheckCircle2, Clock3 } from 'lucide-react'
import { attendanceService } from '../services/attendanceService'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState } from '../components/PageStates'
import { date, status } from './hrShared'

const LATE_REASONS = [
  { key: 'traffic', label: 'Traffic' },
  { key: 'transport_delay', label: 'Transport delay' },
  { key: 'health_emergency', label: 'Health / emergency' },
  { key: 'official_assignment', label: 'Official assignment' },
  { key: 'family_emergency', label: 'Family emergency' },
  { key: 'weather', label: 'Weather' },
  { key: 'other', label: 'Other' },
]

const ISSUE_TYPES = [
  { key: 'forgot_clock_in', label: 'Forgot to clock in' },
  { key: 'forgot_clock_out', label: 'Forgot to clock out' },
  { key: 'incorrect_time', label: 'Incorrect time' },
  { key: 'wrong_location', label: 'Wrong location' },
  { key: 'device_problem', label: 'Device problem' },
  { key: 'other', label: 'Other' },
]

export default function Attendance() {
  const { name } = useAuth()
  const [employee, setEmployee] = useState(null)
  const [record, setRecord] = useState(null)
  const [history, setHistory] = useState([])
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ kind: '', text: '' })
  const [geo, setGeo] = useState(null)
  const [lateModal, setLateModal] = useState(null)
  const [issueModal, setIssueModal] = useState(false)
  const [currentTime, setCurrentTime] = useState(new Date())
  const [workingDuration, setWorkingDuration] = useState('')
  const [clockAnim, setClockAnim] = useState(false)

  const tickRef = useRef(null)

  useEffect(() => {
    tickRef.current = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(tickRef.current)
  }, [])

  useEffect(() => {
    if (record?.clock_in && !record?.clock_out) {
      const update = () => {
        const diff = Date.now() - new Date(record.clock_in).getTime()
        const h = Math.floor(diff / 3600000)
        const m = Math.floor((diff % 3600000) / 60000)
        setWorkingDuration(`${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`)
      }
      update()
      const id = setInterval(update, 1000)
      return () => clearInterval(id)
    }
  }, [record])

  const load = async () => {
    setLoading(true)
    try {
      const emp = await attendanceService.getMyEmployee()
      setEmployee(emp)
      if (emp) {
        const today = await attendanceService.getToday(emp.id)
        setRecord(today)
        const hist = await attendanceService.getHistory(emp.id, 30)
        setHistory(hist)
      }
      try {
        const cfg = await attendanceService.getConfig()
        setConfig(cfg)
      } catch { /* config may not exist yet */ }
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Unable to load attendance' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const isLate = () => {
    if (!config) return false
    const now = new Date()
    const [expH, expM] = (config.expected_start_time || '08:00').split(':').map(Number)
    const grace = config.grace_period_minutes || 15
    const lateThreshold = new Date()
    lateThreshold.setHours(expH, expM + grace, 0, 0)
    return now > lateThreshold
  }

  const doClockIn = async () => {
    setBusy(true)
    setMessage({})
    setClockAnim(true)
    try {
      const r = await attendanceService.clockIn({ lat: geo?.lat, lng: geo?.lng })
      setRecord(r)
      setMessage({ kind: 'ok', text: `Clocked in at ${new Date(r.clock_in).toLocaleTimeString()}.` })

      // Check if late and show modal
      if (isLate() && config) {
        const [expH, expM] = config.expected_start_time.split(':').map(Number)
        const expTime = new Date()
        expTime.setHours(expH, expM, 0, 0)
        setLateModal({
          attendanceId: r.id,
          employeeId: employee.id,
          expectedTime: expTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          actualTime: new Date(r.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        })
      }

      await load()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Clock in failed' })
    } finally {
      setBusy(false)
      setTimeout(() => setClockAnim(false), 600)
    }
  }

  const doClockOut = async () => {
    setBusy(true)
    setMessage({})
    setClockAnim(true)
    try {
      const r = await attendanceService.clockOut(record?.id)
      setRecord(r)
      setMessage({ kind: 'ok', text: `Clocked out at ${new Date(r.clock_out).toLocaleTimeString()}. Hours worked: ${r.work_hours}.` })
      await load()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Clock out failed' })
    } finally {
      setBusy(false)
      setTimeout(() => setClockAnim(false), 600)
    }
  }

  const submitLateReason = async (reason, customExplanation) => {
    setBusy(true)
    try {
      await attendanceService.submitException({
        attendanceId: lateModal.attendanceId,
        employeeId: lateModal.employeeId,
        exceptionType: 'late_arrival',
        reason,
        customExplanation,
        expectedTime: lateModal.expectedTime,
        actualTime: lateModal.actualTime,
      })
      setMessage({ kind: 'ok', text: 'Late reason submitted for HR review.' })
      setLateModal(null)
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Failed to submit reason' })
    } finally {
      setBusy(false)
    }
  }

  const submitIssue = async (issueData) => {
    setBusy(true)
    try {
      await attendanceService.submitIssue({
        employeeId: employee.id,
        issueDate: issueData.date,
        issueType: issueData.type,
        explanation: issueData.explanation,
      })
      setMessage({ kind: 'ok', text: 'Attendance issue submitted for HR review.' })
      setIssueModal(false)
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Failed to submit issue' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading attendance..." />

  if (!employee) {
    return (
      <div>
        <h2 className="text-2xl font-semibold text-slate-900 mb-4">My Attendance</h2>
        <EmptyState
          title="No employee profile linked"
          description="Your account is not yet linked to an employee record. Ask HR to link your profile so you can clock in and out."
        />
      </div>
    )
  }

  const open = record && !record.clock_out
  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  })()

  return (
    <div>
      {/* Greeting */}
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">{greeting}, {employee.full_name?.split(' ')[0] || name?.split(' ')[0] || 'there'}</h2>
        <p className="text-sm text-slate-500 mt-1">{new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>

      {message.text && (
        <div className={`mb-5 rounded-lg border p-4 text-sm animate-[fadeIn_0.2s_ease] ${message.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Clock In/Out Card */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 p-6">
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              <h3 className="font-semibold text-slate-900">{employee.full_name}</h3>
              <p className="text-sm text-slate-500">{employee.position || 'Staff'} {employee.department ? `· ${employee.department}` : ''}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-400">Current time</p>
              <p className="text-xl font-bold text-slate-900 tabular-nums">{currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
            </div>
          </div>

          {/* Central Clock Control */}
          <div className="flex flex-col items-center py-6">
            {open && (
              <div className="mb-4 text-center">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm font-medium">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Clocked In
                </div>
                <p className="text-2xl font-bold text-slate-900 mt-2 tabular-nums">
                  {new Date(record.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </p>
                <p className="text-sm text-slate-500 mt-1">Working for: <span className="font-medium text-slate-700 tabular-nums">{workingDuration}</span></p>
              </div>
            )}

            {!record && (
              <button
                onClick={doClockIn}
                disabled={busy}
                className={`relative w-40 h-40 rounded-full bg-gradient-to-br from-[#009944] to-[#007a36] text-white font-semibold text-lg flex flex-col items-center justify-center shadow-lg hover:shadow-xl hover:scale-105 active:scale-95 transition-all duration-300 disabled:opacity-50 ${clockAnim ? 'scale-95' : ''}`}
              >
                {busy ? <Loader2 className="w-8 h-8 animate-spin" /> : <LogIn className="w-8 h-8 mb-1" />}
                {busy ? 'Please wait' : 'Clock In'}
              </button>
            )}

            {open && (
              <button
                onClick={doClockOut}
                disabled={busy}
                className={`relative w-40 h-40 rounded-full bg-gradient-to-br from-rose-500 to-rose-700 text-white font-semibold text-lg flex flex-col items-center justify-center shadow-lg hover:shadow-xl hover:scale-105 active:scale-95 transition-all duration-300 disabled:opacity-50 ${clockAnim ? 'scale-95' : ''}`}
              >
                {busy ? <Loader2 className="w-8 h-8 animate-spin" /> : <LogOut className="w-8 h-8 mb-1" />}
                {busy ? 'Please wait' : 'Clock Out'}
              </button>
            )}

            {record && record.clock_out && (
              <div className="flex flex-col items-center gap-2">
                <div className="w-40 h-40 rounded-full bg-slate-100 flex flex-col items-center justify-center text-slate-500">
                  <CheckCircle2 className="w-10 h-10 mb-1 text-emerald-500" />
                  <span className="font-medium text-sm">Shift Complete</span>
                </div>
                <p className="text-sm text-slate-500 mt-2">{record.work_hours || 0} hours worked</p>
              </div>
            )}
          </div>

          {/* Clock In/Out times */}
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs text-slate-400 flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Clock In</p>
              <p className="text-lg font-semibold text-slate-900 mt-1 tabular-nums">{record?.clock_in ? new Date(record.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</p>
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs text-slate-400 flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" /> Clock Out</p>
              <p className="text-lg font-semibold text-slate-900 mt-1 tabular-nums">{record?.clock_out ? new Date(record.clock_out).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : open ? 'In progress' : '—'}</p>
            </div>
          </div>

          {/* Status + Actions */}
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-100">
            <div className="flex items-center gap-3">
              {record && <span className="text-sm">{status(record.status)}</span>}
              {!record && <span className="text-sm text-slate-400">Not clocked in today</span>}
              <button onClick={() => { if (navigator.geolocation) navigator.geolocation.getCurrentPosition((pos) => setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }), () => {}, { enableHighAccuracy: false, timeout: 5000 }) }} className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-[#009944]">
                <MapPin className="w-4 h-4" /> {geo ? 'Location attached' : 'Attach location'}
              </button>
            </div>
            <button
              onClick={() => setIssueModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-medium hover:bg-slate-50"
            >
              <AlertCircle className="w-3.5 h-3.5" /> Report Attendance Issue
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-3">Official clock-in/out times are stamped by the server — the browser clock is never trusted.</p>
        </div>

        {/* This Week */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-900 mb-3">This week</h3>
          {history.length === 0 && <p className="text-sm text-slate-400">No records yet</p>}
          <ul className="space-y-2">
            {history.slice(0, 7).map((r) => (
              <li key={r.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-50 last:border-0">
                <span className="text-slate-600">{date(r.attendance_date)}</span>
                <span className="text-xs">{status(r.status)}</span>
              </li>
            ))}
          </ul>
          {config && (
            <div className="mt-4 pt-3 border-t border-slate-100">
              <p className="text-xs text-slate-400 mb-1">Expected start: <span className="font-medium text-slate-600">{config.expected_start_time}</span></p>
              <p className="text-xs text-slate-400">Grace period: <span className="font-medium text-slate-600">{config.grace_period_minutes} min</span></p>
            </div>
          )}
        </div>
      </div>

      {/* Recent History */}
      <h3 className="text-lg font-semibold text-slate-900 mb-3">Recent history</h3>
      {history.length === 0 && <EmptyState title="No attendance history" />}
      {history.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium">Date</th>
                <th className="px-6 py-3 font-medium">Clock In</th>
                <th className="px-6 py-3 font-medium">Clock Out</th>
                <th className="px-6 py-3 font-medium">Hours</th>
                <th className="px-6 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {history.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3 text-slate-700">{date(r.attendance_date)}</td>
                  <td className="px-6 py-3 text-slate-700 tabular-nums">{r.clock_in ? new Date(r.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td className="px-6 py-3 text-slate-700 tabular-nums">{r.clock_out ? new Date(r.clock_out).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td className="px-6 py-3 text-slate-700">{r.work_hours || '—'}</td>
                  <td className="px-6 py-3">{status(r.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Late Arrival Modal */}
      {lateModal && (
        <LateModal
          data={lateModal}
          onSubmit={submitLateReason}
          onClose={() => setLateModal(null)}
          busy={busy}
        />
      )}

      {/* Attendance Issue Modal */}
      {issueModal && (
        <IssueModal
          onSubmit={submitIssue}
          onClose={() => setIssueModal(false)}
          busy={busy}
        />
      )}
    </div>
  )
}

// ============================================================
// LATE ARRIVAL MODAL
// ============================================================
function LateModal({ data, onSubmit, onClose, busy }) {
  const [reason, setReason] = useState('')
  const [custom, setCustom] = useState('')

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
              <Clock3 className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">You're checking in late</h3>
              <p className="text-sm text-slate-500">Please provide a reason</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-400">Expected time</p>
            <p className="text-lg font-semibold text-slate-700">{data.expectedTime}</p>
          </div>
          <div className="rounded-lg bg-amber-50 p-3">
            <p className="text-xs text-amber-500">Current time</p>
            <p className="text-lg font-semibold text-amber-700">{data.actualTime}</p>
          </div>
        </div>

        <div className="space-y-2 mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Reason</label>
          {LATE_REASONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setReason(r.key)}
              className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm text-left transition ${reason === r.key ? 'border-[#009944] bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`}
            >
              <div className={`w-4 h-4 rounded-full border-2 ${reason === r.key ? 'border-[#009944] bg-[#009944]' : 'border-slate-300'}`} />
              {r.label}
            </button>
          ))}
        </div>

        {reason === 'other' && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Custom explanation</label>
            <textarea
              className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
              rows={2}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Please explain..."
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Skip</button>
          <button
            onClick={() => onSubmit(reason, custom)}
            disabled={busy || !reason}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Submit Reason
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// ATTENDANCE ISSUE MODAL
// ============================================================
function IssueModal({ onSubmit, onClose, busy }) {
  const [issueType, setIssueType] = useState('')
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10))
  const [explanation, setExplanation] = useState('')

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-rose-600" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900">Report Attendance Issue</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Date</label>
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Issue Type</label>
            <select value={issueType} onChange={(e) => setIssueType(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]">
              <option value="">Select issue type...</option>
              {ISSUE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Explanation</label>
            <textarea
              className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
              rows={3}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="Describe what happened..."
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button
            onClick={() => onSubmit({ date: issueDate, type: issueType, explanation })}
            disabled={busy || !issueType}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Submit Issue
          </button>
        </div>
      </div>
    </div>
  )
}
