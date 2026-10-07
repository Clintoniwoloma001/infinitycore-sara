// ------------------------------------------------------------------
// Geofence service — the /geofences administration surface.
//
// Two things live here on purpose:
//   1. PURE helpers — radius unit formatting/parsing, RPC response
//      parsing, SQLSTATE -> friendly message mapping and the
//      lock-circle state machine. They are exported so
//      `tests/geofenceService.test.mjs` can import them with plain node:
//      no DOM, no React, no bundler.
//   2. The RPC wrappers around the migrated geofence functions.
//
// The Supabase client is therefore loaded LAZILY. A static
// `import { supabase } from '../supabaseClient'` executes
// `import.meta.env` at module scope, which only exists inside Vite, and
// would crash the node test before its first assertion.
//
// Server contract (20261102000001_geofence_management_rbac.sql):
//   * every management RPC runs require_geofence_admin() first —
//     SQLSTATE 42501 (HTTP 403) for anyone else;
//   * radius must be 10–5000 m — SQLSTATE 22023;
//   * "no fence configured" — SQLSTATE P0002;
//   * check_is_within_geofence() is readable by ANY authenticated user
//     and its distance_meters (public.geo_distance) is the authority —
//     the client never recomputes a distance.
// ------------------------------------------------------------------

export const RADIUS_MIN_METERS = 10
export const RADIUS_MAX_METERS = 5000
export const DEFAULT_RADIUS_METERS = 150

// ================================================================
// Radius — stored in METRES, displayed in m or km
// ================================================================

export function isRadiusInRange(value) {
  const m = Number(value)
  return Number.isFinite(m) && m >= RADIUS_MIN_METERS && m <= RADIUS_MAX_METERS
}

function trimKm(km) {
  return String(Number(Number(km).toFixed(2)))
}

/** '450 m' | '1.5 km' — unit chosen automatically from the magnitude. */
export function formatRadius(meters) {
  const m = Number(meters)
  if (!Number.isFinite(m) || m <= 0) return '—'
  if (m < 1000) return `${Math.round(m)} m`
  return `${trimKm(m / 1000)} km`
}

/** '1200 m' | '1.2 km' — unit forced by the caller's select. */
export function formatRadiusIn(meters, unit = 'm') {
  const m = Number(meters)
  if (!Number.isFinite(m) || m <= 0) return '—'
  return unit === 'km' ? `${trimKm(m / 1000)} km` : `${Math.round(m)} m`
}

/** Metres -> the number the slider/inputs show in the chosen unit. */
export function radiusForUnit(meters, unit = 'm') {
  const m = Number(meters)
  if (!Number.isFinite(m)) return null
  return unit === 'km' ? Number((m / 1000).toFixed(3)) : Math.round(m)
}

/** The chosen unit -> whole metres. */
export function radiusFromUnit(value, unit = 'm') {
  const v = Number(value)
  if (!Number.isFinite(v)) return null
  return Math.round(unit === 'km' ? v * 1000 : v)
}

/**
 * Parse a radius entered/shown in `unit` into whole metres.
 * Returns { meters, error } — error is null when the value is usable.
 */
export function parseRadius(value, unit = 'm') {
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '' || raw == null) {
    return { meters: null, error: 'Radius is required.' }
  }
  const metres = radiusFromUnit(raw, unit)
  if (metres == null) {
    return { meters: null, error: 'Radius must be a number.' }
  }
  if (metres < RADIUS_MIN_METERS || metres > RADIUS_MAX_METERS) {
    return {
      meters: null,
      error: `Radius must be between ${RADIUS_MIN_METERS} and ${RADIUS_MAX_METERS} metres.`,
    }
  }
  return { meters: metres, error: null }
}

// ================================================================
// Response parsing — one shape in, one shape out, whatever the
// deployed branch_geofences table looks like (the migration keeps the
// legacy center_lat/center_lng/active columns as mirrors).
// ================================================================

function toFiniteNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** list_branch_geofences / save_branch_geofence / … -> normalised rows. */
export function parseGeofenceList(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.geofences
  if (!Array.isArray(rows)) return []

  return rows
    .filter((row) => row && row.branch_id)
    .map((row) => ({
      id: row.id ?? null,
      branchId: row.branch_id,
      branchName: row.branch_name || 'Unnamed branch',
      branchCode: row.branch_code || '',
      latitude: toFiniteNumber(row.latitude ?? row.center_lat),
      longitude: toFiniteNumber(row.longitude ?? row.center_lng),
      radiusMeters: toFiniteNumber(row.radius_meters),
      isActive: row.is_active != null
        ? Boolean(row.is_active)
        : Boolean(row.active ?? true),
      assignedEmployees: toFiniteNumber(row.assigned_employees) ?? 0,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    }))
}

/** check_is_within_geofence -> a verdict the UI can render directly. */
export function parseCoverageResult(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  return {
    ok: p.ok === true,
    serverError: p.error || null,
    hasGeofence: p.has_geofence === true,
    within: p.within === true,
    // ALWAYS the server's number (public.geo_distance). Never recompute.
    distanceMeters: toFiniteNumber(p.distance_meters),
    radiusMeters: toFiniteNumber(p.radius_meters),
    metersOutside: toFiniteNumber(p.meters_outside),
    source: p.source || null,
    branchId: p.branch_id || null,
    reason: p.reason || null,
  }
}

