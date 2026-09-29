// ===========================================================================
// useRecorder — browser MediaRecorder with start/stop/pause/resume.
//
// This is the WEB half of I-Meet recording. The Flutter app implements the
// SAME state machine in MeetingRecorderService, so a recording started on
// either client produces an identical imeet_recordings row and both clients
// read the same summary.
//
// Mirrored states (identical names in both clients):
//   isRecording  capturing, and the timer advances
//   isPaused      capturing is suspended; the timer is frozen
//   duration      seconds of CAPTURED audio, excluding paused time
//
// Design notes that matter:
//  - Safari's MediaRecorder has no usable pause(), so pause is tracked with a
//    timestamp accumulator rather than inferred from recorder.state.
//  - duration is derived from wall-clock minus accumulated paused time, so it
//    cannot drift if a timer tick is dropped.
//  - The Blob is produced ONLY on stop, so a discarded take never uploads a
//    truncated file.
//  - Nothing is uploaded here: storage and transcription are the caller's job.
// ===========================================================================
import { useCallback, useEffect, useRef, useState } from 'react'

/** MM:SS, or HH:MM:SS past an hour. Matches the Flutter formatter. */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/** Pick a container the transcribe endpoint accepts. */
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  return candidates.find((t) => {
    try { return MediaRecorder.isTypeSupported(t) } catch { return false }
  }) || ''
}

export const ACCEPTED_AUDIO_TYPES =
  'audio/webm,audio/ogg,audio/mp4,audio/mpeg,audio/wav,.webm,.ogg,.m4a,.mp3,.wav'

export default function useRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState(null)
  const [permissionDenied, setPermissionDenied] = useState(false)

  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const pausedTotalRef = useRef(0)   // accumulated paused ms
  const pausedAtRef = useRef(null)   // when the current pause began
  const startedAtRef = useRef(0)
  const tickRef = useRef(null)

  const clearTimer = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
  }, [])

  // Releasing the mic is what clears the browser's recording indicator.
  const stopTracks = useCallback(() => {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    streamRef.current = null
  }, [])

  const reset = useCallback(() => {
    clearTimer()
    recorderRef.current = null
    stopTracks()
    chunksRef.current = []
    pausedTotalRef.current = 0
    pausedAtRef.current = null
    startedAtRef.current = 0
    setIsRecording(false)
    setIsPaused(false)
    setDuration(0)
  }, [clearTimer, stopTracks])

  const computeElapsed = useCallback(() => {
    if (!startedAtRef.current) return 0
    const now = pausedAtRef.current ?? Date.now()
    return Math.max(0, Math.floor((now - startedAtRef.current - pausedTotalRef.current) / 1000))
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setPermissionDenied(false)
    if (isRecording) return

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio. Use Chrome, Edge or Safari 14.1+.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream

      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      chunksRef.current = []
      pausedTotalRef.current = 0
      pausedAtRef.current = null
      startedAtRef.current = Date.now()

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onerror = (e) => setError(e?.error?.message || 'Recording failed.')

      // Flush every second, so a crash loses at most a second of audio.
      recorder.start(1000)
      setDuration(0)
      setIsRecording(true)
      setIsPaused(false)
      tickRef.current = setInterval(() => setDuration(computeElapsed()), 250)
    } catch (e) {
      // A denied permission and a missing device need different remedies.
      const name = e?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setPermissionDenied(true)
        setError('Microphone access was blocked. Allow it in your browser settings and try again.')
      } else if (name === 'NotFoundError') {
        setError('No microphone was found on this device.')
      } else {
        setError(e?.message || 'Could not start recording.')
      }
      stopTracks()
    }
  }, [isRecording, computeElapsed, stopTracks])

  const pause = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state === 'inactive' || pausedAtRef.current) return
    try {
      if (typeof rec.pause === 'function' && rec.state === 'recording') rec.pause()
    } catch { /* ignore */ }
    pausedAtRef.current = Date.now()
    setDuration(computeElapsed())
    setIsPaused(true)
  }, [computeElapsed])

  const resume = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state === 'inactive' || !pausedAtRef.current) return
    pausedTotalRef.current += Date.now() - pausedAtRef.current
    pausedAtRef.current = null
    try {
      if (typeof rec.resume === 'function' && rec.state === 'paused') rec.resume()
    } catch { /* ignore */ }
    setDuration(computeElapsed())
    setIsPaused(false)
  }, [computeElapsed])

  /**
   * Stop and return the finished recording.
   * @returns {Promise<{blob: Blob, durationSeconds: number, mime: string}|null>}
   *   null when nothing usable was captured.
   */
  const stop = useCallback(async () => {
    const rec = recorderRef.current
    clearTimer()
    if (!rec) return null

    const finalDuration = computeElapsed()
    const finished = await new Promise((resolve) => {
      const done = () => resolve(true)
      rec.addEventListener('stop', done, { once: true })
      try {
        if (rec.state !== 'inactive') rec.stop()
        else done()
      } catch { done() }
    })

    setIsRecording(false)
    setIsPaused(false)
    setDuration(finalDuration)

    const type = rec.mimeType || pickMimeType() || 'audio/webm'
    const blob = finished && chunksRef.current.length
      ? new Blob(chunksRef.current, { type })
      : null

    recorderRef.current = null
    chunksRef.current = []
    stopTracks()

    if (!blob || blob.size === 0) {
      setError('No audio was captured. Please try recording again.')
      return null
    }
    return { blob, durationSeconds: finalDuration, mime: type }
  }, [clearTimer, computeElapsed, stopTracks])

  // Release the mic on unmount, or the OS indicator stays on and the user
  // believes recording continued after leaving the page.
  useEffect(() => () => {
    clearTimer()
    try {
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') rec.stop()
    } catch { /* ignore */ }
    stopTracks()
  }, [clearTimer, stopTracks])

  return {
    isRecording, isPaused, duration, error, permissionDenied,
    formattedDuration: formatDuration(duration),
    start, pause, resume, stop, reset,
  }
}
