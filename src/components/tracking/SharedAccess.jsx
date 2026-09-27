// Share Tracking Access. Super Admin only, and enforced again server-side by
// employee_tracking_access() - this form is a convenience, not the control.
import React, { useCallback, useEffect, useState } from 'react'
import { Check, Clock } from 'lucide-react'
import { trackingService } from '../../services/employeeTrackingService'
import { ROLES } from '../../constants/roles'
import { LoadingState, ErrorState } from '../PageStates'
import GrantForm from './GrantForm'

export default function SharedAccess() {
  const [grants, setGrants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setGrants(await trackingService.listGrants()) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const revoke = async (id) => {
    if (!window.confirm('Revoke this access immediately? The recipient loses it on their next request.')) return
    try {
      await trackingService.revoke(id)
      setNotice({ tone: 'ok', text: 'Access revoked immediately.' })
      load()
    } catch (err) {
      setNotice({ tone: 'error', text: err.message })
    }
  }

  return (
    <div className="space-y-5">
      <GrantForm onNotice={setNotice} onSaved={load} />

      <div className="rounded-lg border border-slate-200 bg-white">
        <h2 className="px-4 py-3 font-semibold text-slate-900 border-b border-slate-200">
          Delegated access
        </h2>
        {loading && <LoadingState />}
        {error && <div className="p-4"><ErrorState message={error} /></div>}
        {!loading && !error && (
          grants.length === 0
            ? <p className="p-4 text-sm text-slate-500">No access has been shared.</p>
            : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>{['Recipient', 'Type', 'Granted', 'Expires', 'Status', ''].map((h) => (
                      <th key={h} className="px-4 py-2 font-medium">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {grants.map((g) => (
                      <tr key={g.id}>
                        <td className="px-4 py-2.5 text-slate-900">
                          {g.target_user_name || g.target_role}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{g.target_type}</td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {g.granted_by_name} · {new Date(g.granted_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {g.expires_at ? new Date(g.expires_at).toLocaleString() : 'Forever'}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                            g.status === 'active' ? 'bg-emerald-100 text-emerald-800'
                            : g.status === 'expired' ? 'bg-amber-100 text-amber-800'
                            : 'bg-slate-100 text-slate-600'}`}>
                            {g.status === 'active'
                              ? <Check className="w-3 h-3" />
                              : <Clock className="w-3 h-3" />}
                            {g.status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {g.status === 'active' && (
                            <button onClick={() => revoke(g.id)}
                              className="text-xs font-medium text-red-600 hover:underline">
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
    </div>
  )
}
