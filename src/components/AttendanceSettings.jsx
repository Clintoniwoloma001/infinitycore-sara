import React, { useState, useEffect } from 'react'
import { AlertTriangle, Camera, Check, CheckCircle2, Clock, Cpu, Edit, Fingerprint, Key, Link2, Loader2, Ban, MapPin, Monitor, Navigation, Plus, RefreshCw, Trash2, Wifi, WifiOff, X } from 'lucide-react'
import { attendanceEngineService } from '../services/attendanceEngineService'
import { platformSettingsService } from '../services/platformSettingsService'
import { biometricService } from '../services/biometricService'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import CameraCapture from '../components/CameraCapture'
import { supabase } from '../supabaseClient'
import { normalizeEmployeeId } from '../utils/employeeId'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

// ============================================================
// GEOFENCING TAB
// ============================================================
export function GeofencingTab({ canManage }) {
  const [geofences, setGeofences] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState({ name: '', branch_id: '', location_name: '', latitude: '', longitude: '', radius_meters: 150, clock_in_allowed: true, clock_out_allowed: true, department: '' })
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setGeofences(await attendanceEngineService.listGeofences())
    } catch (e) {
      setError(e?.message || 'Failed to load geofences. Run the Phase 11 migration first.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const useCurrentLocation = () => {
    if (!navigator.geolocation) { setError('Geolocation not supported'); return }
    navigator.geolocation.getCurrentPosition(
      (pos) => setForm((p) => ({ ...p, latitude: pos.coords.latitude.toFixed(7), longitude: pos.coords.longitude.toFixed(7) })),
      () => setError('Unable to get location. Check permissions.'),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const payload = {
        name: form.name,
        branch_id: form.branch_id || null,
        location_name: form.location_name || null,
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        radius_meters: Number(form.radius_meters) || 150,
        clock_in_allowed: form.clock_in_allowed,
        clock_out_allowed: form.clock_out_allowed,
        department: form.department || null,
        active: true,
      }
      if (editId) {
        await attendanceEngineService.updateGeofence(editId, payload)
      } else {
        await attendanceEngineService.createGeofence(payload)
      }
      setShowForm(false)
      setEditId(null)
      setForm({ name: '', branch_id: '', location_name: '', latitude: '', longitude: '', radius_meters: 150, clock_in_allowed: true, clock_out_allowed: true, department: '' })
      await load()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (g) => {
    try {
      await attendanceEngineService.updateGeofence(g.id, { active: !g.active })
      await load()
    } catch (e) {
      setError(e?.message || 'Toggle failed')
    }
  }

  if (loading) return <LoadingState label="Loading geofences..." />

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Configure authorized attendance locations. Employees must be within the geofence radius to clock in via GPS.</p>
        {canManage && (
          <button onClick={() => { setShowForm(true); setEditId(null) }} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> Add Geofence
          </button>
        )}
      </div>
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {geofences.length === 0 && !showForm && <EmptyState title="No geofences configured" description="Add attendance locations with coordinates and radius." />}

      {geofences.length > 0 && (
        <div className="space-y-3">
          {geofences.map((g) => (
            <div key={g.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                    <MapPin className="w-5 h-5 text-[#009944]" />
                  </div>
                  <div>
                    <h4 className="font-medium text-slate-900">{g.name}</h4>
                    {g.source === 'branch' && (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 mt-0.5">Managed in Platform Settings → Geofence</span>
                    )}
                    <p className="text-xs text-slate-500">{g.location_name || 'No location name'}</p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                      <span>Lat: {g.latitude}</span>
                      <span>Lng: {g.longitude}</span>
                      <span>Radius: {g.radius_meters}m</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      {g.clock_in_allowed && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Clock-in ✓</span>}
                      {g.clock_out_allowed && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">Clock-out ✓</span>}
                      {g.department && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{g.department}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-1 rounded-full ${g.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>{g.active ? 'Active' : 'Inactive'}</span>
                  {canManage && g.source !== 'branch' && (
                    <>
                      <button onClick={() => { setEditId(g.id); setForm({ name: g.name, branch_id: g.branch_id || '', location_name: g.location_name || '', latitude: String(g.latitude), longitude: String(g.longitude), radius_meters: g.radius_meters, clock_in_allowed: g.clock_in_allowed, clock_out_allowed: g.clock_out_allowed, department: g.department || '' }); setShowForm(true) }} className="text-slate-400 hover:text-[#009944]"><Edit className="w-4 h-4" /></button>
                      <button onClick={() => toggle(g)} className="text-slate-400 hover:text-amber-500"><Ban className="w-4 h-4" /></button>
                      <button onClick={async () => { await attendanceEngineService.deleteGeofence(g.id); load() }} className="text-slate-400 hover:text-rose-500"><Trash2 className="w-4 h-4" /></button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">{editId ? 'Edit Geofence' : 'Add Geofence'}</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className={labelCls}>Location Name</label>
                <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Head Office" />
              </div>
              <div>
                <label className={labelCls}>Branch ID (optional)</label>
                <input className={inputCls} value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} placeholder="Branch identifier" />
              </div>
              <div>
                <label className={labelCls}>Department (optional)</label>
                <input className={inputCls} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Restrict to department" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Latitude</label>
                  <input className={inputCls} value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} placeholder="6.5244" />
                </div>
                <div>
                  <label className={labelCls}>Longitude</label>
                  <input className={inputCls} value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} placeholder="3.3792" />
                </div>
              </div>
              <button onClick={useCurrentLocation} className="inline-flex items-center gap-1.5 text-sm text-[#009944] hover:underline">
                <Navigation className="w-4 h-4" /> Use Current Location
              </button>
              <div>
                <label className={labelCls}>Radius (meters)</label>
                <input type="number" className={inputCls} value={form.radius_meters} onChange={(e) => setForm({ ...form, radius_meters: e.target.value })} />
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={form.clock_in_allowed} onChange={(e) => setForm({ ...form, clock_in_allowed: e.target.checked })} className="rounded" />
                  Allow Clock-in
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={form.clock_out_allowed} onChange={(e) => setForm({ ...form, clock_out_allowed: e.target.checked })} className="rounded" />
                  Allow Clock-out
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={save} disabled={busy || !form.name || !form.latitude || !form.longitude} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// DEVICES & TERMINALS TAB
// ============================================================
const EMPTY_DEVICE_FORM = {
  device_name: '', device_type: 'fingerprint', manufacturer: '', model: '',
  serial_number: '', branch_id: '', integration_type: 'api', api_endpoint: '',
  geofenceMode: 'none', geofence_id: '', custom_lat: '', custom_lng: '', radius_meters: 150,
}

export function DevicesTab({ canManage }) {
  const [devices, setDevices] = useState([])
  const [geofences, setGeofences] = useState([])
  const [branches, setBranches] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState(EMPTY_DEVICE_FORM)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [devs, geos, branchRows] = await Promise.all([
        attendanceEngineService.listDevices(),
        attendanceEngineService.listGeofences(),
        supabase.from('branches').select('id, branch_name, branch_code').order('branch_name', { ascending: true }).then(({ data }) => data || []),
      ])
      setDevices(devs)
      setGeofences(geos)
      setBranches(branchRows)
    } catch (e) {
      setError(e?.message || 'Failed to load devices. Run the Phase 11 migration first.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const branchName = (id) => branches.find((b) => b.id === id)?.branch_name || (id && id.includes('-') ? null : id) || null
  const geofenceName = (id) => geofences.find((g) => g.id === id)?.name || geofences.find((g) => g.id === id)?.location_name || null

  const openAdd = () => {
    setEditId(null)
    setForm(EMPTY_DEVICE_FORM)
    setShowForm(true)
  }

  const openEdit = (d) => {
    const linked = d.geofence_id || d.location_id
    setEditId(d.id)
    setForm({
      device_name: d.device_name,
      device_type: d.device_type,
      manufacturer: d.manufacturer || '',
      model: d.model || '',
      serial_number: d.serial_number || '',
      branch_id: d.branch_id || '',
      integration_type: d.integration_type,
      api_endpoint: d.api_endpoint || '',
      geofenceMode: linked ? 'link' : (d.custom_lat ? 'custom' : 'none'),
      geofence_id: linked || '',
      custom_lat: d.custom_lat != null ? String(d.custom_lat) : '',
      custom_lng: d.custom_lng != null ? String(d.custom_lng) : '',
      radius_meters: d.radius_meters ?? 150,
    })
    setShowForm(true)
  }

  const buildGeofencePayload = () => {
    if (form.geofenceMode === 'link' && form.geofence_id) {
      return {
        geofence_id: form.geofence_id,
        location_id: form.geofence_id,
        custom_lat: null,
        custom_lng: null,
        radius_meters: null,
      }
    }
    if (form.geofenceMode === 'custom' && form.custom_lat && form.custom_lng) {
      return {
        geofence_id: null,
        location_id: null,
        custom_lat: Number(form.custom_lat),
        custom_lng: Number(form.custom_lng),
        radius_meters: Number(form.radius_meters) || 150,
      }
    }
    return { geofence_id: null, location_id: null, custom_lat: null, custom_lng: null, radius_meters: null }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const payload = {
        device_name: form.device_name,
        device_type: form.device_type,
        manufacturer: form.manufacturer || null,
        model: form.model || null,
        serial_number: form.serial_number || null,
        branch_id: form.branch_id || null,
        integration_type: form.integration_type,
        api_endpoint: form.api_endpoint || null,
        ...buildGeofencePayload(),
      }
      if (editId) {
        await attendanceEngineService.updateDevice(editId, payload)
      } else {
        await attendanceEngineService.createDevice({ ...payload, status: 'active', active: true })
      }
      setShowForm(false)
      setEditId(null)
      setForm(EMPTY_DEVICE_FORM)
      await load()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (d) => {
    if (!confirm(`Revoke device "${d.device_name}"? It will no longer accept attendance events.`)) return
    await attendanceEngineService.revokeDevice(d.id)
    await load()
  }

  const DEVICE_ICONS = { fingerprint: Fingerprint, face: Cpu, biometric: Cpu, attendance_terminal: Monitor, kiosk: Monitor }

  if (loading) return <LoadingState label="Loading devices..." />

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Register fingerprint scanners, biometric devices, and attendance terminals. Pin a geofence (or custom location) and an assigned branch so terminal scans are verified server-side.</p>
        {canManage && (
          <button onClick={openAdd} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> Add Device
          </button>
        )}
      </div>
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {devices.length === 0 && !showForm && <EmptyState title="No devices registered" description="Register fingerprint scanners, terminals, and biometric devices." />}

      {devices.length > 0 && (
        <div className="space-y-3">
          {devices.map((d) => {
            const Icon = DEVICE_ICONS[d.device_type] || Monitor
            const geo = geofenceName(d.geofence_id || d.location_id)
            const customGeo = d.custom_lat != null && d.custom_lng != null
            const br = branchName(d.branch_id)
            return (
              <div key={d.id} className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
                      <Icon className="w-5 h-5 text-slate-600" />
                    </div>
                    <div>
                      <h4 className="font-medium text-slate-900">{d.device_name}</h4>
                      <p className="text-xs text-slate-500 capitalize">{d.device_type.replace(/_/g, ' ')} · {d.manufacturer || 'Unknown manufacturer'}</p>
                      <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-slate-400">
                        {d.serial_number && <span>S/N: {d.serial_number}</span>}
                        {br && <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" /> {br}</span>}
                        <span>Integration: {d.integration_type}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-1.5">
                        {geo && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Geofence: {geo}</span>}
                        {customGeo && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-sky-50 text-sky-700" title={`${d.custom_lat}, ${d.custom_lng} · ${d.radius_meters}m`}>
                            Custom location · {d.radius_meters || 150}m
                          </span>
                        )}
                        {!geo && !customGeo && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">No geofence</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full ${d.status === 'active' ? 'bg-emerald-50 text-emerald-700' : d.status === 'offline' ? 'bg-slate-100 text-slate-500' : 'bg-rose-50 text-rose-700'}`}>
                      {d.status === 'active' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                      {d.status}
                    </span>
                    {d.last_seen_at && <span className="text-xs text-slate-400">Last seen: {new Date(d.last_seen_at).toLocaleDateString()}</span>}
                    {canManage && (
                      <>
                        <button onClick={() => openEdit(d)} className="text-slate-400 hover:text-[#009944]" title="Edit"><Edit className="w-4 h-4" /></button>
                        {d.status === 'active' && (
                          <button onClick={() => revoke(d)} className="text-slate-400 hover:text-rose-500" title="Revoke"><Ban className="w-4 h-4" /></button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">{editId ? 'Edit Device' : 'Register Device'}</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className={labelCls}>Device Name</label>
                <input className={inputCls} value={form.device_name} onChange={(e) => setForm({ ...form, device_name: e.target.value })} placeholder="e.g. Ketu Branch Fingerprint Scanner" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Device Type</label>
                  <select className={inputCls} value={form.device_type} onChange={(e) => setForm({ ...form, device_type: e.target.value })}>
                    <option value="fingerprint">Fingerprint</option>
                    <option value="face">Face Recognition</option>
                    <option value="biometric">Biometric</option>
                    <option value="attendance_terminal">Attendance Terminal</option>
                    <option value="kiosk">Kiosk</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Integration Type</label>
                  <select className={inputCls} value={form.integration_type} onChange={(e) => setForm({ ...form, integration_type: e.target.value })}>
                    <option value="api">API</option>
                    <option value="webhook">Webhook</option>
                    <option value="local_agent">Local Agent</option>
                    <option value="manual_import">Manual Import</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Manufacturer</label>
                  <input className={inputCls} value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} placeholder="e.g. ZKTeco" />
                </div>
                <div>
                  <label className={labelCls}>Model</label>
                  <input className={inputCls} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="e.g. SpeedFace V5L" />
                </div>
              </div>
              <div>
                <label className={labelCls}>Serial Number</label>
                <input className={inputCls} value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Assigned Branch</label>
                <select className={inputCls} value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
                  <option value="">Select branch...</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name} ({b.branch_code || '—'})</option>)}
                </select>
                <p className="text-xs text-slate-400 mt-1">The physical branch this terminal belongs to. Cross-branch terminal clock-ins are sent to HR review.</p>
              </div>
              <div>
                <label className={labelCls}>API Endpoint (optional)</label>
                <input className={inputCls} value={form.api_endpoint} onChange={(e) => setForm({ ...form, api_endpoint: e.target.value })} placeholder="https://..." />
              </div>

              <div className="border-t border-slate-100 pt-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-1">Geofence / Clock-in Range</h3>
                <p className="text-xs text-slate-400 mb-3">Server-side range check for terminal scans. Scans outside the range are rejected (OUT_OF_BOUNDS) with no attendance record.</p>
                <div className="flex gap-3 text-sm">
                  {[{ v: 'none', l: 'No geofence' }, { v: 'link', l: 'Link existing geofence' }, { v: 'custom', l: 'Custom location' }].map((m) => (
                    <label key={m.v} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="radio" name="geofenceMode" checked={form.geofenceMode === m.v} onChange={() => setForm({ ...form, geofenceMode: m.v })} className="accent-[#009944]" />
                      {m.l}
                    </label>
                  ))}
                </div>
              </div>

              {form.geofenceMode === 'link' && (
                <div>
                  <label className={labelCls}>Attendance Geofence</label>
                  <select className={inputCls} value={form.geofence_id} onChange={(e) => setForm({ ...form, geofence_id: e.target.value })}>
                    <option value="">Select geofence...</option>
                    {geofences.filter((g) => g.source === 'attendance').map((g) => (
                      <option key={g.id} value={g.id}>{g.name || g.location_name} ({g.radius_meters}m)</option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-400 mt-1">Uses the geofence centre and radius. Branch-managed locations are edited in Platform Settings → Geofence.</p>
                </div>
              )}

              {form.geofenceMode === 'custom' && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={labelCls}>Latitude</label>
                    <input className={inputCls} value={form.custom_lat} onChange={(e) => setForm({ ...form, custom_lat: e.target.value })} placeholder="6.5244" />
                  </div>
                  <div>
                    <label className={labelCls}>Longitude</label>
                    <input className={inputCls} value={form.custom_lng} onChange={(e) => setForm({ ...form, custom_lng: e.target.value })} placeholder="3.3792" />
                  </div>
                  <div>
                    <label className={labelCls}>Radius (m)</label>
                    <input type="number" min="1" className={inputCls} value={form.radius_meters} onChange={(e) => setForm({ ...form, radius_meters: Number(e.target.value) })} />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={save} disabled={busy || !form.device_name || (form.geofenceMode === 'custom' && (!form.custom_lat || !form.custom_lng))} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} {editId ? 'Save Changes' : 'Register'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================
// BIOMETRIC MAPPING TAB
// ============================================================
export function BiometricTab({ canManage }) {
  const [mappings, setMappings] = useState([])
  const [devices, setDevices] = useState([])
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ employee_id: '', device_id: '', external_user_id: '', enrollment_status: 'enrolled' })
  const [busy, setBusy] = useState(false)
  const [showCapture, setShowCapture] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [maps, devs, emps] = await Promise.all([
        attendanceEngineService.listBiometricMappings(),
        attendanceEngineService.listDevices(),
        supabase.from('employees').select('id, full_name, department, employee_number, staff_id, employee_code').eq('employment_status', 'active').order('full_name').then(({ data }) => data || []),
      ])
      setMappings(maps)
      setDevices(devs)
      setEmployees(emps)
    } catch (e) {
      setError(e?.message || 'Failed to load biometric mappings. Run the Phase 11 migration first.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await attendanceEngineService.createBiometricMapping({
        employee_id: form.employee_id,
        device_id: form.device_id,
        external_user_id: normalizeEmployeeId(form.external_user_id),
        enrollment_status: form.enrollment_status,
        active: true,
      })
      setShowForm(false)
      setForm({ employee_id: '', device_id: '', external_user_id: '', enrollment_status: 'enrolled' })
      await load()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading biometric mappings..." />

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Map InfinityCore employees to external biometric device identities. When a fingerprint device identifies an employee, it maps to their InfinityCore record.</p>
        <div className="flex items-center gap-2">
          {canManage && (
            <button onClick={() => setShowCapture(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#009944] text-[#009944] text-sm font-medium hover:bg-[#009944]/5">
              <Camera className="w-4 h-4" /> Start Biometric Capture
            </button>
          )}
          {canManage && (
            <button onClick={() => setShowForm(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <Plus className="w-4 h-4" /> Add Mapping
            </button>
          )}
        </div>
      </div>
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {mappings.length === 0 && !showForm && <EmptyState title="No biometric mappings" description="Map employees to fingerprint device user IDs." />}

      {mappings.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 font-medium">Employee ID</th>
                <th className="px-4 py-3 font-medium">Device</th>
                <th className="px-4 py-3 font-medium">External ID</th>
                <th className="px-4 py-3 font-medium">Status</th>
                {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {mappings.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{m.employees?.full_name || 'Unknown'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{m.employees?.employee_number || m.employees?.staff_id || m.employees?.employee_code || '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{m.attendance_devices?.device_name || '—'}</td>
                  <td className="px-4 py-3 text-slate-600 font-mono">{m.external_user_id}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full capitalize ${m.enrollment_status === 'enrolled' ? 'bg-emerald-50 text-emerald-700' : m.enrollment_status === 'pending' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                      {m.enrollment_status?.replace(/_/g, ' ')}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <button onClick={async () => { await attendanceEngineService.updateBiometricMapping(m.id, { enrollment_status: 'disabled', active: false }); load() }} className="text-slate-400 hover:text-amber-500 mr-2"><Ban className="w-4 h-4" /></button>
                      <button onClick={async () => { await attendanceEngineService.deleteBiometricMapping(m.id); load() }} className="text-slate-400 hover:text-rose-500"><Trash2 className="w-4 h-4" /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-xl">
            <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Add Biometric Mapping</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className={labelCls}>Employee</label>
                <select className={inputCls} value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
                  <option value="">Select employee...</option>
                  {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.full_name} ({emp.employee_number || emp.staff_id || emp.employee_code || emp.department || '—'})</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Device</label>
                <select className={inputCls} value={form.device_id} onChange={(e) => setForm({ ...form, device_id: e.target.value })}>
                  <option value="">Select device...</option>
                  {devices.map((d) => <option key={d.id} value={d.id}>{d.device_name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>External User ID</label>
                <input className={inputCls} value={form.external_user_id} onChange={(e) => setForm({ ...form, external_user_id: e.target.value })} placeholder="e.g. IMFB/26 or 238 (fingerprint device user ID)" />
              </div>
              <div>
                <label className={labelCls}>Enrollment Status</label>
                <select className={inputCls} value={form.enrollment_status} onChange={(e) => setForm({ ...form, enrollment_status: e.target.value })}>
                  <option value="enrolled">Enrolled</option>
                  <option value="pending">Pending</option>
                  <option value="not_enrolled">Not Enrolled</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={save} disabled={busy || !form.employee_id || !form.device_id || !form.external_user_id} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCapture && <BiometricCaptureModal employees={employees} onClose={() => setShowCapture(false)} onEnrolled={() => load()} />}
    </div>
  )
}

// ============================================================
// BIOMETRIC CAPTURE MODAL — camera presence check + WebAuthn enrollment
//
// Uses the SAME credential model as the employee Biometric Profile
// (employee_auth_credentials via biometricService.registerDevice):
// the device's authenticator builds the credential locally and only the
// public key + credential ID are stored — fingerprints / Face ID never
// leave the device.
// ============================================================
function BiometricCaptureModal({ employees, onClose, onEnrolled }) {
  const supported = biometricService.isWebAuthnSupported()
  const [employeeId, setEmployeeId] = useState('')
  const [deviceName, setDeviceName] = useState(() => `${navigator.userAgent.split(' ').pop() || 'Device'} — ${new Date().toLocaleDateString()}`)
  const [enrolling, setEnrolling] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [photo, setPhoto] = useState(null)

  const startCapture = async () => {
    if (!employeeId) { setError('Select an employee first.'); return }
    setError('')
    setSuccess('')
    if (!supported) {
      setError('Device biometric authentication is not available in this browser/device. Use a recent Chrome, Firefox, Edge or Safari on a biometric-capable device, or enroll the employee on a device that supports WebAuthn.')
      return
    }
    setEnrolling(true)
    try {
      await biometricService.registerDevice({
        employeeId,
        authenticatorType: 'platform',
        deviceName: deviceName.trim() || `Device — ${new Date().toLocaleDateString()}`,
      })
      setSuccess('Device biometric registered. Only the public key was stored — the fingerprint / Face ID never leaves the device.')
      setPhoto(null)
      onEnrolled()
    } catch (e) {
      setError(e?.message || 'Biometric capture could not be completed.')
    } finally {
      setEnrolling(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2"><Key className="w-5 h-5 text-[#009944]" /> Start Biometric Capture</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          {/* Privacy note */}
          <p className="text-xs text-slate-500">
            The biometric capture is a two-part confirmation: a camera presence check, then a WebAuthn device enrollment.
            InfinityCore never receives or stores fingerprints / Face ID — the device builds a public key locally and only
            that key is saved (same data model as the employee’s Biometric Profile).
          </p>

          {/* Support status */}
          <div className={`flex items-start gap-2 text-sm rounded-lg p-3 ${supported ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
            {supported ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
            <span>
              {supported
                ? 'Device biometric authentication is available in this browser.'
                : 'Device biometric authentication is not available in this browser/device. Use a recent Chrome, Firefox, Edge or Safari on a biometric-capable device, or enroll the employee on a device that supports WebAuthn.'}
            </span>
          </div>

          {/* Employee */}
          <div>
            <label className={labelCls}>Employee</label>
            <select className={inputCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Select employee...</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.full_name} ({emp.employee_number || emp.staff_id || emp.employee_code || '—'})</option>)}
            </select>
          </div>

          {/* Device name */}
          <div>
            <label className={labelCls}>Device Name</label>
            <input className={inputCls} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. HR workstation — Face ID" />
          </div>

          {/* Camera presence check (photo is held in memory only) */}
          <div>
            <label className={labelCls}>Camera Presence Check</label>
            <CameraCapture onCapture={(dataUrl) => setPhoto(dataUrl)} />
            {photo && <p className="text-xs text-slate-500 mt-1">Photo captured for the enrollment session (stored in memory only — not uploaded).</p>}
          </div>

          {error && <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm p-3">{error}</div>}
          {success && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm p-3">{success}</div>}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
            <button
              onClick={startCapture}
              disabled={enrolling || !employeeId}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
            >
              {enrolling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />} Start Biometric Capture
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// ATTENDANCE POLICY TAB
// ============================================================
export function AttendancePolicyTab({ canManage }) {
  const [config, setConfig] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const [cfg, platform] = await Promise.all([
        attendanceEngineService.getConfig(),
        platformSettingsService.get(),
      ])
      setConfig(cfg)
      if (cfg) {
        setForm({
          expected_start_time: platform?.default_work_start_time?.slice(0, 5) || cfg.expected_start_time || '',
          expected_end_time: platform?.default_work_end_time?.slice(0, 5) || cfg.expected_end_time || '',
          grace_period_minutes: platform?.default_grace_period_minutes ?? cfg.grace_period_minutes,
          late_threshold_time: cfg.late_threshold_time || '',
          geofence_enabled: platform?.geofence_enabled ?? (cfg.geofence_enabled || false),
          early_departure_threshold_minutes: platform?.early_departure_threshold_minutes ?? cfg.early_departure_threshold_minutes,
          break_allowed: cfg.break_allowed !== false,
          break_duration_minutes: platform?.default_break_duration_minutes ?? cfg.break_duration_minutes,
          overtime_threshold_hours: platform?.overtime_threshold_minutes != null ? Number((Number(platform.overtime_threshold_minutes) / 60).toFixed(2)) : cfg.overtime_threshold_hours,
          manual_correction_requires_reason: cfg.manual_correction_requires_reason !== false,
          allow_admin_override: cfg.allow_admin_override !== false,
        })
      }
    } catch (e) {
      setError(e?.message || 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const updateStartTime = (val) => {
    const grace = Number(form.grace_period_minutes)
    const parts = (val || '').split(':').map(Number)
    let lateTime = form.late_threshold_time
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && Number.isFinite(grace)) {
      const totalMins = parts[0] * 60 + parts[1] + grace + 1
      const thH = Math.floor((totalMins / 60) % 24)
      const thM = totalMins % 60
      lateTime = `${String(thH).padStart(2, '0')}:${String(thM).padStart(2, '0')}`
    }
    setForm((p) => ({ ...p, expected_start_time: val, late_threshold_time: lateTime }))
  }

  const updateGracePeriod = (val) => {
    const grace = Number(val)
    const parts = (form.expected_start_time || '').split(':').map(Number)
    let lateTime = form.late_threshold_time
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      const totalMins = parts[0] * 60 + parts[1] + grace + 1
      const thH = Math.floor((totalMins / 60) % 24)
      const thM = totalMins % 60
      lateTime = `${String(thH).padStart(2, '0')}:${String(thM).padStart(2, '0')}`
    }
    setForm((p) => ({ ...p, grace_period_minutes: grace, late_threshold_time: lateTime }))
  }

  const save = async () => {
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      await attendanceEngineService.updateConfig(form)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      await load()
    } catch (e) {
      setError(e?.message || 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading configuration..." />

  return (
    <div>
       <p className="text-sm text-slate-500 mb-4">Configure attendance policies including geofencing, breaks, and correction rules. Global work hours and grace policy are edited only in Platform Settings → Working Hours.</p>
      
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      
      {saved && (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2 max-w-2xl">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>Attendance policy and Platform Settings working hours saved and synchronized successfully.</span>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-2xl space-y-5">
        <div className="flex items-center gap-2 text-xs text-slate-600 bg-emerald-50/60 border border-emerald-200/60 rounded-lg p-3">
          <Clock className="w-4 h-4 text-[#009944] shrink-0" />
           <span>Working hours, working days, and grace period are read from <strong>Platform Settings → Working Hours</strong>.</span>
        </div>

        {/* General */}
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3">General Work Hours</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Expected Start Time</label>
               <input type="time" className={`${inputCls} bg-slate-50`} value={form.expected_start_time || ''} readOnly />
            </div>
            <div>
              <label className={labelCls}>Expected End Time</label>
               <input type="time" className={`${inputCls} bg-slate-50`} value={form.expected_end_time || ''} readOnly />
            </div>
            <div>
              <label className={labelCls}>Grace Period (minutes)</label>
               <input type="number" className={`${inputCls} bg-slate-50`} value={form.grace_period_minutes ?? ''} readOnly />
            </div>
            <div>
              <label className={labelCls}>Late Threshold Time</label>
               <input type="time" className={`${inputCls} bg-slate-50`} value={form.late_threshold_time || ''} readOnly />
            </div>
          </div>
        </div>

        {/* Geofencing */}
        <div className="border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Geofencing</h3>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={form.geofence_enabled || false} onChange={(e) => setForm({ ...form, geofence_enabled: e.target.checked })} disabled={!canManage} className="rounded" />
            Enable geofencing (require GPS location for clock-in)
          </label>
        </div>

        {/* Breaks & Overtime */}
        <div className="border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Breaks & Overtime</h3>
          <div className="grid grid-cols-3 gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.break_allowed || false} onChange={(e) => setForm({ ...form, break_allowed: e.target.checked })} disabled={!canManage} className="rounded" />
              Breaks allowed
            </label>
            <div>
              <label className={labelCls}>Break Duration (min)</label>
              <input type="number" className={inputCls} value={form.break_duration_minutes ?? ''} onChange={(e) => setForm({ ...form, break_duration_minutes: Number(e.target.value) })} disabled={!canManage} />
            </div>
            <div>
              <label className={labelCls}>Overtime Threshold (hrs)</label>
              <input type="number" step="0.5" className={inputCls} value={form.overtime_threshold_hours ?? ''} onChange={(e) => setForm({ ...form, overtime_threshold_hours: Number(e.target.value) })} disabled={!canManage} />
            </div>
          </div>
        </div>

        {/* Corrections */}
        <div className="border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Corrections & Overrides</h3>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.manual_correction_requires_reason || false} onChange={(e) => setForm({ ...form, manual_correction_requires_reason: e.target.checked })} disabled={!canManage} className="rounded" />
              Require reason for manual corrections
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.allow_admin_override || false} onChange={(e) => setForm({ ...form, allow_admin_override: e.target.checked })} disabled={!canManage} className="rounded" />
              Allow admin override for geofence failures
            </label>
            <div>
              <label className={labelCls}>Early Departure Threshold (min)</label>
              <input type="number" className={inputCls} value={form.early_departure_threshold_minutes ?? ''} onChange={(e) => setForm({ ...form, early_departure_threshold_minutes: Number(e.target.value) })} disabled={!canManage} />
            </div>
          </div>
        </div>

        {canManage && (
          <div className="flex justify-end pt-2 border-t border-slate-100">
            <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save Configuration
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
