import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

// The service imports ./supabaseClient at module scope, which plain node cannot
// resolve (extensionless specifier plus browser deps). The pure helpers are
// therefore lifted out of the REAL source text and run in a sandbox, so these
// tests exercise the shipped implementation rather than a transcription of it.
const loadHelpers = () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const src = readFileSync(
    join(root, 'src/services/employeeTrackingService.js'),
    'utf8',
  )

  // Slice one `export function name(...)` out of the source, braces balanced.
  // Braces are counted only from the BODY onwards: a parameter list may contain
  // a default like `points = []` and even an object default, and starting there
  // would balance against the wrong brace.
  const pick = (name) => {
    const start = src.indexOf(`export function ${name}(`)
    assert.ok(start >= 0, `${name} not found in employeeTrackingService.js`)

    // Find the body brace: the first `{` after the parameter list closes.
    const paramsStart = src.indexOf('(', start)
    let depth = 0
    let bodyStart = -1
    for (let i = paramsStart; i < src.length; i += 1) {
      const c = src[i]
      if (c === '(' || c === '[' || c === '{') depth += 1
      else if (c === ')' || c === ']' || c === '}') {
        depth -= 1
        if (depth === 0 && c === ')') { bodyStart = i + 1; break }
      }
    }
    assert.ok(bodyStart > 0, `could not find the parameter list end for ${name}`)

    depth = 0
    for (let i = src.indexOf('{', bodyStart); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1
      else if (src[i] === '}') {
        depth -= 1
        if (depth === 0) return src.slice(start, i + 1)
      }
    }
    throw new Error(`unterminated ${name}`)
  }

  // buildMovementTimeline calls formatClockTime, so it is injected as a
  // parameter rather than left to resolve in the sandbox global scope.
  const factory = vm.runInNewContext(`
    (function (formatClockTime) {
      ${pick('buildMovementTimeline').replace(/^export function/, 'function')}
      return buildMovementTimeline
    })
  `)
  const formatClockTime = vm.runInNewContext(
    `(${pick('formatClockTime').replace(/^export function/, 'function')})`,
  )
  return factory(formatClockTime)
}

const buildMovementTimeline = loadHelpers()

// ============================================================================
// Employee Tracking - the movement timeline names the REAL place.
//
// The report: the timeline read "08:00 HEAD OFFICE" on an observation the very
// same row recorded as outside every geofence. The stored label names the
// NEAREST fence, which is true but useless when the question is "where was this
// person?" - the person was ~9.2 km away in Ogudu GRA Estate.
//
// These tests exercise buildMovementTimeline directly, because the defect was
// in the LABEL, not the coordinates or the inside/outside verdict.
// ============================================================================

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok  ${name}`) }
  catch (e) {
    const msg = String(e.message).slice(0, 300)
    console.error(`  FAIL ${name}\n       ${msg}`)
    process.exitCode = 1
  }
}

// The exact case from the screen: inside_geofence false, stored label naming
// the nearest fence 9.2 km away.
const OUTSIDE_POINT = {
  id: 'p1',
  latitude: 6.579477,
  longitude: 3.381569,
  recorded_at: '2026-09-30T05:55:00Z',
  inside_geofence: false,
  location_label: 'Outside HEAD OFFICE (9 km away)',
  nearest_location_name: 'HEAD OFFICE',
  nearest_distance: 9173.8,
  nearest_radius: 20,
}

const INSIDE_POINT = {
  id: 'p2',
  latitude: 6.605829,
  longitude: 3.392538,
  recorded_at: '2026-09-30T08:00:00Z',
  inside_geofence: true,
  location_label: 'HEAD OFFICE',
}

console.log('\nA point inside a fence is named by that fence')
check('an inside point shows its registered location', () => {
  const [t] = buildMovementTimeline([INSIDE_POINT])
  assert.equal(t.label, 'HEAD OFFICE')
  assert.equal(t.insideGeofence, true)
})

check('an inside point is never relabelled by a reverse-geocoded address', () => {
  // "Somewhere Estate" must NOT appear for a verified inside point: the
  // registered location is the authoritative answer there.
  const [t] = buildMovementTimeline([INSIDE_POINT], {
    p2: { short: 'Somewhere Estate' },
  })
  assert.equal(t.label, 'HEAD OFFICE')
  assert.ok(!t.label.includes('Somewhere'))
})

console.log('\nA point outside every fence names the real place')
check('an outside point shows the map address instead of the fence', () => {
  const [t] = buildMovementTimeline([OUTSIDE_POINT], {
    p1: { short: 'Ogudu GRA Estate' },
  })
  assert.equal(t.label, 'Ogudu GRA Estate')
  assert.ok(
    !t.label.includes('HEAD OFFICE'),
    'must not name a location the person was never at',
  )
})

check('the sub-line still states it was outside every location', () => {
  const [t] = buildMovementTimeline([OUTSIDE_POINT], {
    p1: { short: 'Ogudu GRA Estate' },
  })
  assert.equal(t.insideGeofence, false)
  assert.equal(t.placeLabel, 'Ogudu GRA Estate')
  assert.match(t.transition, /outside every registered location/i)
})

check('without an address the honest distance label is kept', () => {
  // Geocoding is cosmetic and can fail offline, so the fallback must remain the
  // server's honest "9 km away" label rather than inventing a place.
  const [t] = buildMovementTimeline([OUTSIDE_POINT])
  assert.equal(t.label, 'Outside HEAD OFFICE (9 km away)')
  assert.match(t.label, /km away/)
  assert.equal(t.placeLabel, null)
})

check('a null address result does not blank the label', () => {
  const [t] = buildMovementTimeline([OUTSIDE_POINT], { p1: null })
  assert.equal(t.label, 'Outside HEAD OFFICE (9 km away)')
})

console.log('\nThe two surfaces can never contradict each other again')
check('the label and the verdict always agree', () => {
  const timeline = buildMovementTimeline(
    [OUTSIDE_POINT, INSIDE_POINT],
    { p1: { short: 'Ogudu GRA Estate' } },
  )
  for (const t of timeline) {
    if (t.insideGeofence) {
      assert.ok(
        !/GRA Estate/.test(t.label),
        'an inside point must not show the outside address',
      )
    } else {
      assert.equal(t.label, 'Ogudu GRA Estate')
    }
  }
})

check('leaving and entering a fence is still described', () => {
  const timeline = buildMovementTimeline([INSIDE_POINT, OUTSIDE_POINT], {
    p2: { short: 'Ogudu GRA Estate' },
  })
  assert.match(timeline[1].transition, /Left HEAD OFFICE geofence/)
})

check('points with no id still key off their coordinates', () => {
  const p = { ...OUTSIDE_POINT, id: undefined }
  const [t] = buildMovementTimeline([p], {
    '6.579477,3.381569': { short: 'Ogudu GRA Estate' },
  })
  assert.equal(t.label, 'Ogudu GRA Estate')
})

check('a non-array input is handled without throwing', () => {
  assert.deepEqual(buildMovementTimeline(null), [])
  assert.deepEqual(buildMovementTimeline(undefined, {}), [])
})

console.log(`\n${passed} checks passed`)