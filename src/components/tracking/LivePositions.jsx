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
import { RefreshCw, AlertTriangle } from 'lucide-react'
import {
  trackingService, describeFreshness, formatCoord, describeGeofenceStatus,
} from '../../services/employeeTrackingService'
import {
  FRESHNESS, countFreshness, rowFreshness,
} from '../../config/trackingFreshness'
import { LoadingState, EmptyState, ErrorState } from '../PageStates'
import HistoryDrawer from './HistoryDrawer'

const POLL_MS = 30000

export default function LivePositions() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  // When the server answered, so ages keep advancing against server time.
  const [fetchedAt, setFetchedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const loadingRef = useRef(false)

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

  if (loading && !rows.length) return <LoadingState label="Loading live positions..." />
  if (error && !rows.length) return <ErrorState title="Unable to load positions" message={error} />
  if (!rows.length) {
    return (
      <EmptyState
        title="No locations recorded yet"
        description="Positions appear once an employee app records a location observation."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600" data-testid="freshness-counts">
          <span className="font-semibold text-emerald-700">{counts.live} live</span>
          {' · '}
          <span className="font-semibold text-amber-700">{counts.delayed} delayed</span>
          {' · '}
          <span className="font-semibold text-slate-700">{counts.stale} stale</span>
        </p>
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
            {rows.map((r) => (
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

      <MobileRows rows={rows} elapsed={elapsed} onSelect={setSelected} />

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
