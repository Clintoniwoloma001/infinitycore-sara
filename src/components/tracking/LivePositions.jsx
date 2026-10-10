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
  trackingService, describeFreshness, formatCoord, formatDistance, isLowAccuracy,
} from '../../services/employeeTrackingService'
import {
  FRESHNESS, LOW_ACCURACY_SUFFIX, classifyAgeSeconds, ageSecondsOf,
} from '../../config/trackingFreshness'
import { LoadingState, EmptyState, ErrorState } from '../PageStates'
import HistoryDrawer from './HistoryDrawer'

/**
 * The ONE category set, in display order. These are the server's
 * `display_category` values — the page never recomputes a verdict, it only
 * groups by this field, so the chips and the badges can never disagree.
 */
export const DISPLAY_CATEGORY = Object.freeze({
  LIVE: 'live',
  INSIDE: 'inside',
  OUTSIDE: 'outside',
  STALE: 'stale',
  UNCONFIGURED: 'unconfigured',
})

/**
 * The mutually exclusive categories a row can belong to. Exactly one applies
 * per row, which is what makes the header arithmetic checkable:
 *   inside + outside + stale + unconfigured === rows listed
 */
export const COUNTED_CATEGORIES = ['inside', 'outside', 'stale', 'unconfigured']

/**
 * How long a fix keeps an employee on this tab.
 */
export const RECENT_HOURS = 48

/**
 * Optional, OFF by default. When true the tab shows a single muted line with
 * the number of tracked employees who have NOT reported inside the window — it
 * is deliberately NOT a chip and never a list, because a chip would imply those
 * employees are rows of this table and would break the sum invariant above.
 */
export const SHOW_NO_DATA_COUNT = false

const POLL_MS = 30000

const EMPTY_SCOPE = { department: '', position: '', branch: '' }

/** Local "HH:mm:ss" for the "updated" stamp. */
function clockNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/**
 * Group the rows the server authorised by display_category.
 *
 * Counting happens HERE, from the same array that is rendered, so the header
 * can neither drift from the table nor overlap itself. There is no separate
 * "freshness" pipeline for the chips and no separate "geofence" pipeline for
 * the badges — one field, one source.
 */
export function countDisplayCategories(rows = []) {
  const counts = { inside: 0, outside: 0, stale: 0, unconfigured: 0 }
  for (const row of rows) {
    const category = row?.display_category
    if (category && Object.prototype.hasOwnProperty.call(counts, category)) {
      counts[category] += 1
    }
  }
  return counts
}

/** Employees with no fix inside the window, for the optional muted line. */
export function sumCounted(counts) {
  return COUNTED_CATEGORIES.reduce((total, key) => total + (counts[key] || 0), 0)
}

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

