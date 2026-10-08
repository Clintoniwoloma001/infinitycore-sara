// ============================================================================
// Employee Tracking service (Phase 70)
// ============================================================================
// Every call goes through a SECURITY DEFINER RPC that re-checks
// employee_tracking_access() server-side. The UI never decides authorization:
// it only renders what the server returned, and surfaces the server's reason
// when a call is refused.
//
// No geofence math happens in this file. Location resolution belongs to
// resolve_employee_location() in Postgres so the web app, the mobile app, the
// clock-in path and the Location Audit can never disagree.
import { supabase } from '../supabaseClient'
import {
  TIMELINE_GAP_MINUTES, LATE_UPLOAD_MINUTES, LOW_ACCURACY_SUFFIX,
  ageSecondsOf, formatDurationMinutes,
} from '../config/trackingFreshness'

const unwrap = (data, error, fallback) => {
  if (error) {
    const message = error.message || String(error)
    // Preserve the server's explicit refusal reason for the UI.
    const denied = /TRACKING_FORBIDDEN/.test(message)
    const detail = denied ? message.split('TRACKING_FORBIDDEN:')[1] : message
    const err = new Error(detail)
    err.forbidden = denied
    err.raw = message
    throw err
  }
  return data ?? fallback
}

export const trackingService = {
  /** Who am I allowed to see, and why. Drives the access banner. */
  async myAccess() {
    const { data, error } = await supabase.rpc('employee_tracking_access')
    return unwrap(data, error, { can_view: false, can_manage: false, via: 'none' })
  },

  /**
   * Latest known position per employee.
   *
   * Freshness is NEVER decided here: the server returns the fix's age against
   * its own clock (`age_seconds`) and the UI classifies it with the thresholds
   * in src/config/trackingFreshness.js. Every server field is passed through
   * verbatim — the previous implementation silently dropped `is_stale`, which
   * is what let a two-day-old fix be counted as "recently updated".
   */
  async livePositions({ withinMinutes = 60, department = null, branchId = null } = {}) {
    const { data, error } = await supabase.rpc('list_tracked_employees', {
      p_within_minutes: withinMinutes,
      p_department: department,
      p_branch_id: branchId,
    })

    const result = unwrap(data, error, [])
    const normalized = Array.isArray(result) ? result : (result?.positions || [])

    if (!Array.isArray(normalized)) {
      throw new Error(
        'Tracking data could not be read: the server returned an unexpected shape.',
      )
    }

    return normalized.map(item => ({
      id: item.id || item.employee_id,
      employee_id: item.employee_id,
      latitude: item.latitude == null ? null : Number(item.latitude),
      longitude: item.longitude == null ? null : Number(item.longitude),
      recorded_at: item.recorded_at || item.last_seen || null,
      full_name: item.employee_name || item.employee?.full_name || item.full_name || 'Staff Member',
      branch_name: item.branch_name || item.employee?.branch?.name || 'Head Office',
      // Preserve existing flags used by the UI
      inside_geofence: item.inside_geofence,
      location_label: item.location_label,
      resolved_place: item.resolved_place,
      nearest_location_name: item.nearest_location_name,
      nearest_distance: item.nearest_distance,
      nearest_radius: item.nearest_radius,
      minutes_ago: item.minutes_ago,
      last_seen: item.last_seen,
      uploaded_at: item.uploaded_at,
      // Server-computed age (now() - recorded_at, in seconds) + the server's
      // own clock reading. These are what freshness is computed from.
      age_seconds: item.age_seconds,
      server_now: item.server_now,
      is_stale: item.is_stale,
      accuracy: item.accuracy,
      employee_number: item.employee_number,
      position: item.position,
      department: item.department,
      has_fix: item.has_fix !== false && item.recorded_at != null,
    }))
  },

  /**
   * Movement history for one employee on one date. Returns the ACTUAL recorded
   * points in recorded_at order - the map polyline and the timeline are both
   * drawn from this array, so no route is ever inferred between two points and
   * a late (backfilled) upload can never be shown out of sequence.
   */
  async history(employeeId, date, { fromTime = null, toTime = null, insideOnly = 'all' } = {}) {
    const { data, error } = await supabase.rpc('employee_location_history', {
      p_employee_id: employeeId,
      p_date: date,
      p_from_time: fromTime,
      p_to_time: toTime,
      p_inside_only: insideOnly,
    })
    const res = unwrap(data, error, { points: [], point_count: 0 })
    return { ...res, points: sortByRecordedAt(res?.points) }
  },

  /**
   * ACTIVE registered locations with the radius the engine actually applies, so
   * the map draws exactly the fences that can resolve a clock-in. Read through
   * the same access gate as every other tracking RPC.
   */
  async geofences() {
    const { data, error } = await supabase.rpc('list_tracking_geofences')
    return unwrap(data, error, { geofences: [] }).geofences || []
  },

  /**
   * Remember the real place for one of the caller's own tracking points.
   *
   * Fire-and-forget persistence for the reverse-geocoded label: the point is
   * already recorded either way, so a failure here must never surface to the
   * user. The server refuses any row the caller does not own and cannot change
   * inside_geofence or any coordinate.
   */
  async saveResolvedPlace(eventId, place) {
    if (!eventId || !place) return false
    const { data, error } = await supabase.rpc('set_employee_location_resolved_place', {
      p_event_id: eventId,
      p_place: place,
    })
    if (error) return false
    return data === true
  },

  /** All shares the Super Admin can see, with an explicit status per row. */
  async listGrants() {
    const { data, error } = await supabase.rpc('list_tracking_access_grants')
    return unwrap(data, error, { grants: [] }).grants || []
  },

  /**
   * Share access with a user or a role.
   * duration: 'forever' | 'PT8H' (X hours) | 'P2D' (X days), or pass
   * expiresAt for an exact date-time. Server rejects non-positive durations.
   */
  async grant({ targetType, targetUserId = null, targetRole = null, duration = 'forever', expiresAt = null, reason = null }) {
    const { data, error } = await supabase.rpc('grant_tracking_access', {
      p_target_type: targetType,
      p_target_user_id: targetUserId,
      p_target_role: targetRole,
      p_duration: duration,
      p_expires_at: expiresAt,
      p_reason: reason,
    })
    return unwrap(data, error, {})
  },

  /** Immediate revocation. The recipient loses access on the next read. */
  async revoke(grantId) {
    const { data, error } = await supabase.rpc('revoke_tracking_access', { p_grant_id: grantId })
    return unwrap(data, error, {})
  },

  /**
   * Explicit retention prune. The server refuses to delete anything until
   * location_retention_days is configured, so precise history is never
   * discarded silently.
   */
  async pruneHistory(olderThanDays = null) {
    const { data, error } = await supabase.rpc('prune_employee_location_history', {
      p_older_than_days: olderThanDays,
    })
    return unwrap(data, error, {})
  },
}

