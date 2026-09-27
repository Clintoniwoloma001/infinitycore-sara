// Live positions list. Staleness is explicit: an old point is never presented
// as a live one.
import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import {
  trackingService, describeFreshness, formatCoord,
} from '../../services/employeeTrackingService'
import { LoadingState, EmptyState, ErrorState } from '../PageStates'
import HistoryDrawer from './HistoryDrawer'

export default function LivePositions() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setRows(await trackingService.livePositions({ withinMinutes: 60 }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return <LoadingState label="Loading live positions..." />
  if (error) return <ErrorState title="Unable to load positions" message={error} />
  if (!rows.length) {
    return (
      <EmptyState
        title="No locations recorded yet"
        description="Positions appear once an employee app records a location observation."
      />
    )
  }

  const live = rows.filter((r) => !r.is_stale).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{live}</span> recently updated
          {' · '}
          <span className="font-semibold text-slate-900">{rows.length - live}</span> stale
        </p>
        <button onClick={load}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" />Refresh
        </button>
      </div>

      {/* Desktop table; cards on small screens rather than a squeezed table. */}
      <div className="hidden md:block overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              {['Employee', 'Location', 'Coordinates', 'Geofence', 'Last update', ''].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.employee_id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900">{r.full_name}</p>
                  <p className="text-xs text-slate-500">
                    {r.employee_number || '—'} · {r.position || r.department || '—'}
                  </p>
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {r.location_label || 'Outside registered locations'}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">
                  {formatCoord(r.latitude)}, {formatCoord(r.longitude)}
                  {r.accuracy != null && (
                    <span className="ml-1 text-slate-400">±{Math.round(r.accuracy)}m</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    r.inside_geofence ? 'bg-emerald-100 text-emerald-800'
                                       : 'bg-amber-100 text-amber-800'}`}>
                    {r.inside_geofence ? 'Inside' : 'Outside'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={r.is_stale ? 'text-amber-700' : 'text-slate-600'}>
                    {describeFreshness(r)}
                  </span>
                  {r.is_stale && <AlertTriangle className="inline w-3.5 h-3.5 ml-1.5" />}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setSelected(r)}
                    className="text-xs font-medium text-[#009944] hover:underline">
                    History
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <MobileRows rows={rows} onSelect={setSelected} />

      {selected && <HistoryDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function MobileRows({ rows, onSelect }) {
  return (
    <div className="md:hidden space-y-3">
      {rows.map((r) => (
        <div key={r.employee_id} className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="font-medium text-slate-900">{r.full_name}</p>
              <p className="text-xs text-slate-500">{r.employee_number || '—'}</p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              r.inside_geofence ? 'bg-emerald-100 text-emerald-800'
                                 : 'bg-amber-100 text-amber-800'}`}>
              {r.inside_geofence ? 'Inside' : 'Outside'}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-700">
            {r.location_label || 'Outside registered locations'}
          </p>
          <p className="font-mono text-xs text-slate-500 mt-1">
            {formatCoord(r.latitude)}, {formatCoord(r.longitude)}
          </p>
          <div className="mt-2 flex items-center justify-between">
            <span className={`text-xs ${r.is_stale ? 'text-amber-700' : 'text-slate-500'}`}>
              {describeFreshness(r)}
            </span>
            <button onClick={() => onSelect(r)}
              className="text-xs font-medium text-[#009944] hover:underline">
              History
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
