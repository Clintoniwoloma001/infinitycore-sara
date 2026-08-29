import { useCallback, useEffect, useRef, useState } from 'react'

// ------------------------------------------------------------------
// SARA voice engine.
//
// Wake-word detection happens locally: we run the browser's own
// SpeechRecognition in continuous + interim mode and match the phrase
// "SARA" against interim transcripts in this file. Audio is handled
// entirely by the browser speech engine — we never stream microphone
// audio to any AI endpoint just to detect the wake word, and we never
// call a remote model while waiting for the wake word.
//
// If SpeechRecognition is unavailable or the mic is denied, the UI
// falls back to push-to-talk buttons; nothing crashes.
//
// The hook owns the microphone plumbing only. Command processing and
// the higher-level state machine (ACTIVATED / PROCESSING / AWAITING_
// CONFIRMATION / ...) live in the SARA component so the engine stays
// reusable by other channels.
// ------------------------------------------------------------------

export const MIC_STATES = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  GRANTED: 'granted',
  DENIED: 'denied',
  UNAVAILABLE: 'unavailable',
  SUSPENDED: 'suspended',
}

const WAKE_PATTERN = /(^|[^a-z0-9])sara([.!?,']|$)\s*|^sara$/i
const COMMAND_TIMEOUT_MS = 15000

function speechSupported() {
  return !!(typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition))
}

function getRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return null
  const rec = new SR()
  rec.lang = 'en-US'
  rec.interimResults = true
  rec.maxAlternatives = 1
  return rec
}

