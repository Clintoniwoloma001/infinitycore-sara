// ===========================================================================
// RecorderControls — the recording UI for the web client.
//
// Renders the same four states the Flutter widget does (idle / recording /
// paused / stopping) from the same useRecorder state machine, so a user moving
// between web and mobile sees identical behaviour.
// ===========================================================================
import React from 'react'
import { Mic, Square, Pause, Play, Loader2, AlertTriangle } from 'lucide-react'
import useRecorder, { ACCEPTED_AUDIO_TYPES } from '../../hooks/useRecorder'

/** A calm breathing pulse, so "recording" is legible at a glance. */
function Pulse({ paused }) {
  return (
    <span className="relative flex h-3 w-3" aria-hidden="true">
      <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
        paused ? 'bg-amber-400' : 'animate-ping bg-red-500'
      }`} />
      <span className={`relative inline-flex h-3 w-3 rounded-full ${
        paused ? 'bg-amber-500' : 'bg-red-600'
      }`} />
    </span>
  )
}

export default function RecorderControls({
  onRecordingReady, meetingId, isFollowUp = false, disabled = false, busy = false,
}) {
  const {
    isRecording, isPaused, formattedDuration, error, permissionDenied,
    start, pause, resume, stop,
  } = useRecorder()

  const handleStop = async () => {
    const result = await stop()
    // A null result means nothing usable was captured; the hook has already
    // set a real error, and we must not report a success.
    if (result && onRecordingReady) {
      await onRecordingReady({ ...result, meetingId, isFollowUp })
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-[9rem] items-center gap-2">
          {isRecording && <Pulse paused={isPaused} />}
          <span className="font-mono text-lg tabular-nums text-slate-900">
            {formattedDuration}
          </span>
          <span className="text-xs text-slate-500">
            {isRecording ? (isPaused ? 'Paused' : 'Recording') : 'Ready'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isRecording ? (
            <button
              onClick={start} disabled={disabled || busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
              {isFollowUp ? 'Record follow-up' : 'Start recording'}
            </button>
          ) : (
            <>
              <button
                onClick={isPaused ? resume : pause}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
              >
                {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <button
                onClick={handleStop}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
              >
                <Square className="h-4 w-4" />Stop &amp; save
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
          {permissionDenied && (
            <span className="block text-red-600">
              Chrome: the icon beside the address bar → Site settings → Microphone → Allow.
              Safari: Settings for this website → Microphone → Allow.
            </span>
          )}
        </p>
      )}

      <p className="mt-2 text-[11px] text-slate-400">
        Audio is stored privately and transcribed by Sara. Accepted formats: {ACCEPTED_AUDIO_TYPES}.
      </p>
    </div>
  )
}
