export const CAMERA_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  PERMISSION_DENIED: 'permission-denied',
  NOT_SUPPORTED: 'not-supported',
  DEVICE_ERROR: 'device-error',
  BUSY: 'busy',
  STOPPED: 'stopped',
})

export const CAMERA_CONSTRAINTS = Object.freeze({
  video: Object.freeze({
    facingMode: 'user',
    width: Object.freeze({ ideal: 1280 }),
    height: Object.freeze({ ideal: 720 }),
  }),
  audio: false,
})

export const FALLBACK_CAMERA_CONSTRAINTS = Object.freeze({
  video: true,
  audio: false,
})

export const CAMERA_START_TIMEOUT_MS = 15000

export function getCameraSupport({
  navigatorObject = typeof navigator !== 'undefined' ? navigator : null,
  secureContext = typeof window !== 'undefined' ? window.isSecureContext : undefined,
} = {}) {
  const mediaDevices = navigatorObject?.mediaDevices || null
  const isSecureContext = secureContext !== false
  const mediaDevicesAvailable = !!mediaDevices
  const getUserMediaAvailable = typeof mediaDevices?.getUserMedia === 'function'

  return {
    isSecureContext,
    mediaDevicesAvailable,
    getUserMediaAvailable,
    supported: isSecureContext && mediaDevicesAvailable && getUserMediaAvailable,
    mediaDevices,
  }
}

export function isVideoReady(video) {
  return !!(
    video
    && video.srcObject
    && Number(video.readyState) >= 2
    && Number(video.videoWidth) > 0
    && Number(video.videoHeight) > 0
  )
}

export function hasLiveVideoTrack(stream) {
  return !!stream?.getTracks?.().some((track) => track?.kind === 'video' && track.readyState === 'live')
}

export function getCameraStateMessage(state, { isSecureContext = true } = {}) {
  if (state === CAMERA_STATES.STARTING) return 'Starting camera...'
  if (state === CAMERA_STATES.READY) return 'Camera ready - position your face inside the frame.'
  if (state === CAMERA_STATES.PERMISSION_DENIED) return 'Camera access was blocked. Allow camera access in your browser settings and try again.'
  if (state === CAMERA_STATES.NOT_SUPPORTED) {
    return isSecureContext
      ? 'This browser/device does not provide camera access.'
      : 'Camera access requires a secure connection. Use HTTPS or localhost.'
  }
  if (state === CAMERA_STATES.DEVICE_ERROR) return 'Camera could not be started. Check your browser camera permission and try again.'
  if (state === CAMERA_STATES.BUSY) return 'The camera is currently being used by another application or browser tab.'
  if (state === CAMERA_STATES.STOPPED) return 'Camera stopped.'
  return 'Camera is ready to start.'
}

export function getCameraErrorDetails(error, { isSecureContext = true } = {}) {
  const name = error?.name

  if (name === 'NotAllowedError') {
    return {
      state: CAMERA_STATES.PERMISSION_DENIED,
      message: getCameraStateMessage(CAMERA_STATES.PERMISSION_DENIED),
    }
  }

  if (name === 'NotFoundError') {
    return {
      state: CAMERA_STATES.DEVICE_ERROR,
      message: 'No usable camera was detected.',
    }
  }

  if (name === 'NotReadableError') {
    return {
      state: CAMERA_STATES.BUSY,
      message: getCameraStateMessage(CAMERA_STATES.BUSY),
    }
  }

  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return {
      state: CAMERA_STATES.DEVICE_ERROR,
      message: 'No usable camera was detected.',
    }
  }

  if (name === 'SecurityError') {
    return isSecureContext
      ? {
          state: CAMERA_STATES.PERMISSION_DENIED,
          message: 'Camera access was blocked by browser security settings. Allow camera access and try again.',
        }
      : {
          state: CAMERA_STATES.NOT_SUPPORTED,
          message: getCameraStateMessage(CAMERA_STATES.NOT_SUPPORTED, { isSecureContext: false }),
        }
  }

  if (name === 'TypeError') {
    return {
      state: CAMERA_STATES.NOT_SUPPORTED,
      message: getCameraStateMessage(CAMERA_STATES.NOT_SUPPORTED, { isSecureContext }),
    }
  }

  if (name === 'AbortError' || name === 'CameraStartTimeout') {
    return {
      state: CAMERA_STATES.DEVICE_ERROR,
      message: getCameraStateMessage(CAMERA_STATES.DEVICE_ERROR),
    }
  }

  return {
    state: CAMERA_STATES.DEVICE_ERROR,
    message: getCameraStateMessage(CAMERA_STATES.DEVICE_ERROR),
  }
}

export function shouldTryConstraintFallback(error) {
  return ['OverconstrainedError', 'ConstraintNotSatisfiedError', 'TypeError'].includes(error?.name)
}
