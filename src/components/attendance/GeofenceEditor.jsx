import React, { useMemo, useState } from 'react'
import { MapPin, Loader2, CheckCircle2, AlertTriangle, Crosshair, TestTube, Trash2, X } from 'lucide-react'
import { geofenceService, haversine } from '../../services/geofenceService'
import { getPosition } from '../../services/attendanceService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

function validateGeofence(form) {
  const errors = []
  const lat = form.latitude === '' ? null : Number(form.latitude)
  const lng = form.longitude === '' ? null : Number(form.longitude)
  const radius = Number(form.geofence_radius)

  if (lat == null || lng == null) {
    errors.push('Latitude and longitude are required.')
  } else {
    if (Number.isNaN(lat) || lat < -90 || lat > 90) errors.push('Latitude must be between -90 and 90.')
    if (Number.isNaN(lng) || lng < -180 || lng > 180) errors.push('Longitude must be between -180 and 180.')
  }
  if (Number.isNaN(radius) || radius <= 0) errors.push('Radius must be a positive number (metres).')
  if (radius > 100000) errors.push('Radius cannot exceed 100,000m (100km).')
  return errors
}

export default function GeofenceEditor({ branch, onSave, onDelete, busy }) {
  const [form, setForm] = useState({
    latitude: branch?.latitude ?? '',
    longitude: branch?.longitude ?? '',
    geofence_radius: branch?.geofence_radius ?? 150,
    geofence_active: branch?.geofence_active ?? false,
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [geoLoading, setGeoLoading] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const update = (k, v) => setForm((p) => ({ ...p, [k]: v }))

  const validationErrors = useMemo(() => validateGeofence(form), [form])

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
    if (validationErrors.length > 0) return
    onSave(branch.id, {
      latitude: form.latitude === '' ? null : parseFloat(form.latitude),
      longitude: form.longitude === '' ? null : parseFloat(form.longitude),
      geofence_radius: parseInt(form.geofence_radius) || 150,
      geofence_active: form.geofence_active,
    })
  }

  const handleDelete = () => {
    if (!window.confirm(`Clear the geofence configuration for "${branch.branch_name}"? This only removes the latitude, longitude and radius from the branch record. Historical attendance records are not affected.`)) return
    onDelete?.(branch.id)
  }

  const hasConfig = branch?.latitude != null && branch?.longitude != null
  const updatedAt = branch?.updated_at ? new Date(branch.updated_at).toLocaleString() : null

  return (
    <div className="space-y-5">
      {/* Status / metadata header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${form.geofence_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
            <MapPin className="w-3 h-3" />
            {form.geofence_active ? 'Active' : 'Inactive'}
          </span>
          {hasConfig && (
            <span className="text-xs text-slate-500">
              Configured: {Number(branch.latitude).toFixed(5)}, {Number(branch.longitude).toFixed(5)} · {branch.geofence_radius || 150}m radius
            </span>
          )}
        </div>
        {updatedAt && <span className="text-xs text-slate-400">Last updated: {updatedAt}</span>}
      </div>

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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Geofence Radius (metres)</label>
          <input type="number" min="1" className={inputCls} value={form.geofence_radius} onChange={(e) => update('geofence_radius', e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

      {validationErrors.length > 0 && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <ul className="list-disc list-inside space-y-0.5">
            {validationErrors.map((err, i) => <li key={i}>{err}</li>)}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">
        Working days, start/end time, and grace period are managed only in Platform Settings → Working Hours. This editor controls this branch's attendance location and radius. Historical attendance records keep the distance/status that was calculated at the time of clock-in.
      </div>

      {/* Test location */}
      {form.latitude && form.longitude && validationErrors.length === 0 && (
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

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button onClick={handleSave} disabled={busy || validationErrors.length > 0} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Update Geofence
        </button>
        {hasConfig && (
          <button onClick={handleDelete} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-rose-200 text-rose-700 text-sm font-medium hover:bg-rose-50 disabled:opacity-60">
            <Trash2 className="w-4 h-4" /> Delete Geofence
          </button>
        )}
      </div>
    </div>
  )
}