// ---------------------------------------------------------------------------
// Presentation helpers (formatting only - no business math, no geofence logic)
// ---------------------------------------------------------------------------

/**
 * Strict recorded_at ascending order. Both the timeline and the map polyline
 * consume this, so a backfilled row (recorded earlier, uploaded later) can
 * never be drawn after a fix that was captured after it.
 */
export function sortByRecordedAt(points = []) {
  if (!Array.isArray(points)) return []
  return [...points].sort((a, b) => {
    const at = a?.recorded_at ? Date.parse(a.recorded_at) : NaN
    const bt = b?.recorded_at ? Date.parse(b.recorded_at) : NaN
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0
    if (Number.isNaN(at)) return 1
    if (Number.isNaN(bt)) return -1
    return at - bt
  })
}

/**
 * "Last seen 42 minutes ago" - never present a stale point as live.
 *
 * `elapsedMs` is the time since the server response arrived; the base age is
 * always the server's own `age_seconds`, so the label keeps counting up between
 * polls instead of freezing (and a wrong browser clock cannot make an old fix
 * look fresh).
 */
export function describeFreshness(row, elapsedMs = 0) {
  if (!row) return 'No location yet'
  const seconds = ageSecondsOf(row, elapsedMs)
  if (seconds == null) return 'No location yet'
  const mins = Math.floor(seconds / 60)
  if (mins < 1) return 'Just now'
  if (mins === 1) return 'Last seen 1 minute ago'
  if (mins < 60) return `Last seen ${mins} minutes ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Last seen ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `Last seen ${days} day${days === 1 ? '' : 's'} ago`
}

export function formatCoord(value) {
  return value == null ? '—' : Number(value).toFixed(6)
}

/**
 * "18 m" / "1.4 km" / "9.2 km". Presentation only - the number itself comes from
 * the server's geo_distance() result, never recomputed here.
 */
export function formatDistance(meters) {
  if (meters == null || Number.isNaN(Number(meters))) return '—'
  const m = Number(meters)
  if (m < 1000) return `${Math.round(m)} m`
  return `${(m / 1000).toFixed(1)} km`
}

/**
 * Why a point is inside or outside, stated so it can be checked.
 *
 * The old wording ("HEAD OFFICE" beside a red "Outside" badge) was the actual
 * defect: the stored label named the NEAREST fence, so a point 9 km away looked
 * like it was at the branch. The server now stores the honest label, and this
 * helper additionally surfaces the measured distance and the fence radius, so
 * "outside" is always a checkable statement rather than an assertion.
 */
/**
 * A fix whose GPS error is larger than the fence radius cannot, on its own,
 * prove inside or outside. This never changes the verdict — resolve_employee_location()
 * owns that — it only says out loud that the reading is imprecise.
 */
export function isLowAccuracy(point) {
  if (!point) return false
  const accuracy = point.accuracy
  const radius = point.nearest_radius
  if (accuracy == null || radius == null) return false
  const a = Number(accuracy)
  const r = Number(radius)
  if (!Number.isFinite(a) || !Number.isFinite(r)) return false
  return a > r
}

function withLowAccuracy(detail, low) {
  if (!low) return detail
  return detail ? `${detail} · ${LOW_ACCURACY_SUFFIX}` : LOW_ACCURACY_SUFFIX
}

export function describeGeofenceStatus(point) {
  if (!point) return { tone: 'muted', text: 'No location recorded', detail: null, lowAccuracy: false }

  const low = isLowAccuracy(point)
  const nearest = point.nearest_location_name
  const distance = point.nearest_distance
  const radius = point.nearest_radius

  if (point.inside_geofence) {
    return {
      tone: 'inside',
      text: point.location_label || nearest || 'Inside a registered location',
      detail: withLowAccuracy(
        distance != null
          ? `${formatDistance(distance)} from the centre (radius ${formatDistance(radius)})`
          : null,
        low,
      ),
      lowAccuracy: low,
    }
  }

  if (!nearest) {
    return {
      tone: 'outside',
      text: 'Outside all registered locations',
      detail: withLowAccuracy(null, low),
      lowAccuracy: low,
    }
  }

  const gap = distance != null && radius != null
    ? `${formatDistance(distance)} from ${nearest}, whose radius is ${formatDistance(radius)}`
    : distance != null
      ? `${formatDistance(distance)} from ${nearest}`
      : `nearest registered location is ${nearest}`

  return {
    tone: 'outside',
    // The measured distance is part of the headline, not a footnote.
    text: distance != null
      ? `${formatDistance(distance)} outside ${nearest}`
      : `Outside ${nearest}`,
    detail: withLowAccuracy(gap, low),
    lowAccuracy: low,
  }
}

export function formatClockTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * The points that need a real place name: those OUTSIDE every registered
 * geofence.
 *
 * This is a presentation-side selector, NOT a filter on the audited result set.
 * It never removes a point from what is drawn - the drawer still renders every
 * point the server authorised. Its only effect is to decide which coordinates
 * are worth a reverse-geocode lookup. A point inside a fence already has a
 * verified name, so looking one up would be a paid request for a worse answer.
 *
 * It lives here, next to the other point helpers, so the drawer never contains
 * a `points.filter(...)` of its own. That keeps the original guarantee literal
 * and auditable: the client does not reshape the authorised point list.
 */
export function outsidePoints(points = []) {
  if (!Array.isArray(points)) return []
  return points.filter((p) => !p.inside_geofence)
}

/**
 * Movement timeline derived strictly from consecutive recorded points. The
 * "left geofence" / "entered" wording is computed by comparing each point's
 * inside_geofence flag to the previous one - it describes what the recorded
 * data says, it does not infer a route.
 *
 * `addresses` is an optional map of point id -> { short } from
 * reverseGeocodeService. It ONLY affects points that are outside every
 * registered geofence: those are the points whose stored label names the
 * nearest fence ("Outside HEAD OFFICE (9.2 km away)"), which is true but not
 * what a reader wants to know when asking "where was this person?". A point
 * that IS inside a fence is always labelled with that fence's name, because
 * that is a verified fact - an address never replaces it.
 */
export function buildMovementTimeline(points = [], addresses = {}) {
  if (!Array.isArray(points)) return []
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1] : null
    const id = p.id ?? `${p.latitude},${p.longitude}`
    const place = addresses?.[id]?.short

    // The headline a reader sees for this observation.
    //   inside  -> the registered location (authoritative)
    //   outside -> the real place from the map, e.g. "Ogudu GRA Estate"
    //   outside with no address -> the honest "X km away" label
    const label = p.inside_geofence
      ? (p.location_label || 'Registered location')
      : (place || p.location_label || 'Outside registered locations')

    let transition = null
    if (prev && prev.inside_geofence !== p.inside_geofence) {
      transition = p.inside_geofence
        ? `Entered ${p.location_label || 'registered location'}`
        : `Left ${prev.location_label || 'registered location'} geofence`
    } else if (i === 0) {
      transition = p.inside_geofence
        ? `At ${p.location_label || 'registered location'}`
        : (place ? `At ${place} (outside every registered location)` : 'Outside any registered location')
    }

    return {
      id: p.id,
      time: formatClockTime(p.recorded_at),
      recordedAt: p.recorded_at,
      // Kept so the row can say "uploaded late" when a backfilled fix reached
      // the server long after it was captured (threshold lives in config).
      uploadedAt: p.uploaded_at,
      label,
      // The registered-location wording is kept separately so the sub-line can
      // still say how far outside the point was, even when the headline shows
      // the real address.
      placeLabel: p.inside_geofence ? null : place || null,
      insideGeofence: !!p.inside_geofence,
      accuracy: p.accuracy,
      latitude: p.latitude,
      longitude: p.longitude,
      transition,
    }
  })
}

/**
 * Inserts a "No data for 1h 20m" row wherever two consecutive fixes are more
 * than TIMELINE_GAP_MINUTES apart, so a long silent stretch is stated instead
 * of being drawn over as if the person never moved.
 *
 * Pure presentation: it reads recorded_at only, never reorders and never
 * removes a point. The threshold comes from src/config/trackingFreshness.js.
 */
export function insertTimelineGaps(timeline = [], gapMinutes = TIMELINE_GAP_MINUTES) {
  if (!Array.isArray(timeline) || timeline.length === 0) return []
  const out = []
  let lastPoint = null
  let seq = 0

  for (const item of timeline) {
    if (!item || item.isGap) continue
    if (lastPoint) {
      const from = Date.parse(lastPoint.recordedAt)
      const to = Date.parse(item.recordedAt)
      const deltaMs = to - from
      if (Number.isFinite(deltaMs) && deltaMs > gapMinutes * 60000) {
        out.push({
          id: `timeline-gap-${seq++}`,
          isGap: true,
          gapMinutes: deltaMs / 60000,
          label: `No data for ${formatDurationMinutes(deltaMs / 60000)}`,
        })
      }
    }
    out.push(item)
    lastPoint = item
  }
  return out
}

/** True when the fix reached the server more than LATE_UPLOAD_MINUTES after capture. */
export function isUploadedLate(recordedAt, uploadedAt, lateMinutes = LATE_UPLOAD_MINUTES) {
  if (!recordedAt || !uploadedAt) return false
  const recorded = Date.parse(recordedAt)
  const uploaded = Date.parse(uploadedAt)
  if (!Number.isFinite(recorded) || !Number.isFinite(uploaded)) return false
  return (uploaded - recorded) > lateMinutes * 60000
}