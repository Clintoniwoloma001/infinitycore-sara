import React, { useState, useEffect, useCallback } from 'react'
import { X, ShieldCheck, AlertTriangle, Loader2, Smartphone, Laptop, CheckCircle, Trash2, Key } from 'lucide-react'
import { biometricService } from '../services/biometricService'

// ============================================================
// BiometricModal — WebAuthn credential management
//
// Shows enrolled devices, registers new ones, revokes credentials.
// The actual fingerprint/Face ID data never leaves the employee's
// device — InfinityCore stores only the public key and credential ID
// created by the device's secure authenticator.
// ============================================================
export default function BiometricModal({ open, onClose, employeeId, employeeName = '' }) {
  const [credentials, setCredentials] = useState([])
  const [loading, setLoading] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revoking, setRevoking] = useState(false)
  const [support, setSupport] = useState({ webauthn: false, known: false })

  const loadCredentials = useCallback(async () => {
    if (!employeeId || !open) return
    setLoading(true)
    try {
      const data = employeeId ? await biometricService.listCredentials({ employeeId }) : []
      setCredentials(data)
    } catch {
      setCredentials([])
    } finally {
      setLoading(false)
    }
  }, [employeeId, open])

  useEffect(() => {
    if (open) {
      loadCredentials()
      setSupport({ webauthn: biometricService.isWebAuthnSupported(), known: true })
    }
  }, [open, loadCredentials])

  const handleEnroll = async () => {
    if (!employeeId) return
    setEnrolling(true)
    try {
      await biometricService.registerDevice({
        employeeId,
        deviceName: `${navigator.userAgent.split(' ').pop() || 'Device'} — ${new Date().toLocaleDateString()}`,
      })
      await loadCredentials()
    } catch (e) {
      alert(e?.message || 'Enrollment failed. Please try again.')
    } finally {
      setEnrolling(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      const result = await biometricService.removeCredential(revokeTarget.id)
      if (result?.success) {
        setRevokeTarget(null)
        await loadCredentials()
      } else {
        alert(result?.error || 'Failed to revoke credential')
      }
    } catch (e) {
      alert(e?.message || 'Failed to revoke credential')
    } finally {
      setRevoking(false)
    }
  }

  const deviceIcon = (type) => {
    if (type === 'platform') return <Smartphone className="w-4 h-4 text-slate-500" />
    return <Laptop className="w-4 h-4 text-slate-500" />
  }

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 shadow-xl">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#009944]" />
              <h3 className="text-lg font-semibold text-slate-900">Security & Authentication</h3>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Privacy notice */}
          <div className="bg-slate-50 rounded-lg p-3 mb-5 text-sm text-slate-700">
            <p className="font-medium text-slate-900 mb-1">Your biometric data never leaves this device.</p>
            <p>
              InfinityCore does not receive or store your fingerprint or Face ID — authentication is
              handled securely by your device. The system only stores a digital key that your device
              created locally; your actual biometric data is never transmitted to or saved by our servers.
            </p>
          </div>

          {/* Support status */}
          {support.known && (
            <div className={`flex items-center gap-2 text-sm mb-4 ${support.webauthn ? 'text-emerald-700' : 'text-amber-700'}`}>
              {support.webauthn ? (
                <><CheckCircle className="w-4 h-4" /> <span>Biometric authentication is available in this browser</span></>
              ) : (
                <><AlertTriangle className="w-4 h-4" /> <span>WebAuthn is not supported — use a recent Chrome, Firefox, Edge or Safari with a biometric-capable device</span></>
              )}
            </div>
          )}

          {/* Enroll button */}
          <button
            onClick={handleEnroll}
            disabled={!support.webauthn || enrolling || !employeeId}
            className="w-full h-11 rounded-lg bg-[#009944] text-white font-medium hover:bg-[#007a36] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 mb-5"
          >
            {enrolling
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Waiting for device biometric…</>
              : <><Key className="w-4 h-4" /> Enroll New Device</>
            }
          </button>

          {/* Existing credentials */}
          <div>
            <h4 className="text-sm font-semibold text-slate-900 mb-2">Enrolled Devices</h4>
            {loading && (
              <p className="text-sm text-slate-500 py-4 text-center">Loading…</p>
            )}
            {!loading && credentials.length === 0 && (
              <p className="text-sm text-slate-500 py-4 text-center">No devices enrolled yet.</p>
            )}
            {!loading && credentials.length > 0 && (
              <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
                {credentials.map((c) => (
                  <div key={c.id} className="flex items-center justify-between px-3 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {deviceIcon(c.authenticator_type)}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{c.device_name || 'Unknown device'}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {c.authenticator_type === 'platform' ? 'Platform (fingerprint / Face ID)' : 'Security key'}
                          {c.last_used_at && <> · Last used {new Date(c.last_used_at).toLocaleDateString()}</>}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setRevokeTarget(c)}
                      className="ml-2 p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                      title="Remove this device"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {employeeName && (
            <p className="mt-4 text-xs text-slate-400 text-center">
              Managing credentials for <span className="font-medium text-slate-600">{employeeName}</span>
            </p>
          )}
        </div>
      </div>

      {/* Revoke confirmation dialog */}
      {revokeTarget && (
        <div className="fixed inset-0 z-60 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-sm p-6 shadow-2xl">
            <div className="flex items-center gap-2 text-amber-600 mb-3">
              <AlertTriangle className="w-5 h-5" />
              <h4 className="font-semibold">Remove device?</h4>
            </div>
            <p className="text-sm text-slate-700 mb-4">
              Remove <span className="font-medium">{revokeTarget.device_name || 'this device'}</span>?
              This device will no longer be able to authenticate. You can re-enroll it later.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setRevokeTarget(null)}
                disabled={revoking}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-rose-600 hover:bg-rose-700 transition-colors flex items-center gap-2"
              >
                {revoking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}