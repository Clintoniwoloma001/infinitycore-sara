import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Loader2, ShieldAlert, Timer, XCircle } from 'lucide-react'
import CareersShell from './CareersShell'
import { careerService } from '../../services/careerService'

// Candidate CBT interface. Runs fullscreen with anti-cheat monitoring,
// per-question autosave and an enforced time limit. All mutation flows
// through the token-gated public RPCs.

const fmtTime = (s) => {
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export default function AssessmentTake() {
  const { token } = useParams()
  const [asset, setAsset] = useState(null) // { assignment, template, candidate, attempts }
  const [phase, setPhase] = useState('load') // load | intro | running | submit | result | error
  const [errorMsg, setErrorMsg] = useState('')
  const [attempt, setAttempt] = useState(null)
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [retakeMsg, setRetakeMsg] = useState('')
  const [closedReason, setClosedReason] = useState('')

  const endAtRef = useRef(null)
  const activeRef = useRef(false)
  const attemptIdRef = useRef(null)
  const answersRef = useRef({})
  const saveTimers = useRef({})
  const inactivityTimer = useRef(null)
  const lastActivity = useRef(Date.now())
  const fullscreenExits = useRef(0)
  const focusFlickers = useRef(0)
  const lastBlur = useRef(Date.now())
  const visibilityHidden = useRef(false)

  useEffect(() => {
    let active = true
    const load = async () => {
      setPhase('load')
      try {
        const data = await careerService.getAssessment(token)
        if (active) { setAsset(data); setPhase('intro') }
      } catch (e) {
        if (active) { setPhase('error'); setErrorMsg(e?.message || 'This assessment could not be loaded.') }
      }
    }
    load()
    return () => { active = false }
  }, [token])

  const recordEvent = useCallback(async (eventType, metadata = {}) => {
    if (!activeRef.current || !attemptIdRef.current) return
    try {
      const res = await careerService.recordEvent(token, attemptIdRef.current, eventType, metadata)
      if (res?.closed) {
        activeRef.current = false
        setClosedReason(res?.close_reason || 'This assessment attempt was automatically closed.')
        setPhase('result')
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      }
    } catch { /* best-effort monitoring */ }
  }, [token])

  const updateAnswer = useCallback((qid, value) => {
    setAnswers((prev) => {
      const next = { ...prev, [qid]: value }
      answersRef.current = next
      return next
    })
    if (attempt) {
      clearTimeout(saveTimers.current[qid])
      saveTimers.current[qid] = setTimeout(() => {
        careerService.saveAnswer(token, attempt.id, qid, value).catch(() => {})
      }, 700)
    }
  }, [token, attempt])

  const startAttempt = async () => {
    const start = async () => {
      try {
        const res = await careerService.startAttempt(token)
        setAttempt(res.attempt)
        setQuestions(res.questions || [])
        setAnswers(res.answers || {})
        answersRef.current = res.answers || {}
        const durationMin = Number(res.template?.duration_minutes || 30) * 60
        const startedAt = res.resumed ? new Date(res.attempt.started_at || Date.now()).getTime() : Date.now()
        endAtRef.current = startedAt + durationMin * 1000
        setSecondsLeft(Math.max(0, Math.floor((endAtRef.current - Date.now()) / 1000)))
        activeRef.current = true
        attemptIdRef.current = res.attempt.id
        lastActivity.current = Date.now()
        startWatchers(res.attempt.id)
        setPhase('running')
      } catch (e) {
        setPhase('error')
        setErrorMsg(e?.message || 'The assessment could not be started.')
      }
    }
    if (!document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen?.() } catch { /* fullscreen unavailable — continue monitored */ }
    }
    start()
  }

  // --- anti-cheat watchers ---
  const startWatchers = (attemptId) => {
    const onVisibility = () => {
      if (document.hidden && !visibilityHidden.current) {
        visibilityHidden.current = true
        lastActivity.current = Date.now()
        recordEvent('suspicious_activity', { screen: 'hidden' })
      } else if (!document.hidden) {
        visibilityHidden.current = false
      }
    }
    const onBlur = () => {
      const now = Date.now()
      if (now - lastBlur.current < 2500) {
        focusFlickers.current += 1
        if (focusFlickers.current >= 3) recordEvent('rapid_focus_changes', { count: focusFlickers.current })
      }
      lastBlur.current = now
      lastActivity.current = now
    }
    const onPaste = () => recordEvent('paste_attempt', {})
    const onCtx = (e) => { e.preventDefault(); recordEvent('context_menu', {}) }
    const onFsChange = () => {
      if (!document.fullscreenElement) {
        fullscreenExits.current += 1
        if (fullscreenExits.current === 1) recordEvent('suspicious_activity', { screen: 'exited_fullscreen' })
        if (fullscreenExits.current >= 3) recordEvent('multiple_fullscreen_exit', { count: fullscreenExits.current })
      }
    }
    const onActivity = () => { lastActivity.current = Date.now() }
    const tickInactivity = () => {
      const idleMs = Date.now() - lastActivity.current
      if (idleMs > 120000) {
        recordEvent('excessive_inactivity', { seconds: Math.floor(idleMs / 1000) })
        lastActivity.current = Date.now()
      }
      inactivityTimer.current = setTimeout(tickInactivity, 30000)
    }
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = '' }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    document.addEventListener('paste', onPaste)
    document.addEventListener('contextmenu', onCtx)
    document.addEventListener('fullscreenchange', onFsChange)
    window.addEventListener('mousemove', onActivity)
    window.addEventListener('keydown', onActivity)
    window.addEventListener('beforeunload', onBeforeUnload)
    inactivityTimer.current = setTimeout(tickInactivity, 30000)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('contextmenu', onCtx)
      document.removeEventListener('fullscreenchange', onFsChange)
      window.removeEventListener('mousemove', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('beforeunload', onBeforeUnload)
      clearTimeout(inactivityTimer.current)
    }
  }

  const submit = useCallback(async (auto = false) => {
    if (submitting || !attempt) return
    setSubmitting(true)
    setPhase('submit')
    try {
      const res = await careerService.submitAttempt(token, attempt.id, answersRef.current)
      setResult(res)
      setPhase('result')
    } catch (e) {
      setPhase('running')
      setErrorMsg(auto ? '' : e?.message || 'Your answers could not be submitted. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [submitting, attempt, token])

  // timer
  useEffect(() => {
    if (phase !== 'running') return
    const iv = setInterval(() => {
      const left = Math.max(0, Math.floor((endAtRef.current - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) {
        clearInterval(iv)
        submit(true)
      }
    }, 1000)
    return () => clearInterval(iv)
  }, [phase, submit])

  const requestRetake = async () => {
    if (!attempt) return
    try {
      await careerService.requestRetake(token, attempt.id, 'I would like a retake after a technical interruption.')
      setRetakeMsg('Your retake request has been submitted for review.')
    } catch (e) {
      setRetakeMsg(e?.message || 'Your retake request could not be submitted.')
    }
  }

  const answeredCount = Object.values(answers).filter((a) => a !== undefined && a !== null && a !== '' && !(Array.isArray(a) && a.length === 0)).length
  const needsFullscreen = phase === 'intro' && asset?.template?.anti_cheat?.require_fullscreen !== false

  // ================= render =================
  if (phase === 'load') {
    return <CareersShell compact><div className="flex items-center justify-center py-20 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading assessment…</div></CareersShell>
  }
  if (phase === 'error') {
    return (
      <CareersShell compact>
        <div className="bg-white border border-slate-200 rounded-2xl p-8 max-w-lg mx-auto text-center">
          <AlertTriangle className="w-10 h-10 text-rose-500 mx-auto mb-3" />
          <h1 className="text-lg font-bold text-slate-900">Assessment unavailable</h1>
          <p className="text-sm text-slate-500 mt-2">{errorMsg}</p>
          <Link to="/careers" className="inline-block mt-5 text-sm font-medium text-[#009944] hover:underline">Back to jobs</Link>
        </div>
      </CareersShell>
    )
  }

  // result (after submit, closed by flags, or timeout)
  if (phase === 'result' && result) {
    const passed = result.passed
    return (
      <CareersShell compact>
        <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl p-8 text-center">
          {passed ? <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" /> : <XCircle className="w-14 h-14 text-rose-500 mx-auto mb-4" />}
          <h1 className="text-xl font-bold text-slate-900">{passed ? 'Assessment passed' : 'Assessment not passed'}</h1>
          <p className="text-sm text-slate-500 mt-2">You scored <span className="font-semibold text-slate-800">{result.percentage}%</span> (pass mark {result.pass_mark}%)</p>
          {(result.attempt?.flags_count > 0 || result.attempt?.flagged) && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-4">Your attempt was reviewed by our monitoring system. The result is subject to HR review.</p>
          )}
          {!passed && (
            <button onClick={requestRetake} disabled={!!retakeMsg} className="mt-6 rounded-lg bg-[#009944] text-white px-6 py-2.5 text-sm font-semibold hover:bg-[#00813a] disabled:opacity-60">
              {retakeMsg || 'Request a retake'}
            </button>
          )}
          {retakeMsg && <p className="text-xs text-slate-500 mt-2">{retakeMsg}</p>}
          <Link to="/careers" className="inline-block mt-6 text-sm font-medium text-slate-500 hover:text-[#009944]">Return to careers</Link>
        </div>
      </CareersShell>
    )
  }

  // closed by flags before any submit response
  if (phase === 'result' && closedReason) {
    return (
      <CareersShell compact>
        <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl p-8 text-center">
          <ShieldAlert className="w-14 h-14 text-amber-500 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-slate-900">Assessment closed</h1>
          <p className="text-sm text-slate-500 mt-2">{closedReason}</p>
          <Link to="/careers" className="inline-block mt-6 text-sm font-medium text-[#009944] hover:underline">Return to careers</Link>
        </div>
      </CareersShell>
    )
  }

  if (phase === 'submit') {
    return <CareersShell compact><div className="flex items-center justify-center py-20 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Submitting your assessment…</div></CareersShell>
  }

  if (phase === 'intro' && asset) {
    const tpl = asset.template || {}
    const done = (asset.attempts || []).filter((a) => ['submitted', 'flagged', 'auto_submitted'].includes(a.status))
    const inProgress = (asset.attempts || []).find((a) => ['started', 'in_progress'].includes(a.status))
    const totalAllowed = 1 + (asset.assignment?.retake_limit ?? 0)
    const limitReached = done.length >= totalAllowed && !inProgress
    return (
      <CareersShell compact>
        <div className="max-w-2xl mx-auto bg-white border border-slate-200 rounded-2xl p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400 font-medium">Assessment</p>
              <h1 className="text-xl font-bold text-slate-900 mt-1">{tpl.title || 'Skill assessment'}</h1>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm text-slate-600"><Timer className="w-4 h-4" /> {tpl.duration_minutes || 30} minutes</span>
          </div>
          {tpl.description && <p className="text-sm text-slate-500 mt-4">{tpl.description}</p>}
          {tpl.instructions && (
            <div className="mt-4 rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm text-slate-600 whitespace-pre-line"><span className="font-medium text-slate-800">Instructions:</span> {tpl.instructions}</div>
          )}
          <div className="mt-5 rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
            <p className="font-medium inline-flex items-center gap-1.5"><ShieldAlert className="w-4 h-4" /> Integrity notice</p>
            <ul className="list-disc ml-5 mt-2 space-y-1 text-xs">
              <li>Answers are saved automatically as you go.</li>
              <li>Leaving the assessment window, switching tabs or exiting fullscreen is monitored and can flag your attempt.</li>
              <li>Copy/paste and right-click are disabled during the assessment.</li>
              {(asset.assignment?.retake_limit ?? 0) > 0 && <li>Limit: {asset.assignment.retake_limit} retake{(asset.assignment.retake_limit || 0) > 1 ? 's' : ''} if needed.</li>}
            </ul>
          </div>
          {(asset.attempts || []).map((a, i) => (
            <div key={a.id || i} className="mt-4 text-xs text-slate-500 flex items-center justify-between border-t border-slate-100 pt-3">
              <span>Attempt {a.attempt_number}</span>
              <span>{a.status === 'submitted' ? `${a.percentage}%` : a.status}{a.flagged ? ' · flagged' : ''}</span>
            </div>
          ))}
          {needsFullscreen && (
            <p className="mt-4 text-xs text-slate-400 inline-flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> This assessment runs in fullscreen mode for integrity.</p>
          )}
          <button onClick={startAttempt} disabled={limitReached} className="mt-6 w-full rounded-lg bg-[#009944] text-white py-3 text-sm font-semibold hover:bg-[#00813a] disabled:opacity-50 disabled:cursor-not-allowed transition">
            {limitReached ? 'Retake limit reached' : inProgress ? 'Resume assessment' : done.length > 0 ? 'Start retake' : 'Begin assessment'}
          </button>
        </div>
      </CareersShell>
    )
  }

  if (phase === 'running' && questions.length > 0) {
    return (
      <div className="min-h-screen bg-slate-100">
        <div className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
          <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">{questions.length} questions</p>
              <p className="text-xs text-slate-500">{answeredCount} answered</p>
            </div>
            <div className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-bold ${secondsLeft < 60 ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-700'}`}>
              <Timer className="w-4 h-4" /> {fmtTime(secondsLeft)}
            </div>
          </div>
        </div>
        <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
          {errorMsg && <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm p-3">{errorMsg}</div>}
          {questions.map((q, qi) => (
            <Question
              key={q.id}
              q={q}
              index={qi}
              value={answers[q.id]}
              onAnswer={(v) => updateAnswer(q.id, v)}
            />
          ))}
          <div className="sticky bottom-4 bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between shadow-lg">
            <p className="text-sm text-slate-500">{answeredCount} of {questions.length} answered</p>
            <button
              onClick={() => submit(false)}
              disabled={submitting}
              className="rounded-lg bg-[#009944] text-white px-8 py-2.5 text-sm font-semibold hover:bg-[#00813a] disabled:opacity-60"
            >
              {submitting ? <><Loader2 className="w-4 h-4 animate-spin inline mr-1.5" /> Submitting…</> : 'Submit assessment'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return null
}

function Question({ q, index, value, onAnswer }) {
  const [ranked, setRanked] = useState(Array.isArray(value) ? value : (q.options || []))

  const setRank = (arr) => { setRanked(arr); onAnswer(arr) }
  const move = (dir, idx) => {
    const next = [...ranked]
    const target = idx + dir
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    setRank(next)
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6" data-question-id={q.id}>
      <p className="text-sm font-medium text-slate-900"><span className="text-[#009944] font-bold">{index + 1}.</span> {q.question_text}</p>
      <p className="text-xs text-slate-400 mt-1 mb-4">({q.marks} mark{q.marks > 1 ? 's' : ''}{q.competency ? ` · ${q.competency}` : ''})</p>

      {(q.question_type === 'multiple_choice' || q.question_type === 'true_false') && (
        <div className="space-y-2">
          {(q.options || []).map((opt, i) => (
            <label key={i} className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm cursor-pointer transition ${value === opt ? 'border-[#009944] bg-emerald-50/50 font-medium' : 'border-slate-200 hover:border-slate-300'}`}>
              <input type="radio" name={`q-${q.id}`} className="accent-[#009944]" checked={value === opt} onChange={() => onAnswer(opt)} />
              {opt}
            </label>
          ))}
        </div>
      )}

      {q.question_type === 'multiple_select' && (
        <div className="space-y-2">
          {(q.options || []).map((opt, i) => {
            const arr = Array.isArray(value) ? value : []
            const checked = arr.includes(opt)
            return (
              <label key={i} className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm cursor-pointer transition ${checked ? 'border-[#009944] bg-emerald-50/50 font-medium' : 'border-slate-200 hover:border-slate-300'}`}>
                <input
                  type="checkbox"
                  className="accent-[#009944]"
                  checked={checked}
                  onChange={() => onAnswer(checked ? arr.filter((a) => a !== opt) : [...arr, opt])}
                />
                {opt}
              </label>
            )
          })}
        </div>
      )}

      {q.question_type === 'numerical' && (
        <input
          type="text"
          inputMode="decimal"
          value={value ?? ''}
          onChange={(e) => onAnswer(e.target.value)}
          placeholder="Enter your numerical answer…"
          className="w-full sm:w-72 h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
        />
      )}

      {q.question_type === 'ranking' && (
        <div className="space-y-2 max-w-md">
          {ranked.map((opt, i) => (
            <div key={opt} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-xs flex items-center justify-center font-bold">{i + 1}</span>
              <span className="flex-1">{opt}</span>
              <button type="button" onClick={() => move(-1, i)} disabled={i === 0} className="text-slate-400 hover:text-[#009944] disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
              <button type="button" onClick={() => move(1, i)} disabled={i === ranked.length - 1} className="text-slate-400 hover:text-[#009944] disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}