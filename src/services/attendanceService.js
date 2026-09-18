import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { sendInAppNotification } from './notificationService'

// ------------------------------------------------------------------
// Attendance — clock in/out with server-authoritative timestamps
// and server-side geofence validation.
//
// The database RPCs (clock_in_secure / clock_out_secure) are the
// authority. The server stamps the time, applies the configured
// branch/platform schedule, and validates the geofence.
//
// GPS is requested ONLY when the platform policy requires it
// (get_attendance_requirements). When policy says GPS is optional,
// the employee can clock in/out without location access — the client
// no longer demands a location the server does not require.
//
// calculateAttendanceState() is the single source of truth for
// late / early / on-time interpretation, used by the Attendance menu,
// the clock card and SARA. It reads the schedule stored in the DB
// (branch → work_start_time / work_end_time / grace_period_minutes)
// and compares in the fixed Africa/Lagos (GMT+1) timezone,
// never UTC-stamped-as-local.
// ------------------------------------------------------------------

export const DEFAULT_ATTENDANCE_TIMEZONE = 'Africa/Lagos'

const performanceNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function parseHHMM(value) {
  if (!value) return null
  const m = String(value).match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function timeZoneMinutes(date, timeZone) {
  if (!date) return null
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(date))
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    return hour * 60 + minute
  } catch {
    const d = new Date(date)
    return d.getHours() * 60 + d.getMinutes()
  }
}

function timeZoneDateKey(date, timeZone) {
  if (!date) return null
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date))
  } catch {
    return new Date(date).toISOString().slice(0, 10)
  }
}

/**
 * Returns a YYYY-MM-DD date key for a moment as observed in the platform
 * timezone. Use this instead of `new Date().toISOString().slice(0, 10)`
 * for attendance so "today" always matches the server's day boundary.
 */
export function platformDateKey(date = new Date(), timeZone = DEFAULT_ATTENDANCE_TIMEZONE) {
  return timeZoneDateKey(date, timeZone)
}

/**
 * Get a server-time snapshot. The midpoint of the request is used so the
 * live clock is independent of a device clock that is wrong or adjusted.
 */
export async function getNetworkTime() {
  const requestStartedAt = performanceNow()
  const { data, error } = await supabase.rpc('get_attendance_network_time')
  const responseReceivedAt = performanceNow()
  if (error) throw error
  const serverTimeMs = new Date(data).getTime()
  if (!Number.isFinite(serverTimeMs)) throw new Error('The attendance server returned an invalid time.')
  return {
    serverTimeMs,
    referencePerformanceMs: requestStartedAt + ((responseReceivedAt - requestStartedAt) / 2),
  }
}

export function formatAttendanceTime(value, timeZone = DEFAULT_ATTENDANCE_TIMEZONE, options = {}) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      ...options,
    }).format(new Date(value))
  } catch {
    return '—'
  }
}

/**
 * Canonical attendance interpretation. Server-stored values win when
 * present (late_minutes / early_departure_minutes / status), otherwise
 * the state is derived from the record times against the DB schedule.
 *
 * @param {object|null} record attendance_records row
 * @param {{workStartTime?:string, workEndTime?:string, graceMinutes?:number, timezone?:string}} schedule
 */
