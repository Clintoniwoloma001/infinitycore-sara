import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { getPosition } from './attendanceService'
import { getDeviceFingerprint } from '../utils/deviceFingerprint'

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

function formatTimeHHMM(t) {
  if (!t) return ''
  const s = String(t).trim()
  return s.length >= 5 ? s.slice(0, 5) : s
}

function formatLateThreshold(startTimeStr, graceMins) {
  if (!startTimeStr || graceMins == null) return ''
  const parts = startTimeStr.split(':').map(Number)
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return ''
  const totalMins = parts[0] * 60 + parts[1] + (Number(graceMins) || 0) + 1
  const thH = Math.floor((totalMins / 60) % 24)
  const thM = totalMins % 60
  return `${String(thH).padStart(2, '0')}:${String(thM).padStart(2, '0')}`
}

export const attendanceEngineService = {
  // ---- GEOFENCES ----
  // Returns attendance geofences PLUS branch-based geofences (configured in
  // Platform Settings → Geofence / branches table). Branch geofences are
  // surfaced read-only so a location saved there appears in every
  // "configured attendance locations" list and in the Attendance Terminal.
  async listGeofences() {
    const geoRes = await supabase
      .from('attendance_geofences')
      .select('*')
      .order('created_at', { ascending: false })
    if (geoRes.error) throw geoRes.error

    let branchData = []
    try {
      const branchRes = await supabase
        .from('branches')
        .select('id, branch_name, branch_code, latitude, longitude, geofence_radius, geofence_active, location')
        .order('branch_name', { ascending: true })
      if (!branchRes.error) branchData = branchRes.data || []
    } catch {
      branchData = []
    }

    const attendanceGeofences = (geoRes.data || []).map((g) => ({ ...g, source: 'attendance' }))

    const branchGeofences = branchData
      .filter((b) => b.latitude != null && b.longitude != null)
      .map((b) => ({
        id: `branch-${b.id}`,
        name: b.branch_name,
        location_name: b.location || b.branch_name,
        latitude: b.latitude,
        longitude: b.longitude,
        radius_meters: b.geofence_radius || 150,
        active: b.geofence_active !== false,
        clock_in_allowed: true,
        clock_out_allowed: true,
        source: 'branch',
        branchId: b.id,
        created_at: null,
      }))

    return [...attendanceGeofences, ...branchGeofences]
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
      .select('id, device_name, device_type, manufacturer, model, serial_number, branch_id, location_id, api_endpoint, integration_type, status, last_seen_at, active, created_by, created_at, updated_at, attendance_geofences(name, location_name)')
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
      .select('*, employees(full_name, department, position, employee_number, staff_id, employee_code), attendance_devices(device_name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // Safely resolve an employee for the attendance terminal. Returns only
  // identity fields (name / number / department / position / status).
  async lookupAttendanceEmployee(identifier) {
    if (!identifier) return null
    const { data, error } = await supabase.rpc('lookup_employee_by_identifier', { p_identifier: identifier })
    if (error) throw error
    return data
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

  // Simulate a device clock-in event (for testing/terminal mode).
  // p_employeeId is optional; the RPC resolves by canonical employee number
  // when omitted, or uses the pre-verified employee when provided (WebAuthn).
  async simulateDeviceEvent({ deviceId, externalUserId, eventType, verificationMethod = 'FINGERPRINT', employeeId = null, metadata = {} }) {
    const { data: requirements, error: requirementsError } = await supabase.rpc('get_attendance_requirements')
    if (requirementsError) throw requirementsError

    // Location is mandatory for every attendance action. Platform Settings
    // controls whether being outside a geofence is allowed, not whether GPS
    // evidence may be omitted.
    const needsLocation = true
    let locationMetadata = { ...metadata }
    if (needsLocation) {
      const position = await getPosition()
      locationMetadata = {
        ...locationMetadata,
         latitude: position.lat,
         longitude: position.lng,
         accuracy: position.accuracy,
         captured_at: position.timestamp || Date.now(),
         location_source: 'browser_geolocation',
      }
    }

    const { data, error } = await supabase.rpc('ingest_attendance_event', {
      p_device_id: deviceId,
      p_external_user_id: externalUserId || '',
      p_event_type: eventType,
      p_verification_method: verificationMethod,
      p_employee_id: employeeId,
      p_metadata: locationMetadata,
    })
    if (error) throw error
    return data
  },

  // ---- ATTENDANCE CONFIG (extended & mirrored with Platform Settings) ----
  async getConfig() {
    let cfg = null
    let ps = null
    const [cfgRes, requirementsRes, platformRes] = await Promise.all([
      supabase.from('attendance_config').select('*').eq('id', 1).maybeSingle(),
      supabase.rpc('get_attendance_requirements'),
      supabase.from('hr_platform_settings').select('*').eq('id', 1).maybeSingle(),
    ])
    cfg = cfgRes?.data || null
    const platform = platformRes?.data || null
    const requirements = requirementsRes?.data || null
    ps = platform || (requirements ? {
      default_work_start_time: requirements.default_work_start_time,
      default_work_end_time: requirements.default_work_end_time,
      default_grace_period_minutes: requirements.default_grace_period_minutes,
      default_working_days: requirements.default_working_days,
      geofence_enabled: requirements.geofence_enabled,
      early_departure_threshold_minutes: requirements.early_departure_threshold_minutes,
    } : null)

    if (!cfg && !ps) return null

    const startTime = ps?.default_work_start_time
      ? formatTimeHHMM(ps.default_work_start_time)
      : (cfg?.expected_start_time ? formatTimeHHMM(cfg.expected_start_time) : null)
    const graceMins = ps?.default_grace_period_minutes ?? cfg?.grace_period_minutes ?? null

    return {
      ...(cfg || {}),
      expected_start_time: startTime,
      expected_end_time: ps?.default_work_end_time
        ? formatTimeHHMM(ps.default_work_end_time)
        : (cfg?.expected_end_time ? formatTimeHHMM(cfg.expected_end_time) : null),
      grace_period_minutes: graceMins,
      late_threshold_time: (cfg?.late_threshold_time ? formatTimeHHMM(cfg.late_threshold_time) : null) || (startTime && graceMins != null ? formatLateThreshold(startTime, graceMins) : null),
      working_days: ps?.default_working_days || cfg?.working_days || [],
      break_duration_minutes: ps?.default_break_duration_minutes ?? cfg?.break_duration_minutes ?? null,
      overtime_threshold_hours: ps?.overtime_threshold_minutes != null
        ? Number((Number(ps.overtime_threshold_minutes) / 60).toFixed(2))
        : (cfg?.overtime_threshold_hours ?? null),
      geofence_enabled: ps?.geofence_enabled ?? cfg?.geofence_enabled ?? false,
      early_departure_threshold_minutes: ps?.early_departure_threshold_minutes ?? cfg?.early_departure_threshold_minutes ?? null,
      break_allowed: cfg?.break_allowed !== false,
      manual_correction_requires_reason: cfg?.manual_correction_requires_reason !== false,
      allow_admin_override: cfg?.allow_admin_override !== false,
    }
  },

  async updateConfig(payload) {
    const platformUpdates = {}
    const configUpdates = {}
    const canonicalKeys = new Set(['expected_start_time', 'expected_end_time', 'grace_period_minutes', 'working_days'])

    if (payload.expected_start_time != null) platformUpdates.default_work_start_time = formatTimeHHMM(payload.expected_start_time)
    if (payload.expected_end_time != null) platformUpdates.default_work_end_time = formatTimeHHMM(payload.expected_end_time)
    if (payload.grace_period_minutes != null) {
      platformUpdates.default_grace_period_minutes = Number(payload.grace_period_minutes)
      platformUpdates.late_threshold_minutes = Number(payload.grace_period_minutes)
    }
    if (payload.working_days != null) {
      platformUpdates.default_working_days = (Array.isArray(payload.working_days) ? payload.working_days : [])
        .map((day) => String(day).toLowerCase().slice(0, 3))
    }
    if (payload.break_duration_minutes != null) platformUpdates.default_break_duration_minutes = Number(payload.break_duration_minutes)
    if (payload.overtime_threshold_hours != null) platformUpdates.overtime_threshold_minutes = Math.round(Number(payload.overtime_threshold_hours) * 60)
    if (payload.geofence_enabled != null) platformUpdates.geofence_enabled = Boolean(payload.geofence_enabled)
    if (payload.early_departure_threshold_minutes != null) platformUpdates.early_departure_threshold_minutes = Number(payload.early_departure_threshold_minutes)

    for (const [key, value] of Object.entries(payload || {})) {
      if (!canonicalKeys.has(key) && !['late_threshold_time', 'break_duration_minutes', 'overtime_threshold_hours', 'geofence_enabled', 'early_departure_threshold_minutes', 'updated_at'].includes(key)) {
        configUpdates[key] = value
      }
    }

    // Platform Settings owns all global timing/policy values. Its RPC and
    // database trigger update attendance_config atomically and audit both
    // surfaces using their existing schemas.
    if (Object.keys(platformUpdates).length > 0) {
      const { error } = await supabase.rpc('update_hr_settings', { p_settings: platformUpdates })
      if (error) throw error
    }

    if (Object.keys(configUpdates).length > 0) {
      const { data: { user } } = await supabase.auth.getUser()
      const updates = { ...configUpdates, updated_at: new Date().toISOString(), updated_by: user?.id || null }
      const { error: updateErr } = await supabase
        .from('attendance_config')
        .update(updates)
        .eq('id', 1)
      if (updateErr) throw updateErr
    }

    const { data, error } = await supabase.from('attendance_config').select('*').eq('id', 1).maybeSingle()
    if (error) throw error
    logAction({ action: 'ATTENDANCE_CONFIG_UPDATE', entityType: 'AttendanceConfig', entityId: 1, details: 'Attendance policy updated through Platform Settings source of truth' })
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
    // Keep this legacy entry point on the same server-authoritative path.
    // The RPC resolves the authenticated employee and ignores client time.
    const deviceFingerprint = await getDeviceFingerprint().catch(() => '')
    const { data, error } = await supabase.rpc('clock_in_secure', {
      p_lat: lat ?? null,
      p_lng: lng ?? null,
      p_accuracy: null,
      p_device_fingerprint: deviceFingerprint || null,
    })
    if (error) throw error
    logAction({ action: 'ATTENDANCE_CLOCK_IN', entityType: 'AttendanceRecord', entityId: data.attendance_id, details: `Clock in by ${employeeId || 'authenticated employee'}` })
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
