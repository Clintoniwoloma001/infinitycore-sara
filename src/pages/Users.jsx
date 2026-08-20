import React, { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { logAction } from '../services/supabaseService'
import { StatusBadge } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'
import { ROLE_METADATA, assignableRoles } from '../constants/roles'

export default function Users() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [err, setErr] = useState(null)
  const { name: userName, role: actorRole } = useAuth()
  const myAssignableRoles = assignableRoles(actorRole)

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
      setUsers(data || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const changeRole = async (u, role) => {
    setErr(null)
    setBusyId(u.id)
    try {
      // The actual authorization check happens server-side (see
      // enforce_role_change_policy in schema_phase5_role_security.sql)
      // — this call can be rejected even if it appears in the dropdown,
      // e.g. if the actor's own role changed in another tab.
      await supabase.from('profiles').update({ role }).eq('id', u.id).throwOnError()
      await logAction({ action: 'user_role_changed', entityType: 'User', entityId: u.id, details: `${u.email} → ${role}`, userName, severity: 'critical' })
      load()
    } catch (e) {
      setErr(`Could not change role for ${u.email}: ${e?.message || 'not authorized'}`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <div className="mb-6"><h2 className="text-2xl font-semibold text-slate-900">User Management</h2><p className="text-sm text-slate-500 mt-1">Every new signup starts as a Customer — promote to a staff role below. Role changes are enforced and audited server-side.</p></div>
      {err && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{err}</div>}
      {loading ? <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div> : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left"><tr><th className="px-6 py-3 font-medium">Email</th><th className="px-6 py-3 font-medium">Current Role</th><th className="px-6 py-3 font-medium text-right">Change Role</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => {
                const options = myAssignableRoles.includes(u.role) || myAssignableRoles.length === 0 ? myAssignableRoles : [...myAssignableRoles, u.role]
                return (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3 font-medium text-slate-800">{u.email || u.id}</td>
                    <td className="px-6 py-3"><StatusBadge label={ROLE_METADATA[u.role]?.label || u.role || 'Customer'} color={ROLE_METADATA[u.role]?.color || '#6b7280'} /></td>
                    <td className="px-6 py-3 text-right">
                      {options.length === 0 ? (
                        <span className="text-xs text-slate-400">Not authorized to change</span>
                      ) : (
                        <select value={u.role || 'customer'} disabled={busyId === u.id} onChange={(e) => changeRole(u, e.target.value)} className="h-9 rounded-md border border-slate-300 px-2 text-sm disabled:opacity-50">
                          {!options.includes(u.role) && <option value={u.role}>{ROLE_METADATA[u.role]?.label || u.role} (current)</option>}
                          {options.map((r) => (
                            <option key={r} value={r}>{ROLE_METADATA[r]?.label || r}</option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
