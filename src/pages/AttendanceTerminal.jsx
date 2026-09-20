import React, { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Fingerprint, Loader2, Check, X, Clock, MapPin, ShieldCheck } from 'lucide-react'
import { attendanceEngineService } from '../services/attendanceEngineService'
import { attendanceService, DEFAULT_ATTENDANCE_TIMEZONE, formatAttendanceTime, getPosition, normalizeAttendanceError } from '../services/attendanceService'
import { biometricService } from '../services/biometricService'
import { normalizeEmployeeId, canonicalEmployeeId } from '../utils/employeeId'
import { getDeviceFingerprint } from '../utils/deviceFingerprint'
import { useNetworkTime } from '../hooks/useNetworkTime'

// ============================================================
// ATTENDANCE TERMINAL MODE
// Simplified interface for dedicated attendance devices.
// Does NOT expose the rest of InfinityCore.
//
// Employee lookup: the official employee number (IMFB/26) is
// normalized and resolved through employees.employee_number /
// staff_id / employee_code. The confirmed identity is shown
// BEFORE recording attendance, then clock-in/out is recorded
// against the employee's UUID (never a duplicate).
// ============================================================
export default function AttendanceTerminal() {
  const navigate = useNavigate()
  const location = useLocation()
  const terminalToken = new URLSearchParams(location.search).get('token') || ''
  const publicMode = Boolean(terminalToken)
  const [devices, setDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [geo, setGeo] = useState(null)
  const [geoStatus, setGeoStatus] = useState('idle')
  const [locationCheck, setLocationCheck] = useState(null)
  const [timeZone, setTimeZone] = useState(DEFAULT_ATTENDANCE_TIMEZONE)
  const { now: currentTime, synced: networkTimeSynced } = useNetworkTime()
  // Confirmed identity — shown before recording attendance
  const [confirmed, setConfirmed] = useState(null)
  // Device-scoped fingerprint (QR mode only) — one device, one employee/day
  const [deviceFingerprint, setDeviceFingerprint] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const requirements = await attendanceService.getAttendanceRequirements()
        if (publicMode) {
          // Browser composite fingerprint sent with every QR terminal call.
          // The server enforces one-device-per-employee-per-day from it.
          const fp = await getDeviceFingerprint().catch(() => '')
          setDeviceFingerprint(fp)
        }
        if (!publicMode) {
          const devs = await attendanceEngineService.listDevices()
          const terminals = devs.filter((d) => d.device_type === 'attendance_terminal' && d.status === 'active')
          setDevices(terminals)
          if (terminals.length > 0) setSelectedDevice(terminals[0])
        }
        if (requirements?.appTimezone) setTimeZone(requirements.appTimezone)
      } catch (e) {
        setError(e?.message || 'Failed to load terminal data')
      }
    }
    load()
  }, [publicMode])

  const verifyEmployee = async () => {
    if (!pin || (!selectedDevice && !publicMode)) return
    setBusy(true)
    setError('')
    setResult(null)
    setConfirmed(null)
    try {
      const lookup = publicMode
        ? await attendanceService.validatePublicTerminalEmployee(terminalToken, pin, deviceFingerprint)
        : await attendanceEngineService.lookupAttendanceEmployee(pin)
      if (publicMode ? !lookup?.valid : !lookup?.found) {
        setError(lookup?.error || 'Employee ID not found. Please check the ID and try again.')
        setBusy(false)
        return
      }
      if (publicMode && lookup?.device_binding_blocked) {
        setError(lookup?.device_binding_error || 'This device has already been used to clock in a different employee today. Contact your supervisor or HR if this is an error.')
        setBusy(false)
        return
      }
      const identity = publicMode
        ? {
            employee_number: lookup.employee_number || pin,
            employee_name: lookup.employee_name,
            nextAction: lookup.next_action || null,
            public: true,
          }
        : lookup.employee
      setConfirmed(identity)
      if (publicMode) {
        setGeoStatus('fetching')
        setLocationCheck(null)
        const position = await getPosition()
        setGeo(position)
        const checked = await attendanceService.validatePublicTerminalLocation({
          token: terminalToken,
          employeeIdentifier: identity.employee_number,
          eventType: 'CLOCK_IN',
          geo: position,
        })
        setLocationCheck(checked)
        setGeoStatus('ok')
      }
    } catch (e) {
      if (publicMode) setGeoStatus('denied')
      setError(e?.message || 'Employee lookup failed')
    } finally {
      setBusy(false)
    }
  }

  const handleClock = async (eventType) => {
    if ((!selectedDevice && !publicMode) || !confirmed) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      let actionGeo = geo
      if (publicMode) {
        setGeoStatus('fetching')
        actionGeo = await getPosition()
        const checked = await attendanceService.validatePublicTerminalLocation({
          token: terminalToken,
          employeeIdentifier: confirmed.employee_number || pin,
          eventType,
          geo: actionGeo,
        })
        setGeo(actionGeo)
        setLocationCheck(checked)
        setGeoStatus('ok')
      }
      const data = publicMode
        ? await attendanceService.clockPublicTerminal({
          token: terminalToken,
          employeeIdentifier: confirmed.employee_number || pin,
          eventType,
          geo: actionGeo,
          deviceFingerprint,
        })
        : await attendanceEngineService.simulateDeviceEvent({
          deviceId: selectedDevice.id,
          externalUserId: confirmed.employee_number || pin,
          eventType,
          verificationMethod: 'DEVICE_AUTHENTICATION',
          employeeId: confirmed.id,
        })

      if (data?.success) {
        setResult({
          success: true,
           name: publicMode ? (data.employee_name || confirmed.employee_name || 'Attendance recorded') : (data.employee_name || confirmed.full_name),
          eventType,
          time: data.event_time || data.server_time,
          location: data.actual_location_name,
          assignedBranch: data.assigned_branch_name,
          workHours: data.work_hours,
        })
        setConfirmed(null)
        setPin('')
        setTimeout(() => setResult(null), 5000)
      } else {
        setError(data?.error || 'Clock operation failed')
      }
    } catch (e) {
      setError(normalizeAttendanceError(e?.message) || 'Terminal error')
    } finally {
      setBusy(false)
    }
  }

  // ---- WebAuthn / device authentication (option B) ----
  const handleBiometric = async (eventType) => {
    if (!selectedDevice || publicMode) return
    setBusy(true)
    setError('')
    setResult(null)
    setConfirmed(null)
    try {
      const verified = await biometricService.authenticate()
      if (!verified?.employee?.id) throw new Error('Biometric authentication could not identify an employee.')
      const employee = verified.employee

      const data = await attendanceEngineService.simulateDeviceEvent({
        deviceId: selectedDevice.id,
        externalUserId: employee.employee_number || '',
        eventType,
        verificationMethod: 'WEBAUTHN',
        employeeId: employee.id,
      })

      if (data?.success) {
        setResult({
          success: true,
          name: data.employee_name || employee.full_name,
          eventType,
          time: data.event_time || data.server_time,
        })
        setTimeout(() => setResult(null), 5000)
      } else {
        setError(data?.error || 'Clock operation failed')
      }
    } catch (e) {
      setError(normalizeAttendanceError(e?.message) || 'Biometric authentication failed')
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    setConfirmed(null)
    setError('')
    setPin('')
    setGeo(null)
    setLocationCheck(null)
    setGeoStatus('idle')
  }

  const greeting = (() => {
    if (!currentTime) return 'Welcome'
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(currentTime))
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  })()

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        {/* Back navigation */}
        {!publicMode && (
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white transition-colors mb-4"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
        )}

        {/* Terminal Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#009944] to-[#007a36] flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Fingerprint className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">InfinityCore</h1>
           <p className="text-sm text-white/60 mt-1">{publicMode ? 'QR Attendance Terminal' : 'Attendance Terminal'}</p>
          <p className="text-3xl font-bold text-white tabular-nums mt-4">{currentTime ? currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone }) : 'Syncing official time...'}</p>
          <p className="text-sm text-white/60 mt-1">{currentTime ? currentTime.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone }) : 'Official server time'}</p>
        </div>

        {/* Device selector */}
        {!publicMode && devices.length > 1 && (
          <div className="mb-6">
            <select
              value={selectedDevice?.id || ''}
              onChange={(e) => setSelectedDevice(devices.find((d) => d.id === e.target.value))}
              className="w-full h-12 rounded-xl bg-white/10 border border-white/20 text-white px-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
            >
              {devices.map((d) => <option key={d.id} value={d.id} className="bg-slate-800">{d.device_name}</option>)}
            </select>
          </div>
        )}

        {/* Result display */}
        {result?.success && (
          <div className="bg-emerald-500 rounded-2xl p-8 text-center mb-6 animate-[fadeIn_0.3s_ease]">
            <Check className="w-16 h-16 text-white mx-auto mb-3" />
            <p className="text-white/80 text-sm">{greeting},</p>
            <p className="text-2xl font-bold text-white mb-2">{result.name}</p>
            <p className="text-white text-lg font-medium">{result.eventType.replace(/_/g, ' ')} SUCCESSFUL</p>
            <p className="text-white/70 text-sm mt-2">{formatAttendanceTime(result.time, timeZone)}</p>
            {result.location && <p className="text-white/90 text-sm mt-2">Location: {result.location}</p>}
            {result.assignedBranch && result.location && result.assignedBranch !== result.location && (
              <p className="text-white/80 text-xs mt-1">Assigned branch: {result.assignedBranch}</p>
            )}
            {result.workHours != null && <p className="text-white/80 text-xs mt-1">Hours: {result.workHours}</p>}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="bg-rose-500/20 border border-rose-500/40 rounded-xl p-4 text-center mb-6">
            <X className="w-8 h-8 text-rose-400 mx-auto mb-2" />
            <p className="text-rose-300 text-sm">{error}</p>
          </div>
        )}

        {/* Confirmed identity — shown before recording attendance */}
        {confirmed && !result?.success && (
          <div className="bg-white rounded-2xl p-6 mb-6 shadow-xl">
            <div className="flex items-start justify-between mb-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Confirm your identity</p>
              <button onClick={cancel} className="text-slate-400 hover:text-slate-600 text-sm">Cancel</button>
            </div>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#009944] to-[#007a36] flex items-center justify-center text-white font-bold text-lg">
                {(confirmed.full_name || confirmed.employee_name || '?').split(' ').filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase()).join('')}
              </div>
              <div>
                <p className="font-semibold text-slate-900 text-lg leading-tight">{confirmed.public ? (confirmed.employee_name || 'Employee number verified') : (confirmed.full_name || 'Unknown')}</p>
                <p className="font-mono text-sm text-[#009944] font-medium">{confirmed.employee_number || '—'}</p>
              </div>
            </div>
            {publicMode && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 mb-4 text-sm">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-slate-500" />
                  {geoStatus === 'fetching' && <span className="text-slate-600">Checking location…</span>}
                  {geoStatus === 'denied' && <span className="text-rose-600">Location is required to clock in or out.</span>}
                  {geoStatus === 'ok' && locationCheck?.valid && (
                    <span className="text-emerald-700">
                      Location verified — {locationCheck.actual_location_name || 'approved attendance location'}
                    </span>
                  )}
                </div>
                {geoStatus === 'ok' && locationCheck?.valid && (
                  <p className="text-xs text-slate-500 mt-1 ml-6">
                    {locationCheck.location_difference
                      ? `Clocking from ${locationCheck.actual_location_name}. Your assigned branch is ${locationCheck.assigned_branch_name || 'different branch'}.`
                      : 'Clock-in location matches your assigned branch.'}
                    {locationCheck.distance != null ? ` Distance: ${Math.round(locationCheck.distance)}m.` : ''}
                  </p>
                )}
              </div>
            )}
            {!confirmed.public && <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Department</p>
                <p className="font-medium text-slate-800">{confirmed.department || '—'}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">Branch</p>
                <p className="font-medium text-slate-800">{confirmed.branch || '—'}</p>
              </div>
            </div>}
            {publicMode && confirmed.nextAction === 'COMPLETE' ? (
              <div className="mt-4 h-12 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 font-medium flex items-center justify-center gap-2">
                <Check className="w-5 h-5" /> Attendance complete for today
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 mt-4">
                {(!publicMode || !confirmed.nextAction || confirmed.nextAction === 'CLOCK_IN') && (
                  <button
                    onClick={() => handleClock('CLOCK_IN')}
                    disabled={busy || !networkTimeSynced || (publicMode && !locationCheck?.valid)}
                    className="h-12 rounded-xl bg-[#009944] text-white font-medium hover:bg-[#007a36] transition-all disabled:opacity-30 flex items-center justify-center gap-2"
                  >
                    {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Clock className="w-5 h-5" /> Clock In</>}
                  </button>
                )}
                {(!publicMode || !confirmed.nextAction || confirmed.nextAction === 'CLOCK_OUT') && (
                  <button
                    onClick={() => handleClock('CLOCK_OUT')}
                    disabled={busy || !networkTimeSynced || (publicMode && !locationCheck?.valid)}
                    className="h-12 rounded-xl bg-rose-500/80 text-white font-medium hover:bg-rose-600 transition-all disabled:opacity-30 flex items-center justify-center gap-2"
                  >
                    {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Clock className="w-5 h-5" /> Clock Out</>}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ID entry */}
        {!result?.success && !confirmed && (
          <div className="bg-white/5 backdrop-blur rounded-2xl border border-white/10 p-6">
             <p className="text-white/60 text-sm text-center mb-4">{publicMode ? 'Enter your Employee Number or Email' : 'Enter your Employee ID or PIN'}</p>
            <input
              type="text"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && pin) verifyEmployee() }}
              placeholder="Enter ID..."
              className="w-full h-14 rounded-xl bg-white/10 border border-white/20 text-white text-center text-xl font-medium tracking-wider focus:outline-none focus:ring-2 focus:ring-[#009944] mb-4"
              autoFocus
            />
            <button
              onClick={verifyEmployee}
              disabled={busy || !pin}
              className="w-full h-14 rounded-xl bg-[#009944] text-white font-medium hover:bg-[#007a36] transition-all disabled:opacity-30 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <><ShieldCheck className="w-5 h-5" /> Verify ID</>}
            </button>

             {!publicMode && biometricService.isWebAuthnSupported() && (
              <div className="mt-4 flex items-center gap-3">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-xs text-white/40">or</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>
            )}
            {!publicMode && <div className="grid grid-cols-2 gap-3 mt-4">
              <button
                onClick={() => handleBiometric('CLOCK_IN')}
                disabled={busy || !networkTimeSynced || !biometricService.isWebAuthnSupported()}
                className="h-12 rounded-xl bg-white/10 border border-white/20 text-white text-sm font-medium hover:bg-white/20 transition-all disabled:opacity-30 flex items-center justify-center gap-2"
              >
                <Fingerprint className="w-4 h-4" /> Biometric In
              </button>
              <button
                onClick={() => handleBiometric('CLOCK_OUT')}
                disabled={busy || !networkTimeSynced || !biometricService.isWebAuthnSupported()}
                className="h-12 rounded-xl bg-white/10 border border-white/20 text-white text-sm font-medium hover:bg-white/20 transition-all disabled:opacity-30 flex items-center justify-center gap-2"
              >
                <Fingerprint className="w-4 h-4" /> Biometric Out
              </button>
            </div>}
          </div>
        )}

        {/* Status */}
        <div className="mt-6 text-center space-y-1">
          {publicMode ? (
            <>
              <p className="text-xs text-white/40 flex items-center justify-center gap-1.5"><MapPin className="w-3 h-3" /> Public QR terminal · location required</p>
              <p className="text-xs text-white/30 flex items-center justify-center gap-1.5">No InfinityCore login or private employee data is required.</p>
            </>
          ) : selectedDevice ? (
            <>
              <p className="text-xs text-white/40 flex items-center justify-center gap-1.5">
                <MapPin className="w-3 h-3" /> {selectedDevice.device_name} · {selectedDevice.branch_id || 'No branch'}
              </p>
              <p className="text-xs text-white/30 flex items-center justify-center gap-1.5">
                Location is captured and checked against the employee branch geofence in Platform Settings.
              </p>
            </>
          ) : (
            <p className="text-xs text-amber-400/60">No active terminal device registered. Register a terminal in Settings → Devices.</p>
          )}
        </div>
      </div>
    </div>
  )
}
