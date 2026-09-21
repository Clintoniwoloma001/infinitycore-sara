// Location label for attendance display rows.
//
// The UI reads "Clocking Location" primarily from the attendance_events ledger
// (record.clock_in_event/clock_out_event metadata.actual_location_name). Rows
// written before the event ledger existed, or where the ledger is absent, would
// otherwise render "—" even though verified GPS is stored on the record
// (clock_in_lat/lng). locationLabel() prefers the event metadata (preserving the
// In: x / Out: y distinction) and falls back to the record-level columns, then
// the raw coordinates, so a captured location is never hidden from a row.

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

export default { locationLabel, recordCoords }