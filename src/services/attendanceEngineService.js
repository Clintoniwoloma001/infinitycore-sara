import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Attendance Engine Service — geofencing, devices, biometric mapping,
// central events, and extended attendance operations.
// Extends the existing attendanceService — does NOT replace it.
// ------------------------------------------------------------------

// Haversine distance in meters
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(R * 2 * Math.asin(Math.min(1, Math.sqrt(a))))
}

export const attendanceEngineService = {
  // ---- GEOFENCES ----
  async listGeofences() {
    const { data, error } = await supabase
      .from('attendance_geofences')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async createGeofence(payload) {
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('attendance_geofences')
      .insert({ ...payload, created_by: user?.id })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'GEOFENCE_CREATE', entityType: 'AttendanceGeofence', entityId: data.id, details: `Geofence ${data.name} created` })
    return data
  },

  async updateGeofence(id, payload) {
    const { data, error } = await supabase
      .from('attendance_geofences')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteGeofence(id) {
    const { error } = await supabase.from('attendance_geofences').delete().eq('id', id)
    if (error) throw error
  },

  // Verify employee location against geofences
  verifyLocation(lat, lng, geofences) {
    if (!geofences || geofences.length === 0) return { inside: false, nearest: null, distance: null, noGeofences: true }
    let nearest = null
    let minDist = Infinity
    for (const g of geofences) {
      if (!g.active) continue
      const dist = haversine(lat, lng, g.latitude, g.longitude)
      if (dist < minDist) { minDist = dist; nearest = g }
    }
    if (!nearest) return { inside: false, nearest: null, distance: null, noGeofences: true }
    const inside = minDist <= nearest.radius_meters
    return { inside, nearest, distance: minDist, noGeofences: false }
  },

  // ---- DEVICES ----
  async listDevices() {
    const { data, error } = await supabase
      .from('attendance_devices')
      .select('*, attendance_geofences(name, location_name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async createDevice(payload) {
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('attendance_devices')
      .insert({ ...payload, created_by: user?.id })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'DEVICE_REGISTER', entityType: 'AttendanceDevice', entityId: data.id, details: `Device ${data.device_name} registered` })
    return data
  },

  async updateDevice(id, payload) {
    const { data, error } = await supabase
      .from('attendance_devices')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteDevice(id) {
    const { error } = await supabase.from('attendance_devices').delete().eq('id', id)
    if (error) throw error
  },

  async revokeDevice(id) {
    return this.updateDevice(id, { status: 'suspended', active: false })
  },

  // ---- BIOMETRIC MAPPING ----
  async listBiometricMappings() {
    const { data, error } = await supabase
      .from('employee_biometric_identifiers')
      .select('*, employees(full_name, department, position), attendance_devices(device_name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async createBiometricMapping(payload) {
    const { data, error } = await supabase
      .from('employee_biometric_identifiers')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateBiometricMapping(id, payload) {
    const { data, error } = await supabase
      .from('employee_biometric_identifiers')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteBiometricMapping(id) {
    const { error } = await supabase.from('employee_biometric_identifiers').delete().eq('id', id)
    if (error) throw error
  },

  // ---- ATTENDANCE EVENTS ----
  async listEvents({ employeeId, source, limit = 100 } = {}) {
    let query = supabase
      .from('attendance_events')
      .select('*, employees(full_name, department), attendance_geofences(name), attendance_devices(device_name)')
      .order('event_time', { ascending: false })
      .limit(limit)
    if (employeeId) query = query.eq('employee_id', employeeId)
    if (source) query = query.eq('source', source)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  // Simulate a device clock-in event (for testing/terminal mode)
  async simulateDeviceEvent({ deviceId, externalUserId, eventType }) {
    const { data, error } = await supabase.rpc('ingest_attendance_event', {
      p_device_id: deviceId,
      p_external_user_id: externalUserId,
      p_event_type: eventType,
      p_verification_method: 'FINGERPRINT',
    })
    if (error) throw error
    return data
  },

  // ---- ATTENDANCE CONFIG (extended) ----
  async getConfig() {
    const { data, error } = await supabase
      .from('attendance_config')
      .select('*')
      .eq('id', 1)
      .single()
    if (error && error.code !== 'PGRST116') throw error
    return data
  },

  async updateConfig(payload) {
    const { data, error } = await supabase
      .from('attendance_config')
      .upsert({ id: 1, ...payload })
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'ATTENDANCE_CONFIG_UPDATE', entityType: 'AttendanceConfig', entityId: 1, details: 'Attendance config updated' })
    return data
  },

  // ---- EMPLOYEE QUERIES ----
  async listQueries(employeeId) {
    let query = supabase.from('employee_queries').select('*').order('created_at', { ascending: false })
    if (employeeId) query = query.eq('employee_id', employeeId)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async listAllQueries(limit = 100) {
    const { data, error } = await supabase
      .from('employee_queries')
      .select('*, employees(full_name, department)')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  async createQuery(payload) {
    const { data, error } = await supabase
      .from('employee_queries')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async resolveQuery(id, { status, resolution }) {
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('employee_queries')
      .update({
        status,
        resolution,
        resolved_by: user?.id,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- EMPLOYEE APPRAISALS ----
  async listAppraisals(employeeId) {
    let query = supabase.from('employee_appraisals').select('*').order('created_at', { ascending: false })
    if (employeeId) query = query.eq('employee_id', employeeId)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async listAllAppraisals(limit = 100) {
    const { data, error } = await supabase
      .from('employee_appraisals')
      .select('*, employees(full_name, department, position)')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  async createAppraisal(payload) {
    const { data, error } = await supabase
      .from('employee_appraisals')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateAppraisal(id, payload) {
    const { data, error } = await supabase
      .from('employee_appraisals')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- EMPLOYEE DIGITAL FILE ----
  async getDigitalFile(employeeId) {
    const { data, error } = await supabase
      .from('employee_digital_files')
      .select('*')
      .eq('employee_id', employeeId)
      .single()
    if (error && error.code !== 'PGRST116') throw error
    return data
  },

  async upsertDigitalFile(payload) {
    const { data, error } = await supabase
      .from('employee_digital_files')
      .upsert(payload)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- HR METRICS ----
  async getHRMetrics() {
    const { data, error } = await supabase.from('hr_metrics_view').select('*').single()
    if (error && error.code !== 'PGRST116') throw error
    return data
  },

  // ---- GEOFENCE CLOCK-IN FLOW ----
  async clockInWithGeofence({ employeeId, lat, lng, geofences, config }) {
    // If geofencing is enabled, verify location
    if (config?.geofence_enabled && geofences && geofences.length > 0) {
      const result = this.verifyLocation(lat, lng, geofences)
      if (!result.inside) {
        return {
          success: false,
          blocked: true,
          message: "You're outside the authorized attendance area.",
          nearest: result.nearest,
          distance: result.distance,
        }
      }
    }

    // Proceed with clock-in
    const { data, error } = await supabase
      .from('attendance_records')
      .insert({
        employee_id: employeeId,
        attendance_date: new Date().toISOString().slice(0, 10),
        source: 'web',
        source_detail: 'WEB',
        location_lat: lat,
        location_lng: lng,
        verification_method: config?.geofence_enabled ? 'GPS' : 'NONE',
        location_status: config?.geofence_enabled ? 'inside' : 'unknown',
        geofence_id: geofences?.find((g) => {
          const dist = haversine(lat, lng, g.latitude, g.longitude)
          return dist <= g.radius_meters
        })?.id || null,
      })
      .select()
      .single()
    if (error) throw error

    // Create central event
    await supabase.from('attendance_events').insert({
      employee_id: employeeId,
      attendance_record_id: data.id,
      event_type: 'CLOCK_IN',
      source: 'WEB',
      latitude: lat,
      longitude: lng,
      geofence_id: data.geofence_id,
      verification_method: config?.geofence_enabled ? 'GPS' : 'NONE',
      verification_status: config?.geofence_enabled ? 'verified' : 'pending',
      location_status: config?.geofence_enabled ? 'inside' : 'unknown',
      ip_address: null,
      user_agent: navigator.userAgent,
    })

    logAction({ action: 'ATTENDANCE_CLOCK_IN', entityType: 'AttendanceRecord', entityId: data.id, details: `Clock in by ${employeeId}` })
    return { success: true, data }
  },

  // ---- GPS helpers ----
  getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported by this browser.'))
        return
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      )
    })
  },
}

export default attendanceEngineService
