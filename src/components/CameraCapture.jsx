import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Camera, Check, RefreshCw, Upload } from 'lucide-react'
import {
  CAMERA_CONSTRAINTS,
  CAMERA_START_TIMEOUT_MS,
  CAMERA_STATES,
  FALLBACK_CAMERA_CONSTRAINTS,
  getCameraErrorDetails,
  getCameraStateMessage,
  getCameraSupport,
  hasLiveVideoTrack,
  isVideoReady,
  shouldTryConstraintFallback,
} from '../utils/cameraCapture'

const CANCELLED = { name: 'CameraInitializationCancelled' }

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop()
    } catch {
      // A track can already be stopped by the browser when a device changes.
    }
  })
}

function isDevelopment() {
  return import.meta.env?.DEV === true
}

function createDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('The captured image could not be prepared.'))
    reader.readAsDataURL(blob)
  })
}

function createImageFile(blob) {
  const name = `selfie-${Date.now()}.jpg`
  if (typeof File === 'function') return new File([blob], name, { type: blob.type || 'image/jpeg' })
  return blob
}

export default function CameraCapture({ onCapture }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const operationRef = useRef(null)
  const operationIdRef = useRef(0)
  const mountedRef = useRef(false)
  const cleanupTimerRef = useRef(null)
  const cameraStateRef = useRef(CAMERA_STATES.IDLE)
  const onCaptureRef = useRef(onCapture)
  const [cameraState, setCameraState] = useState(CAMERA_STATES.IDLE)
  const [cameraMessage, setCameraMessage] = useState('')
  const [captured, setCaptured] = useState(null)

  const reportDiagnostics = useCallback((event, details = {}) => {
    if (!isDevelopment()) return
    const support = getCameraSupport()
    const video = videoRef.current
    console.debug('[CameraCapture]', event, {
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : undefined,
      mediaDevicesAvailable: support.mediaDevicesAvailable,
      getUserMediaAvailable: support.getUserMediaAvailable,
      cameraState: cameraStateRef.current,
      videoReadyState: video?.readyState ?? null,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      ...details,
    })
  }, [])

  const updateCameraState = useCallback((nextState, message = '') => {
    cameraStateRef.current = nextState
    if (!mountedRef.current) return
    setCameraState(nextState)
    setCameraMessage(message)
  }, [])

  const releaseCamera = useCallback(({ nextState = CAMERA_STATES.STOPPED, updateState = true } = {}) => {
    const operation = operationRef.current
    if (operation) {
      operation.cancelled = true
      operation.resolveCancellation?.()
      operation.readyCleanup?.()
      operation.readyCleanup = null
      operationRef.current = null
    }

    stopStream(streamRef.current)
    streamRef.current = null

    const video = videoRef.current
    if (video) {
      try {
        video.pause?.()
      } catch {
        // The video may already be detached during unmount.
      }
      video.srcObject = null
    }

    if (updateState) updateCameraState(nextState)
    reportDiagnostics('camera released')
  }, [reportDiagnostics, updateCameraState])

  const failCamera = useCallback((operation, details) => {
    if (operationRef.current !== operation || operation.cancelled) return
    operation.cancelled = true
    operation.resolveCancellation?.()
    operation.readyCleanup?.()
    operation.readyCleanup = null
    operationRef.current = null
    stopStream(streamRef.current)
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    updateCameraState(details.state, details.message)
    reportDiagnostics('camera initialization failed')
  }, [reportDiagnostics, updateCameraState])

  const waitForVideoReady = useCallback((video, operation) => new Promise((resolve, reject) => {
    let settled = false
    let timeoutId
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing']
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      events.forEach((eventName) => video.removeEventListener(eventName, check))
      if (operation.readyCleanup === cancel) operation.readyCleanup = null
      callback(value)
    }
    const check = () => {
      if (operation.cancelled || operationRef.current !== operation) {
        finish(reject, CANCELLED)
        return
      }
      if (isVideoReady(video)) finish(resolve, true)
    }
    const cancel = () => finish(reject, CANCELLED)
    events.forEach((eventName) => video.addEventListener(eventName, check))
    operation.readyCleanup = cancel
    timeoutId = window.setTimeout(() => {
      finish(reject, Object.assign(new Error('Video readiness timed out.'), { name: 'CameraStartTimeout' }))
    }, CAMERA_START_TIMEOUT_MS)
    check()
    // Some Safari versions attach the stream before dispatching a readiness event.
    window.setTimeout(check, 100)
  }), [])

  const requestStream = useCallback(async (mediaDevices, constraints, operation) => {
    const request = mediaDevices.getUserMedia(constraints)
    request.then((lateStream) => {
      if (operation.cancelled || operationRef.current !== operation) stopStream(lateStream)
    }).catch(() => {})

    let timeoutId
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        reject(Object.assign(new Error('Camera startup timed out.'), { name: 'CameraStartTimeout' }))
      }, CAMERA_START_TIMEOUT_MS)
    })
    const cancelled = operation.cancellationPromise.then(() => Promise.reject(CANCELLED))
    try {
      return await Promise.race([request, timeout, cancelled])
    } finally {
      window.clearTimeout(timeoutId)
    }
  }, [])

  const startCamera = useCallback(async () => {
    const currentOperation = operationRef.current
    if (currentOperation && !currentOperation.cancelled) return currentOperation.promise
    if (hasLiveVideoTrack(streamRef.current) && cameraStateRef.current === CAMERA_STATES.READY) return true

    releaseCamera({ nextState: CAMERA_STATES.IDLE })
    const operation = {
      id: ++operationIdRef.current,
      cancelled: false,
      readyCleanup: null,
      resolveCancellation: null,
      promise: null,
    }
    operation.cancellationPromise = new Promise((resolve) => {
      operation.resolveCancellation = resolve
    })
    operationRef.current = operation
    updateCameraState(CAMERA_STATES.STARTING)
    reportDiagnostics('camera initialization started')

    const run = async () => {
      const support = getCameraSupport()
      if (!support.isSecureContext) {
        failCamera(operation, getCameraErrorDetails({ name: 'SecurityError' }, { isSecureContext: false }))
        return false
      }
      if (!support.mediaDevicesAvailable || !support.getUserMediaAvailable) {
        failCamera(operation, getCameraErrorDetails({ name: 'TypeError' }, { isSecureContext: support.isSecureContext }))
        return false
      }

      let stream
      let fallbackAttempted = false
      try {
        try {
          stream = await requestStream(support.mediaDevices, CAMERA_CONSTRAINTS, operation)
        } catch (error) {
          if (operation.cancelled) return false
          if (!shouldTryConstraintFallback(error)) throw error
          fallbackAttempted = true
          reportDiagnostics('camera constraints rejected; trying fallback')
          stream = await requestStream(support.mediaDevices, FALLBACK_CAMERA_CONSTRAINTS, operation)
        }

        if (operation.cancelled || operationRef.current !== operation) {
          stopStream(stream)
          return false
        }

        const video = videoRef.current
        if (!video) {
          stopStream(stream)
          throw Object.assign(new Error('The camera preview is unavailable.'), { name: 'AbortError' })
        }

        streamRef.current = stream
        video.muted = true
        video.playsInline = true
        video.srcObject = stream
        const readyPromise = waitForVideoReady(video, operation)

        try {
          const playResult = video.play?.()
          if (playResult && typeof playResult.catch === 'function') {
            playResult.catch(() => reportDiagnostics('video.play() was blocked; readiness events will continue'))
          }
        } catch {
          reportDiagnostics('video.play() threw; readiness events will continue')
        }

        await readyPromise
        if (operation.cancelled || operationRef.current !== operation || !isVideoReady(video)) {
          stopStream(stream)
          return false
        }

        cameraStateRef.current = CAMERA_STATES.READY
        if (mountedRef.current) {
          setCameraState(CAMERA_STATES.READY)
          setCameraMessage('')
        }
        reportDiagnostics('camera ready')
        return true
      } catch (error) {
        if (operation.cancelled || error === CANCELLED) return false
        const details = getCameraErrorDetails(error, { isSecureContext: support.isSecureContext, fallbackAttempted })
        reportDiagnostics('camera error mapped', {
          errorName: error?.name || 'unknown',
          fallbackAttempted,
        })
        failCamera(operation, details)
        return false
      } finally {
        if (operationRef.current === operation && cameraStateRef.current !== CAMERA_STATES.READY) {
          operationRef.current = null
        }
      }
    }

    operation.promise = run()
    return operation.promise
  }, [failCamera, releaseCamera, reportDiagnostics, requestStream, updateCameraState, waitForVideoReady])

  const capture = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const stream = streamRef.current
    if (!hasLiveVideoTrack(stream) || !isVideoReady(video)) {
      releaseCamera({ nextState: CAMERA_STATES.DEVICE_ERROR })
      updateCameraState(CAMERA_STATES.DEVICE_ERROR, 'The camera preview is not ready. Please retry the camera and try again.')
      return
    }
    if (!canvas) {
      releaseCamera({ nextState: CAMERA_STATES.DEVICE_ERROR })
      updateCameraState(CAMERA_STATES.DEVICE_ERROR, 'The captured image could not be prepared. Please retry the camera.')
      return
    }

    const width = video.videoWidth
    const height = video.videoHeight
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      releaseCamera({ nextState: CAMERA_STATES.DEVICE_ERROR })
      updateCameraState(CAMERA_STATES.DEVICE_ERROR, 'The captured image could not be prepared. Please retry the camera.')
      return
    }

    context.save()
    context.translate(width, 0)
    context.scale(-1, 1)
    context.drawImage(video, 0, 0, width, height)
    context.restore()
    releaseCamera({ nextState: CAMERA_STATES.STOPPED })

    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
      if (!blob || !mountedRef.current) {
        if (mountedRef.current) updateCameraState(CAMERA_STATES.DEVICE_ERROR, 'The captured image could not be prepared. Please retry the camera.')
        return
      }
      const preview = await createDataUrl(blob)
      if (!mountedRef.current) return
      setCaptured({ file: createImageFile(blob), preview })
    } catch {
      if (mountedRef.current) updateCameraState(CAMERA_STATES.DEVICE_ERROR, 'The captured image could not be prepared. Please retry the camera.')
    }
  }, [releaseCamera, updateCameraState])

  const retryCamera = useCallback(() => {
    if (cameraStateRef.current === CAMERA_STATES.STARTING) return
    setCaptured(null)
    releaseCamera({ nextState: CAMERA_STATES.IDLE })
    startCamera()
  }, [releaseCamera, startCamera])

  const confirm = useCallback(() => {
    if (!captured?.preview) return
    onCaptureRef.current?.(captured.preview, captured.file)
  }, [captured])

  const handleFileUpload = useCallback((event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (!mountedRef.current) return
      setCaptured({ file, preview: reader.result })
      updateCameraState(CAMERA_STATES.STOPPED)
    }
    reader.readAsDataURL(file)
  }, [updateCameraState])

  useEffect(() => {
    onCaptureRef.current = onCapture
  }, [onCapture])

  useEffect(() => {
    if (cleanupTimerRef.current) {
      window.clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
    }
    mountedRef.current = true
    startCamera()
    return () => {
      mountedRef.current = false
      // React StrictMode replays effects immediately. Deferring cleanup by one
      // task lets that replay reuse the existing operation instead of opening
      // a second permission request, while a real unmount still cleans up.
      cleanupTimerRef.current = window.setTimeout(() => {
        cleanupTimerRef.current = null
        if (!mountedRef.current) releaseCamera({ updateState: false })
      }, 0)
    }
  }, [releaseCamera, startCamera])

  if (captured) {
    return (
      <div className="space-y-3">
        <img src={captured.preview} alt="Captured selfie" className="w-full max-w-xs rounded-lg border border-slate-300 mx-auto" />
        <div className="flex justify-center gap-2">
          <button type="button" onClick={retryCamera} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" /> Retake
          </button>
          <button type="button" onClick={confirm} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Check className="w-4 h-4" /> Confirm Photo
          </button>
        </div>
      </div>
    )
  }

  const support = getCameraSupport()
  const message = cameraMessage || getCameraStateMessage(cameraState, { isSecureContext: support.isSecureContext })
  const failed = [
    CAMERA_STATES.PERMISSION_DENIED,
    CAMERA_STATES.NOT_SUPPORTED,
    CAMERA_STATES.DEVICE_ERROR,
    CAMERA_STATES.BUSY,
  ].includes(cameraState)

  return (
    <div className="space-y-3">
      {failed && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 text-amber-600 mt-0.5" />
          <div className="min-w-0">
            <p className="font-medium">Camera not available</p>
            <p className="text-xs mt-0.5">{message}</p>
            {cameraState === CAMERA_STATES.PERMISSION_DENIED && (
              <div className="text-xs mt-2 text-amber-800">
                <p className="font-medium">How to allow camera</p>
                <p>Chrome: Site Settings - Camera - Allow, then retry.</p>
                <p>Safari: Safari Settings - Websites - Camera - Allow, then retry.</p>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="relative bg-slate-900 rounded-lg overflow-hidden" style={{ aspectRatio: '4/3' }}>
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} />
        {cameraState !== CAMERA_STATES.READY && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70 px-4 text-center text-slate-200 text-sm">
            {message}
          </div>
        )}
        {cameraState === CAMERA_STATES.READY && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-32 h-32 rounded-full border-2 border-white/50 border-dashed" />
          </div>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      <div className="flex flex-col gap-2">
        {cameraState === CAMERA_STATES.READY && (
          <>
            <p className="text-center text-sm text-slate-500">{message}</p>
            <button type="button" onClick={capture} className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <Camera className="w-4 h-4" /> Capture Photo
            </button>
          </>
        )}
        {cameraState === CAMERA_STATES.IDLE && (
          <button type="button" onClick={startCamera} className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Camera className="w-4 h-4" /> Start Camera
          </button>
        )}
        {cameraState === CAMERA_STATES.STARTING && (
          <p className="text-center text-sm text-slate-400">{message}</p>
        )}
        {failed && (
          <>
            <button type="button" onClick={retryCamera} className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
              <RefreshCw className="w-4 h-4" /> Retry Camera
            </button>
            <label className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 cursor-pointer">
              <Upload className="w-4 h-4" /> Upload Photo
              <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
            </label>
          </>
        )}
      </div>
    </div>
  )
}