export default function LivePositions({ notReportingCount = null }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  // When the server answered, so ages keep advancing against server time.
  const [fetchedAt, setFetchedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [updatedAt, setUpdatedAt] = useState('')
  const loadingRef = useRef(false)
  const [scope, setScope] = useState(EMPTY_SCOPE)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (loadingRef.current) return
    loadingRef.current = true
    if (!silent) setLoading(true)
    setError(null)
    try {
      // ONE server call, ONE row set. There is no client-side merge with the
      // full employee list and no client-side re-sort: the server already
      // returns only employees with a fix in the window, already ordered
      // (freshness rank, then newest, then name).
      const result = await trackingService.livePositionsRecent({ recentHours: RECENT_HOURS })
      setRows(result)
      setFetchedAt(Date.now())
      setUpdatedAt(clockNow())
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

  // Wall-clock since the server answered. Only a delta, added to the server's
  // own age_seconds, so ages keep advancing between polls without ever
  // trusting the browser clock.
  const elapsed = fetchedAt ? Math.max(0, now - fetchedAt) : 0

  // Counts come from the SAME rows that get rendered — never a second source.
  // Filters narrow the rendered set, and the chips are recomputed after that,
  // so a filter can never make the header disagree with the table.
  const counts = useMemo(() => countDisplayCategories(rows), [rows])
  const options = useMemo(() => scopeOptionsOf(rows), [rows])
  const scopeActive = scope.department !== '' || scope.position !== '' || scope.branch !== ''

  // Scope first (what the operator picked), then the category chip. Both are
  // derived from the same server-authorised row set; neither recomputes a
  // verdict, and neither can hide a row the server did not authorise.
  const scoped = useMemo(
    () => rows.filter((r) => matchesScope(r, scope)),
    [rows, scope],
  )
  const scopedCounts = useMemo(() => countDisplayCategories(scoped), [scoped])

  // Header chips: clickable filters over the SAME category the badges show.
  // Selecting one filters to rows with exactly that display_category; selecting
  // it again clears the filter.
  const [activeFilter, setActiveFilter] = useState(null)
  const visible = useMemo(() => {
    if (!activeFilter) return scoped
    return scoped.filter((r) => r.display_category === activeFilter)
  }, [scoped, activeFilter])

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
            {rows.length} employee{rows.length === 1 ? ' is' : 's are'} reporting in the last {RECENT_HOURS} h, but none match the selected{' '}
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
        title={`No one has reported in the last ${RECENT_HOURS} h`}
        description="This tab lists only employees whose app has recorded a location in that window."
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
        label={`${rows.length} reporting in the last ${RECENT_HOURS} h`}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="display-category-counts">
          {[
            { key: 'inside', label: `${scopedCounts.inside} Inside`, tone: 'text-emerald-700 bg-emerald-50 ring-emerald-200' },
            { key: 'outside', label: `${scopedCounts.outside} Outside`, tone: 'text-rose-700 bg-rose-50 ring-rose-200' },
            { key: 'stale', label: `${scopedCounts.stale} Stale`, tone: 'text-slate-700 bg-slate-100 ring-slate-200' },
            { key: 'unconfigured', label: `${scopedCounts.unconfigured} No geofence`, tone: 'text-slate-600 bg-slate-50 ring-slate-200' },
          ].map((c) => (
            <button
              key={c.key}
              onClick={() => setActiveFilter(activeFilter === c.key ? null : c.key)}
              title={activeFilter === c.key ? `Clear the ${c.key} filter` : `Show only ${c.key}`}
              aria-pressed={activeFilter === c.key}
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 transition ${
                activeFilter === c.key ? 'bg-slate-800 text-white ring-slate-800' : c.tone
              }`}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {updatedAt && (
            <span className="text-xs text-slate-400" data-testid="updated-stamp">updated {updatedAt}</span>
          )}
          <button onClick={() => load({ silent: false })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" />Refresh
          </button>
        </div>
      </div>

      {/* Exactly one of inside/outside/stale/unconfigured applies to every
          listed row, so the sum below must equal the row count. If it ever does
          not, the server returned a category we do not model. */}
      {process.env.NODE_ENV !== 'production' && sumCounted(scopedCounts) !== scoped.length && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Category counts do not match the table; some rows carry an unmapped display category.
        </p>
      )}

      {/* Optional, off by default: a count only, never a list, never a chip. */}
      {SHOW_NO_DATA_COUNT && notReportingCount != null && (
        <p className="text-xs text-slate-400">
          {notReportingCount} tracked employee{notReportingCount === 1 ? '' : 's'} have no location in the last {RECENT_HOURS} h.
        </p>
      )}

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
                  <LocationCell row={r} />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-600">
                  {r.latitude == null ? '—' : `${formatCoord(r.latitude)}, ${formatCoord(r.longitude)}`}
                  {r.accuracy != null && (
                    <span className="ml-1 text-slate-400">±{Math.round(r.accuracy)}m</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <GeofenceCell row={r} />
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

/**
 * Location column.
 *
 * STALE prefixes the verdict with "Last known" so a two-day-old reading can
 * never be read as a current position. The distance is stated ONCE, on one
 * line — the old implementation printed the geofence name and the distance and
 * then repeated both in a sub-line, which is where the doubled sentence the
 * screenshot showed came from.
 *
 * "(low GPS accuracy)" is appended ONLY when the server says the reading is
 * genuinely boundary-ambiguous.
 */
function LocationCell({ row }) {
  const category = row.display_category
  const stale = category === 'stale'
  const prefix = stale ? 'Last known: ' : ''
  const isInside = row.inside_geofence === true

  if (category === 'unconfigured') {
    return (
      <>
        <span className="text-slate-600">No geofence configured</span>
        <p className="text-xs text-slate-400">This branch has no active geofence.</p>
      </>
    )
  }

  const distance = row.distance_to_center_m ?? row.nearest_distance
  return (
    <>
      {prefix}
      <span className={stale ? 'text-slate-600' : 'text-slate-700'}>
        {isInside ? (row.geofence_name || 'Registered location') : 'Outside a registered location'}
      </span>
      {/* One line, one distance, once. */}
      {!isInside && distance != null && (
        <span className="text-slate-400">{`, ${formatDistance(distance)} from the centre`}</span>
      )}
      {isLowAccuracy(row) && (
        <span className="text-xs text-slate-400">{LOW_ACCURACY_SUFFIX}</span>
      )}
    </>
  )
}

/**
 * Geofence column.
 *
 * The badge is driven by the SAME `display_category` the chips count, so a row
 * can never disagree with the header. Verdicts are never recomputed here — the
 * server produced them from the newest fix and the active fences.
 *
 *   inside      green, with the registered name
 *   outside     red/amber, one line: "Outside <name>, 11.7 km from centre"
 *   stale       grey, never green: "Last known: Inside/Outside <name>" + age
 *   unconfigured neutral: "No geofence set for <branch>"
 */
function GeofenceCell({ row }) {
  const category = row.display_category
  const stale = row.freshness === 'stale' || category === 'stale'
  const name = row.geofence_name || row.nearest_location_name || row.branch_name || 'the registered location'

  // A stale fix gets a grey badge and "Last known: …" wording, never a bright
  // inside/outside pill, so a two-day-old reading can't read as current.
  if (category === 'stale') {
    const wasInside = row.inside_geofence === true
    const known = wasInside
      ? `Inside ${row.geofence_name || name}`
      : `Outside ${row.geofence_name || name}`
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600">
          Stale
        </span>
        <span className="text-xs text-slate-400">Last known: {known}</span>
      </span>
    )
  }

  if (category === 'unconfigured') {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
          Unconfigured
        </span>
        <span className="text-xs text-slate-400">No geofence set for {row.branch_name || 'this branch'}</span>
      </span>
    )
  }

  // INSIDE: green, with the registered name.
  if (category === 'inside') {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
          Inside
        </span>
        <span className="text-xs text-slate-500">{row.geofence_name || 'Registered location'}</span>
      </span>
    )
  }

  // OUTSIDE: red/amber, and the distance-to-centre on ONE line.
  const distance = row.distance_to_center_m ?? row.meters_outside ?? row.nearest_distance
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        stale ? 'bg-slate-200 text-slate-600' : 'bg-rose-100 text-rose-800'
      }`}>
        Outside
      </span>
      <span className="text-xs text-slate-500">
        {`Outside ${name}`}
        {distance != null && <span className="text-slate-400">{`, ${formatDistance(distance)} from centre`}</span>}
      </span>
    </span>
  )
}

/**
 * Last update column — amber for delayed, red for stale, never "live".
 *
 * Age is always measured against SERVER time: the server returns age_seconds
 * (now() - recorded_at) and this adds only the wall-clock elapsed since that
 * response arrived, so the label keeps counting up between polls and a wrong
 * browser clock cannot make an old fix look fresh.
 */
function LastSeenCell({ row, elapsed }) {
  const state = classifyAgeSeconds(ageSecondsOf(row, elapsed))
  const tone = state === FRESHNESS.LIVE ? 'text-slate-600'
    : state === FRESHNESS.DELAYED ? 'text-amber-700'
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
            <GeofenceCell row={r} />
          </div>
          <p className="mt-2 text-sm">
            <LocationCell row={r} />
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
      <span className="ml-auto text-xs text-slate-500">{label}</span>
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
