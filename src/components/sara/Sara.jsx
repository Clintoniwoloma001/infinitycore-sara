import React, { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Send, X, Volume2, VolumeX, Sparkles } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useMyLeaveApprovals } from '../../hooks/useMyLeaveApprovals'
import { runSaraCommand, executeConfirmedDecision } from '../../services/agentService'
import { parseSaraCommand } from '../../services/saraCommandParser'
import { formatDate } from '../../lib/utils'
import { LEAVE_TYPE_LABELS } from '../../services/leaveBalanceService'

const VOICE_PREF_KEY = 'sara_voice_enabled'
const GREETED_KEY = 'sara_greeted_session'

function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const u = new window.SpeechSynthesisUtterance(text)
    u.rate = 1
    u.pitch = 1
    window.speechSynthesis.speak(u)
  } catch { /* speech synthesis is a progressive enhancement, never fatal */ }
}

function getRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return null
  const rec = new SR()
  rec.continuous = false
  rec.interimResults = false
  rec.lang = 'en-US'
  return rec
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
  const { user, name: userName, role, isAdmin } = useAuth()
  const { queue, count, oldest, refresh } = useMyLeaveApprovals()

  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([]) // { from: 'sara'|'user', text, requests? }
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [voiceOn, setVoiceOn] = useState(() => { try { return localStorage.getItem(VOICE_PREF_KEY) !== 'off' } catch { return true } })
  const [pendingConfirm, setPendingConfirm] = useState(null) // { matches, decision, message }
  const [busy, setBusy] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const recognitionRef = useRef(null)

  useEffect(() => { setSpeechSupported(!!(window.SpeechRecognition || window.webkitSpeechRecognition)) }, [])

  useEffect(() => {
    try { localStorage.setItem(VOICE_PREF_KEY, voiceOn ? 'on' : 'off') } catch { /* no-op */ }
  }, [voiceOn])

  // One greeting per session, once we actually know there's something to say.
  useEffect(() => {
    if (!user || count === 0) return
    let already = false
    try { already = sessionStorage.getItem(GREETED_KEY) === '1' } catch { /* no-op */ }
    if (already) return
    try { sessionStorage.setItem(GREETED_KEY, '1') } catch { /* no-op */ }
    const greeting = `Hi Boss. You have ${count} pending leave approval${count === 1 ? '' : 's'}.${oldest ? ` The oldest request has been pending since ${formatDate(oldest.created_at)}.` : ''}`
    setMessages([{ from: 'sara', text: greeting }])
    if (voiceOn) speak(greeting)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, count])

  const say = (text, extra = {}) => {
    setMessages((m) => [...m, { from: 'sara', text, ...extra }])
    if (voiceOn) speak(text)
  }

  const handleCommand = async (raw, method) => {
    setMessages((m) => [...m, { from: 'user', text: raw }])
    setBusy(true)
    try {
      if (pendingConfirm) {
        const parsed = parseSaraCommand(raw)
        if (parsed.intent === 'CONFIRM') {
          const { matches, decision } = pendingConfirm
          setPendingConfirm(null)
          const results = await executeConfirmedDecision({ matches, decision, ctx: { approverId: user.id, approverName: userName, method }, command: raw })
          const okCount = results.filter((r) => r.ok).length
          await refresh()
          say(okCount === results.length
            ? `Done. I ${decision === 'approved' ? 'approved' : 'rejected'} ${okCount} leave request${okCount === 1 ? '' : 's'}.`
            : `I ${decision === 'approved' ? 'approved' : 'rejected'} ${okCount} of ${results.length} requests. One or more failed — please check Audit Logs.`)
          return
        }
        if (parsed.intent === 'CANCEL') {
          setPendingConfirm(null)
          say('Okay, cancelled — no changes made.')
          return
        }
        say('That action requires confirmation. Say "yes" to proceed or "cancel" to stop.')
        return
      }

      const result = await runSaraCommand({ command: raw, pool: queue, ctx: { userId: user.id, role, isAdmin } })
      if (result.type === 'confirm') {
        setPendingConfirm({ matches: result.matches, decision: result.decision })
        say(result.message, { requests: result.matches })
      } else if (result.type === 'list') {
        say(result.message, { requests: result.requests })
      } else {
        say(result.message)
      }
    } catch (e) {
      say(`I couldn't complete that — ${e?.message || 'something went wrong'}.`)
    } finally {
      setBusy(false)
    }
  }

  const submitText = () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    handleCommand(text, 'text')
  }

  const startListening = () => {
    const rec = getRecognition()
    if (!rec) { say("Voice input isn't supported in this browser — you can type instead.") ; return }
    recognitionRef.current = rec
    setListening(true)
    say("I'm listening.")
    rec.onresult = (e) => {
      const transcript = e.results?.[0]?.[0]?.transcript
      if (transcript) handleCommand(transcript, 'voice')
    }
    rec.onerror = () => { setListening(false); say("I didn't catch that — you can type instead.") }
    rec.onend = () => setListening(false)
    try { rec.start() } catch { setListening(false) }
  }

  const stopListening = () => {
    try { recognitionRef.current?.stop() } catch { /* no-op */ }
    setListening(false)
  }

  if (!user) return null

  return (
    <>
      {/* Floating launcher — never blocks core navigation */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full bg-[#0a0b0d] text-white shadow-xl flex items-center justify-center hover:scale-105 transition-transform"
        aria-label="Open SARA assistant"
      >
        {count > 0 && !open && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-semibold flex items-center justify-center">{count > 9 ? '9+' : count}</span>
        )}
        <Sparkles className="w-6 h-6 text-[#FF8C00]" />
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-40 w-[calc(100vw-2.5rem)] max-w-sm h-[520px] max-h-[70vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 bg-[#0a0b0d] text-white flex items-center justify-between shrink-0">
            <div>
              <div className="font-semibold text-sm flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-[#FF8C00]" /> SARA</div>
              <div className="text-[11px] text-white/50">Smart Automated Reporting &amp; Approval Assistant</div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setVoiceOn((v) => !v)} title={voiceOn ? 'Voice replies on' : 'Voice replies off'} className="text-white/60 hover:text-white">
                {voiceOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
              <button onClick={() => setOpen(false)} className="text-white/60 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-slate-50">
            {messages.length === 0 && (
              <div className="text-center text-xs text-slate-400 mt-8">
                Ask me things like<br />"show my pending leave approvals"<br />or "approve John's leave"
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
              {speechSupported && (
                <button
                  onClick={listening ? stopListening : startListening}
                  disabled={busy}
                  className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${listening ? 'bg-rose-500 text-white animate-pulse' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                  aria-label="Speak to SARA"
                >
                  {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
              )}
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
        </div>
      )}
    </>
  )
}
