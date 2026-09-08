import React, { useState } from 'react'
import { MapPin, Loader2, CheckCircle2, AlertTriangle, Crosshair, TestTube } from 'lucide-react'
import { geofenceService, haversine } from '../../services/geofenceService'
import { getPosition } from '../../services/attendanceService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const DAYS = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
]

export default function GeofenceEditor({ branch, onSave, busy }) {
  const [form, setForm] = useState({
    latitude: branch?.latitude || '',
    longitude: branch?.longitude || '',
    geofence_radius: branch?.geofence_radius || 150,
    geofence_active: branch?.geofence_active || false,
    work_start_time: branch?.work_start_time || '08:00',
    work_end_time: branch?.work_end_time || '17:00',
    grace_period_minutes: branch?.grace_period_minutes || 15,
    working_days: branch?.working_days || ['mon', 'tue', 'wed', 'thu', 'fri'],
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testCoords, setTestCoords] = useState(null)
  const [geoLoading, setGeoLoading] = useState(false)

  const update = (k, v) => setForm((p) => ({ ...p, [k]: v }))

  const toggleDay = (day) => {
    setForm((p) => ({
      ...p,
      working_days: p.working_days.includes(day)
        ? p.work_days?.filter((d) => d !== day)
        : [...p.working_days, day],
    }))
  }

  const useMyLocation = async () => {
    setGeoLoading(true)
    try {
      const pos = await getPosition()
      update('latitude', pos.lat.toFixed(6))
      update('longitude', pos.lng.toFixed(6))
    } catch (e) {
      alert(e.message)
    } finally {
      setGeoLoading(false)
    }
  }

  const testLocation = async () => {
    if (!form.latitude || !form.longitude) return
    setTesting(true)
    setTestResult(null)
    try {
      const pos = await getPosition()
      setTestCoords(pos)
      const result = geofenceService.testGeofence(pos.lat, pos.lng, {
        latitude: parseFloat(form.latitude),
        longitude: parseFloat(form.longitude),
        geofence_radius: parseInt(form.geofence_radius),
      })
      setTestResult(result)
    } catch (e) {
      setTestResult({ inside: false, message: e.message })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = () => {
    onSave(branch.id, {
      latitude: form.latitude ? parseFloat(form.latitude) : null,
      longitude: form.longitude ? parseFloat(form.longitude) : null,
      geofence_radius: parseInt(form.geofence_radius) || 150,
      geofence_active: form.geofence_active,
      work_start_time: form.work_start_time,
      work_end_time: form.work_end_time,
      grace_period_minutes: parseInt(form.grace_period_minutes) || 15,
      working_days: form.working_days,
    })
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Latitude</label>
          <input type="number" step="0.000001" className={inputCls} value={form.latitude} onChange={(e) => update('latitude', e.target.value)} placeholder="e.g. 6.524379" />
        </div>
        <div>
          <label className={labelCls}>Longitude</label>
          <input type="number" step="0.000001" className={inputCls} value={form.longitude} onChange={(e) => update('longitude', e.target.value)} placeholder="e.g. 3.379206" />
        </div>
      </div>

      <button onClick={useMyLocation} disabled={geoLoading} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#009944] text-[#009944] text-sm font-medium hover:bg-emerald-50 disabled:opacity-60">
        {geoLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crosshair className="w-4 h-4" />}
        Use My Current Location
      </button>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className={labelCls}>Geofence Radius (metres)</label>
          <input type="number" className={inputCls} value={form.geofence_radius} onChange={(e) => update('geofence_radius', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Work Start Time</label>
          <input type="time" className={inputCls} value={form.work_start_time} onChange={(e) => update('work_start_time', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Work End Time</label>
          <input type="time" className={inputCls} value={form.work_end_time} onChange={(e) => update('work_end_time', e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Grace Period (minutes)</label>
          <input type="number" className={inputCls} value={form.grace_period_minutes} onChange={(e) => update('grace_period_minutes', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Geofence Status</label>
          <div className="flex items-center gap-3 mt-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.geofence_active} onChange={(e) => update('geofence_active', e.target.checked)} className="w-4 h-4 accent-[#009944]" />
              Active
            </label>
          </div>
        </div>
      </div>

      <div>
        <label className={labelCls}>Working Days</label>
        <div className="flex flex-wrap gap-2 mt-1">
          {DAYS.map((d) => (
            <button
              key={d.key}
              onClick={() => toggleDay(d.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${form.working_days?.includes(d.key) ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Test location */}
      {form.latitude && form.longitude && (
        <div className="rounded-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><TestTube className="w-4 h-4 text-slate-400" /> Test Location</p>
            <button onClick={testLocation} disabled={testing} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-medium hover:bg-slate-200 disabled:opacity-60">
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />} Test
            </button>
          </div>
          {testResult && (
            <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${testResult.inside ? 'bg-emerald-50 text-emerald-800' : testResult.inside === false ? 'bg-rose-50 text-rose-800' : 'bg-slate-50 text-slate-600'}`}>
              {testResult.inside ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : testResult.inside === false ? <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> : null}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      )}

      <button onClick={handleSave} disabled={busy} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save Geofence Settings
      </button>
    </div>
  )
}
