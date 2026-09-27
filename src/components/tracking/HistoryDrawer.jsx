// Movement history for one employee on one day.
//
// The polyline and the timeline are both drawn from the SAME array of recorded
// points the server returned. No route between two points is ever inferred, and
// with fewer than two points there is deliberately no line at all.
import React, { useEffect, useMemo, useState } from 'react'
import { X, Map as MapIcon } from 'lucide-react'
import {
  trackingService, formatCoord, formatClockTime, buildMovementTimeline,
} from '../../services/employeeTrackingService'
import { LoadingState, ErrorState } from '../PageStates'
import RecordedPath from './RecordedPath'

export default function HistoryDrawer({ row, onClose }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [points, setPoints] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [active, setActive] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true); setError(null)
    ;(async () => {
      try {
        const res = await trackingService.history(row.employee_id, date)
        if (alive) setPoints(res.points || [])
      } catch (e) {
        if (alive) setError(e.message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [row.employee_id, date])

  const timeline = useMemo(() => buildMovementTimeline(points), [points])

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
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>

          {loading && <LoadingState label="Loading history..." />}
          {error && <ErrorState title="Unable to load history" message={error} />}

          {!loading && !error && (
            <>
              <p className="text-sm text-slate-600">
                {points.length
                  ? `${points.length} recorded point${points.length === 1 ? '' : 's'} on ${date}`
                  : `No points recorded on ${date}`}
              </p>

              {points.length > 1 && (
                <section>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 mb-2">
                    <MapIcon className="w-4 h-4" />Recorded path
                  </h3>
                  <RecordedPath points={points} onSelect={setActive} />
                  <p className="mt-1.5 text-xs text-slate-500">
                    Straight lines connect consecutive recorded observations only. No route
                    between points is inferred.
                  </p>
                </section>
              )}

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
                            t.insideGeofence ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                          {i < timeline.length - 1 && (
                            <span className="w-px flex-1 bg-slate-200" />
                          )}
                        </div>
                        <div className="pb-4">
                          <p className="text-sm font-medium text-slate-900">
                            {t.time} {t.label}
                          </p>
                          {t.transition && (
                            <p className="text-xs text-slate-500">{t.transition}</p>
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
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
      <p className="font-semibold text-slate-800">
        {row.full_name} · {formatClockTime(point.recorded_at)}
      </p>
      <p className="mt-1 text-slate-700">
        Location: {point.location_label || 'Outside registered locations'}
      </p>
      <p className="font-mono text-slate-600">
        {formatCoord(point.latitude)}, {formatCoord(point.longitude)}
      </p>
      <p className="text-slate-600">
        Accuracy: {point.accuracy != null ? `±${Math.round(point.accuracy)}m` : '—'}
        {' · '}Geofence: {point.inside_geofence ? 'Inside' : 'Outside'}
      </p>
    </div>
  )
}
