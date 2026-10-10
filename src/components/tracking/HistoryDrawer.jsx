// Movement history for one employee.
//
// The map, the timeline and the summary are all drawn from the SAME array of
// recorded points the server returned. No route between two points is ever
// inferred, and with fewer than two points there is deliberately no line.
//
// Filtering is done by the SERVER (employee_location_history takes a date plus
// an optional from/to time window). The client never slices the result itself,
// so what is drawn is exactly what was authorised and audited.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Map as MapIcon, Filter, RotateCcw } from 'lucide-react'
import {
  trackingService, formatCoord, formatClockTime, buildMovementTimeline,
  describeGeofenceStatus, outsidePoints, insertTimelineGaps, isUploadedLate,
} from '../../services/employeeTrackingService'
import { LATE_UPLOAD_MINUTES } from '../../config/trackingFreshness'
import { LoadingState, ErrorState } from '../PageStates'
import TrackingMap from './TrackingMap'
import MovementSummary from './MovementSummary'
import { reverseGeocodeAll } from '../../services/reverseGeocodeService'

const PRESETS = [
  { id: 'all', label: 'Whole day', from: '', to: '' },
  { id: 'morning', label: 'Morning (00:00–12:00)', from: '00:00', to: '12:00' },
  { id: 'afternoon', label: 'Afternoon (12:00–18:00)', from: '12:00', to: '18:00' },
]

