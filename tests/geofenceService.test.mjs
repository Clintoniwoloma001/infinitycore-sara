import assert from 'node:assert/strict'
import {
  RADIUS_MIN_METERS,
  RADIUS_MAX_METERS,
  formatRadius,
  formatRadiusIn,
  radiusForUnit,
  radiusFromUnit,
  parseRadius,
  parseGeofenceList,
  parseCoverageResult,
  coverageErrorMessage,
  geofenceErrorMessage,
  createFenceGeometry,
  fenceGeometryReducer,
  fenceCircleCentre,
} from '../src/services/geofenceService.js'

// ---------------------------------------------------------------------------
// Geofence service — the pure half of the /geofences module.
//
// Everything imported above is DOM-free, React-free and Supabase-free on
// purpose: the module keeps its client import lazy so these assertions can
// run under plain `node`, exactly like tests/accessControlPrecedence.test.mjs
// runs the access-control engine.
//
// Covered: radius unit formatting/parsing (m <-> km, 10–5000 bounds),
// response parsing for list_branch_geofences / check_is_within_geofence,
// SQLSTATE -> friendly message mapping, and the lock-circle state machine
// that decides which centre the fence circle uses.
// ---------------------------------------------------------------------------

let n = 0
const check = (name, fn) => {
  n += 1
  fn()
  console.log(`  ${n}. PASS  ${name}`)
}

// ---------------------------------------------------------------------------
console.log('--- radius: metres are stored, units are display only ---')
// ---------------------------------------------------------------------------

check('metres format below 1 km, kilometres above it', () => {
  assert.equal(RADIUS_MIN_METERS, 10)
  assert.equal(RADIUS_MAX_METERS, 5000)
  assert.equal(formatRadius(450), '450 m')
  assert.equal(formatRadius(10), '10 m')
  assert.equal(formatRadius(1500), '1.5 km')
  assert.equal(formatRadius(1200), '1.2 km')
  assert.equal(formatRadius(5000), '5 km')
  assert.equal(formatRadius(null), '—')
})

check('formatRadiusIn swaps the displayed unit without touching the value', () => {
  assert.equal(formatRadiusIn(1200, 'km'), '1.2 km')
  assert.equal(formatRadiusIn(1200, 'm'), '1200 m')
  assert.equal(formatRadiusIn(450, 'm'), '450 m')
  assert.equal(formatRadiusIn(450, 'km'), '0.45 km')
})

check('radiusForUnit / radiusFromUnit round-trip both units', () => {
  assert.equal(radiusForUnit(1200, 'km'), 1.2)
  assert.equal(radiusForUnit(1200, 'm'), 1200)
  assert.equal(radiusFromUnit(1.2, 'km'), 1200)
  assert.equal(radiusFromUnit('1.5', 'km'), 1500)
  assert.equal(radiusFromUnit('450', 'm'), 450)
  assert.equal(radiusFromUnit(0.15, 'km'), 150)
  // float noise must never leak into the stored metres
  assert.equal(radiusFromUnit(1.15, 'km'), 1150)
  assert.equal(radiusFromUnit('nonsense', 'm'), null)
})

check('parseRadius accepts the 10–5000 boundary in metres', () => {
  assert.deepEqual(parseRadius(10, 'm'), { meters: 10, error: null })
  assert.deepEqual(parseRadius(5000, 'm'), { meters: 5000, error: null })
  assert.deepEqual(parseRadius('450', 'm'), { meters: 450, error: null })
})

check('parseRadius accepts the same bounds in kilometres', () => {
  assert.deepEqual(parseRadius(0.01, 'km'), { meters: 10, error: null })
  assert.deepEqual(parseRadius(5, 'km'), { meters: 5000, error: null })
  assert.deepEqual(parseRadius('1.2', 'km'), { meters: 1200, error: null })
})