/** Friendly text for a parsed verdict that came back with serverError. */
export function coverageErrorMessage(result) {
  if (result?.serverError === 'INVALID_COORDINATES') {
    return 'Enter a valid latitude and longitude.'
  }
  if (result?.serverError === 'INVALID_BRANCH') {
    return 'Choose a branch to test against.'
  }
  return 'The coverage check could not be completed. Please try again.'
}

// ================================================================
// Errors — SQLSTATE -> the words a person understands
// ================================================================

export function geofenceErrorMessage(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '')

  if (code === '42501' || message.includes('GEOFENCE_FORBIDDEN')) {
    return 'Only Super Admin / Head of HR can manage geofences'
  }
  if (code === '22023' || message.includes('GEOFENCE_INVALID')) {
    if (message.includes('GEOFENCE_INVALID_RADIUS')) {
      return `Radius must be between ${RADIUS_MIN_METERS} and ${RADIUS_MAX_METERS} metres.`
    }
    const detail = message
      .replace(/^\s*GEOFENCE_INVALID(?:_RADIUS)?:\s*/i, '')
      .replace(/[.\s]+$/, '')
    return detail || 'The geofence values are not valid.'
  }
  if (code === 'P0002' || message.includes('GEOFENCE_NOT_FOUND') || message.includes('GEOFENCE_BRANCH_NOT_FOUND')) {
    return 'No fence configured'
  }
  return message || 'The geofence request failed. Please try again.'
}

// ================================================================
// The lock-circle state machine
//
//   locked   -> the circle is ANCHORED to the pin: moving the pin moves
//               the circle with it, and a circle drag is ignored.
//   unlocked -> the circle keeps its own centre: it can be dragged
//               independently of the pin (pin = test/user location,
//               circle = fence being placed).
//
// Toggling the lock never moves the pin. Locking snaps the circle back
// onto the pin; unlocking releases the circle where it already is.
// ================================================================

function toCentre(value) {
  const lat = value?.lat
  const lng = value?.lng
  // Number(null) is 0 and Number('') is 0 — both must be refused before
  // coercion, or the null island becomes a "valid" fence centre.
  if (lat == null || lng == null || lat === '' || lng === '') return null
  const nLat = Number(lat)
  const nLng = Number(lng)
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null
  return { lat: nLat, lng: nLng }
}

export function createFenceGeometry({ lat, lng, radiusMeters = DEFAULT_RADIUS_METERS, locked = true } = {}) {
  const pin = toCentre({ lat, lng })
  if (!pin) throw new Error('createFenceGeometry requires a finite lat/lng centre.')
  const radius = Number(radiusMeters)
  return {
    locked: locked !== false,
    pin: { ...pin },
    circle: { ...pin },
    radiusMeters: Number.isFinite(radius) ? radius : DEFAULT_RADIUS_METERS,
  }
}

export function fenceGeometryReducer(state, action) {
  switch (action.type) {
    case 'pin-move': {
      const pin = toCentre(action.center)
      if (!pin) return state
      // Locked: the circle is anchored to the pin and follows it.
      return { ...state, pin, circle: state.locked ? { ...pin } : state.circle }
    }
    case 'circle-move': {
      if (state.locked) return state // the pin owns the circle while locked
      const circle = toCentre(action.center)
      if (!circle) return state
      return { ...state, circle }
    }
    case 'toggle-lock': {
      const locked = !state.locked
      // Locking snaps the circle back onto the pin; unlocking leaves it put.
      return { ...state, locked, circle: locked ? { ...state.pin } : { ...state.circle } }
    }
    case 'radius-set': {
      const radius = Number(action.meters)
      if (!Number.isFinite(radius)) return state
      return { ...state, radiusMeters: radius }
    }
    default:
      return state
  }
}

/** The centre the circle must render at for the current lock state. */
export function fenceCircleCentre(state) {
  if (!state) return null
  return state.locked ? state.pin : (state.circle || state.pin)
}

// ================================================================
// Supabase access (lazy — see the header note)
// ================================================================

let depsPromise = null
function loadClient() {
  if (!depsPromise) {
    depsPromise = Promise.all([
      import('../supabaseClient'),
      import('./supabaseService'),
    ]).then(([client, audit]) => ({
      supabase: client.supabase,
      logAction: audit.logAction,
    }))
  }
  return depsPromise
}