export function calculateAttendanceState(record, schedule = {}) {
  const timezone = schedule.timezone || DEFAULT_ATTENDANCE_TIMEZONE
  const startMin = parseHHMM(schedule.workStartTime || '08:00') ?? 480
  const endMin = parseHHMM(schedule.workEndTime || '17:00') ?? 1020
  const grace = Number.isFinite(schedule.graceMinutes) ? schedule.graceMinutes : 15

  const base = {
    state: 'not_clocked_in',
    label: 'Not clocked in',
    tone: 'neutral',
    isLate: false,
    isEarlyExit: false,
    lateMinutes: 0,
    earlyMinutes: 0,
    scheduledStartMinutes: startMin,
    scheduledEndMinutes: endMin,
    graceMinutes: grace,
    timezone,
    clockInAt: record?.clock_in || null,
    clockOutAt: record?.clock_out || null,
  }
  if (!record || !record.clock_in) return base

  const derivedLate = Math.max(0, (timeZoneMinutes(record.clock_in, timezone) ?? startMin) - (startMin + grace))
  const lateMinutes = Number.isFinite(record.late_minutes) && record.late_minutes != null ? record.late_minutes : derivedLate

  if (!record.clock_out) {
    return {
      ...base,
      state: lateMinutes > 0 ? 'working_late' : 'working_on_time',
      label: lateMinutes > 0 ? `Working — late by ${lateMinutes}m` : 'Working — on time',
      tone: lateMinutes > 0 ? 'warn' : 'ok',
      isLate: lateMinutes > 0,
      lateMinutes,
    }
  }

  const derivedEarly = Math.max(0, endMin - (timeZoneMinutes(record.clock_out, timezone) ?? endMin))
  const earlyMinutes = Number.isFinite(record.early_departure_minutes) && record.early_departure_minutes != null
    ? record.early_departure_minutes
    : derivedEarly

  if (lateMinutes > 0) {
    return {
      ...base,
      state: 'late',
      label: `Clocked out — late by ${lateMinutes}m`,
      tone: 'warn',
      isLate: true,
      isEarlyExit: earlyMinutes > 0,
      lateMinutes,
      earlyMinutes,
    }
  }
  if (earlyMinutes > 0) {
    return {
      ...base,
      state: 'early_exit',
      label: `Left early — ${earlyMinutes}m before close`,
      tone: 'warn',
      isEarlyExit: true,
      lateMinutes,
      earlyMinutes,
    }
  }
  return {
    ...base,
    state: 'on_time',
    label: 'Clocked out on time',
    tone: 'ok',
    lateMinutes,
    earlyMinutes,
  }
}

async function myEmployeeId() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { data, error } = await supabase
    .from('employees')
    .select('id')
    .eq('user_id', user.id)
    .limit(1)
  if (error) throw error
  if (!data || data.length === 0) return null
  return data[0].id
}

/**
 * Get the browser's GPS position as a promise.
 * Returns { lat, lng, accuracy } or throws a friendly error.
 */
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Your browser does not support location detection. Please use a modern browser.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      (err) => {
        if (err.code === 1) reject(new Error('Location access is required to verify your workplace attendance. Please enable location access and try again.'))
        else if (err.code === 2) reject(new Error('Your location could not be determined. Check your GPS or network connection and try again.'))
        else if (err.code === 3) reject(new Error('Location request timed out. Please try again.'))
        else reject(new Error('Unable to get your location. Please try again.'))
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    )
  })
}

/**
 * Map server RPC error prefixes to clean, user-facing messages.
 */
export function normalizeAttendanceError(message) {
  const msg = message || 'Attendance action failed. Please try again.'
  if (msg.startsWith('OUTSIDE_GEOFENCE:')) return 'Not within bank or branch allowed clocking radius.'
  if (msg.startsWith('GEOFENCE_NOT_CONFIGURED:')) return msg.replace('GEOFENCE_NOT_CONFIGURED:', '')
  if (msg.startsWith('LOCATION_REQUIRED:')) return msg.replace('LOCATION_REQUIRED:', '')
  if (msg.startsWith('LOCATION_INVALID:')) return msg.replace('LOCATION_INVALID:', '')
  return msg
}

