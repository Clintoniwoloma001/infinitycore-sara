import React, { useEffect, useState } from 'react'
import { LogIn, LogOut, MapPin, Loader2, CheckCircle2, AlertTriangle, Clock, RefreshCw } from 'lucide-react'
import { getPosition } from '../../services/attendanceService'
import { haversine } from '../../services/geofenceService'

/**
 * The main clock in/out card with GPS capture and geofence feedback.
 * Modern, clean, with animated status indicators.
 */
export default function ClockCard({ record, employee, onClockIn, onClockOut, busy, message }) {
  const [geo, setGeo] = useState(null)
  const [geoStatus, setGeoStatus] = useState('idle') // idle | fetching | ok | denied | error
  const [geoMsg, setGeoMsg] = useState('')
  const [now, setNow] = useState(new Date())
  const [geofencePreview, setGeofencePreview] = useState(null)

  const branch = employee?.branches || null
  const hasGeofence = branch?.geofence_active && branch?.latitude != null
  const isOpen = record && !record.clock_out
  const isComplete = record && record.clock_out

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  // Auto-request location on mount if geofence is active
  useEffect(() => {
    if (hasGeofence && !geo) {
      requestLocation()
    }
  }, [hasGeofence]) // eslint-disable-line react-hooks/exhaustive-deps

  async function requestLocation() {
    setGeoStatus('fetching')
    setGeoMsg('')
    try {
      const pos = await getPosition()
      setGeo(pos)
      setGeoStatus('ok')
      // Preview geofence
      if (branch?.latitude && branch?.longitude) {
        const dist = haversine(pos.lat, pos.lng, branch.latitude, branch.longitude)
        const inside = dist <= (branch.geofence_radius || 150)
        setGeofencePreview({ distance: Math.round(dist), inside, radius: branch.geofence_radius || 150 })
      }
    } catch (e) {
      setGeoStatus('denied')
      setGeoMsg(e.message || 'Unable to get location.')
    }
  }

  const handleClockIn = async () => {
    if (!geo && hasGeofence) {
      await requestLocation()
      return // Let the user see the geo status first
    }
    onClockIn(geo)
  }

  const handleClockOut = async () => {
    if (!geo && hasGeofence) {
      await requestLocation()
      return
    }
    onClockOut(geo)
  }

  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
      {/* Gradient header */}
      <div className={`px-6 py-4 ${isOpen ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' : isComplete ? 'bg-gradient-to-r from-slate-400 to-slate-300' : 'bg-gradient-to-r from-[#009944] to-[#00b35a]'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-white" />
            <span className="text-white font-semibold text-sm">Today's Attendance</span>
          </div>
          <span className="text-white/80 text-xs">{dateStr}</span>
        </div>
        <div className="mt-2 text-white text-3xl font-bold tracking-tight tabular-nums">{timeStr}</div>
      </div>

      <div className="p-6">
        {/* Status row */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          {isComplete ? (
            <StatusBadge color="emerald" icon={CheckCircle2} label="Shift Complete" />
          ) : isOpen ? (
            <StatusBadge color="blue" icon={Clock} label="Clocked In" />
          ) : (
            <StatusBadge color="slate" icon={MapPin} label="Not Clocked In" />
          )}
          {record?.status === 'late' && <StatusBadge color="amber" icon={AlertTriangle} label={`Late by ${record.late_minutes || 0}m`} />}
          {record?.status === 'early_exit' && <StatusBadge color="amber" icon={AlertTriangle} label="Early Departure" />}
          {branch && <StatusBadge color="slate" icon={MapPin} label={branch.branch_name} />}
        </div>

        {/* Clock in/out times */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-400 flex items-center gap-1"><LogIn className="w-3.5 h-3.5" /> Clock In</p>
            <p className="text-lg font-semibold text-slate-900 mt-1 tabular-nums">
              {record?.clock_in ? new Date(record.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-400 flex items-center gap-1"><LogOut className="w-3.5 h-3.5" /> Clock Out</p>
            <p className="text-lg font-semibold text-slate-900 mt-1 tabular-nums">
              {record?.clock_out ? new Date(record.clock_out).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : isOpen ? 'In progress' : '—'}
            </p>
          </div>
        </div>

        {/* Hours worked */}
        {(isOpen || isComplete) && (
          <div className="flex items-center justify-between rounded-xl bg-gradient-to-r from-slate-50 to-slate-100 px-4 py-3 mb-5">
            <span className="text-sm text-slate-500">Total Hours</span>
            <span className="text-lg font-bold text-slate-900 tabular-nums">
              {record?.work_hours != null ? `${record.work_hours}h` : isOpen ? 'In progress' : '—'}
              {record?.total_minutes != null && <span className="text-sm text-slate-400 ml-1">({record.total_minutes}m)</span>}
            </span>
          </div>
        )}

        {/* Geofence status */}
        {hasGeofence && (
          <div className={`rounded-xl border p-3 mb-5 ${geofencePreview?.inside ? 'border-emerald-200 bg-emerald-50' : geofencePreview ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex items-center gap-2 text-sm">
              <MapPin className={`w-4 h-4 ${geofencePreview?.inside ? 'text-emerald-600' : geofencePreview ? 'text-rose-600' : 'text-slate-400'}`} />
              {geoStatus === 'fetching' && <span className="text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Getting your location…</span>}
              {geoStatus === 'denied' && <span className="text-rose-600">{geoMsg}</span>}
              {geoStatus === 'ok' && geofencePreview && (
                <span className={geofencePreview.inside ? 'text-emerald-700' : 'text-rose-700'}>
                  {geofencePreview.inside
                    ? `Inside geofence — ${geofencePreview.distance}m from branch center`
                    : `Outside geofence — ${geofencePreview.distance}m away (radius: ${geofencePreview.radius}m)`}
                </span>
              )}
              {geoStatus === 'idle' && <span className="text-slate-400">Location needed for geofence verification</span>}
            </div>
            {geoStatus === 'ok' && geo?.accuracy && (
              <p className="text-xs text-slate-400 mt-1 ml-6">GPS accuracy: ±{Math.round(geo.accuracy)}m</p>
            )}
            {geoStatus !== 'fetching' && (
              <button onClick={requestLocation} className="ml-auto text-xs text-[#009944] hover:underline flex items-center gap-1 mt-1">
                <RefreshCw className="w-3 h-3" /> {geo ? 'Refresh location' : 'Enable location'}
              </button>
            )}
          </div>
        )}

        {/* Message */}
        {message?.text && (
          <div className={`rounded-xl border p-3 mb-5 text-sm ${message.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : message.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
            {message.text}
          </div>
        )}

        {/* Primary action */}
        <div className="flex flex-col sm:flex-row gap-3">
          {!record && (
            <button
              onClick={handleClockIn}
              disabled={busy || (hasGeofence && geoStatus !== 'ok')}
              className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-[#009944] text-white font-semibold hover:bg-[#007a36] disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:shadow-[#009944]/20"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
              {busy ? 'Clocking in…' : 'Clock In'}
            </button>
          )}
          {isOpen && (
            <button
              onClick={handleClockOut}
              disabled={busy || (hasGeofence && geoStatus !== 'ok')}
              className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-rose-600 text-white font-semibold hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:shadow-rose-600/20"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogOut className="w-5 h-5" />}
              {busy ? 'Clocking out…' : 'Clock Out'}
            </button>
          )}
          {isComplete && (
            <div className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-slate-100 text-slate-500 font-medium">
              <CheckCircle2 className="w-5 h-5" /> Shift complete
            </div>
          )}
        </div>

        {/* Completion summary */}
        {isComplete && (
          <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-emerald-900 mb-2">Attendance Complete</p>
            <div className="grid grid-cols-2 gap-2 text-sm text-emerald-800">
              <div>Clock-in: <span className="font-medium">{new Date(record.clock_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span></div>
              <div>Clock-out: <span className="font-medium">{new Date(record.clock_out).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span></div>
              <div>Worked: <span className="font-medium">{record.work_hours}h</span></div>
              <div>Status: <span className="font-medium capitalize">{record.status.replace(/_/g, ' ')}</span></div>
            </div>
          </div>
        )}

        <p className="text-xs text-slate-400 mt-4 text-center">
          {hasGeofence ? 'Geofence verification is active for your branch.' : 'Official timestamps are set by the server.'}
        </p>
      </div>
    </div>
  )
}

function StatusBadge({ color, icon: Icon, label }) {
  const colors = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border ${colors[color] || colors.slate}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </span>
  )
}
