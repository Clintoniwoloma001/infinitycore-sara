import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { sendInAppNotification } from './notificationService'

// ------------------------------------------------------------------
// Attendance — clock in/out with server-authoritative timestamps
// and server-side geofence validation.
//
// The database RPCs (clock_in_secure / clock_out_secure) are the
// authority. The client supplies GPS coordinates; the server stamps
// the time and validates the geofence.
// ------------------------------------------------------------------

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

  async getToday(employeeId) {
    const today = new Date().toISOString().slice(0, 10)
    const { data, error } = await supabase
      .from('attendance_records')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('attendance_date', today)
      .limit(1)
    if (error) throw error
    return data?.[0] || null
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
   * Clock in with server-side geofence validation.
   * @param {{ lat: number, lng: number, accuracy: number }} geo
   */
  async clockIn(geo) {
    if (!geo) throw new Error('Location is required to clock in. Please enable location access.')
    const { data, error } = await supabase.rpc('clock_in_secure', {
      p_lat: geo.lat,
      p_lng: geo.lng,
      p_accuracy: geo.accuracy || null,
    })
    if (error) {
      // Check for geofence error with custom prefix
      const msg = error.message || ''
      if (msg.startsWith('OUTSIDE_GEOFENCE:')) {
        throw new Error(msg.replace('OUTSIDE_GEOFENCE:', ''))
      }
      throw new Error(msg)
    }
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
   * Clock out with server-side geofence validation.
   * @param {string} attendanceId
   * @param {{ lat: number, lng: number, accuracy: number }} geo
   */
  async clockOut(attendanceId, geo) {
    if (!geo) throw new Error('Location is required to clock out. Please enable location access.')
    const { data, error } = await supabase.rpc('clock_out_secure', {
      p_attendance_id: attendanceId,
      p_lat: geo.lat,
      p_lng: geo.lng,
      p_accuracy: geo.accuracy || null,
    })
    if (error) {
      const msg = error.message || ''
      if (msg.startsWith('OUTSIDE_GEOFENCE:')) {
        throw new Error(msg.replace('OUTSIDE_GEOFENCE:', ''))
      }
      throw new Error(msg)
    }
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
}

export default attendanceService
