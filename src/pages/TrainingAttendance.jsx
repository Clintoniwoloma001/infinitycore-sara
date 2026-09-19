import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Award, Ban, Building2, CalendarDays, CheckCircle2, Clock3, Loader2, NotebookPen, ShieldCheck, UserRound, Users } from 'lucide-react'
import { trainingService } from '../services/trainingService'
import SignaturePad from '../components/SignaturePad'
import { normalizeEmployeeId } from '../utils/employeeId'
import { formatDate } from '../lib/utils'

function StepShell({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="w-full max-w-lg mx-auto px-4 py-6">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center"><Icon className="w-4.5 h-4.5 text-[#009944]" /></div>
          <div>
            <h2 className="font-semibold text-slate-900 text-base leading-tight">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

function BrandHeader() {
  return (
    <header className="bg-gradient-to-r from-[#007a36] to-[#009944] text-white">
      <div className="max-w-lg mx-auto px-4 py-5 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center"><Building2 className="w-5 h-5" /></div>
        <div>
          <p className="font-semibold leading-tight">InfinityCore</p>
          <p className="text-xs text-white/70">Training attendance &amp; completion</p>
        </div>
      </div>
    </header>
  )
}

function TrainingInfo({ session }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-sm">
      <div><p className="text-xs uppercase tracking-wide text-slate-400">Training</p><p className="font-semibold text-slate-900 leading-snug">{session.title}</p></div>
      {session.description && <p className="text-slate-600 text-xs leading-relaxed">{session.description}</p>}
      <div className="grid grid-cols-2 gap-3 pt-1 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1.5"><CalendarDays className="w-3.5 h-3.5 text-[#009944]" /> {formatDate(session.training_date)}</span>
        {session.start_time && <span className="inline-flex items-center gap-1.5"><Clock3 className="w-3.5 h-3.5 text-[#009944]" /> {session.start_time}{session.end_time ? ` – ${session.end_time}` : ''}</span>}
        {session.facilitator && <span className="inline-flex items-center gap-1.5"><UserRound className="w-3.5 h-3.5 text-[#009944]" /> {session.facilitator}</span>}
        <span className="inline-flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-[#009944]" /> {session.venue_label || (session.delivery_type === 'virtual' ? 'Virtual' : 'Physical')}</span>
      </div>
    </div>
  )
}

export default function TrainingAttendance() {
  const { token } = useParams()
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // identity
  const [employeeId, setEmployeeId] = useState('')
  const [identity, setIdentity] = useState(null)
  const [identityBusy, setIdentityBusy] = useState(false)

  // assessment
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [quizBusy, setQuizBusy] = useState(false)
  const [quizResult, setQuizResult] = useState(null)

  // signature + completion
  const [signature, setSignature] = useState(null)
  const [completing, setCompleting] = useState(false)
  const [done, setDone] = useState(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const context = await trainingService.getPublicTrainingAttendance(token)
        if (!active) return
        setSession(context)
      } catch (e) {
        if (!active) return
        setError(e?.message || 'This training attendance link could not be opened.')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [token])

  const resolveEmployee = async (event) => {
    event?.preventDefault()
    setError('')
    const value = normalizeEmployeeId(employeeId)
    if (!value) { setError('Enter your Employee ID to continue.'); return }
    setIdentityBusy(true)
    try {
      const result = await trainingService.resolvePublicTrainingEmployee(token, value)
      if (result.already_completed) {
        setDone(result)
        setError('')
      } else {
        setIdentity(result)
        setError('')
        if (result.assessment_required) {
          const loaded = await trainingService.loadPublicTrainingQuestions(token, value)
          setQuestions(loaded.questions || [])
        }
      }
    } catch (e) {
      setError(e?.message || 'Your Employee ID could not be verified.')
    } finally {
      setIdentityBusy(false)
    }
  }

  const submitQuiz = async (event) => {
    event?.preventDefault()
    setError('')
    const missing = questions.some((question) => !answers[question.id])
    if (missing) { setError('Answer every question before submitting.'); return }
    setQuizBusy(true)
    try {
      const result = await trainingService.submitPublicTrainingQuiz(
        token, normalizeEmployeeId(employeeId),
        questions.map((question) => ({ question_id: question.id, answer: answers[question.id] })),
      )
      setQuizResult(result)
      setError('')
    } catch (e) {
      setError(e?.message || 'The assessment could not be submitted.')
    } finally {
      setQuizBusy(false)
    }
  }

  const completeTraining = async () => {
    setError('')
    if (!signature) { setError('Please sign below to confirm your attendance.'); return }
    setCompleting(true)
    try {
      const signaturePath = await trainingService.uploadPublicTrainingSignature(token, signature)
      const result = await trainingService.completePublicTraining(token, normalizeEmployeeId(employeeId), signaturePath)
      setDone(result)
      setError('')
    } catch (e) {
      setError(e?.message || 'The completion could not be recorded. Please try again.')
    } finally {
      setCompleting(false)
    }
  }

  const restart = () => {
    setEmployeeId(''); setIdentity(null); setQuestions([]); setAnswers({}); setQuizResult(null); setSignature(null); setDone(null); setError('')
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <BrandHeader />
      {loading ? (
        <div className="max-w-lg mx-auto px-4 py-16 text-center space-y-3">
          <Loader2 className="w-8 h-8 mx-auto text-[#009944] animate-spin" />
          <p className="text-sm text-slate-500">Opening training attendance...</p>
        </div>
      ) : error && !session ? (
        <StepShell icon={Ban} title="Link unavailable" subtitle="Training attendance">
          <p className="text-sm text-slate-600">{error}</p>
        </StepShell>
      ) : !session ? null : done ? (
        <CompletionDone result={done} identity={identity} onRestart={restart} />
      ) : !identity ? (
        <StepShell icon={UserRound} title="Attendance confirmation" subtitle="Enter your Employee ID to continue">
          <TrainingInfo session={session} />
          {error && <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 text-sm">{error}</div>}
          <form onSubmit={resolveEmployee} className="mt-4 space-y-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Employee ID</label>
              <input
                autoFocus
                className="w-full h-12 rounded-xl border border-slate-300 px-4 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#009944]"
                placeholder="e.g. IMFB/26/0526"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                disabled={identityBusy}
              />
              <p className="text-xs text-slate-400 mt-1.5">Your ID is checked securely against this training's assigned participants.</p>
            </div>
            <button disabled={identityBusy} className="w-full h-12 rounded-xl bg-[#009944] text-white text-sm font-semibold hover:bg-[#007a36] disabled:opacity-50 inline-flex items-center justify-center gap-2">
              {identityBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Continue
            </button>
          </form>
        </StepShell>
      ) : questions.length === 0 && !quizResult ? (
        // No assessment required → straight to signature
        <SignatureStep session={session} identity={identity} signature={signature} setSignature={setSignature} error={error} busy={completing} onComplete={completeTraining} />
      ) : !quizResult ? (
        <StepShell icon={NotebookPen} title={`Knowledge check · ${questions.length} question${questions.length === 1 ? '' : 's'}`} subtitle="Your assigned questions, graded securely on our servers">
          <TrainingInfo session={session} />
          {error && <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 text-sm">{error}</div>}
          <div className="mt-4 space-y-4">
            {questions.map((question, index) => (
              <fieldset key={question.id} className="rounded-xl border border-slate-200 p-4">
                <p className="text-sm font-medium text-slate-800">Question {index + 1} of {questions.length}</p>
                <p className="text-sm text-slate-700 mt-2 leading-snug">{question.prompt}</p>
                <div className="mt-3 space-y-2">
                  {(question.options || []).map((option) => {
                    const selected = answers[question.id] === option
                    return (
                      <label key={option} className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm cursor-pointer transition ${selected ? 'border-[#009944] bg-emerald-50' : 'border-slate-200 hover:border-[#009944]/40'}`}>
                        <input type="radio" name={`q-${question.id}`} className="mt-0.5 accent-[#009944]" checked={selected} onChange={() => setAnswers((a) => ({ ...a, [question.id]: option }))} />
                        <span className="text-slate-700">{option}</span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>
            ))}
          </div>
          <button onClick={submitQuiz} disabled={quizBusy} className="mt-5 w-full h-12 rounded-xl bg-[#009944] text-white text-sm font-semibold hover:bg-[#007a36] disabled:opacity-50 inline-flex items-center justify-center gap-2">
            {quizBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Submit answers
          </button>
        </StepShell>
      ) : !quizResult.passed ? (
        <StepShell icon={Ban} title="NOT PASSED" subtitle="Assessment result">
          <TrainingInfo session={session} />
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <p className="font-semibold">You scored {quizResult.percentage ?? 0}% ({quizResult.score} of {quizResult.max_score}).</p>
            <p className="mt-1 text-xs">This training was not marked as completed. Please contact HR to discuss a reassessment.</p>
          </div>
        </StepShell>
      ) : (
        <SignatureStep
          session={session}
          identity={identity}
          quizResult={quizResult}
          signature={signature}
          setSignature={setSignature}
          error={error}
          busy={completing}
          onComplete={completeTraining}
        />
      )}
    </div>
  )
}

function SignatureStep({ session, identity, quizResult, signature, setSignature, error, busy, onComplete }) {
  return (
    <StepShell icon={NotebookPen} title="Training completion signature" subtitle="Please sign to confirm you attended and completed this training">
      <TrainingInfo session={session} />
      {identity && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 px-3 py-2 text-sm flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>Verified: <b>{identity.name_masked}</b> ({identity.employee_id}){quizResult?.passed ? ` · Passed ${quizResult.percentage ?? 0}%` : ''}</span>
        </div>
      )}
      {error && <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 text-sm">{error}</div>}
      <div className="mt-4">
        <SignaturePad onChange={setSignature} height={180} />
        <p className="text-xs text-slate-400 mt-2">Touch or mouse to sign. Sign inside the box above, then tap Complete Training.</p>
      </div>
      <button onClick={onComplete} disabled={busy} className="mt-4 w-full h-12 rounded-xl bg-[#009944] text-white text-sm font-semibold hover:bg-[#007a36] disabled:opacity-50 inline-flex items-center justify-center gap-2">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Complete Training
      </button>
    </StepShell>
  )
}

function CompletionDone({ result, identity, onRestart }) {
  const already = result.already_completed
  const blocked = already && (result.status === 'failed' || result.status === 'withdrawn')
  if (blocked) {
    return (
      <StepShell icon={Ban} title="Record already submitted" subtitle="InfinityCore training record">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-center space-y-2">
          <p className="font-semibold text-slate-900">This training record is marked {result.status}.</p>
          <p className="text-sm text-slate-600">Your completion was not recorded for this attempt. Please contact HR to discuss a reassessment.</p>
        </div>
      </StepShell>
    )
  }
  return (
    <StepShell icon={CheckCircle2} title={already ? 'Already completed' : 'Training completed'} subtitle="InfinityCore training record">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-center space-y-2">
        <Award className="w-10 h-10 mx-auto text-[#009944]" />
        <p className="font-semibold text-slate-900">{already ? 'Your completion was already recorded.' : 'Your attendance and completion have been recorded.'}</p>
        {identity?.name_masked && <p className="text-sm text-slate-600">{identity.name_masked}</p>}
        {result.certificate && (
          <div className="inline-flex flex-col items-center gap-1 rounded-lg bg-white border border-emerald-200 px-4 py-3 mt-2">
            <span className="text-xs uppercase tracking-wide text-slate-400">Certificate</span>
            <span className="font-mono text-sm font-semibold text-slate-800">{result.certificate.certificate_number}</span>
            {!already && <span className="text-xs text-slate-400">It will appear in your My Training record.</span>}
          </div>
        )}
      </div>
      {!already && <button onClick={onRestart} className="mt-4 w-full h-11 rounded-xl border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50">Close</button>}
    </StepShell>
  )
}