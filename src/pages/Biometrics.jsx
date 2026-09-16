import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Fingerprint, Loader2, Monitor, Plus, Trash2, ShieldAlert, Smartphone } from 'lucide-react'
import { supabase } from '../supabaseClient'
import biometricService from '../services/biometricService'

function Biometrics() {
  const { employeeId } = useParams()
  const [employee, setEmployee] = useState(null)
  const [credentials, setCredentials] = useState([])
  const [mappings, setMappings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deviceName, setDeviceName] = useState('')
  const [registering, setRegistering] = useState(false)
  const [revoking, setRevoking] = useState(null)
  const [notice, setNotice] = useState(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!employeeId) throw new Error('Missing employee. Go back and open Link Biometrics from a valid profile.')

      const { data: emp, error: empErr } = await supabase
        .from('employees')
        .select('id, full_name, employee_number, employee_code, staff_id, department, branch, position, employment_status')
        .eq('id', employeeId)
        .single()
      if (empErr) throw new Error('Employee not found or you do not have access to this record.')
      setEmployee(emp)

      let creds = []
      try { creds = await biometricService.listCredentials({ employeeId }) } catch (e) { /* credential table may be empty/private */ }
      setCredentials(creds || [])

      let maps = []
      try {
        const { data, error: mErr } = await supabase
          .from('employee_biometric_identifiers')
          .select('id, device_id, external_user_id, enrollment_status, active, created_at')
          .eq('employee_id', employeeId)
        if (!mErr) maps = data || []
      } catch (e) { /* optional table */ }
      setMappings(maps)
    } catch (e) {
      setError(e.message || 'Failed to load biometrics data')
    } finally {
      setLoading(false)
    }
  }, [employeeId])

  useEffect(() => { loadAll() }, [loadAll])

  const handleRegister = async () => {
    const name = deviceName.trim()
    if (!name) return
    setRegistering(true)
    setNotice(null)
    setError(null)
    try {
      await biometricService.registerDevice({ employeeId, authenticatorType: 'platform', deviceName: name })
      setNotice('Device registration verified. The public key is now linked to this employee.')
      setDeviceName('')
      await loadAll()
    } catch (e) {
      setError(`Registration could not be completed: ${e.message || ''}`.trim())
    } finally {
      setRegistering(false)
    }
  }

  const handleRevoke = async (id, deviceName_) => {
    if (!window.confirm(`Revoke the biometric credential "${deviceName_}"? The employee will no longer be able to authenticate with this device.`)) return
    setRevoking(id)
    setError(null)
    try {
      await biometricService.removeCredential(id)
      await loadAll()
    } catch (e) {
      setError(`Could not revoke credential: ${e.message || ''}`)
    } finally {
      setRevoking(null)
    }
  }

  const supported = biometricService.isWebAuthnSupported()

  return (
    <div>
      <Link to="/profile" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#009944] mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to profile
      </Link>

      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-full bg-[#FF8C00] text-black flex items-center justify-center text-xl font-semibold">
            {employee?.full_name?.charAt(0)?.toUpperCase() || 'U'}
          </div>
          <div className="flex-1">
            <h2 className="text-2xl font-semibold text-slate-900">{employee?.full_name || 'Employee'}</h2>
            <p className="text-sm text-slate-500 mt-1">
              {[employee?.position, employee?.department, employee?.branch].filter(Boolean).join(' · ') || 'Biometric credentials'
              }
            </p>
            {(employee?.employee_number || employee?.staff_id || employee?.employee_code) && (
              <p className="text-xs text-slate-500 mt-1">
                {[employee?.employee_number && `Emp #${employee.employee_number}`, employee?.staff_id && `Staff ID ${employee.staff_id}`, employee?.employee_code && `Code ${employee.employee_code}`].filter(Boolean).join('  ·  ')}
              </p>
            )}
          </div>
          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${employee?.employment_status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            {(employee?.employment_status || '—').replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex gap-3">
        <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-800">
          <p className="font-medium">Biometric data never leaves the device</p>
          <p className="mt-1 text-amber-700">
            InfinityCore does not store fingerprints or Face ID images. WebAuthn/FIDO2 keeps your biometric on this device's secure enclave and registers a public key only. These credentials are used to authenticate into InfinityCore and are managed per employee.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg p-4 mb-6">{error}</div>
      )}
      {notice && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-lg p-4 mb-6">{notice}</div>
      )}

      <div className="bg-white rounded-lg border border-slate-200 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <div>
            <h3 className="font-medium text-slate-900">Registered devices</h3>
            <p className="text-xs text-slate-400 mt-0.5">Active WebAuthn credentials for this employee</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
              placeholder="Device name (e.g. MacBook Face ID)"
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-56 focus:outline-none focus:ring-2 focus:ring-[#009944]/30"
            />
            <button onClick={handleRegister} disabled={registering || !deviceName.trim() || !supported}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
              {registering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Register device
            </button>
          </div>
        </div>

        {!supported && (
          <div className="px-5 py-4 text-sm text-slate-500">
            WebAuthn is not available in this browser. Use a recent Chrome, Edge, Firefox or Safari to register devices.
          </div>
        )}

        {loading ? (
          <div className="px-5 py-10 flex items-center justify-center text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading credentials…
          </div>
        ) : credentials.length === 0 && mappings.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <Fingerprint className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No registered devices yet.</p>
            <p className="text-xs text-slate-400 mt-1">Enter a device name above and click Register device to link a biometric login.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="px-5 py-3 font-medium">Device</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium">Registered</th>
                  <th className="px-5 py-3 font-medium">Last used</th>
                  <th className="px-5 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => (
                  <tr key={c.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-2 text-slate-800 font-medium">
                        {c.authenticator_type === 'platform' ? <Monitor className="w-4 h-4 text-slate-400" /> : <Smartphone className="w-4 h-4 text-slate-400" />}
                        {c.device_name || 'Unnamed device'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-500">{c.authenticator_type || 'platform'}</td>
                    <td className="px-5 py-3 text-slate-500">{c.created_at ? new Date(c.created_at).toLocaleDateString() : '—'}</td>
                    <td className="px-5 py-3 text-slate-500">{c.last_used_at ? new Date(c.last_used_at).toLocaleString() : 'Never'}</td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => handleRevoke(c.id, c.device_name)} disabled={revoking === c.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 text-xs font-medium hover:bg-rose-50 disabled:opacity-50">
                        {revoking === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {mappings.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200">
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="font-medium text-slate-900">Device identifier mappings</h3>
            <p className="text-xs text-slate-400 mt-0.5">Physical device links (reference metadata only, never the raw biometric)</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="px-5 py-3 font-medium">Device</th>
                  <th className="px-5 py-3 font-medium">External user</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Linked</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m) => (
                  <tr key={m.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-5 py-3 text-slate-800 font-medium">{m.device_id || '—'}</td>
                    <td className="px-5 py-3 text-slate-500">{m.external_user_id}</td>
                    <td className="px-5 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${m.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        {m.active ? (m.enrollment_status || 'enrolled') : 'inactive'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-500">{m.created_at ? new Date(m.created_at).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

export default Biometrics