function splitAfterWake(phrase) {
  // Returns { command } — the text that follows "sara" in the same
  // utterance, so "sara show pending" works without a second sentence.
  const m = phrase.match(/sara([.!?,']\s*|$)(.*)/i)
  if (!m) return { command: '' }
  const rest = (m[2] || '').trim().replace(/^[.!?,']+\s*/, '')
  return { command: rest }
}

export function useSaraVoice() {
  const [micState, setMicState] = useState(() => (speechSupported() ? MIC_STATES.IDLE : MIC_STATES.UNAVAILABLE))
  const [wakeListening, setWakeListening] = useState(false) // wake-word recognizer currently running
  const [interim, setInterim] = useState('')                 // live interim transcript while wakeListening
  const [commandTranscript, setCommandTranscript] = useState('') // live interim while capturing a command
  const [isSpeaking, setIsSpeaking] = useState(false)

  const micSupported = speechSupported()
  const wakeRecRef = useRef(null)
  const cmdRecRef = useRef(null)
  const streamRef = useRef(null)
  const armedRef = useRef(false) // wake armed (started + not explicitly stopped)
  const restoredRef = useRef(false)

  // Called by the host when the wake word rounds the corner — the
  // engine exposes onWake and onCommand through refs set by the host.
  const handlersRef = useRef({ onWake: null, onCommand: null, onWakeError: null })

  const setHandlers = useCallback((h) => { handlersRef.current = { ...handlersRef.current, ...h } }, [])

  const stopWakeRec = useCallback(() => {
    const rec = wakeRecRef.current
    wakeRecRef.current = null
    if (rec) {
      rec.onresult = null; rec.onend = null; rec.onerror = null
      try { rec.stop() } catch { /* no-op */ }
    }
    streamRef.current?.getTracks?.().forEach((t) => t.stop())
    streamRef.current = null
    setWakeListening(false)
    setInterim('')
  }, [])

  const requestMic = useCallback(async () => {
    if (!micSupported) { setMicState(MIC_STATES.UNAVAILABLE); return false }
    if (micState === MIC_STATES.GRANTED) return true
    setMicState(MIC_STATES.REQUESTING)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      setMicState(MIC_STATES.GRANTED)
      return true
    } catch (e) {
      setMicState(e?.name === 'NotAllowedError' ? MIC_STATES.DENIED : MIC_STATES.UNAVAILABLE)
      return false
    }
  }, [micSupported, micState])

  // Persistent wake-word listening. Restarts itself when the browser
  // engine drops the connection (Chrome auto-times-out ~60s), but only
  // while armed — never a busy loop.
  const startWake = useCallback(async () => {
    if (!micSupported || armedRef.current) return
    armedRef.current = true
    const ok = await requestMic()
    if (!ok) {
      armedRef.current = false
      handlersRef.current.onWakeError?.(micState)
      return
    }
    const rec = getRecognition()
    if (!rec) { setMicState(MIC_STATES.UNAVAILABLE); handlersRef.current.onWakeError?.(MIC_STATES.UNAVAILABLE); return }
    wakeRecRef.current = rec
    rec.continuous = true
    rec.interimResults = true

    let stopped = false
    const hardStop = () => { stopped = true }

    rec.onresult = (e) => {
      let interimText = ''
      let finalText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript || ''
        if (e.results[i].isFinal) finalText += t
        else interimText += t
      }
      if (interimText) setInterim(interimText.trim())
      const running = `${finalText}${interimText}`
      if (WAKE_PATTERN.test(running.trim())) {
        // "sara" detected locally — hand off to the host, which decides
        // whether to acknowledge and capture a command.
        const { command } = splitAfterWake(running.trim())
        hardStop()
        stopWakeRec()
        handlersRef.current.onWake?.(command)
      }
    }

    const restart = () => {
      if (!stopped && armedRef.current && !wakeRecRef.current) {
        // Re-arm after browser auto-end (Chrome ~60s cap). Guarded.
        wakeRecRef.current = null
        try { startWake() } catch { /* next poll restarts */ }
      }
    }

    rec.onend = () => { if (!stopped) setWakeListening(false); restoreTimeout = setTimeout(restart, 600) }
    rec.onerror = (e) => {
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
        setMicState(MIC_STATES.DENIED)
      } else if (e?.error === 'network') {
        stopWakeRec()
        handlersRef.current.onWakeError?.('network')
      }
    }

    setWakeListening(true)
    let restoreTimeout
    try { rec.start() } catch {
      setMicState(MIC_STATES.UNAVAILABLE)
      setWakeListening(false)
    }
    return () => { if (restoreTimeout) clearTimeout(restoreTimeout) }
  }, [micSupported, micState, requestMic, stopWakeRec])

  const stopWake = useCallback(() => {
    armedRef.current = false
    restoredRef.current = false
    stopWakeRec()
    setCommandTranscript('')
  }, [stopWakeRec])

  // Single-shot command capture (used after the wake word, and by the
  // push-to-talk fallback). Stops the wake recognizer first.
  const captureCommand = useCallback(({ onResult, ack = null, timeoutMs = COMMAND_TIMEOUT_MS, liveInterim = null, onNoMicrophone = null }) => {
    stopWake()
    const fire = async () => {
      const ok = await requestMic()
      if (!ok) { onNoMicrophone?.(); return }
      const rec = getRecognition()
      if (!rec) { onNoMicrophone?.(); return }
      cmdRecRef.current = rec
      rec.continuous = false
      rec.interimResults = true
      let captured = false
      let done = false

      const finishClear = () => {
        done = true
        if (cmdRecRef.current === rec) cmdRecRef.current = null
        rec.onresult = null; rec.onend = null; rec.onerror = null
        try { rec.stop() } catch { /* no-op */ }
      }

      const finish = () => {
        if (done) return
        finishClear()
        if (timeoutTimer) clearTimeout(timeoutTimer)
        setCommandTranscript('')
        onResult?.()
      }

      const timeoutTimer = setTimeout(finish, timeoutMs)
      ack?.()
      rec.onresult = (e) => {
        let interimText = ''
        let finalText = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript || ''
          if (e.results[i].isFinal) finalText += t
          else interimText += t
        }
        if (interimText) setCommandTranscript(interimText.trim())
        if (finalText && !captured) {
          captured = true
          finishClear()
          if (timeoutTimer) clearTimeout(timeoutTimer)
          setCommandTranscript('')
          const transcript = finalText.trim()
          liveInterim?.(transcript)
          onResult?.(transcript)
        }
      }
      rec.onerror = () => {
        if (!done) {
          finishClear()
          onResult?.('')
        }
      }
      rec.onend = () => { if (!captured) finish() }
      try { rec.start() } catch { finish() }
    }
    fire()
  }, [requestMic, stopWake])

  // Catch-all release of any active recognition on unmount.
  useEffect(() => {
    return () => {
      armedRef.current = false
      try { wakeRecRef.current?.stop?.() } catch { /* no-op */ }
      try { cmdRecRef.current?.stop?.() } catch { /* no-op */ }
      streamRef.current?.getTracks?.().forEach((t) => t.stop())
    }
  }, [])

  return {
    micSupported,
    micState,
    wakeListening,
    interim,
    commandTranscript,
    isSpeaking,
    setHandlers,
    requestMic,
    startWake,
    stopWake,
    captureCommand,
  }
}

// ------------------------------------------------------------------
// Text-to-speech helpers — thin wrappers over the platform speech
// synthesis, so the UI never crashes if it is unavailable.
// ------------------------------------------------------------------

export function speakText(text, { volume = 1, enabled = true, onStart = null, onEnd = null } = {}) {
  if (!enabled || !text || typeof window === 'undefined' || !('speechSynthesis' in window)) return false
  try {
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1
    u.pitch = 1
    u.volume = Math.max(0, Math.min(1, volume))
    if (onStart) u.onstart = onStart
    if (onEnd) u.onend = onEnd
    window.speechSynthesis.speak(u)
    return true
  } catch { return false }
}

export function cancelSpeech() {
  try { window.speechSynthesis?.cancel?.() } catch { /* no-op */ }
}

export function availableVoices() {
  try { return window.speechSynthesis?.getVoices?.() || [] } catch { return [] }
}