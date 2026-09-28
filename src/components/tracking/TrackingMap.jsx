// ============================================================================
// Real map view of the recorded trajectory.
//
// Leaflet + OpenStreetMap raster tiles. This REPLACES the old dependency-free SVG
// plot, which had no basemap and therefore no addresses and no zoom - it could
// only ever show relative position.
//
// Honesty rules preserved from the original component:
//   * The polyline connects consecutive RECORDED points only. No route between
//     two points is inferred, and with fewer than two points there is no line.
//   * Inside/outside colouring comes from the server's resolve_employee_location()
//     result. This component never recomputes a geofence.
//   * Geofence circles come from list_tracking_geofences(), the same registry the
//     engine reads, so a circle drawn here is a fence that can actually resolve a
//     clock-in.
//   * Addresses are reverse-geocoded for display only and are cached + rate
//     limited in reverseGeocodeService.
// ============================================================================
import React, { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { reverseGeocode } from '../../services/reverseGeocodeService'
import { formatClockTime, formatCoord, describeGeofenceStatus } from '../../services/employeeTrackingService'

// Fix Leaflet's default icon paths, which break under bundlers.
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const GREEN = '#009944'
const AMBER = '#d97706'
const SLATE = '#64748b'

export default function TrackingMap({
  points = [],
  geofences = [],
  activeId = null,
  onSelect,
  className = '',
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const valid = useMemo(
    () => points.filter((p) => p.latitude != null && p.longitude != null),
    [points],
  )

  // Create the map once; later data changes redraw through the layer effect.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
    const map = L.map(containerRef.current, {
      center: [valid[0]?.latitude ?? 6.5244, valid[0]?.longitude ?? 3.3792],
      zoom: 13,
      zoomControl: true,
      scrollWheelZoom: false, // do not hijack page scroll
    })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; layerRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redraw path, points and geofence circles whenever the data changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (layerRef.current) layerRef.current.remove()
    const group = L.layerGroup().addTo(map)
    layerRef.current = group

    // Geofence circles first, so the trajectory always draws on top of them.
    geofences.forEach((g) => {
      if (g.latitude == null || g.longitude == null) return
      L.circle([g.latitude, g.longitude], {
        radius: Number(g.radius_meters) || 20,
        color: GREEN,
        weight: 1.5,
        fillColor: GREEN,
        fillOpacity: 0.08,
        dashArray: '4 3',
      })
        .bindPopup(
          `<strong>${escapeHtml(g.location_name || 'Registered location')}</strong><br>`
          + `Radius ${Math.round(Number(g.radius_meters) || 0)} m`,
        )
        .addTo(group)
    })

    // A single recorded point has no path - there is nothing to connect.
    if (valid.length >= 2) {
      L.polyline(valid.map((p) => [p.latitude, p.longitude]), {
        color: GREEN,
        weight: 3,
        opacity: 0.8,
        dashArray: '6 4',
      }).addTo(group)
    }

    valid.forEach((p, i) => {
      const status = describeGeofenceStatus(p)
      const isActive = activeId != null && p.id === activeId
      const colour = p.inside_geofence ? GREEN : AMBER
      const time = formatClockTime(p.recorded_at)

      const marker = L.circleMarker([p.latitude, p.longitude], {
        radius: isActive ? 9 : 6,
        color: isActive ? SLATE : colour,
        weight: isActive ? 3 : 2,
        fillColor: colour,
        fillOpacity: 0.9,
      }).addTo(group)

      marker.bindPopup(
        `<strong>${escapeHtml(time)}</strong> &middot; point ${i + 1} of ${valid.length}<br>`
        + `${escapeHtml(status.text)}<br>`
        + `<span style="color:#64748b">${formatCoord(p.latitude)}, ${formatCoord(p.longitude)}</span>`
        + '<div data-address style="color:#334155;margin-top:4px">Zoom in or tap for the address</div>',
      )
      marker.on('click', () => onSelectRef.current?.(p))
      marker.bindTooltip(`${i + 1}. ${time}`, { direction: 'top', offset: [0, -6] })

      // Resolve the street address only when a marker is actually opened, so a
      // long day cannot fire a burst of Nominatim requests on first paint.
      marker.on('popupopen', async (e) => {
        const holder = e.popup.getElement()?.querySelector('[data-address]')
        if (!holder) return
        holder.textContent = 'Resolving address…'
        const result = await reverseGeocode(p.latitude, p.longitude, 18)
        holder.textContent = result?.short || 'No address available for this point'
      })

      if (isActive) setTimeout(() => marker.openPopup(), 0)
    })

    if (valid.length) {
      const bounds = L.latLngBounds(valid.map((p) => [p.latitude, p.longitude]))
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 })
    }
  }, [valid, geofences, activeId])

  if (!valid.length) return null

  return (
    <div
      ref={containerRef}
      className={`w-full h-96 rounded-lg border border-slate-200 ${className}`}
      role="img"
      aria-label="Map of recorded movement with registered geofences"
    />
  )
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}