check('parseRadius refuses anything outside 10–5000 m', () => {
  for (const [value, unit] of [[9, 'm'], [5001, 'm'], [0, 'm'], [0.009, 'km'], [5.01, 'km'], [-100, 'm']]) {
    const result = parseRadius(value, unit)
    assert.equal(result.meters, null, `${value} ${unit} must not parse`)
    assert.match(result.error, /between 10 and 5000 metres/)
  }
})

check('parseRadius refuses empty and non-numeric input', () => {
  assert.match(parseRadius('', 'm').error, /required/)
  assert.match(parseRadius('   ', 'm').error, /required/)
  assert.match(parseRadius('wide', 'm').error, /must be a number/)
})

// ---------------------------------------------------------------------------
console.log('--- list_branch_geofences response parsing ---')
// ---------------------------------------------------------------------------

const canonicalList = {
  ok: true,
  geofences: [
    {
      id: 'f1',
      branch_id: 'b1',
      branch_name: 'Lagos Island',
      branch_code: 'LI-01',
      latitude: 6.451234,
      longitude: 3.391234,
      radius_meters: 450,
      is_active: true,
      active: true,
      center_lat: 6.451234,
      center_lng: 3.391234,
      created_at: '2026-10-01T09:00:00Z',
      updated_at: '2026-10-02T09:00:00Z',
      assigned_employees: 12,
    },
    {
      id: 'f2',
      branch_id: 'b2',
      branch_name: 'Abuja Central',
      branch_code: 'AC-02',
      latitude: 9.066666,
      longitude: 7.483333,
      radius_meters: 1.5,
      is_active: false,
      active: false,
      assigned_employees: 0,
    },
  ],
}

check('normalises the canonical rows the RPC returns', () => {
  const fences = parseGeofenceList(canonicalList)
  assert.equal(fences.length, 2)

  const first = fences[0]
  assert.equal(first.branchId, 'b1')
  assert.equal(first.branchName, 'Lagos Island')
  assert.equal(first.branchCode, 'LI-01')
  assert.equal(first.latitude, 6.451234)
  assert.equal(first.longitude, 3.391234)
  assert.equal(first.radiusMeters, 450)
  assert.equal(first.isActive, true)
  assert.equal(first.assignedEmployees, 12)

  assert.equal(fences[1].isActive, false)
  assert.equal(fences[1].assignedEmployees, 0)
})

check('tolerates the legacy centre columns and the mirrored active flag', () => {
  const legacy = parseGeofenceList({
    ok: true,
    geofences: [{
      id: 'f3',
      branch_id: 'b3',
      branch_name: 'Ibadan North',
      branch_code: null,
      center_lat: 7.3775,
      center_lng: 3.947,
      radius_meters: '300',
      active: true,
      assigned_employees: '7',
    }],
  })
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].latitude, 7.3775)
  assert.equal(legacy[0].longitude, 3.947)
  assert.equal(legacy[0].radiusMeters, 300)
  assert.equal(legacy[0].isActive, true)
  assert.equal(legacy[0].branchCode, '')
  assert.equal(legacy[0].branchName, 'Ibadan North')
  assert.equal(legacy[0].assignedEmployees, 7)
})

check('an absent or malformed payload yields an empty list, not a crash', () => {
  assert.deepEqual(parseGeofenceList(null), [])
  assert.deepEqual(parseGeofenceList(undefined), [])
  assert.deepEqual(parseGeofenceList('nope'), [])
  assert.deepEqual(parseGeofenceList({ ok: true }), [])
  assert.deepEqual(parseGeofenceList({ ok: true, geofences: 'nope' }), [])
  assert.deepEqual(parseGeofenceList({ ok: true, geofences: [{ id: 'no-branch' }] }), [])
  // a bare array (older callers) is accepted too
  assert.equal(parseGeofenceList(canonicalList.geofences).length, 2)
})

check('the mutation RPCs answer with the same list shape', () => {
  const saved = parseGeofenceList({
    ok: true,
    saved_id: 'f9',
    branch_id: 'b9',
    geofences: canonicalList.geofences,
  })
  assert.equal(saved.length, 2)
  assert.equal(saved[0].branchId, 'b1')
})