export const attendanceService = {
  async getMyEmployee() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const { data, error } = await supabase
      .from('employees')
      .select('*, branches!branch_id(id, branch_name, latitude, longitude, geofence_radius, geofence_active, work_start_time, work_end_time, grace_period_minutes)')
      .eq('user_id', user.id)
      .limit(1)
    if (error) throw error
    return data?.[0] || null
  },

  /**
   * Platform attendance policy + schedule. Distinguishes "policy requires
   * GPS" from "GPS unavailable". The database is read on each request so
   * Platform Settings changes are picked up without a stale client cache.
   */
  async getAttendanceRequirements() {
    const { data, error } = await supabase.rpc('get_attendance_requirements')
    if (error) throw error
    return {
      requireGpsClockIn: data?.require_gps_clock_in !== false,
      requireGpsClockOut: data?.require_gps_clock_out !== false,
      geofenceEnabled: data?.geofence_enabled !== false,
      defaultGeofenceRadius: data?.default_geofence_radius ?? 150,
      lateThresholdMinutes: data?.late_threshold_minutes ?? 15,
      earlyDepartureThresholdMinutes: data?.early_departure_threshold_minutes ?? 30,
      defaultWorkStartTime: data?.default_work_start_time || '08:00',
      defaultWorkEndTime: data?.default_work_end_time || '17:00',
      defaultGracePeriodMinutes: data?.default_grace_period_minutes ?? 15,
      appTimezone: DEFAULT_ATTENDANCE_TIMEZONE,
    }
  },

  /** Build the canonical schedule object for calculateAttendanceState(). */
  scheduleFor(employee, requirements) {
    const branch = employee?.branches
    return {
      workStartTime: branch?.work_start_time || requirements?.defaultWorkStartTime || '08:00',
      workEndTime: branch?.work_end_time || requirements?.defaultWorkEndTime || '17:00',
      graceMinutes: branch?.grace_period_minutes ?? requirements?.defaultGracePeriodMinutes ?? 15,
      timezone: requirements?.appTimezone || DEFAULT_ATTENDANCE_TIMEZONE,
    }
  },

  async getToday(employeeId) {
    const { appTimezone } = await this.getAttendanceRequirements()
    const networkTime = await getNetworkTime()
    const today = timeZoneDateKey(new Date(networkTime.serverTimeMs), appTimezone)
    const { data, error } = await supabase
      .from('attendance_records')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('attendance_date', today)
      .limit(1)
    if (error) throw error
    return data?.[0] || null
  },

  async reconcileAutoClockouts() {
    const { data, error } = await supabase.rpc('attendance_auto_clockout_close_sessions')
    if (error) throw error
    return data
  },

  async getHistory(employeeId, { startDate, endDate, limit = 90 } = {}) {
    let q = supabase
      .from('attendance_records')
      .select('*')
      .eq('employee_id', employeeId)
      .order('attendance_date', { ascending: false })
    if (startDate) q = q.gte('attendance_date', startDate)
    if (endDate) q = q.lte('attendance_date', endDate)
    q = q.limit(limit)
    const { data, error } = await q
    if (error) throw error
    return data || []
  },

  /**
   * Clock in. GPS is requested only when platform policy requires it; the
   * server re-checks the policy and applies the branch schedule/timezone.
   * @param {{ lat: number, lng: number, accuracy: number }=} geo optional
   */
  async clockIn(geo) {
    const req = await this.getAttendanceRequirements()
    let coords = geo || null
    if ((req.requireGpsClockIn || req.geofenceEnabled) && !coords) {
      coords = await getPosition()
    }
    const { data, error } = await supabase.rpc('clock_in_secure', {
      p_lat: coords?.lat ?? null,
      p_lng: coords?.lng ?? null,
      p_accuracy: coords?.accuracy ?? null,
    })
    if (error) throw new Error(normalizeAttendanceError(error.message))
    logAction({ action: 'ATTENDANCE_CLOCK_IN', entityType: 'AttendanceRecord', entityId: data.attendance_id, details: 'Clock in via geofence RPC' })
    // Send notification
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await sendInAppNotification({
          userId: user.id,
          title: 'Clocked In',
          message: data.late_minutes > 0
            ? `You clocked in ${data.late_minutes} minutes late today.`
            : 'You are clocked in. Have a productive day!',
          type: 'attendance',
        })
      }
    } catch { /* best-effort */ }
    return data
  },

  /**
   * Clock out — a server-side UPDATE of the open session (never an insert,
   * so the status CHECK cannot fire and duplicates are impossible).
   * @param {string} attendanceId
   * @param {{ lat: number, lng: number, accuracy: number }=} geo optional
   */
  async clockOut(attendanceId, geo) {
    const req = await this.getAttendanceRequirements()
    let coords = geo || null
    if ((req.requireGpsClockOut || req.geofenceEnabled) && !coords) {
      coords = await getPosition()
    }
    const { data, error } = await supabase.rpc('clock_out_secure', {
      p_attendance_id: attendanceId,
      p_lat: coords?.lat ?? null,
      p_lng: coords?.lng ?? null,
      p_accuracy: coords?.accuracy ?? null,
    })
    if (error) throw new Error(normalizeAttendanceError(error.message))
    logAction({ action: 'ATTENDANCE_CLOCK_OUT', entityType: 'AttendanceRecord', entityId: attendanceId, details: 'Clock out via geofence RPC' })
    // Send notification
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await sendInAppNotification({
          userId: user.id,
          title: 'Clocked Out',
          message: `You worked ${data.work_hours} hours today. See you next time!`,
          type: 'attendance',
        })
      }
    } catch { /* best-effort */ }
    return data
  },

  // HR / manager view
  async listAll({ startDate, endDate, branchId, department, employeeId, status } = {}) {
    let q = supabase
      .from('attendance_records')
      .select('*, employees(full_name, department, position, branch, branch_id, user_id), branches(id, branch_name)')
      .order('attendance_date', { ascending: false })
      .limit(500)
    if (startDate) q = q.gte('attendance_date', startDate)
    if (endDate) q = q.lte('attendance_date', endDate)
    if (branchId) q = q.eq('branch_id', branchId)
    if (employeeId) q = q.eq('employee_id', employeeId)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) throw error
    // Department filter (on joined employee)
    return (data || []).filter((r) => !department || r.employees?.department === department)
  },

  async listEmployees() {
    const { data, error } = await supabase
      .from('employees')
      .select('id, full_name, department, position, branch, branch_id, user_id')
      .order('full_name')
      .limit(500)
    if (error) throw error
    return data || []
  },

  async listBranches() {
    const { data, error } = await supabase
      .from('branches')
      .select('id, branch_name, branch_code, status, latitude, longitude, geofence_radius, geofence_active, work_start_time, work_end_time, grace_period_minutes, working_days')
      .order('branch_name')
    if (error) throw error
    return data || []
  },

  async correct({ id, clockIn, clockOut, reason }) {
    const { data, error } = await supabase.rpc('correct_attendance', {
      p_attendance_id: id,
      p_clock_in: clockIn,
      p_clock_out: clockOut || null,
      p_reason: reason || 'Corrected by HR',
    })
    if (error) throw error
    return data
  },

  async getCorrectionAudit(attendanceId) {
    const { data, error } = await supabase
      .from('attendance_corrections_audit')
      .select('*')
      .eq('attendance_id', attendanceId)
      .order('corrected_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // ---- Self-reporting (late arrival exception, attendance issue) ----
  // Both inserts are RLS-guarded to the caller's own employee record.
  async submitException({ attendanceId, employeeId, exceptionType, reason, customExplanation, expectedTime, actualTime }) {
    const { data, error } = await supabase
      .from('attendance_exceptions')
      .insert({
        attendance_id: attendanceId || null,
        employee_id: employeeId,
        exception_type: exceptionType || 'late_arrival',
        reason: reason || 'other',
        custom_explanation: customExplanation || null,
        expected_time: expectedTime || null,
        actual_time: actualTime || null,
        status: 'pending',
      })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ATTENDANCE_EXCEPTION_SUBMIT', entityType: 'AttendanceException', entityId: data.id, details: `${exceptionType} reported by ${employeeId}` })
    return data
  },

  async submitIssue({ employeeId, issueDate, issueType, explanation }) {
    const { data, error } = await supabase
      .from('attendance_issues')
      .insert({
        employee_id: employeeId,
        issue_date: issueDate,
        issue_type: issueType,
        explanation: explanation || null,
        status: 'pending',
      })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ATTENDANCE_ISSUE_SUBMIT', entityType: 'AttendanceIssue', entityId: data.id, details: `${issueType} reported by ${employeeId}` })
    return data
  },

  // ---- HR review queues (RLS restricts review to HR/management roles) ----
  async listAllExceptions() {
    const { data, error } = await supabase
      .from('attendance_exceptions')
      .select('*, employees(full_name, staff_id)')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw error
    return data || []
  },

  async reviewException(id, { status, comment } = {}) {
    const { data: authData } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('attendance_exceptions')
      .update({
        status,
        review_comment: comment || null,
        reviewed_by: authData?.user?.id || null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ATTENDANCE_EXCEPTION_REVIEW', entityType: 'AttendanceException', entityId: id, details: `Exception ${status}` })
    return data
  },

  async listAllIssues() {
    const { data, error } = await supabase
      .from('attendance_issues')
      .select('*, employees(full_name, staff_id)')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) throw error
    return data || []
  },

  async reviewIssue(id, { status, comment } = {}) {
    const { data: authData } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('attendance_issues')
      .update({
        status,
        review_comment: comment || null,
        reviewed_by: authData?.user?.id || null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ATTENDANCE_ISSUE_REVIEW', entityType: 'AttendanceIssue', entityId: id, details: `Issue ${status}` })
    return data
  },
}

export default attendanceService
