import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mic, MicOff, Send, Settings, Volume2, VolumeX, X, Sparkles, Loader2 } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useMyLeaveApprovals } from '../../hooks/useMyLeaveApprovals'
import { runSaraCommand, executeConfirmedDecision } from '../../services/agentService'
import { analyzeIntent } from '../../services/saraNlu'
import { useSaraSettings, isQuietHours } from '../../services/saraSettings'
import { useSaraVoice, speakText, cancelSpeech, MIC_STATES, SARA_WAKE_WORDS, playActivationTone } from '../../services/saraVoice'
import { useSaraAlerts, pushBrowserNotification, buildLeaveAlert } from '../../services/saraAlerts'
import { formatDate } from '../../lib/utils'
import { LEAVE_TYPE_LABELS } from '../../services/leaveBalanceService'

export const PHASES = {
  IDLE: 'idle',           // ⚪ Idle
  WAKE: 'wake',           // 🔵 Listening (wake word, mic actually active)
  ACK: 'ack',             // 🟢 SARA activated
  LISTEN: 'listen',       // 🟡 Listening for instruction
  THINK: 'think',         // 🟠 Processing
  EXECUTING: 'executing', // 🔵 Executing a confirmed action
  CONFIRM: 'confirm',     // 🔴 Action requires confirmation
  SPEAK: 'speak',         // 🟢 Speaking
  PERMISSION_DENIED: 'permission_denied', // mic denied
  ERROR: 'error',         // transient voice engine error
  FALLBACK: 'fallback',   // mic unavailable → push-to-talk
}

// Stable, channel-agnostic state names (the spec's IDLE / LISTENING_FOR_
// WAKE_WORD / WAKE_WORD_DETECTED / LISTENING_FOR_COMMAND / PROCESSING /
// EXECUTING / AWAITING_CONFIRMATION / SPEAKING / ERROR / PERMISSION_DENIED)
// mapped onto the runtime phases — other channels (email/WhatsApp/Flutter)
// can switch on these without knowing the UI internals.
export const SARA_STATES = {
  IDLE: PHASES.IDLE,
  LISTENING_FOR_WAKE_WORD: PHASES.WAKE,
  WAKE_WORD_DETECTED: PHASES.ACK,
  LISTENING_FOR_COMMAND: PHASES.LISTEN,
  PROCESSING: PHASES.THINK,
  EXECUTING: PHASES.EXECUTING,
  AWAITING_CONFIRMATION: PHASES.CONFIRM,
  SPEAKING: PHASES.SPEAK,
  ERROR: PHASES.ERROR,
  PERMISSION_DENIED: PHASES.PERMISSION_DENIED,
}

const WAKE_LABEL = `Listening for ${SARA_WAKE_WORDS.map((w) => `"${w.charAt(0).toUpperCase()}${w.slice(1)}"`).join(' or ')}`

const STATUS_META = {
  [PHASES.IDLE]: { dot: 'bg-slate-400', label: 'Idle', pulse: false },
  [PHASES.WAKE]: { dot: 'bg-sky-500', label: WAKE_LABEL, pulse: true },
  [PHASES.ACK]: { dot: 'bg-emerald-500', label: 'SARA activated', pulse: false },
  [PHASES.LISTEN]: { dot: 'bg-amber-500', label: 'Listening for instruction', pulse: true },
  [PHASES.THINK]: { dot: 'bg-orange-500', label: 'Processing', pulse: false },
  [PHASES.EXECUTING]: { dot: 'bg-sky-600', label: 'Executing action', pulse: true },
  [PHASES.CONFIRM]: { dot: 'bg-rose-500', label: 'Action requires confirmation', pulse: true },
  [PHASES.SPEAK]: { dot: 'bg-emerald-500', label: 'Speaking', pulse: false },
  [PHASES.PERMISSION_DENIED]: { dot: 'bg-rose-600', label: 'Microphone permission denied — use push-to-talk or type', pulse: false },
  [PHASES.ERROR]: { dot: 'bg-orange-600', label: 'Voice engine hiccup — you can still type', pulse: false },
  [PHASES.FALLBACK]: { dot: 'bg-slate-400', label: 'Microphone unavailable — use push-to-talk', pulse: false },
}

