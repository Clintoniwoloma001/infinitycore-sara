// Live positions list.
//
// Freshness is explicit and comes from ONE place: the thresholds in
// src/config/trackingFreshness.js, applied to the age the SERVER computed
// (now() - recorded_at). An old fix is never presented as a live one: it gets a
// grey "Stale" chip and "Last known …" wording instead of a bright Inside pill.
//
// The list refreshes itself: every 30 s while the tab is visible, on tab focus,
// and on Refresh — so a reconnect upload (sync_offline_location_batch) shows up
// without the operator having to guess. Realtime is deliberately NOT used:
// employee_location_events is not in the supabase_realtime publication.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, AlertTriangle, Filter, X } from 'lucide-react'
import {
  trackingService, describeFreshness, formatCoord, describeGeofenceStatus,
} from '../../services/employeeTrackingService'
import {
  FRESHNESS, countFreshness, rowFreshness,
} from '../../config/trackingFreshness'
import { LoadingState, EmptyState, ErrorState } from '../PageStates'
import HistoryDrawer from './HistoryDrawer'

const POLL_MS = 30000

const EMPTY_SCOPE = { department: '', position: '', branch: '' }

/** Does one row satisfy the operator's explicit department/position/branch picks? */
function matchesScope(row, scope) {
  if (scope.department && (row.department || '') !== scope.department) return false
  if (scope.position && (row.position || '') !== scope.position) return false
  if (scope.branch && (row.branch_id || '') !== scope.branch) return false
  return true
}

/**
 * The options an operator can pick from. They are derived from the rows the
 * SERVER already authorised — never from a client-side table read — so a filter
 * can never offer (or hide) a person the caller is not allowed to see.
 */
function scopeOptionsOf(rows = []) {
  const departments = new Map()
  const positions = new Map()
  const branches = new Map()
  for (const r of rows) {
    if (r.department) departments.set(r.department, r.department)
    if (r.position) positions.set(r.position, r.position)
    if (r.branch_id) branches.set(r.branch_id, r.branch_name || r.branch_id)
  }
  const byLabel = (entries) => entries.sort((a, b) => String(a[1]).localeCompare(String(b[1])))
  return {
    departments: byLabel([...departments.entries()]),
    positions: byLabel([...positions.entries()]),
    branches: byLabel([...branches.entries()]),
  }
}

