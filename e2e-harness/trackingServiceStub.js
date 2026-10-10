// Stub for the tracking service. It returns the REAL rows that
// employee_live_positions_v4 produced from the production database, so the
// component under test renders against real data. Only the network layer is
// replaced; every chip, badge, distance and ordering is produced by the
// shipped component itself.
const liveRows = () => (window.__LIVE_ROWS__ || [])

export const trackingService = {
  async livePositionsRecent() { return liveRows() },
  async livePositions() { return liveRows() },
  async history() { return { points: [], point_count: 0 } },
  async geofences() { return { geofences: [] } },
  async myAccess() { return { can_view: true, can_manage: true, via: 'super_admin' } },
  async listGrants() { return { grants: [] } },
  async revoke() { return {} },
  async grant() { return {} },
  async pruneHistory() { return {} },
  async saveResolvedPlace() { return true },
  subscribeLive() { return { channel: {}, unsubscribe() {} } },
}

export const normalizeLiveRow = (i) => i
export const sortByRecordedAt = (p = []) => p
export const describeFreshness = () => ''
export const formatCoord = (v) => (v == null ? '—' : Number(v).toFixed(6))
export const formatDistance = (m) => (m == null ? '—' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`)
export const isLowAccuracy = (p) => !!p && p.boundary_ambiguous === true
export const describeGeofenceStatus = () => ({ tone: 'muted', text: '', detail: null })
export const formatClockTime = () => '—'
export const outsidePoints = () => []
export const buildMovementTimeline = () => []
export const insertTimelineGaps = (t = []) => t
export const isUploadedLate = () => false