// ---------------------------------------------------------------------------
console.log('--- check_is_within_geofence response parsing ---')
// ---------------------------------------------------------------------------

check('parses a verdict that lands inside', () => {
  const verdict = parseCoverageResult({
    ok: true,
    within: true,
    distance_meters: 120.4,
    radius_meters: 450,
    branch_id: 'b1',
    has_geofence: true,
    source: 'branch_geofences',
    meters_outside: 0,
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.within, true)
  assert.equal(verdict.hasGeofence, true)
  assert.equal(verdict.distanceMeters, 120.4)
  assert.equal(verdict.radiusMeters, 450)
  assert.equal(verdict.metersOutside, 0)
  assert.equal(verdict.source, 'branch_geofences')
  assert.equal(verdict.serverError, null)
})

check('parses a verdict that lands outside, with metres still to go', () => {
  const verdict = parseCoverageResult({
    ok: true,
    within: false,
    distance_meters: 980.5,
    radius_meters: 450,
    branch_id: 'b1',
    has_geofence: true,
    source: 'branches',
    meters_outside: 530.5,
  })
  assert.equal(verdict.within, false)
  assert.equal(verdict.hasGeofence, true)
  assert.equal(verdict.distanceMeters, 980.5)
  assert.equal(verdict.metersOutside, 530.5)
})

check('has_geofence:false keeps the reason and no distances', () => {
  const verdict = parseCoverageResult({
    ok: true,
    within: false,
    distance_meters: null,
    radius_meters: null,
    branch_id: 'b4',
    has_geofence: false,
    reason: 'No active geofence is configured for this branch.',
  })
  assert.equal(verdict.hasGeofence, false)
  assert.equal(verdict.within, false)
  assert.equal(verdict.distanceMeters, null)
  assert.equal(verdict.radiusMeters, null)
  assert.equal(verdict.metersOutside, null)
  assert.match(verdict.reason, /No active geofence/)
  // No serverError: the UI shows the grey "no fence" badge with `reason`,
  // it does not render this as a failed check.
  assert.equal(verdict.serverError, null)
})

check('server-side input refusals surface as friendly text', () => {
  const badCoords = parseCoverageResult({ ok: false, within: false, error: 'INVALID_COORDINATES' })
  assert.equal(badCoords.serverError, 'INVALID_COORDINATES')
  assert.equal(coverageErrorMessage(badCoords), 'Enter a valid latitude and longitude.')

  const badBranch = parseCoverageResult({ ok: false, within: false, error: 'INVALID_BRANCH' })
  assert.equal(coverageErrorMessage(badBranch), 'Choose a branch to test against.')
})

check('a missing payload never reports "inside"', () => {
  const verdict = parseCoverageResult(null)
  assert.equal(verdict.within, false)
  assert.equal(verdict.hasGeofence, false)
  assert.equal(verdict.distanceMeters, null)
})

// ---------------------------------------------------------------------------
console.log('--- SQLSTATE -> friendly message ---')
// ---------------------------------------------------------------------------

check('42501 maps to the role message', () => {
  const message = geofenceErrorMessage({
    code: '42501',
    message: 'GEOFENCE_FORBIDDEN: Geofence settings and management are restricted to Super Admin and Head of Human Resources.',
  })
  assert.equal(message, 'Only Super Admin / Head of HR can manage geofences')
})

check('P0002 maps to "No fence configured"', () => {
  assert.equal(
    geofenceErrorMessage({ code: 'P0002', message: 'GEOFENCE_NOT_FOUND: no geofence is configured for that branch.' }),
    'No fence configured',
  )
  assert.equal(
    geofenceErrorMessage({ code: 'P0002', message: 'GEOFENCE_BRANCH_NOT_FOUND: no branch with that id.' }),
    'No fence configured',
  )
})

check('22023 maps radius failures to the 10–5000 rule', () => {
  assert.equal(
    geofenceErrorMessage({ code: '22023', message: 'GEOFENCE_INVALID_RADIUS: radius must be between 10 and 5000 meters.' }),
    'Radius must be between 10 and 5000 metres.',
  )
})

check('22023 maps other invalid values to the server detail', () => {
  const message = geofenceErrorMessage({
    code: '22023',
    message: 'GEOFENCE_INVALID: valid latitude and longitude are required.',
  })
  assert.match(message, /latitude and longitude are required/)
  assert.ok(!message.includes('GEOFENCE_INVALID'), 'the raw prefix is stripped')
})

check('an unmapped error keeps its message, with a sane fallback', () => {
  assert.equal(geofenceErrorMessage({ code: 'XX000', message: 'network unreachable' }), 'network unreachable')
  assert.equal(geofenceErrorMessage(null), 'The geofence request failed. Please try again.')
  // a client-side pre-check throws with the same codes the server uses
  assert.equal(geofenceErrorMessage({ code: '42501', message: 'anything' }), 'Only Super Admin / Head of HR can manage geofences')
})

// ---------------------------------------------------------------------------
console.log('--- lock-circle state machine ---')
// ---------------------------------------------------------------------------

const start = createFenceGeometry({ lat: 6.52, lng: 3.37, radiusMeters: 450 })
const moved = (state, lat, lng) => fenceGeometryReducer(state, { type: 'pin-move', center: { lat, lng } })

check('a fresh geometry starts locked with the circle on the pin', () => {
  assert.equal(start.locked, true)
  assert.deepEqual(start.pin, { lat: 6.52, lng: 3.37 })
  assert.deepEqual(start.circle, { lat: 6.52, lng: 3.37 })
  assert.equal(start.radiusMeters, 450)
  assert.deepEqual(fenceCircleCentre(start), start.pin)
})

check('locked: moving the pin drags the circle with it', () => {
  const state = moved(start, 6.6, 3.5)
  assert.deepEqual(state.pin, { lat: 6.6, lng: 3.5 })
  assert.deepEqual(state.circle, { lat: 6.6, lng: 3.5 })
  assert.deepEqual(fenceCircleCentre(state), state.pin)
})

check('locked: a circle drag is refused', () => {
  const state = fenceGeometryReducer(start, { type: 'circle-move', center: { lat: 1.1, lng: 2.2 } })
  assert.deepEqual(state, start, 'nothing may move the circle while it is locked')
})

check('unlocking releases the circle where it is', () => {
  const unlocked = fenceGeometryReducer(start, { type: 'toggle-lock' })
  assert.equal(unlocked.locked, false)
  assert.deepEqual(unlocked.circle, start.circle)
  assert.deepEqual(fenceCircleCentre(unlocked), unlocked.circle)
})

check('unlocked: the pin and the circle move independently', () => {
  const unlocked = fenceGeometryReducer(start, { type: 'toggle-lock' })
  const pinMoved = moved(unlocked, 6.9, 3.9)
  assert.deepEqual(pinMoved.pin, { lat: 6.9, lng: 3.9 }, 'the pin still moves')
  assert.deepEqual(pinMoved.circle, start.circle, 'but the circle stays put')
  assert.deepEqual(fenceCircleCentre(pinMoved), start.circle, 'the circle renders from ITS centre now')

  const circleMoved = fenceGeometryReducer(pinMoved, { type: 'circle-move', center: { lat: 6.1, lng: 3.1 } })
  assert.deepEqual(circleMoved.pin, { lat: 6.9, lng: 3.9 })
  assert.deepEqual(circleMoved.circle, { lat: 6.1, lng: 3.1 })
  assert.deepEqual(fenceCircleCentre(circleMoved), { lat: 6.1, lng: 3.1 })
})

check('re-locking snaps the circle back onto the pin', () => {
  const state = fenceGeometryReducer(
    fenceGeometryReducer(
      fenceGeometryReducer(start, { type: 'toggle-lock' }),
      { type: 'pin-move', center: { lat: 6.9, lng: 3.9 } },
    ),
    { type: 'circle-move', center: { lat: 1.1, lng: 1.1 } },
  )
  const relocked = fenceGeometryReducer(state, { type: 'toggle-lock' })
  assert.equal(relocked.locked, true)
  assert.deepEqual(relocked.pin, { lat: 6.9, lng: 3.9 })
  assert.deepEqual(relocked.circle, { lat: 6.9, lng: 3.9 })
  assert.deepEqual(fenceCircleCentre(relocked), relocked.pin)
})

check('the radius action replaces metres and ignores junk', () => {
  const wider = fenceGeometryReducer(start, { type: 'radius-set', meters: 1200 })
  assert.equal(wider.radiusMeters, 1200)
  const junk = fenceGeometryReducer(wider, { type: 'radius-set', meters: 'nope' })
  assert.equal(junk.radiusMeters, 1200, 'a non-numeric radius never lands in state')
  const unlocked = fenceGeometryReducer(wider, { type: 'toggle-lock' })
  assert.equal(unlocked.radiusMeters, 1200, 'toggling the lock keeps the radius')
})

check('an unknown action is a no-op', () => {
  const state = fenceGeometryReducer(start, { type: 'not-a-real-action' })
  assert.deepEqual(state, start)
})

check('a centre with missing coordinates cannot enter the state machine', () => {
  assert.deepEqual(moved(start, 'abc', 3.4), start)
  assert.throws(() => createFenceGeometry({ lat: null, lng: null }), /finite lat\/lng/)
})

// ---------------------------------------------------------------------------
console.log('--- GPS must move the fence, not just the green dot ---')
// ---------------------------------------------------------------------------

// A GPS fix somewhere other than the branch. "Use my location" has to PLOT THE
// FENCE HERE, so the state machine (and with it fenceCircleCentre) must move
// to it in the default locked mode — which renders the circle from `pin`.
const GPS = { lat: 6.4558, lng: 3.6015 }

check('set-my-position snaps the fence circle onto the fix while locked', () => {
  const gps = fenceGeometryReducer(start, { type: 'set-my-position', center: GPS })
  assert.deepEqual(gps.myPosition, GPS)
  assert.deepEqual(gps.pin, GPS, 'while locked the pin owns the circle, so it must move with it')
  assert.deepEqual(fenceCircleCentre(gps), GPS, 'the fence must render around the operator')
})

check('set-my-position keeps the pin while unlocked (the circle snaps only)', () => {
  const unlocked = fenceGeometryReducer(start, { type: 'toggle-lock' })
  const gps = fenceGeometryReducer(unlocked, { type: 'set-my-position', center: GPS })
  assert.deepEqual(gps.myPosition, GPS)
  assert.deepEqual(gps.pin, start.pin, 'unlocked: the pin keeps marking the test location')
  assert.deepEqual(gps.circle, GPS)
  assert.deepEqual(fenceCircleCentre(gps), GPS)
})

check('a jammed/absent fix is refused, never coerced to null island', () => {
  const gps = fenceGeometryReducer(start, { type: 'set-my-position', center: { lat: null, lng: null } })
  assert.deepEqual(gps.myPosition, start.myPosition)
  assert.deepEqual(fenceCircleCentre(gps), start.pin)
})

check('clear-my-position removes the green marker and leaves the fence put', () => {
  const gps = fenceGeometryReducer(start, { type: 'set-my-position', center: GPS })
  const cleared = fenceGeometryReducer(gps, { type: 'clear-my-position' })
  assert.equal(cleared.myPosition, null)
  assert.equal(cleared.locating, false)
  assert.deepEqual(cleared.pin, GPS, 'the anchored fence does not move when GPS stops')
  assert.deepEqual(fenceCircleCentre(cleared), GPS)
})

check('a held fix from the Add-Fence dialog seeds through the same action', () => {
  // GeofenceMapEditor's reducer initialiser dishes the held fix through
  // set-my-position rather than rewriting centres by hand, so this path is
  // the one that produces the opening map of a newly added fence.
  const opened = fenceGeometryReducer(start, { type: 'set-my-position', center: GPS })
  assert.deepEqual(fenceCircleCentre(opened), GPS)
})

console.log(`\nAll ${n} checks passed.`)
