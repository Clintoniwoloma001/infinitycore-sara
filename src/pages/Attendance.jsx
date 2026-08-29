import React, { useEffect, useState } from 'react'
import { CalendarClock, Clock, LogIn, LogOut, MapPin, User } from 'lucide-react'
import { attendanceService } from '../services/attendanceService'
import { LoadingState, EmptyState } from '../components/PageStates'
import { date, status } from './hrShared'

export default function Attendance() {
  const [employee, setEmployee] = useState(null)
  const [record, setRecord] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ kind: '', text: '' })
  const [geo, setGeo] = useState(null)

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
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Unable to load attendance' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const captureLocation = () => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 5000 },
    )
  }

  const doClockIn = async () => {
    setBusy(true)
    setMessage({})
    try {
      const r = await attendanceService.clockIn({ lat: geo?.lat, lng: geo?.lng })
      setRecord(r)
      setMessage({ kind: 'ok', text: `Clocked in at ${new Date(r.clock_in).toLocaleTimeString()}.` })
      await load()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Clock in failed' })
    } finally {
      setBusy(false)
    }
  }

  const doClockOut = async () => {
    setBusy(true)
    setMessage({})
    try {
      const r = await attendanceService.clockOut(record?.id)
      setRecord(r)
      setMessage({ kind: 'ok', text: `Clocked out at ${new Date(r.clock_out).toLocaleTimeString()}. Hours worked: ${r.work_hours}.` })
      await load()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Clock out failed' })
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

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-900 mb-6">My Attendance</h2>

      {message.text && (
        <div className={`mb-5 rounded-lg border p-4 text-sm ${message.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2 bg-white rounded-lg border border-slate-200 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold text-slate-900">{employee.full_name}</h3>
              <p className="text-sm text-slate-500">{employee.position || 'Staff'} {employee.department ? `· ${employee.department}` : ''}</p>
              <p className="text-xs text-slate-400 mt-2 flex items-center gap-1"><User className="w-3.5 h-3.5" /> {employee.employee_code || employee.email || employee.phone}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-400">Today</p>
              <p className="text-2xl font-bold text-slate-900">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
            </div>
          </div>

          <div className="mt-8 flex flex-col sm:flex-row items-center gap-4">
            {!record && (
              <button onClick={doClockIn} disabled={busy} className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3 rounded-xl bg-[#009944] text-white font-semibold hover:bg-[#007a36] disabled:opacity-60">
                <LogIn className="w-5 h-5" /> Clock In
              </button>
            )}
            {record && !record.clock_out && (
              <button onClick={doClockOut} disabled={busy} className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-3 rounded-xl bg-rose-600 text-white font-semibold hover:bg-rose-700 disabled:opacity-60">
                <LogOut className="w-5 h-5" /> Clock Out
              </button>
            )}
            {record && record.clock_out && (
              <div className="w-full sm:w-auto inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-slate-100 text-slate-600 font-medium">
                <CheckIcon /> Shift complete · {record.work_hours || 0} hours
              </div>
            )}
            <button onClick={captureLocation} className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-[#009944]">
              <MapPin className="w-4 h-4" /> {geo ? 'With location' : 'Attach location'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4 mt-8">
            <div className="rounded-lg bg-slate-50 p-4">
              <p className="text-xs text-slate-400 flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> Clock In</p>
              <p className="text-lg font-semibold text-slate-900 mt-1">{record?.clock_in ? new Date(record.clock_in).toLocaleTimeString() : '—'}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-4">
              <p className="text-xs text-slate-400 flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" /> Clock Out</p>
              <p className="text-lg font-semibold text-slate-900 mt-1">{record?.clock_out ? new Date(record.clock_out).toLocaleTimeString() : open ? 'In progress' : '—'}</p>
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-4">Official clock-in/out times are stamped by the server — the browser clock is never trusted.</p>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-900 mb-3">This week</h3>
          {history.length === 0 && <EmptyState title="No records yet" />}
          <ul className="space-y-2">
            {history.slice(0, 7).map((r) => (
              <li key={r.id} className="flex items-center justify-between text-sm">
                <span className="text-slate-600">{date(r.attendance_date)}</span>
                <span className="text-xs">{status(r.status)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h3 className="text-lg font-semibold text-slate-900 mb-3">Recent history</h3>
      {history.length === 0 && <EmptyState title="No attendance history" />}
      {history.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
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
                  <td className="px-6 py-3 text-slate-700">{r.clock_in ? new Date(r.clock_in).toLocaleTimeString() : '—'}</td>
                  <td className="px-6 py-3 text-slate-700">{r.clock_out ? new Date(r.clock_out).toLocaleTimeString() : '—'}</td>
                  <td className="px-6 py-3 text-slate-700">{r.work_hours || '—'}</td>
                  <td className="px-6 py-3">{status(r.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}