// ============================================================================
// Plain-language summary of how the person actually moved.
//
// Every sentence is derived from consecutive RECORDED points. Distances are the
// straight-line separations between those points (haversine, matching the
// server's geo_distance); the copy never implies a road route, a mode of
// transport, or a place the employee did not actually record. Where the data is
// too sparse to support a claim, the summary says so instead of guessing.
// ============================================================================
import React from 'react'
import { formatClockTime, formatDistance } from '../../services/employeeTrackingService'

const EARTH_R = 6371000
const toRad = (d) => (Number(d) * Math.PI) / 180

/** Straight-line separation between two recorded points, in meters. */
function separation(a, b) {
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(s))
}

export default function MovementSummary({ points = [], timezone }) {
  if (!points.length) return null

  const first = points[0]
  const last = points[points.length - 1]
  const inside = points.filter((p) => p.inside_geofence)
  const outside = points.length - inside.length

  // Legs are the gaps BETWEEN recorded points; the first point has no leg.
  const legs = points.slice(1).map((p, i) => separation(points[i], p))
  const total = legs.reduce((a, b) => a + b, 0)
  const longest = legs.length ? Math.max(...legs) : 0

  const spanMs = new Date(last.recorded_at) - new Date(first.recorded_at)
  const spanMin = Math.max(0, Math.round(spanMs / 60000))

  // Distinct registered locations, grouped by the server's own verdict.
  const places = new Map()
  points.forEach((p) => {
    const key = p.inside_geofence
      ? (p.location_label || p.nearest_location_name || 'Registered location')
      : 'Outside registered locations'
    places.set(key, (places.get(key) || 0) + 1)
  })

  const geofenceVisits = inside.length
  const entered = points.filter(
    (p, i) => p.inside_geofence && i > 0 && !points[i - 1].inside_geofence,
  ).length

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-800">How they moved</h3>

      <p className="mt-2 text-sm text-slate-700 leading-relaxed">
        Between {formatClockTime(first.recorded_at)} and {formatClockTime(last.recorded_at)}
        {spanMin >= 1 ? ` (${formatDuration(spanMin)})` : ''},{' '}
        {points.length} position{points.length === 1 ? ' was' : 's were'} recorded
        {points.length === 1
          ? ' at a single moment, so no movement can be described.'
          : `, covering ${formatDistance(total)} of straight-line travel`}
        {legs.length > 1 ? ` across ${legs.length} recorded legs` : legs.length === 1 ? ' across 1 recorded leg' : ''}.
      </p>

      <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
        <li className="flex gap-2">
          <span aria-hidden>•</span>
          <span>
            <strong className="text-slate-800">{geofenceVisits}</strong> of{' '}
            <strong className="text-slate-800">{points.length}</strong> observations fell
            inside a registered location
            {outside > 0 && `, ${outside} fell outside every geofence`}.
          </span>
        </li>

        {entered > 0 && (
          <li className="flex gap-2">
            <span aria-hidden>•</span>
            <span>Entered a geofence <strong className="text-slate-800">{entered}</strong> time{entered === 1 ? '' : 's'} during this window.</span>
          </li>
        )}

        {legs.length > 0 && longest > 0 && (
          <li className="flex gap-2">
            <span aria-hidden>•</span>
            <span>
              Longest single gap between two recorded points:{' '}
              <strong className="text-slate-800">{formatDistance(longest)}</strong>.
            </span>
          </li>
        )}

        {[...places.entries()].map(([place, count]) => (
          <li key={place} className="flex gap-2">
            <span aria-hidden>•</span>
            <span>
              {place} — {count} observation{count === 1 ? '' : 's'}.
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-xs text-slate-400">
        Distances are straight-line separations between recorded points, not a
        travelled route or driving distance. No route between two points is
        inferred.
        {timezone ? ` Times are shown in ${timezone}.` : ''}
      </p>
    </section>
  )
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h} hour${h === 1 ? '' : 's'}`
  return `${m} minute${m === 1 ? '' : 's'}`
}
