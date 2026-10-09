// Live positions list. Staleness is explicit: an old point is never presented
// as a live one.
import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw, AlertTriangle, Filter, X } from 'lucide-react'
import {
  trackingService, describeFreshness, formatCoord, describeGeofenceStatus,
} from '../../services/employeeTrackingService'
import { LoadingState, EmptyState, ErrorState } from '../PageStates'
import HistoryDrawer from './HistoryDrawer'

const selectCls = 'h-9 rounded-lg border border-slate-300 bg-white px-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#009944]/30'

export default function LivePositions() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)

  // Filters
  const [filters, setFilters] = useState({ department: '', branchId: '', position: '' })
  const [options, setOptions] = useState({ departments: [], branches: [], positions: [] })

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setRows(await trackingService.livePositions({
        withinMinutes: 60,
        department: filters.department || null,
        branchId: filters.branchId || null,
        position: filters.position || null,
      }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filters.department, filters.branchId, filters.position])

  // Fetch filter options once on mount.
  useEffect(() => {
    trackingService.filterOptions()
      .then(setOptions)
      .catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const hasFilters = filters.department || filters.branchId || filters.position

  const clearFilters = () => setFilters({ department: '', branchId: '', position: '' })

  if (loading && !rows.length) return <LoadingState label="Loading live positions..." />
  if (error) return <ErrorState title="Unable to load positions" message={error} />
  if (!rows.length && !hasFilters) {
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
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
          <Filter className="w-4 h-4" />
          <span>Filters</span>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Department</label>
          <select
            className={selectCls}
            value={filters.department}
            onChange={(e) => setFilters(f => ({ ...f, department: e.target.value }))}
          >
            <option value="">All</option>
            {options.departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Branch</label>
          <select
            className={selectCls}
            value={filters.branchId}
            onChange={(e) => setFilters(f => ({ ...f, branchId: e.target.value }))}
          >
            <option value="">All</option>
            {options.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Position</label>
          <select
            className={selectCls}
            value={filters.position}
            onChange={(e) => setFilters(f => ({ ...f, position: e.target.value }))}
          >
            <option value="">All</option>
            {options.positions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <X className="w-3.5 h-3.5" /> Clear filters
          </button>
        )}
        <div className="ml-auto">
          <button onClick={load}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" />Refresh
          </button>
        </div>
      </div>

      {/* Counts */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-900">{live}</span> recently updated
          {' · '}
          <span className="font-semibold text-slate-900">{rows.length - live}</span> stale
          {hasFilters && <span className="text-slate-400"> · filtered</span>}
        </p>
      </div>

      {rows.length === 0 && hasFilters && (
        <EmptyState
          title="No positions match the selected filters"
          description="Try clearing filters or selecting different values."
        />
      )}

      {/* Desktop table; cards on small screens rather than a squeezed table. */}
      {rows.length > 0 && (
        <>
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
                {rows.map((r) => {
                  const status = describeGeofenceStatus(r)
                  return (
                  <tr key={r.employee_id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{r.full_name}</p>
                      <p className="text-xs text-slate-500">
                        {r.employee_number || '—'} · {r.position || r.department || '—'}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {status.text}
                      {status.detail && (
                        <p className="text-xs text-slate-500">{status.detail}</p>
                      )}
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
                  )
                })}
              </tbody>
            </table>
          </div>

          <MobileRows rows={rows} onSelect={setSelected} />
        </>
      )}

      {selected && <HistoryDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function MobileRows({ rows, onSelect }) {
  return (
    <div className="md:hidden space-y-3">
      {rows.map((r) => {
        const status = describeGeofenceStatus(r)
        return (
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
            {status.text}
          </p>
          {status.detail && (
            <p className="mt-0.5 text-xs text-slate-500">{status.detail}</p>
          )}
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
        )
      })}
    </div>
  )
}
