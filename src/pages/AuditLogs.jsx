import React, { useEffect, useState } from 'react'
import { auditLogs as svc } from '../services/supabaseService'
import { formatDate, StatusBadge } from '../lib/utils'

const SEV = { info: 'blue', warning: 'amber', critical: 'rose' }

export default function AuditLogs() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => { (async () => { try { setLogs(await svc.list()) } finally { setLoading(false) } })() }, [])
  const filtered = filter === 'all' ? logs : logs.filter((l) => l.severity === filter)

  return (
    <div>
      <div className="mb-6"><h2 className="text-2xl font-semibold text-slate-900">Audit Logs</h2><p className="text-sm text-slate-500 mt-1">Immutable trail of all critical actions</p></div>
      <div className="flex gap-2 mb-4">
        {['all', 'info', 'warning', 'critical'].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-lg text-sm capitalize ${filter === f ? 'bg-[#009944] text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>{f}</button>
        ))}
      </div>
      {loading ? <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div> : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left"><tr><th className="px-6 py-3 font-medium">Severity</th><th className="px-6 py-3 font-medium">Action</th><th className="px-6 py-3 font-medium">User</th><th className="px-6 py-3 font-medium">Details</th><th className="px-6 py-3 font-medium">Timestamp</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 && <tr><td colSpan={5} className="px-6 py-8 text-center text-slate-400">No logs</td></tr>}
              {filtered.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3"><StatusBadge label={l.severity} color={SEV[l.severity] || 'blue'} /></td>
                  <td className="px-6 py-3 font-medium text-slate-700">{l.action?.replace(/_/g, ' ')}</td>
                  <td className="px-6 py-3 text-slate-600">{l.user_name || 'system'}</td>
                  <td className="px-6 py-3 text-slate-500 max-w-xs truncate">{l.details || '—'}</td>
                  <td className="px-6 py-3 text-slate-400 whitespace-nowrap">{formatDate(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}