export default function LivePositions() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  // When the server answered, so ages keep advancing against server time.
  const [fetchedAt, setFetchedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const loadingRef = useRef(false)
  // Explicit, operator-chosen scope: department / position / branch.
  const [scope, setScope] = useState(EMPTY_SCOPE)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (loadingRef.current) return
    loadingRef.current = true
    if (!silent) setLoading(true)
    setError(null)
    try {
      // Rows come straight from the service result: nothing on the client
      // filters the authorised set down to nothing.
      setRows(await trackingService.livePositions({ withinMinutes: 60 }))
      setFetchedAt(Date.now())
    } catch (e) {
      // A failed background poll must never blank a table that is on screen:
      // the rows stay and the error is surfaced as a retryable inline notice.
      setError(e.message)
    } finally {
      loadingRef.current = false
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Realtime: the AFTER INSERT trigger broadcasts {employee_id, recorded_at}
  // on the private tracking:live channel. Coordinates are never sent. We
  // debounce 2 s and refetch the v2 view - rows are never patched locally.
  useEffect(() => {
    let sub
    let timer
    try {
      sub = trackingService.subscribeLive(() => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { timer = null; load({ silent: true }) }, 2000)
      })
    } catch (_) {
      // Realtime unavailable: the 30 s poll covers it.
    }
    return () => { if (timer) clearTimeout(timer); if (sub) sub.unsubscribe() }
  }, [load])

  // Poll while visible + refetch when the tab regains focus.
  useEffect(() => {
    const active = () => document.visibilityState === 'visible'
    const refresh = () => {
      setNow(Date.now())
      if (active()) load({ silent: true })
    }
    const id = setInterval(refresh, POLL_MS)
    const onFocus = () => { if (active()) refresh() }
    const onVisibility = () => { if (active()) refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  const elapsed = fetchedAt ? Math.max(0, now - fetchedAt) : 0
  const counts = useMemo(() => countFreshness(rows, elapsed), [rows, elapsed])
  const options = useMemo(() => scopeOptionsOf(rows), [rows])
  const scopeActive = scope.department !== '' || scope.position !== '' || scope.branch !== ''

  // Scope first (what the operator picked), then the freshness chip. Both are
  // derived from the same server-authorised row set; neither recomputes a
  // verdict, and neither can hide a row the server did not authorise.
  const scoped = useMemo(
    () => rows.filter((r) => matchesScope(r, scope)),
    [rows, scope],
  )

  // Header chips: clickable filters. Default order is newest-first (the v2
  // view returns that); the filters re-derive from the same row set.
  const [activeFilter, setActiveFilter] = useState(null)
  const visible = useMemo(() => {
    if (!activeFilter) return scoped
    return scoped.filter((r) => {
      const state = rowFreshness(r, elapsed)
      if (activeFilter === 'live') return state === FRESHNESS.LIVE
      if (activeFilter === 'delayed') return state === FRESHNESS.DELAYED
      if (activeFilter === 'stale') return state === FRESHNESS.STALE || state === FRESHNESS.NONE
      if (activeFilter === 'no_data') return state === FRESHNESS.NONE
      return true
    })
  }, [scoped, elapsed, activeFilter])

  if (loading && !visible.length) return <LoadingState label="Loading live positions..." />
  if (error && !visible.length) return <ErrorState title="Unable to load positions" message={error} />
  if (!visible.length) {
    // Rows exist but the picks exclude them: say that, and offer the way out.
    // The generic "no locations recorded" empty state would be a lie here.
    if (rows.length > 0 && scopeActive) {
      return (
        <div className="text-center py-14 bg-white rounded-lg border border-slate-200">
          <p className="font-medium text-slate-800">No employees match these filters</p>
          <p className="text-sm text-slate-500 mt-1">
            {rows.length} employee{rows.length === 1 ? '' : 's'} are tracked, but none match the selected{' '}
            {[scope.department && 'department', scope.position && 'position', scope.branch && 'branch'].filter(Boolean).join(' / ')}.
          </p>
          <button
            type="button"
            onClick={() => setScope(EMPTY_SCOPE)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            <X className="w-4 h-4" />Clear filters
          </button>
        </div>
      )
    }
    return (
      <EmptyState
        title="No locations recorded yet"
        description="Positions appear once an employee app records a location observation."
      />
    )
  }

  return (
    <div className="space-y-4">
      <ScopeFilters
        options={options}
        scope={scope}
        onChange={setScope}
        active={scopeActive}
        total={rows.length}
        shown={visible.length}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="freshness-counts">
          {[
            { key: 'live', label: `${counts.live} Inside`, tone: 'text-emerald-700 bg-emerald-50 ring-emerald-200' },
            { key: 'delayed', label: `${counts.delayed} Outside`, tone: 'text-amber-700 bg-amber-50 ring-amber-200' },
            { key: 'stale', label: `${counts.stale} Stale`, tone: 'text-slate-700 bg-slate-100 ring-slate-200' },
            { key: 'no_data', label: `${counts.none} No data`, tone: 'text-slate-500 bg-slate-50 ring-slate-200' },
          ].map((c) => (
            <button
              key={c.key}
              onClick={() => setActiveFilter(activeFilter === c.key ? null : c.key)}
              title={`Filter by ${c.key}`}
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 transition ${
                activeFilter === c.key ? 'bg-slate-800 text-white ring-slate-800' : c.tone
              }`}>
              {c.label}
            </button>
          ))}
        </div>
        <button onClick={() => load({ silent: false })}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" />Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span>Could not refresh: {error}</span>
          <button onClick={() => load({ silent: false })} className="font-medium underline">Retry</button>
        </div>
      )}

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
            {visible.map((r) => (
              <tr key={r.employee_id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900">{r.full_name}</p>
                  <p className="text-xs text-slate-500">
                    {r.employee_number || '—'} · {r.position || r.department || '—'}
                  </p>
                </td>
                <td className="px-4 py-3 text-slate-700">
                  <LocationCell row={r} elapsed={elapsed} />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">
                  {r.latitude == null ? '—' : `${formatCoord(r.latitude)}, ${formatCoord(r.longitude)}`}
                  {r.accuracy != null && (
                    <span className="ml-1 text-slate-400">±{Math.round(r.accuracy)}m</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <GeofenceCell row={r} elapsed={elapsed} />
                </td>
                <td className="px-4 py-3">
                  <LastSeenCell row={r} elapsed={elapsed} />
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

      <MobileRows rows={visible} elapsed={elapsed} onSelect={setSelected} />

      {selected && <HistoryDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

/** Freshness of one row, computed from the server's age + elapsed since fetch. */
function stateOf(row, elapsed) {
  return rowFreshness(row, elapsed)
}

/**
 * Location column.
 * LIVE/DELAYED show the geofence verdict; STALE prefixes it with "Last known"
 * so a two-day-old reading can never be read as a current position.
 */
function LocationCell({ row, elapsed }) {
  const state = stateOf(row, elapsed)
  if (state === FRESHNESS.NONE) {
    return <span className="text-slate-400">No location yet</span>
  }
  const status = describeGeofenceStatus(row)
  const stale = state === FRESHNESS.STALE
  return (
    <>
      {stale && <span className="text-slate-500">Last known: </span>}
      <span className={stale ? 'text-slate-600' : 'text-slate-700'}>{status.text}</span>
      {status.detail && (
        <p className={`text-xs ${stale ? 'text-slate-400' : 'text-slate-500'}`}>{status.detail}</p>
      )}
    </>
  )
}

/**
 * Geofence column.
 * LIVE keeps the current Inside/Outside pill, DELAYED keeps it plus an amber
 * "delayed" hint, STALE swaps it for a grey chip + muted "Last known: …".
 */
function GeofenceCell({ row, elapsed }) {
  const state = stateOf(row, elapsed)
  if (state === FRESHNESS.NONE) {
    return <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">No location yet</span>
  }

  const status = describeGeofenceStatus(row)
  const tooltip = status.detail
    ? `${row.inside_geofence ? 'Inside' : 'Outside'} — ${status.detail}`
    : (row.inside_geofence ? 'Inside a registered location' : 'Outside all registered locations')

  if (state === FRESHNESS.STALE) {
    const label = row.inside_geofence
      ? `Inside ${row.location_label || row.branch_name || 'a registered location'}`
      : `Outside ${row.nearest_location_name || row.branch_name || 'all registered locations'}`
    return (
      <span className="flex flex-wrap items-center gap-1.5" title={tooltip}>
        <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600">
          Stale
        </span>
        <span className="text-xs text-slate-400">Last known: {label}</span>
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        title={tooltip}
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
          row.inside_geofence ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'}`}>
        {row.inside_geofence ? 'Inside' : 'Outside'}
      </span>
      {state === FRESHNESS.DELAYED && (
        <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
          delayed
        </span>
      )}
    </span>
  )
}

/** Last update column — amber for delayed, red for stale, never "live". */
function LastSeenCell({ row, elapsed }) {
  const state = stateOf(row, elapsed)
  const tone = state === FRESHNESS.LIVE ? 'text-slate-600'
    : state === FRESHNESS.DELAYED ? 'text-amber-700'
    : state === FRESHNESS.NONE ? 'text-slate-400'
    : 'text-red-600'
  return (
    <span className={`inline-flex items-center gap-1.5 ${tone}`}>
      {describeFreshness(row, elapsed)}
      {state === FRESHNESS.STALE && <AlertTriangle className="inline w-3.5 h-3.5" aria-hidden />}
      {state === FRESHNESS.DELAYED && (
        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">delayed</span>
      )}
    </span>
  )
}

function MobileRows({ rows, elapsed, onSelect }) {
  return (
    <div className="md:hidden space-y-3">
      {rows.map((r) => (
        <div key={r.employee_id} className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-slate-900">{r.full_name}</p>
              <p className="text-xs text-slate-500">{r.employee_number || '—'}</p>
            </div>
            <GeofenceCell row={r} elapsed={elapsed} />
          </div>
          <p className="mt-2 text-sm">
            <LocationCell row={r} elapsed={elapsed} />
          </p>
          <p className="font-mono text-xs text-slate-500 mt-1">
            {r.latitude == null ? '—' : `${formatCoord(r.latitude)}, ${formatCoord(r.longitude)}`}
            {r.accuracy != null && <span className="ml-1">±{Math.round(r.accuracy)}m</span>}
          </p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs"><LastSeenCell row={r} elapsed={elapsed} /></span>
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

/**
 * Department / position / branch scope for the live tab.
 *
 * The options come from the authorised row set itself, so a filter can never
 * offer a person the operator may not see, and the "shown of tracked" count
 * makes it obvious when a pick is hiding rows. Nothing here decides freshness
 * or inside/outside — those verdicts stay with the server.
 */
function ScopeFilters({ options, scope, onChange, active, total, shown }) {
  const set = (key) => (event) => onChange((prev) => ({ ...prev, [key]: event.target.value }))
  const selectCls = 'h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-700 focus:border-[#009944] focus:outline-none focus:ring-2 focus:ring-[#009944]/30'
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2" data-testid="tracking-scope-filters">
      <Filter className="w-4 h-4 text-slate-400" aria-hidden />
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Filters</span>
      <label className="sr-only" htmlFor="tracking-filter-department">Department</label>
      <select id="tracking-filter-department" className={selectCls} value={scope.department} onChange={set('department')}>
        <option value="">All departments</option>
        {options.departments.map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      <label className="sr-only" htmlFor="tracking-filter-position">Position</label>
      <select id="tracking-filter-position" className={selectCls} value={scope.position} onChange={set('position')}>
        <option value="">All positions</option>
        {options.positions.map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      <label className="sr-only" htmlFor="tracking-filter-branch">Branch</label>
      <select id="tracking-filter-branch" className={selectCls} value={scope.branch} onChange={set('branch')}>
        <option value="">All branches</option>
        {options.branches.map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      <span className="ml-auto text-xs text-slate-500">
        {active ? `${shown} of ${total} tracked` : `${total} tracked`}
      </span>
      {active && (
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_SCOPE })}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        >
          <X className="w-3.5 h-3.5" />Clear
        </button>
      )}
    </div>
  )
}
