import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Award, BookOpen, CheckCircle2, ChevronRight, Clock3, Download, Loader2, Send, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import SignaturePad from '../components/SignaturePad'
import TrainingCertificate from '../components/training/TrainingCertificate'
import { downloadBlob, trainingCertificateToPdf } from '../lib/trainingCertificatePdf'
import { trainingService, formatTrainingType, hours } from '../services/trainingService'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { formatDate } from '../lib/utils'

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

export default function MyTraining() {
  const { name } = useAuth()
  const [assignments, setAssignments] = useState([])
  const [records, setRecords] = useState([])
  const [assignment, setAssignment] = useState(null)
  const [answers, setAnswers] = useState({})
  const [signature, setSignature] = useState(null)
  const [declaration, setDeclaration] = useState(false)
  const [certificate, setCertificate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const certificateRef = useRef(null)

  const load = async () => {
    setLoading(true); setError('')
    try {
      const [assigned, completed] = await Promise.all([trainingService.getMyAssignments(), trainingService.listMyRecords()])
      setAssignments(assigned)
      setRecords(completed)
    } catch (e) {
      setError(e?.message || 'Your training could not be loaded.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const open = async (participantId) => {
    setBusy(true); setError(''); setMessage('')
    try {
      const data = await trainingService.getMyAssignment(participantId)
      setAssignment(data)
      setAnswers({})
      setSignature(null)
      setDeclaration(false)
    } catch (e) {
      setError(e?.message || 'This training assignment could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!assignment?.participant?.id) return
    if (!declaration) { setError('Accept the declaration before submitting.') ; return }
    if (!signature) { setError('Sign the declaration before submitting.') ; return }
    setBusy(true); setError(''); setMessage('')
    try {
      const payload = Object.entries(answers).map(([question_id, answer]) => ({ question_id, answer }))
      const result = await trainingService.submitAssignment({ participantId: assignment.participant.id, answers: payload, signature, declarationText: 'I declare that I completed this training and submitted these answers myself.' })
      setCertificate(result.certificate)
      setMessage(result.passed ? 'Training submitted successfully.' : 'Training submitted. The assessment result is recorded as not passed.')
      setAssignment(null)
      await load()
    } catch (e) {
      setError(e?.message || 'Training submission failed.')
    } finally {
      setBusy(false)
    }
  }

  const downloadCertificate = async () => {
    if (!certificateRef.current || !certificate) return
    setBusy(true); setError('')
    try {
      const blob = await trainingCertificateToPdf(certificateRef.current, `${certificate.certificate_number}.pdf`)
      downloadBlob(blob, `${certificate.certificate_number}.pdf`)
      if (certificate.id && !certificate.pdf_path) {
        const stored = await trainingService.storeCertificatePdf(certificate.id, blob).catch(() => null)
        if (stored?.pdf_path) setCertificate((current) => ({ ...current, pdf_path: stored.pdf_path }))
      }
    } catch (e) {
      setError(e?.message || 'Certificate PDF could not be generated.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading your training..." />

  return <div className="space-y-6">
    <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#009944]">Employee learning</p><h1 className="text-2xl font-semibold text-slate-900 mt-1">My Training</h1><p className="text-sm text-slate-500 mt-1">Complete assigned training, submit your declaration, and keep your certificates.</p></div>
    {error && <ErrorState message={error} />}
    {message && <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 px-4 py-3 text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />{message}</div>}

    {!assignment && <>
      <section><div className="flex items-center justify-between mb-3"><div><h2 className="font-semibold text-slate-900">Assigned training</h2><p className="text-sm text-slate-500">Completed records cannot be edited.</p></div><span className="text-xs text-slate-400">{assignments.filter((item) => !['completed', 'failed'].includes(item.status)).length} open</span></div>{assignments.length === 0 ? <EmptyState title="No training assigned" description="New assignments from HR will appear here." /> : <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{assignments.map((item) => <AssignmentCard key={item.id} item={item} onOpen={() => open(item.id)} busy={busy} />)}</div>}</section>
      <section><div className="mb-3"><h2 className="font-semibold text-slate-900">Completed records</h2><p className="text-sm text-slate-500">Your individual training hours are calculated from these immutable records.</p></div>{records.length === 0 ? <EmptyState title="No completed training yet" /> : <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-slate-500"><tr>{['Training', 'Date', 'Hours', 'Assessment', 'Certificate'].map((label) => <th key={label} className="px-4 py-3 font-medium whitespace-nowrap">{label}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{records.map((record) => { const cert = record.training_certificates?.[0] || record.training_certificates; return <tr key={record.id}><td className="px-4 py-3"><p className="font-medium text-slate-900">{record.training_title}</p><p className="text-xs text-slate-400">{formatTrainingType(record.training_type)}</p></td><td className="px-4 py-3 whitespace-nowrap">{formatDate(record.training_date)}</td><td className="px-4 py-3">{hours(record.duration_minutes)}h</td><td className="px-4 py-3">{record.assessment_percentage == null ? 'Not required' : `${record.assessment_percentage}% ${record.assessment_passed ? '(Pass)' : '(Fail)'}`}</td><td className="px-4 py-3">{cert?.certificate_number ? <Link className="inline-flex items-center gap-1 text-[#009944] hover:underline" to={`/certificate/verify/${encodeURIComponent(cert.certificate_number)}`} target="_blank"><Award className="w-4 h-4" /> View</Link> : '—'}</td></tr> })}</tbody></table></div>}</section>
    </>}

    {assignment && <AssignmentForm assignment={assignment} answers={answers} setAnswers={setAnswers} signature={signature} setSignature={setSignature} declaration={declaration} setDeclaration={setDeclaration} busy={busy} onBack={() => setAssignment(null)} onSubmit={submit} />}
    {certificate && <section className="bg-white border border-emerald-200 rounded-xl p-5"><div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4"><div><h2 className="font-semibold text-slate-900">Certificate ready</h2><p className="text-sm text-slate-500 mt-1">{certificate.certificate_number}</p></div><button disabled={busy} onClick={downloadCertificate} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60"><Download className="w-4 h-4" /> Download PDF</button></div><div className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3"><TrainingCertificate ref={certificateRef} certificate={certificate} employeeName={name} /></div></section>}
  </div>
}

function AssignmentCard({ item, onOpen, busy }) {
  const session = item.training_sessions || {}
  const isDone = ['completed', 'failed'].includes(item.status)
  return <div className="bg-white border border-slate-200 rounded-xl p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-[#009944] font-semibold">{formatTrainingType(session.training_type)}</p><h3 className="font-semibold text-slate-900 mt-1 truncate">{session.title || 'Training session'}</h3><p className="text-sm text-slate-500 mt-2 line-clamp-2">{session.description || 'Review the session information and complete the assigned record.'}</p></div><div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center"><BookOpen className="w-4 h-4 text-[#009944]" /></div></div><div className="flex flex-wrap gap-x-4 gap-y-2 mt-4 text-xs text-slate-500"><span className="inline-flex items-center gap-1"><CalendarDays className="w-3.5 h-3.5" />{formatDate(session.training_date)}</span><span className="inline-flex items-center gap-1"><Clock3 className="w-3.5 h-3.5" />{hours(session.duration_minutes)}h</span><span className="inline-flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" />{session.assessment_required ? 'Assessment' : 'Attendance record'}</span></div><div className="mt-5 flex items-center justify-between"><span className={`text-xs font-medium capitalize ${item.status === 'completed' ? 'text-emerald-600' : item.status === 'failed' ? 'text-rose-600' : 'text-amber-600'}`}>{item.status.replace(/_/g, ' ')}</span>{!isDone && <button onClick={onOpen} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-medium text-[#009944] hover:underline">Open training <ChevronRight className="w-4 h-4" /></button>}</div></div>
}

function AssignmentForm({ assignment, answers, setAnswers, signature, setSignature, declaration, setDeclaration, busy, onBack, onSubmit }) {
  const session = assignment.session || {}
  const questions = assignment.questions || []
  const setAnswer = (id, value) => setAnswers((current) => ({ ...current, [id]: value }))
  return <section className="space-y-5"><button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#009944]"><ArrowLeft className="w-4 h-4" /> Back to assignments</button><div className="bg-white border border-slate-200 rounded-xl p-5"><div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-[#009944] font-semibold">{formatTrainingType(session.training_type)}</p><h2 className="text-xl font-semibold text-slate-900 mt-1">{session.title}</h2><p className="text-sm text-slate-500 mt-2 max-w-2xl">{session.description || 'Please review the session details before completing your record.'}</p></div><div className="text-sm text-right text-slate-500"><p>{formatDate(session.training_date)}</p><p>{hours(session.duration_minutes)} hours · {session.facilitator}</p></div></div><div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5"><Info label="Location" value={session.location || 'Not specified'} /><Info label="Time" value={`${session.start_time || '—'} - ${session.end_time || '—'}`} /><Info label="Assigned question set" value={assignment.participant.question_set_number ? `Set ${assignment.participant.question_set_number}` : 'Not required'} /></div></div>{session.assessment_required && <div className="bg-white border border-slate-200 rounded-xl p-5"><div className="flex items-center justify-between mb-5"><div><h3 className="font-semibold text-slate-900">Assigned assessment</h3><p className="text-sm text-slate-500 mt-1">Answer every question, then submit once. Submitted answers cannot be edited.</p></div><span className="text-xs text-slate-400">{questions.length} questions</span></div><div className="space-y-5">{questions.map((question, index) => <Question key={question.id} question={question} index={index} value={answers[question.id]} onChange={(value) => setAnswer(question.id, value)} />)}</div></div>}<div className="bg-white border border-slate-200 rounded-xl p-5"><h3 className="font-semibold text-slate-900">Declaration and signature</h3><p className="text-sm text-slate-500 mt-1">I declare that I completed this training and submitted these answers myself.</p><label className="flex items-start gap-2 mt-4 text-sm text-slate-700"><input type="checkbox" className="mt-0.5 accent-[#009944]" checked={declaration} onChange={(e) => setDeclaration(e.target.checked)} />I confirm this declaration.</label><div className="mt-5"><label className="block text-sm font-medium text-slate-700 mb-2">Signature</label><SignaturePad onChange={setSignature} /></div><div className="mt-5 flex justify-end"><button onClick={onSubmit} disabled={busy || !declaration || !signature} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Submit training record</button></div></div></section>
}

function Question({ question, index, value, onChange }) {
  const options = question.options || []
  return <div className="rounded-lg border border-slate-200 p-4"><p className="text-sm font-medium text-slate-800"><span className="text-[#009944] mr-2">{index + 1}.</span>{question.prompt}</p>{question.question_type === 'multiple_choice' || question.question_type === 'true_false' ? <div className="mt-3 space-y-2">{(question.question_type === 'true_false' ? ['True', 'False'] : options).map((option) => <label key={option} className="flex items-center gap-2 text-sm text-slate-600"><input type="radio" name={question.id} checked={value === option} onChange={() => onChange(option)} className="accent-[#009944]" />{option}</label>)}</div> : question.question_type === 'multiple_select' ? <div className="mt-3 space-y-2">{options.map((option) => { const selected = Array.isArray(value) && value.includes(option); return <label key={option} className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={selected} onChange={(e) => { const next = new Set(Array.isArray(value) ? value : []); if (e.target.checked) next.add(option); else next.delete(option); onChange([...next].sort()) }} className="accent-[#009944]" />{option}</label> })}</div> : <input className={`${inputCls} mt-3`} type={question.question_type === 'numerical' ? 'number' : 'text'} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder="Your answer" />}</div>
}

function Info({ label, value }) { return <div className="rounded-lg bg-slate-50 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p><p className="text-sm font-medium text-slate-700 mt-1 truncate">{value}</p></div> }