function Switch({ label, checked, onChange, disabled, hint }) {
  return (
    <label className={`flex items-center justify-between gap-3 py-2 text-sm ${disabled ? 'opacity-50' : ''}`}>
      <span>
        <span className="font-medium text-slate-700">{label}</span>
        {hint && <span className="block text-xs text-slate-400">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-[#009944]' : 'bg-slate-300'}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  )
}

function RequestCard({ r }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <div className="font-semibold text-slate-800">{r.employee_name}</div>
      <div className="text-slate-500">{LEAVE_TYPE_LABELS[r.leave_type] || r.leave_type} · {r.days} day(s)</div>
      <div className="text-slate-400">Pending since {formatDate(r.created_at)}</div>
    </div>
  )
}

export default function Sara() {
  const { user, name: userName, role, isAdmin, userPermissions } = useAuth()
  const { queue, count, oldest, refresh } = useMyLeaveApprovals()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([]) // { from: 'sara'|'user', text, requests? }
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState(PHASES.IDLE)
  const [pendingConfirm, setPendingConfirm] = useState(null) // { matches, decision, message }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [micNotice, setMicNotice] = useState('')

  const { settings, update: updateSettings } = useSaraSettings()
  const voice = useSaraVoice()
  const alerts = useSaraAlerts({ settings, count, oldest })

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const committingRef = useRef(false)
  const pendingConfirmRef = useRef(null) // mirror of pendingConfirm for async callbacks
  const setConfirmed = (v) => { pendingConfirmRef.current = v; setPendingConfirm(v) }

  // Re-arm wake-word listening after a command completes or times out.
  const rearmWake = () => {
    committingRef.current = false
    const v = voiceRef.current
    const s = settingsRef.current
    if (user && s.voiceOn && !s.micMuted && !micBlockedNow(v)) {
      setPhase(PHASES.WAKE)
      v.startWake()
    } else {
      setPhase(PHASES.IDLE)
    }
  }
  const micBlockedNow = (v) => v.micState === MIC_STATES.DENIED || v.micState === MIC_STATES.UNAVAILABLE

  const say = (text, extra = {}) => {
    setMessages((m) => [...m, { from: 'sara', text, ...extra }])
    const s = settingsRef.current
    if (s.voiceOn && !isQuietHours(s)) {
      setPhase(PHASES.SPEAK)
      speakText(text, { volume: s.volume, onEnd: () => setPhase((p) => (p === PHASES.SPEAK ? (pendingConfirmRef.current ? PHASES.CONFIRM : PHASES.IDLE) : p)) })
    }
  }

  // Proactive alerts — spoken and/or browser, deduped, quiet-hours aware.
  useEffect(() => {
    const evt = alerts.evaluate()
    if (!evt) return
    setMessages((m) => [...m, { from: 'sara', text: evt.text }])
    if (evt.browser) pushBrowserNotification('SARA — attention needed', evt.text, '/leave-requests')
    if (settingsRef.current.voiceOn) {
      setPhase(PHASES.SPEAK)
      speakText(evt.text, { volume: settingsRef.current.volume, onEnd: () => setPhase((p) => (p === PHASES.SPEAK ? PHASES.IDLE : p)) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, oldest])

  const handleCommand = async (raw, method) => {
    if (!raw) return
    setMessages((m) => [...m, { from: 'user', text: raw }])
    setBusy(true)
    setPhase(PHASES.THINK)
    try {
      if (pendingConfirm) {
        const parsed = await analyzeIntent(raw, { role, isAdmin, permissions: userPermissions })
        if (parsed.intent === 'CONFIRM') {
          const { matches, decision } = pendingConfirm
          setConfirmed(null)
          setPhase(PHASES.EXECUTING)
          const results = await executeConfirmedDecision({ matches, decision, ctx: { approverId: user.id, approverName: userName, method }, command: raw, intent: parsed.intent })
          const okCount = results.filter((r) => r.ok).length
          await refresh()
          say(okCount === results.length
            ? `Done. I ${decision === 'approved' ? 'approved' : 'rejected'} ${okCount} leave request${okCount === 1 ? '' : 's'}.`
            : `I ${decision === 'approved' ? 'approved' : 'rejected'} ${okCount} of ${results.length} requests. One or more failed — please check Audit Logs.`)
          return
        }
        if (parsed.intent === 'CANCEL') {
          setConfirmed(null)
          say('Understood. I haven\u2019t changed anything.')
          return
        }
        say('That action requires confirmation. Say "yes" to proceed or "cancel" to stop.')
        return
      }

      const result = await runSaraCommand({
        command: raw,
        pool: queue,
        ctx: { userId: user.id, role, isAdmin, permissions: userPermissions, intent: null },
      })
      if (result.type === 'confirm') {
        setConfirmed({ matches: result.matches, decision: result.decision })
        say(result.message, { requests: result.matches })
      } else if (result.type === 'list') {
        say(result.message, { requests: result.requests })
      } else if (result.type === 'navigate') {
        say(result.message)
        navigate(result.route)
      } else {
        say(result.message)
      }
    } catch (e) {
      say(`I couldn't complete that — ${e?.message || 'something went wrong'}.`)
    } finally {
      setBusy(false)
      setPhase(pendingConfirmRef.current ? PHASES.CONFIRM : PHASES.IDLE)
    }
  }

  // Re-capture the confirmation answer from the voice channel when the
  // panel is expecting one and voice mode is on.
  useEffect(() => {
    if (!pendingConfirm || !settings.voiceOn || settings.micMuted) return
    setPhase(PHASES.CONFIRM)
    committingRef.current = true
    voice.captureCommand({
      onResult: (text) => {
        committingRef.current = false
        if (text) handleCommand(text, 'voice')
      },
      onNoMicrophone: () => { committingRef.current = false },
      timeoutMs: 20000,
      liveInterim: () => {},
    })
    return () => cancelSpeech()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingConfirm, settings.voiceOn, settings.micMuted])

  // ------------------------------------------------------------------
  // Wake-word lifecycle. Arm only when the user actually enables voice
  // mode; the engine stops itself when the panel is idle or when the
  // user mutes/disables. `committingRef` pauses re-arming while a
  // command is being captured or processed so we never restart the
  // recognizer mid-flow.
  // ------------------------------------------------------------------
  const shouldArm = !!(user && settings.voiceOn && !settings.micMuted && voice.micSupported)
  const micBlocked = voice.micState === MIC_STATES.DENIED || voice.micState === MIC_STATES.UNAVAILABLE

  useEffect(() => {
    if (shouldArm && !micBlocked) {
      if (!voice.wakeListening && !committingRef.current) {
        setPhase(PHASES.WAKE)
        voice.startWake()
      }
    } else if (shouldArm && micBlocked) {
      setPhase(PHASES.FALLBACK)
    } else {
      committingRef.current = false
      voice.stopWake()
      setPhase(PHASES.IDLE)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldArm, micBlocked, voice.wakeListening, voice.micState])

  useEffect(() => {
    voiceRef.current.setHandlers({
      onWake(command, word) {
        committingRef.current = true
        setPhase(PHASES.ACK)
        playActivationTone()
        const s = settingsRef.current
        const v = voiceRef.current
        if (s.voiceOn && !s.micMuted) {
          const reply = String(word || '').toLowerCase() === 'core' ? "I'm listening." : 'Yes, boss. I\u2019m listening.'
          speakText(reply, { volume: s.volume })
        }
        setPhase(PHASES.LISTEN)
        v.captureCommand({
          onResult: (text) => {
            committingRef.current = false
            if (text) {
              handleCommand(text, 'voice')
            } else {
              say("I didn't catch that. You can also type your request.")
              rearmWake()
            }
          },
          onNoMicrophone: () => { setMicNotice("I couldn't get microphone access for the command."); rearmWake() },
          // Spec: after ~5–8s of silence following the wake word, disengage
          // gracefully and go back to wake-word listening.
          onTimeout: () => {
            if (settingsRef.current.voiceOn) speakText("I'm here whenever you need me.", { volume: settingsRef.current.volume })
            setMessages((m) => [...m, { from: 'sara', text: "I'm here whenever you need me." }])
            rearmWake()
          },
        })
      },
      onWakeError(type) {
        // Network / service errors keep the app functional — push-to-talk
        // and text input remain available.
        if (type === MIC_STATES.DENIED) {
          setMicNotice('Microphone permission denied — you can use push-to-talk or type instead.')
          setPhase(PHASES.PERMISSION_DENIED)
        } else {
          setMicNotice('Voice recognition hiccup — you can still type.')
          setPhase(PHASES.ERROR)
          window.setTimeout(() => {
            setPhase((p) => (p === PHASES.ERROR ? PHASES.IDLE : p))
          }, 2500)
        }
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitText = () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    handleCommand(text, 'text')
  }

  const pushToTalk = async () => {
    if (busy || !settings.voiceOn) return
    cancelSpeech()
    setMicNotice('')
    // Explicit permission request so a previously-denied mic can be
    // retried (re-prompts in most browsers), then capture one command.
    const ok = await voice.requestMic()
    if (!ok) {
      setMicNotice('Microphone permission was not granted, so I can\u2019t listen. Please enable it for this site and try again — or type below.')
      setPhase(PHASES.FALLBACK)
      return
    }
    setPhase(PHASES.LISTEN)
    voice.captureCommand({
      onResult: (text) => {
        committingRef.current = false
        if (text) handleCommand(text, 'voice')
        else { say("I didn't catch that. Please try again or type your request."); setPhase(PHASES.IDLE) }
      },
      onNoMicrophone: () => setMicNotice("I couldn't reach the microphone for that command."),
    })
  }

  const requestBrowser = () => {
    if (!settings.browserNotifs && !pushBrowserNotificationPerm()) {
      setMicNotice('Browser notifications are blocked for this site — enable them in your browser settings.')
      return
    }
    updateSettings({ browserNotifs: !settings.browserNotifs })
  }

  if (!user) return null

  const status = STATUS_META[phase]
  const micActive = voice.wakeListening || phase === PHASES.LISTEN || phase === PHASES.CONFIRM
  const voiceOn = !!(settings.voiceOn && !settings.micMuted)

  return (
    <>
      {/* Floating launcher — never blocks core navigation; its mic badge
          is always visible so users can tell SARA is listening for her
          wake word even with the panel closed. */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full bg-[#0a0b0d] text-white shadow-xl flex items-center justify-center hover:scale-105 transition-transform"
        aria-label="Open SARA assistant"
        title={voiceOn ? `SARA listening for ${WAKE_LABEL.replace('Listening for ', '')} — click to open` : 'SARA (voice mode off) — click to open'}
      >
        {count > 0 && !open && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-semibold flex items-center justify-center">{count > 9 ? '9+' : count}</span>
        )}
        <Sparkles className="w-6 h-6 text-[#FF8C00]" />
        {voiceOn ? (
          <span
            title={micActive ? 'Microphone ON — listening for wake word' : 'Microphone ready'}
            className={`absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full ${micActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'} flex items-center justify-center`}
          >
            <Mic className="w-3 h-3 text-white" />
          </span>
        ) : (
          <span title="Mic muted or voice mode off" className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-slate-700 flex items-center justify-center">
            <MicOff className="w-3 h-3 text-slate-400" />
          </span>
        )}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-40 w-[calc(100vw-2.5rem)] max-w-sm h-[560px] max-h-[75vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 bg-[#0a0b0d] text-white flex items-center justify-between shrink-0">
            <div>
              <div className="font-semibold text-sm flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-[#FF8C00]" /> SARA</div>
              <div className="text-[11px] text-white/50">Smart Automated Reporting &amp; Analysis</div>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => updateSettings({ voiceOn: !settings.voiceOn })} title={settings.voiceOn ? 'Voice mode on' : 'Voice mode off'} className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10">
                {settings.voiceOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
              <button onClick={() => updateSettings({ micMuted: !settings.micMuted })} title={settings.micMuted ? 'Microphone muted' : 'Mute microphone'} className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10">
                {settings.micMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
              <button onClick={() => setSettingsOpen((v) => !v)} title="SARA settings" className={`p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 ${settingsOpen ? 'bg-white/10 text-white' : ''}`}>
                <Settings className="w-4 h-4" />
              </button>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10"><X className="w-4 h-4" /></button>
            </div>
          </div>

          {/* Honest status — never shows a listening state unless the mic is running */}
          <div className="px-4 py-2 border-b border-slate-100 bg-slate-50 flex items-center gap-2 shrink-0">
            <span className={`w-2.5 h-2.5 rounded-full ${status.dot} ${status.pulse ? 'animate-pulse' : ''}`} />
            <span className="text-xs font-medium text-slate-600">{status.label}</span>
            <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full ${micActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
              {micActive ? 'Microphone ON' : 'Microphone OFF'}
            </span>
          </div>

          {settingsOpen ? (
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-slate-50">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">SARA Settings</p>
              <Switch label="SARA Voice" hint="Wake word + spoken replies" checked={settings.voiceOn} onChange={(v) => updateSettings({ voiceOn: v })} />
              <Switch label="Mute Microphone" hint="Blocks listening but keeps replies" checked={settings.micMuted} onChange={(v) => updateSettings({ micMuted: v })} disabled={!settings.voiceOn} />
              <div className="pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">Voice volume</span>
                  <span className="text-xs text-slate-400">{Math.round(settings.volume * 10)} / 10</span>
                </div>
                <input type="range" min={0} max={1} step={0.1} value={settings.volume} onChange={(e) => updateSettings({ volume: Number(e.target.value) })} className="w-full accent-[#009944]" />
                <button onClick={() => speakText(buildLeaveAlert({ count: count || (queue.length > 0 ? 0 : 0), oldest }) || "Hello boss. This is a SARA voice test.", { volume: settings.volume, enabled: true })} className="mt-1 text-xs text-[#009944] font-medium hover:underline">Test voice</button>
              </div>
              <div className="border-t border-slate-200 pt-2">
                <Switch label="Voice alerts" hint="Proactively tell you about pending approvals" checked={settings.voiceAlerts} onChange={(v) => updateSettings({ voiceAlerts: v })} />
                <Switch label="Browser notifications" hint="Also pop a browser notification" checked={settings.browserNotifs} onChange={requestBrowser} />
              </div>
              <div className="border-t border-slate-200">
                <Switch label="AI understanding" hint="Use the server NLU when plain parsing fails" checked={settings.aiNlu} onChange={(v) => updateSettings({ aiNlu: v })} />
              </div>
              <div className="border-t border-slate-200 pt-2">
                <Switch label="Quiet hours" checked={settings.quietHours} onChange={(v) => updateSettings({ quietHours: v })} />
                {settings.quietHours && (
                  <div className="flex items-center gap-2 pt-2 text-sm">
                    <input type="time" value={settings.quietStart} onChange={(e) => updateSettings({ quietStart: e.target.value })} className="flex-1 h-9 rounded-lg border border-slate-300 px-2 text-sm" />
                    <span className="text-slate-400">to</span>
                    <input type="time" value={settings.quietEnd} onChange={(e) => updateSettings({ quietEnd: e.target.value })} className="flex-1 h-9 rounded-lg border border-slate-300 px-2 text-sm" />
                  </div>
                )}
              </div>
              {micNotice && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">{micNotice}</p>}
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-slate-50">
                {messages.length === 0 && (
                  <div className="text-center text-xs text-slate-400 mt-8">
                    Say "Sara" or "Core" to activate, then ask, e.g.<br />"what requires my attention?"<br />or "approve John's leave"
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-line ${m.from === 'user' ? 'bg-[#009944] text-white' : 'bg-white border border-slate-200 text-slate-700'}`}>
                      {m.text}
                      {m.requests?.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          {m.requests.map((r) => <RequestCard key={r.id} r={r} />)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {phase === PHASES.LISTEN && (
                  <div className="flex justify-center">
                    <div className="flex items-center gap-2 text-xs text-slate-400 py-1">
                      <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" /> Listening… speak now
                    </div>
                  </div>
                )}
                {phase === PHASES.THINK && (
                  <div className="flex justify-center">
                    <div className="flex items-center gap-1.5 text-xs text-slate-400 py-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Working…</div>
                  </div>
                )}
                {pendingConfirm && (
                  <div className="flex justify-start">
                    <div className="flex gap-2">
                      <button onClick={() => handleCommand('confirm', 'text')} disabled={busy} className="px-3 py-1.5 rounded-lg bg-[#009944] text-white text-xs font-medium disabled:opacity-50">Confirm</button>
                      <button onClick={() => handleCommand('cancel', 'text')} disabled={busy} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-medium disabled:opacity-50">Cancel</button>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-slate-200 p-2.5 shrink-0 bg-white">
                <div className="flex items-center gap-2">
                  <button
                    onClick={pushToTalk}
                    disabled={busy || !settings.voiceOn}
                    title={settings.voiceOn ? 'Push to talk (or say "Sara" / "Core")' : 'Voice mode is off'}
                    className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${micActive ? 'bg-rose-500 text-white animate-pulse' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} disabled:opacity-40`}
                    aria-label="Push to talk to SARA"
                  >
                    {settings.micMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  </button>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submitText()}
                    placeholder="Ask SARA..."
                    disabled={busy}
                    className="flex-1 h-9 rounded-full border border-slate-300 px-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]/30"
                  />
                  <button onClick={submitText} disabled={busy || !input.trim()} className="w-9 h-9 rounded-full bg-[#009944] text-white flex items-center justify-center shrink-0 disabled:opacity-40">
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

// Small indirection so the settings callback can request permission once,
// then flip the toggle only if notification access is possible.
function pushBrowserNotificationPerm() {
  try {
    if (!('Notification' in window)) return false
    if (Notification.permission === 'granted') return true
    if (Notification.permission === 'denied') return false
    Notification.requestPermission().then((p) => {
      if (p !== 'granted') return false
      return true
    })
    return true
  } catch {
    return false
  }
}