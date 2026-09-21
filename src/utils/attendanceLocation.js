// Location label + distance + status helpers for attendance display rows.
//
// The UI reads "Clocking Location" primarily from the attendance_events ledger
// (record.clock_in_event/clock_out_event metadata.actual_location_name). Rows
// written before the event ledger existed, or where the ledger is absent, would
// otherwise render "—" even though verified GPS is stored on the record
// (clock_in_lat/lng). locationLabel() prefers the event metadata (preserving the
// In: x / Out: y distinction) and falls back to the record-level columns, then
// the raw coordinates, so a captured location is never hidden from a row.
//
// Distance + status are the same single contract everywhere: the geofence
// engine persists the authoritative values on the record itself
// (clock_in_distance / geofence_status / location_status). These helpers read
// THAT record-level data first, then derive only when a legacy/disabled row
// lacks the stored verdict but still carries coordinates.

const DEFAULT_GEOFENCE_RADIUS = 150

function toNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function coordText(record) {
  const lat = record?.clock_in_lat ?? record?.clock_out_lat
  const lng = record?.clock_in_lng ?? record?.clock_out_lng
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null
  return `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`
}

export function recordCoords(record) {
  return coordText(record)
}

export function locationLabel(record) {
  const inName = record?.clock_in_event?.metadata?.actual_location_name
  const outName = record?.clock_out_event?.metadata?.actual_location_name
  if (inName && outName && inName !== outName) return `In: ${inName} / Out: ${outName}`
  if (inName || outName) return inName || outName
  if (record?.actual_location_name) return record.actual_location_name
  return coordText(record) || null
}

// True when the record carries any usable GPS point (either clock edge).
export function recordHasGps(record) {
  const r = record || {}
  return [r.clock_in_lat, r.clock_in_lng, r.clock_out_lat, r.clock_out_lng, r.location_lat, r.location_lng]
    .some((v) => toNumber(v) != null)
}

// Side-specific display name: event ledger location name, else raw coords, else
// null. Accepts 'clock_in' | 'clock_out'.
export function clockingLocationName(record, side) {
  const event = side === 'clock_out' ? record?.clock_out_event : record?.clock_in_event
  const name = event?.metadata?.actual_location_name
  if (name) return name
  const lat = side === 'clock_out' ? record?.clock_out_lat : record?.clock_in_lat
  const lng = side === 'clock_out' ? record?.clock_out_lng : record?.clock_in_lng
  if (lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
    return `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`
  }
  return null
}

// Haversine distance in metres — mirrors public.geo_distance so a legacy row
// that never persisted the distance can still derive it from stored coords.
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (Number(d) * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(a))
}

function recordBranch(record) {
  const r = record || {}
  const b = r.branches || r.employees?.branches
  if (Array.isArray(b)) return b[0] || null
  return b || null
}

function recordPrimaryCoords(record) {
  const r = record || {}
  const lat = toNumber(r.clock_in_lat) ?? toNumber(r.clock_out_lat)
  const lng = toNumber(r.clock_in_lng) ?? toNumber(r.clock_out_lng)
  if (lat == null || lng == null) return null
  return { lat, lng }
}

// Effective distance (metres) for the record: the stored server verdict when
// present, otherwise recomputed from GPS against the assigned branch.
export function recordDistanceMeters(record) {
  const stored = toNumber(record?.clock_in_distance) ?? toNumber(record?.clock_out_distance)
  if (stored != null) return stored
  const coords = recordPrimaryCoords(record)
  const branch = recordBranch(record)
  const bLat = toNumber(branch?.latitude)
  const bLng = toNumber(branch?.longitude)
  if (coords && bLat != null && bLng != null) return haversineMeters(coords.lat, coords.lng, bLat, bLng)
  return null
}

// Effective geofence radius (metres) for the record: assigned-branch radius
// when available, else the platform default.
export function recordRadiusMeters(record) {
  const branch = recordBranch(record)
  return toNumber(branch?.geofence_radius) ?? DEFAULT_GEOFENCE_RADIUS
}

// Canonical location status code: 'within' | 'outside' | 'no_data'.
// Server-stored geofence_status wins; a legacy/disabled row derives from the
// stored (or recomputed) distance against the radius; no GPS -> no_data.
export function locationStatusCode(record) {
  const gs = String(record?.geofence_status || '').toLowerCase()
  if (gs === 'inside') return 'within'
  if (gs === 'outside') return 'outside'
  const distance = recordDistanceMeters(record)
  if (distance != null && recordHasGps(record)) {
    return distance <= recordRadiusMeters(record) ? 'within' : 'outside'
  }
  return 'no_data'
}

export const LOCATION_STATUS_META = {
  within: { code: 'within', label: 'Within Geofence', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  outside: { code: 'outside', label: 'Outside Geofence', tone: 'bg-rose-50 text-rose-700 border-rose-200' },
  no_data: { code: 'no_data', label: 'No location data', tone: 'bg-slate-100 text-slate-600 border-slate-200' },
}

export function locationStatusMeta(record) {
  return LOCATION_STATUS_META[locationStatusCode(record)] || LOCATION_STATUS_META.no_data
}

// Distance label for the Location Difference column/modal (e.g. "6m").
export function locationDistanceLabel(record) {
  const distance = recordDistanceMeters(record)
  if (distance == null) return null
  return `${Math.round(distance)}m`
}

export default { locationLabel, recordCoords, recordHasGps, locationStatusCode, locationStatusMeta, locationDistanceLabel, clockingLocationName, recordDistanceMeters, recordRadiusMeters }