export default function HistoryDrawer({ row, onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [fromTime, setFromTime] = useState('')
  const [toTime, setToTime] = useState('')
  const [insideOnly, setInsideOnly] = useState('all')
  const [points, setPoints] = useState([])
  const [geofences, setGeofences] = useState([])
  const [timezone, setTimezone] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [active, setActive] = useState(null)
  // Real place names for points OUTSIDE every registered geofence, keyed by
  // point id. Without these the timeline can only say "Outside HEAD OFFICE
  // (9.2 km away)", which names a fence the person was never at. Inside points
  // are never geocoded: the registered location is a verified fact.
  const [addresses, setAddresses] = useState({})

  // Geofence circles come from the engine's own registry, fetched once.
  useEffect(() => {
    let alive = true
    trackingService.geofences()
      .then((g) => { if (alive) setGeofences(g) })
      .catch(() => { if (alive) setGeofences([]) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true); setError(null); setActive(null)
    ;(async () => {
      try {
        const res = await trackingService.history(row.employee_id, date, {
          // Empty strings mean "no bound", which the RPC treats as unbounded.
          fromTime: fromTime || null,
          toTime: toTime || null,
          insideOnly,
        })
        if (alive) {
          setPoints(res.points || [])
          setTimezone(res.timezone || null)
        }
      } catch (e) {
        if (alive) setError(e.message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [row.employee_id, date, fromTime, toTime, insideOnly])

  // Points arrive sorted by recorded_at (see trackingService.history), so the
  // timeline is chronological even when a backfilled upload lands out of order.
  // Gaps longer than TIMELINE_GAP_MINUTES are stated instead of drawn over.
  const timeline = useMemo(
    () => insertTimelineGaps(buildMovementTimeline(points, addresses)),
    [points, addresses],
  )

  // Resolve the real place for every outside point, oldest first, through the
  // shared rate-limited queue. Purely cosmetic: a failure leaves the honest
  // "X km away" label in place and never blocks the timeline. The selection of
  // which points to look up lives in the service, so the drawer never reshapes
  // the authorised point list itself.
  useEffect(() => {
    let alive = true
    const targets = outsidePoints(points)
    if (targets.length === 0) {
      setAddresses({})
      return () => { alive = false }
    }
    setAddresses({})
    reverseGeocodeAll(targets, { zoom: 18, isCancelled: () => !alive })
      .then(async (map) => {
        if (!alive) return
        setAddresses(map || {})
        // Persist each new place so the history keeps naming the real location
        // on every future visit, not only in this session. Best effort: the
        // point is already recorded, so a rejection changes nothing on screen.
        await Promise.all(
          Object.entries(map || {}).map(([id, address]) =>
            trackingService.saveResolvedPlace(id, address?.short)
              .catch(() => false)),
        )
      })
      .catch(() => { if (alive) setAddresses({}) })
    return () => { alive = false }
  }, [points])

  const applyPreset = useCallback((preset) => {
    setFromTime(preset.from)
    setToTime(preset.to)
  }, [])

  const resetFilters = useCallback(() => {
    setFromTime(''); setToTime(''); setInsideOnly('all')
  }, [])

  const filtered = fromTime || toTime || insideOnly !== 'all'

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <aside className="relative w-full max-w-2xl bg-white h-full overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{row.full_name}</h2>
            <p className="text-xs text-slate-500">
              {row.employee_number || '—'} · {row.position || '—'} · {row.branch_name || '—'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>

            <label className="block text-sm">
              <span className="font-medium text-slate-700">From time</span>
              <input type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>

            <label className="block text-sm">
              <span className="font-medium text-slate-700">To time</span>
              <input type="time" value={toTime} onChange={(e) => setToTime(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => {
              const activePreset = fromTime === p.from && toTime === p.to
              return (
                <button key={p.id} onClick={() => applyPreset(p)}
                  className={`rounded-full px-3 py-1 text-xs font-medium border ${
                    activePreset
                      ? 'border-[#009944] bg-emerald-50 text-[#009944]'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                  {p.label}
                </button>
              )
            })}

            <select value={insideOnly} onChange={(e) => setInsideOnly(e.target.value)}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600">
              <option value="all">All points</option>
              <option value="inside">Inside geofence only</option>
              <option value="outside">Outside geofence only</option>
            </select>

            {filtered && (
              <button onClick={resetFilters}
                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium text-slate-500 hover:bg-slate-50">
                <RotateCcw className="w-3 h-3" />Reset
              </button>
            )}
          </div>

          {loading && <LoadingState label="Loading history..." />}
          {error && <ErrorState title="Unable to load history" message={error} />}

          {!loading && !error && (
            <>
              <p className="flex items-center gap-1.5 text-sm text-slate-600">
                <Filter className="w-3.5 h-3.5 text-slate-400" />
                {points.length
                  ? `${points.length} recorded point${points.length === 1 ? '' : 's'} on ${date}${filtered ? ' (filtered)' : ''}`
                  : `No points recorded on ${date}${filtered ? ' for this time window' : ''}`}
              </p>

              {points.length > 0 && (
                <section>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 mb-2">
                    <MapIcon className="w-4 h-4" />Recorded path
                  </h3>
                  <TrackingMap
                    points={points}
                    geofences={geofences}
                    activeId={active?.id ?? null}
                    onSelect={setActive}
                  />
                  <p className="mt-1.5 text-xs text-slate-500">
                    Straight lines connect consecutive recorded observations only. No route
                    between points is inferred. Select a marker to see its address.
                  </p>
                  <MapLegend />
                </section>
              )}

              <MovementSummary points={points} timezone={timezone} />

              {active && <PointDetail row={row} point={active} />}

              <section>
                <h3 className="text-sm font-semibold text-slate-800 mb-2">Movement timeline</h3>
                {timeline.length === 0 ? (
                  <p className="text-sm text-slate-500">Nothing recorded.</p>
                ) : (
                  <ol>
                    {timeline.map((t, i) => (
                      <li key={t.id || i} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span className={`w-2.5 h-2.5 rounded-full mt-1.5 ${
                            t.isGap ? 'bg-slate-300 ring-2 ring-slate-200'
                                    : t.insideGeofence ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                          {i < timeline.length - 1 && (
                            <span className="w-px flex-1 bg-slate-200" />
                          )}
                        </div>
                        <div className="pb-4">
                          {t.isGap ? (
                            // A silent stretch, stated plainly: the person simply
                            // produced no fixes during this window.
                            <p className="text-xs font-medium italic text-slate-400">{t.label}</p>
                          ) : (
                            <>
                              <p className="text-sm font-medium text-slate-900">
                                {t.time} {t.label}
                              </p>
                              {t.transition && (
                                <p className="text-xs text-slate-500">{t.transition}</p>
                              )}
                              {!t.insideGeofence && t.placeLabel && (
                                <p className="text-xs text-slate-500">
                                  Outside every registered location
                                </p>
                              )}
                              {isUploadedLate(t.recordedAt, t.uploadedAt, LATE_UPLOAD_MINUTES) && (
                                <p className="text-xs text-slate-500">
                                  <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200">
                                    uploaded late
                                  </span>
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

function PointDetail({ row, point }) {
  const status = describeGeofenceStatus(point)
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
      <p className="font-semibold text-slate-800">
        {row.full_name} · {formatClockTime(point.recorded_at)}
      </p>
      <p className="mt-1 text-slate-700">
        Location: {status.text}
      </p>
      {status.detail && (
        <p className="text-slate-600">{status.detail}</p>
      )}
      <p className="font-mono text-slate-600">
        {formatCoord(point.latitude)}, {formatCoord(point.longitude)}
      </p>
      <p className="text-slate-600">
        Accuracy: {point.accuracy != null ? `±${Math.round(point.accuracy)}m` : '—'}
        {' · '}Geofence: {point.inside_geofence ? 'Inside' : 'Outside'}
        {point.source && ` · Source: ${point.source}`}
      </p>
    </div>
  )
}

/** Explains the map symbols so a colour is never the only signal. */
function MapLegend() {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
      <li className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" aria-hidden />Inside a geofence
      </li>
      <li className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full bg-amber-500" aria-hidden />Outside every geofence
      </li>
      <li className="flex items-center gap-1.5">
        <span className="w-4 h-4 rounded-full border border-dashed border-emerald-600" aria-hidden />
        Registered location
      </li>
      <li className="flex items-center gap-1.5">
        <span className="w-4 h-0.5 bg-emerald-600" aria-hidden />Recorded path
      </li>
    </ul>
  )
}
