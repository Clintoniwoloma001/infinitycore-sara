import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

export const geofenceService = {
  async list() {
    const { data, error } = await supabase
      .from('branches')
      .select('id, branch_name, branch_code, status, latitude, longitude, geofence_radius, geofence_active, work_start_time, work_end_time, grace_period_minutes, working_days, location')
      .order('branch_name')
    if (error) throw error
    return data || []
  },

  async update(branchId, updates) {
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
   * Test whether a coordinate falls inside a branch's geofence.
   * Pure client-side calculation (for preview/testing only — the server
   * does the authoritative check in clock_in_secure).
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
 * Haversine distance in metres.
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
