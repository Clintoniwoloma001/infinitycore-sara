import assert from 'node:assert/strict'
import {
  CAMERA_CONSTRAINTS,
  CAMERA_STATES,
  FALLBACK_CAMERA_CONSTRAINTS,
  getCameraErrorDetails,
  getCameraStateMessage,
  getCameraSupport,
  hasLiveVideoTrack,
  isVideoReady,
  shouldTryConstraintFallback,
} from '../src/utils/cameraCapture.js'

assert.deepEqual(CAMERA_CONSTRAINTS, {
  video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: false,
})
assert.deepEqual(FALLBACK_CAMERA_CONSTRAINTS, { video: true, audio: false })

const supportedNavigator = { mediaDevices: { getUserMedia() {} } }
assert.equal(getCameraSupport({ navigatorObject: supportedNavigator, secureContext: true }).supported, true)
assert.equal(getCameraSupport({ navigatorObject: supportedNavigator, secureContext: false }).supported, false)
assert.equal(getCameraSupport({ navigatorObject: {}, secureContext: true }).supported, false)

assert.equal(isVideoReady({ srcObject: {}, readyState: 1, videoWidth: 1280, videoHeight: 720 }), false)
assert.equal(isVideoReady({ srcObject: {}, readyState: 2, videoWidth: 1280, videoHeight: 720 }), true)
assert.equal(isVideoReady({ srcObject: null, readyState: 4, videoWidth: 1280, videoHeight: 720 }), false)
assert.equal(hasLiveVideoTrack({ getTracks: () => [{ kind: 'video', readyState: 'live' }] }), true)
assert.equal(hasLiveVideoTrack({ getTracks: () => [{ kind: 'video', readyState: 'ended' }] }), false)

const expectedStates = [
  CAMERA_STATES.IDLE,
  CAMERA_STATES.STARTING,
  CAMERA_STATES.READY,
  CAMERA_STATES.PERMISSION_DENIED,
  CAMERA_STATES.NOT_SUPPORTED,
  CAMERA_STATES.DEVICE_ERROR,
  CAMERA_STATES.BUSY,
  CAMERA_STATES.STOPPED,
]
assert.deepEqual(Object.values(CAMERA_STATES), expectedStates)
assert.match(getCameraStateMessage(CAMERA_STATES.STARTING), /Starting camera/)
assert.match(getCameraStateMessage(CAMERA_STATES.NOT_SUPPORTED, { isSecureContext: false }), /HTTPS or localhost/)

for (const [name, state] of [
  ['NotAllowedError', CAMERA_STATES.PERMISSION_DENIED],
  ['NotFoundError', CAMERA_STATES.DEVICE_ERROR],
  ['NotReadableError', CAMERA_STATES.BUSY],
  ['OverconstrainedError', CAMERA_STATES.DEVICE_ERROR],
  ['SecurityError', CAMERA_STATES.PERMISSION_DENIED],
  ['AbortError', CAMERA_STATES.DEVICE_ERROR],
  ['TypeError', CAMERA_STATES.NOT_SUPPORTED],
]) {
  const details = getCameraErrorDetails({ name })
  assert.equal(details.state, state, `${name} maps to the expected camera state`)
  assert.equal(details.message.includes(name), false, `${name} is not exposed to candidates`)
}

assert.equal(getCameraErrorDetails({ name: 'SecurityError' }, { isSecureContext: false }).state, CAMERA_STATES.NOT_SUPPORTED)
assert.equal(getCameraErrorDetails(new Error('private diagnostic')).message.includes('private diagnostic'), false)
assert.equal(shouldTryConstraintFallback({ name: 'OverconstrainedError' }), true)
assert.equal(shouldTryConstraintFallback({ name: 'NotFoundError' }), false)

console.log('cameraCapture.test.mjs passed')
