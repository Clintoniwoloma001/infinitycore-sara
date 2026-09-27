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
   * Latest known position per employee. `withinMinutes` only widens the
   * "points in window" signal used for activity display; it never decides
   * whether a stale point is shown as live - `is_stale` does that.
   */
  async livePositions({ withinMinutes = 60, department = null, branchId = null } = {}) {
    const { data, error } = await supabase.rpc('list_tracked_employees', {
      p_within_minutes: withinMinutes,
      p_department: department,
      p_branch_id: branchId,
    })
    return unwrap(data, error, { employees: [] }).employees || []
  },

  /**
   * Movement history for one employee on one date. Returns the ACTUAL recorded
   * points in time order - the map polyline and the timeline are both drawn
   * from this array, so no route is ever inferred between two points.
   */
  async history(employeeId, date, { fromTime = null, toTime = null, insideOnly = 'all' } = {}) {
    const { data, error } = await supabase.rpc('employee_location_history', {
      p_employee_id: employeeId,
      p_date: date,
      p_from_time: fromTime,
      p_to_time: toTime,
      p_inside_only: insideOnly,
    })
    return unwrap(data, error, { points: [], point_count: 0 })
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

/** "Last seen 42 minutes ago" - never present a stale point as live. */
export function describeFreshness(row) {
  if (!row?.last_seen) return 'No location recorded'
  const mins = row.minutes_ago
  if (mins == null) return 'No location recorded'
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

export function formatClockTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * Movement timeline derived strictly from consecutive recorded points. The
 * "left geofence" / "entered" wording is computed by comparing each point's
 * inside_geofence flag to the previous one - it describes what the recorded
 * data says, it does not infer a route.
 */
export function buildMovementTimeline(points = []) {
  if (!Array.isArray(points)) return []
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1] : null
    let transition = null
    if (prev && prev.inside_geofence !== p.inside_geofence) {
      transition = p.inside_geofence
        ? `Entered ${p.location_label || 'registered location'}`
        : `Left ${prev.location_label || 'registered location'} geofence`
    } else if (i === 0) {
      transition = p.inside_geofence
        ? `At ${p.location_label || 'registered location'}`
        : 'Outside any registered location'
    }
    return {
      id: p.id,
      time: formatClockTime(p.recorded_at),
      recordedAt: p.recorded_at,
      label: p.location_label || (p.inside_geofence ? 'Registered location' : 'Outside registered locations'),
      insideGeofence: !!p.inside_geofence,
      accuracy: p.accuracy,
      latitude: p.latitude,
      longitude: p.longitude,
      transition,
    }
  })
}