async function rpc(name, args = {}) {
  const { supabase } = await loadClient()
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  return data
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ================================================================

export const geofenceService = {
  // ------------------------------------------------------------
  // /geofences administration (Super Admin / Head of HR server-side)
  // ------------------------------------------------------------

  /** All branch fences, ordered by branch name. Throws on 42501 etc. */
  async listBranchGeofences() {
    const data = await rpc('list_branch_geofences')
    return parseGeofenceList(data)
  },

  /**
   * Branches that do NOT have a canonical fence yet — the candidate list
   * for "Add fence". Same select list the attendance engine reads.
   */
  async listBranchesWithoutFence(fences = []) {
    const { supabase } = await loadClient()
    const { data, error } = await supabase
      .from('branches')
      .select('id, branch_name, branch_code, latitude, longitude, geofence_radius, geofence_active')
      .order('branch_name')
    if (error) throw error

    const fenced = new Set((fences || []).map((f) => f.branchId).filter(Boolean))
    return (data || []).filter((branch) => !fenced.has(branch.id))
  },

  /**
   * Create or correct the fence for one branch. Returns the refreshed
   * list plus { savedId, branchId }.
   */
  async saveBranchGeofence({ branchId, latitude, longitude, radiusMeters, isActive = true }) {
    if (!branchId) throw codedError('22023', 'GEOFENCE_INVALID: branch_id is required.')

    const lat = Number(latitude)
    const lng = Number(longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw codedError('22023', 'GEOFENCE_INVALID: valid latitude and longitude are required.')
    }
    const radius = parseRadius(radiusMeters, 'm')
    if (radius.error) {
      throw codedError('22023', `GEOFENCE_INVALID_RADIUS: ${radius.error}`)
    }

    const data = await rpc('save_branch_geofence', {
      p_branch_id: branchId,
      p_latitude: lat,
      p_longitude: lng,
      p_radius_meters: radius.meters,
      p_is_active: Boolean(isActive),
    })
    return {
      fences: parseGeofenceList(data),
      savedId: data?.saved_id ?? null,
      branchId: data?.branch_id ?? branchId,
    }
  },

  /** Enable/disable a fence. The argument is the BRANCH id. */
  async setBranchGeofenceActive(branchId, isActive) {
    if (!branchId) throw codedError('22023', 'GEOFENCE_INVALID: branch_id is required.')
    const data = await rpc('set_branch_geofence_active', {
      p_branch_id: branchId,
      p_is_active: Boolean(isActive),
    })
    return {
      fences: parseGeofenceList(data),
      branchId: data?.branch_id ?? branchId,
      isActive: data?.is_active ?? Boolean(isActive),
    }
  },

  /**
   * Delete the canonical fence for a branch. The legacy branches /
   * attendance_geofences copies are DISABLED by the server, never erased.
   */
  async deleteBranchGeofence(branchId) {
    if (!branchId) throw codedError('22023', 'GEOFENCE_INVALID: branch_id is required.')
    const data = await rpc('delete_branch_geofence', { p_branch_id: branchId })
    return {
      fences: parseGeofenceList(data),
      branchId: data?.branch_id ?? branchId,
      deleted: data?.deleted ?? 0,
    }
  },

  /**
   * "Test My Coverage". Readable by ANY authenticated user. The distance
   * in the result is the server's geo_distance haversine — the authority.
   */
  async checkWithinGeofence({ lat, lng, branchId }) {
    const data = await rpc('check_is_within_geofence', {
      p_lat: Number(lat),
      p_lng: Number(lng),
      p_branch_id: branchId || null,
    })
    return parseCoverageResult(data)
  },

  // ------------------------------------------------------------
  // LEGACY — Platform Settings → Geofence tab still drives the raw
  // branches columns through this service (it is a page this module does
  // not own). Do not remove: list()/update()/testGeofence() are load-
  // bearing for src/pages/PlatformSettings.jsx and
  // src/components/attendance/GeofenceEditor.jsx.
  // ------------------------------------------------------------

  async list() {
    const { supabase } = await loadClient()
    const { data, error } = await supabase
      .from('branches')
      .select('id, branch_name, branch_code, status, latitude, longitude, geofence_radius, geofence_active, work_start_time, work_end_time, grace_period_minutes, working_days, location')
      .order('branch_name')
    if (error) throw error
    return data || []
  },

  async update(branchId, updates) {
    const { supabase, logAction } = await loadClient()
    const { data, error } = await supabase
      .from('branches')
      .update(updates)
      .eq('id', branchId)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'GEOFENCE_UPDATED', entityType: 'Branch', entityId: branchId, details: `Geofence config updated for ${data.branch_name}` })
    return data
  },

  /**
   * Client-side preview only. The authoritative verdict comes from
   * check_is_within_geofence / clock_in_secure on the server.
   */
  testGeofence(lat, lng, branch) {
    if (!branch?.latitude || !branch?.longitude) {
      return { inside: null, distance: null, message: 'Branch has no coordinates configured.' }
    }
    const distance = haversine(lat, lng, branch.latitude, branch.longitude)
    const radius = branch.geofence_radius || 150
    const inside = distance <= radius
    return {
      inside,
      distance: Math.round(distance),
      radius,
      message: inside
        ? `Inside geofence (${Math.round(distance)}m from center, radius ${radius}m)`
        : `Outside geofence (${Math.round(distance)}m from center, permitted radius ${radius}m)`,
    }
  },
}

/**
 * Haversine distance in metres (legacy preview helper).
 */
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

export default geofenceService
