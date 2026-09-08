import React, { useState, useEffect } from 'react'
import { Fingerprint, Loader2, Check, X, Clock, MapPin } from 'lucide-react'
import { attendanceEngineService } from '../services/attendanceEngineService'

// ============================================================
// ATTENDANCE TERMINAL MODE
// Simplified interface for dedicated attendance devices.
// Does NOT expose the rest of InfinityCore.
// ============================================================
export default function AttendanceTerminal() {
  const [devices, setDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [mappings, setMappings] = useState([])
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [currentTime, setCurrentTime] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        const devs = await attendanceEngineService.listDevices()
        const terminals = devs.filter((d) => d.device_type === 'attendance_terminal' && d.status === 'active')
        setDevices(terminals)
        if (terminals.length > 0) setSelectedDevice(terminals[0])
        const maps = await attendanceEngineService.listBiometricMappings()
        setMappings(maps.filter((m) => m.enrollment_status === 'enrolled' && m.active))
      } catch (e) {
        setError(e?.message || 'Failed to load terminal data')
      }
    }
    load()
  }, [])

  const handleClock = async (eventType) => {
    if (!selectedDevice || !pin) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      // Find the biometric mapping for this PIN/external_user_id
      const mapping = mappings.find((m) => m.external_user_id === pin && m.device_id === selectedDevice.id)
      if (!mapping) {
        setError('Unknown employee ID. Please check and try again.')
        setBusy(false)
        return
      }

      const data = await attendanceEngineService.simulateDeviceEvent({
        deviceId: selectedDevice.id,
        externalUserId: pin,
        eventType,
      })

      if (data?.success) {
        setResult({
          success: true,
          name: data.employee_name,
          eventType,
          time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        })
        setPin('')
        setTimeout(() => setResult(null), 5000)
      } else {
        setError(data?.error || 'Clock operation failed')
      }
    } catch (e) {
      setError(e?.message || 'Terminal error')
    } finally {
      setBusy(false)
    }
  }

  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  })()

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        {/* Terminal Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#009944] to-[#007a36] flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Fingerprint className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">InfinityCore</h1>
          <p className="text-sm text-white/60 mt-1">Attendance Terminal</p>
          <p className="text-3xl font-bold text-white tabular-nums mt-4">{currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
          <p className="text-sm text-white/60 mt-1">{currentTime.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        </div>

        {/* Device selector */}
        {devices.length > 1 && (
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
            <p className="text-white/70 text-sm mt-2">{result.time}</p>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="bg-rose-500/20 border border-rose-500/40 rounded-xl p-4 text-center mb-6">
            <X className="w-8 h-8 text-rose-400 mx-auto mb-2" />
            <p className="text-rose-300 text-sm">{error}</p>
          </div>
        )}

        {/* PIN input */}
        {!result?.success && (
          <div className="bg-white/5 backdrop-blur rounded-2xl border border-white/10 p-6">
            <p className="text-white/60 text-sm text-center mb-4">Enter your Employee ID or PIN</p>
            <input
              type="text"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && pin) handleClock('CLOCK_IN') }}
              placeholder="Enter ID..."
              className="w-full h-14 rounded-xl bg-white/10 border border-white/20 text-white text-center text-xl font-medium tracking-wider focus:outline-none focus:ring-2 focus:ring-[#009944] mb-4"
              autoFocus
            />
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleClock('CLOCK_IN')}
                disabled={busy || !pin}
                className="h-14 rounded-xl bg-[#009944] text-white font-medium hover:bg-[#007a36] transition-all disabled:opacity-30 flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Clock className="w-5 h-5" /> Clock In</>}
              </button>
              <button
                onClick={() => handleClock('CLOCK_OUT')}
                disabled={busy || !pin}
                className="h-14 rounded-xl bg-rose-500/80 text-white font-medium hover:bg-rose-600 transition-all disabled:opacity-30 flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Clock className="w-5 h-5" /> Clock Out</>}
              </button>
            </div>
          </div>
        )}

        {/* Status */}
        <div className="mt-6 text-center">
          {selectedDevice ? (
            <p className="text-xs text-white/40 flex items-center justify-center gap-1.5">
              <MapPin className="w-3 h-3" /> {selectedDevice.device_name} · {selectedDevice.branch_id || 'No branch'}
            </p>
          ) : (
            <p className="text-xs text-amber-400/60">No active terminal device registered. Register a terminal in Settings → Devices.</p>
          )}
        </div>
      </div>
    </div>
  )
}
