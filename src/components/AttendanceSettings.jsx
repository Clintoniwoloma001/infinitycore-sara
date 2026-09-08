import React, { useState, useEffect } from 'react'
import { Loader2, Plus, Trash2, MapPin, Edit, X, Check, Navigation, Fingerprint, Monitor, Cpu, Link2, Ban, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { attendanceEngineService } from '../services/attendanceEngineService'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'

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
          <button onClick={() => { setShowAdd(true); setShowForm(true); setEditId(null) }} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
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
                  {canManage && (
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
export function DevicesTab({ canManage }) {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ device_name: '', device_type: 'fingerprint', manufacturer: '', model: '', serial_number: '', branch_id: '', integration_type: 'api', api_endpoint: '' })
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setDevices(await attendanceEngineService.listDevices())
    } catch (e) {
      setError(e?.message || 'Failed to load devices. Run the Phase 11 migration first.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await attendanceEngineService.createDevice({
        device_name: form.device_name,
        device_type: form.device_type,
        manufacturer: form.manufacturer || null,
        model: form.model || null,
        serial_number: form.serial_number || null,
        branch_id: form.branch_id || null,
        integration_type: form.integration_type,
        api_endpoint: form.api_endpoint || null,
        status: 'active',
        active: true,
      })
      setShowForm(false)
      setForm({ device_name: '', device_type: 'fingerprint', manufacturer: '', model: '', serial_number: '', branch_id: '', integration_type: 'api', api_endpoint: '' })
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
        <p className="text-sm text-slate-500">Register fingerprint scanners, biometric devices, and attendance terminals. Each device feeds the central attendance engine.</p>
        {canManage && (
          <button onClick={() => setShowForm(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
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
                      <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                        {d.serial_number && <span>S/N: {d.serial_number}</span>}
                        {d.branch_id && <span>Branch: {d.branch_id}</span>}
                        <span>Integration: {d.integration_type}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full ${d.status === 'active' ? 'bg-emerald-50 text-emerald-700' : d.status === 'offline' ? 'bg-slate-100 text-slate-500' : 'bg-rose-50 text-rose-700'}`}>
                      {d.status === 'active' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                      {d.status}
                    </span>
                    {d.last_seen_at && <span className="text-xs text-slate-400">Last seen: {new Date(d.last_seen_at).toLocaleDateString()}</span>}
                    {canManage && d.status === 'active' && (
                      <button onClick={() => revoke(d)} className="text-slate-400 hover:text-rose-500" title="Revoke"><Ban className="w-4 h-4" /></button>
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
          <div className="bg-white rounded-xl w-full max-w-lg shadow-xl">
            <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Register Device</h3>
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
                <label className={labelCls}>Branch ID (optional)</label>
                <input className={inputCls} value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>API Endpoint (optional)</label>
                <input className={inputCls} value={form.api_endpoint} onChange={(e) => setForm({ ...form, api_endpoint: e.target.value })} placeholder="https://..." />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={save} disabled={busy || !form.device_name} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Register
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

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [maps, devs, emps] = await Promise.all([
        attendanceEngineService.listBiometricMappings(),
        attendanceEngineService.listDevices(),
        supabase.from('employees').select('id, full_name, department').eq('employment_status', 'active').order('full_name').then(({ data }) => data || []),
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
        external_user_id: form.external_user_id,
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
        {canManage && (
          <button onClick={() => setShowForm(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> Add Mapping
          </button>
        )}
      </div>
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {mappings.length === 0 && !showForm && <EmptyState title="No biometric mappings" description="Map employees to fingerprint device user IDs." />}

      {mappings.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Employee</th>
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
                  {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.full_name} ({emp.department || '—'})</option>)}
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
                <input className={inputCls} value={form.external_user_id} onChange={(e) => setForm({ ...form, external_user_id: e.target.value })} placeholder="e.g. 238 (fingerprint device user ID)" />
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
  const [error, setError] = useState('')
  const [form, setForm] = useState({})

  const load = async () => {
    setLoading(true)
    try {
      const cfg = await attendanceEngineService.getConfig()
      setConfig(cfg)
      if (cfg) {
        setForm({
          expected_start_time: cfg.expected_start_time || '08:00',
          expected_end_time: cfg.expected_end_time || '17:00',
          grace_period_minutes: cfg.grace_period_minutes || 15,
          late_threshold_time: cfg.late_threshold_time || '08:16',
          geofence_enabled: cfg.geofence_enabled || false,
          early_departure_threshold_minutes: cfg.early_departure_threshold_minutes || 30,
          break_allowed: cfg.break_allowed !== false,
          break_duration_minutes: cfg.break_duration_minutes || 60,
          overtime_threshold_hours: cfg.overtime_threshold_hours || 8.0,
          manual_correction_requires_reason: cfg.manual_correction_requires_reason !== false,
          allow_admin_override: cfg.allow_admin_override !== false,
        })
      } else {
        setForm({
          expected_start_time: '08:00', expected_end_time: '17:00', grace_period_minutes: 15,
          late_threshold_time: '08:16', geofence_enabled: false, early_departure_threshold_minutes: 30,
          break_allowed: true, break_duration_minutes: 60, overtime_threshold_hours: 8.0,
          manual_correction_requires_reason: true, allow_admin_override: true,
        })
      }
    } catch (e) {
      setError(e?.message || 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await attendanceEngineService.updateConfig(form)
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
      <p className="text-sm text-slate-500 mb-4">Configure attendance policies including work hours, geofencing, breaks, and correction rules.</p>
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      <div className="bg-white rounded-xl border border-slate-200 p-6 max-w-2xl space-y-5">
        {/* General */}
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3">General Work Hours</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Expected Start Time</label>
              <input type="time" className={inputCls} value={form.expected_start_time || ''} onChange={(e) => setForm({ ...form, expected_start_time: e.target.value })} disabled={!canManage} />
            </div>
            <div>
              <label className={labelCls}>Expected End Time</label>
              <input type="time" className={inputCls} value={form.expected_end_time || ''} onChange={(e) => setForm({ ...form, expected_end_time: e.target.value })} disabled={!canManage} />
            </div>
            <div>
              <label className={labelCls}>Grace Period (minutes)</label>
              <input type="number" className={inputCls} value={form.grace_period_minutes || ''} onChange={(e) => setForm({ ...form, grace_period_minutes: Number(e.target.value) })} disabled={!canManage} />
            </div>
            <div>
              <label className={labelCls}>Late Threshold Time</label>
              <input type="time" className={inputCls} value={form.late_threshold_time || ''} onChange={(e) => setForm({ ...form, late_threshold_time: e.target.value })} disabled={!canManage} />
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
              <input type="number" className={inputCls} value={form.break_duration_minutes || ''} onChange={(e) => setForm({ ...form, break_duration_minutes: Number(e.target.value) })} disabled={!canManage} />
            </div>
            <div>
              <label className={labelCls}>Overtime Threshold (hrs)</label>
              <input type="number" step="0.5" className={inputCls} value={form.overtime_threshold_hours || ''} onChange={(e) => setForm({ ...form, overtime_threshold_hours: Number(e.target.value) })} disabled={!canManage} />
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
              <input type="number" className={inputCls} value={form.early_departure_threshold_minutes || ''} onChange={(e) => setForm({ ...form, early_departure_threshold_minutes: Number(e.target.value) })} disabled={!canManage} />
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
