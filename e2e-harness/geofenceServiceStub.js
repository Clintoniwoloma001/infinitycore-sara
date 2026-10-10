// Stub for the geofence service: only the SUPABASE network calls are replaced.
// The lock/geometry state machine (fenceGeometryReducer, fenceCircleCentre,
// createFenceGeometry) and the geolocation helpers are the REAL ones, so what
// the browser actually exercises is the shipped logic.
export const MOCK_BRANCH = {
  branchId: 'b1',
  branchName: 'Head Office',
  branchCode: 'BR-06',
  latitude: 6.605754,
  longitude: 3.392573,
}

export const geofenceService = {
  async listBranchGeofences() { return [] },
  async list() { return [MOCK_BRANCH] },
  async listBranchesWithoutFence() { return [MOCK_BRANCH] },
  async saveBranchGeofence() { return { fences: [] } },
  async setBranchGeofenceActive() { return { fences: [] } },
  async deleteBranchGeofence() { return { fences: [] } },
  async checkWithinGeofence() { return { within: false, metersOutside: 0 } },
}

export const geofenceErrorMessage = () => ''
export const coverageErrorMessage = () => ''
