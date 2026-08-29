import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Attendance — clock in/out with server-authoritative timestamps.
//
// The database triggers in schema_phase6 are the authority:
//   * INSERT  → clock_in is stamped with now() by the server. The client
//     NEVER supplies the official time.
//   * UPDATE  → setting clock_out triggers a server stamp + work_hours
//     recalculation.
//   * corrections must go through the correct_attendance() RPC.
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

export const attendanceService = {
  async getMyEmployee() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .eq('user_id', user.id)
      .limit(1)
    if (error) throw error
    return data?.[0] || null
  },

  async getToday(employeeId) {
    const { data, error } = await supabase
      .from('attendance_records')
      .select('*')
      .eq('employee_id', employeeId)
      .order('attendance_date', { ascending: false })
      .limit(1)
    if (error) throw error
    const today = data?.find((r) => String(r.attendance_date) === new Date().toISOString().slice(0, 10))
    return today || data?.[0] || null
  },

  async getHistory(employeeId, limit = 30) {
    const { data, error } = await supabase
      .from('attendance_records')
      .select('*')
      .eq('employee_id', employeeId)
      .order('attendance_date', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  async clockIn(meta = {}) {
    const employeeId = await myEmployeeId()
    if (!employeeId) throw new Error('No employee profile is linked to your account yet.')
    const { data, error } = await supabase
      .from('attendance_records')
      .insert({
        employee_id: employeeId,
        attendance_date: new Date().toISOString().slice(0, 10),
        source: 'web',
        device_info: meta.deviceInfo || navigator.userAgent,
        location_lat: meta.lat || null,
        location_lng: meta.lng || null,
      })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ATTENDANCE_CLOCK_IN', entityType: 'AttendanceRecord', entityId: data.id, details: `Clock in by ${employeeId}` })
    return data
  },

  async clockOut(attendanceId) {
    if (!attendanceId) throw new Error('No open attendance session found.')
    const { data, error } = await supabase
      .from('attendance_records')
      .update({ clock_out: new Date().toISOString() })
      .eq('id', attendanceId)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ATTENDANCE_CLOCK_OUT', entityType: 'AttendanceRecord', entityId: attendanceId, details: 'Clock out' })
    return data
  },

  // HR / manager view — joins employee details for the directory.
  async listAll(limit = 500) {
    const { data, error } = await supabase
      .from('attendance_records')
      .select('*, employees(full_name, department, position, branch)')
      .order('attendance_date', { ascending: false })
      .limit(limit)
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
}

export default attendanceService