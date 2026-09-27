// A dependency-free plot of the recorded points.
//
// Deliberately NOT a street basemap: no map/tile provider is configured for this
// platform, and drawing invented streets or an invented street address would
// misrepresent the data. This shows relative position honestly and says so. The
// human-readable label always comes from the registered geofence name resolved
// server-side, never from a guess made here.
import React from 'react'
import { formatClockTime } from '../../services/employeeTrackingService'

const W = 600, H = 260, PAD = 24

export default function RecordedPath({ points, onSelect }) {
  if (!points || points.length < 2) return null

  const lats = points.map((p) => Number(p.latitude))
  const lngs = points.map((p) => Number(p.longitude))
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
  const spanLat = maxLat - minLat || 0.0001
  const spanLng = maxLng - minLng || 0.0001

  const project = (p) => ({
    x: PAD + ((Number(p.longitude) - minLng) / spanLng) * (W - PAD * 2),
    y: H - PAD - ((Number(p.latitude) - minLat) / spanLat) * (H - PAD * 2),
  })

  const coords = points.map(project)
  const path = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`}
      className="w-full h-64 rounded-lg border border-slate-200 bg-slate-50"
      role="img" aria-label="Recorded movement path">
      <path d={path} fill="none" stroke="#009944" strokeWidth="2" strokeDasharray="4 3" />
      {coords.map((c, i) => (
        <g key={points[i].id || i} onClick={() => onSelect(points[i])} className="cursor-pointer">
          <circle cx={c.x} cy={c.y} r="5"
            fill={points[i].inside_geofence ? '#009944' : '#d97706'} />
          <title>
            {formatClockTime(points[i].recorded_at)} — {points[i].location_label || 'Outside registered locations'}
          </title>
        </g>
      ))}
    </svg>
  )
}
