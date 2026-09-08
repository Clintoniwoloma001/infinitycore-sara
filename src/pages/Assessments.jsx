import React, { useEffect, useState } from 'react'
import { ClipboardCheck, Clock, Plus, X, Loader2, CheckCircle2, AlertCircle, ListChecks } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { logAction } from '../services/supabaseService'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import { date, status } from './hrShared'
import HRJobs from './HRJobs'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const ASSESSMENT_TYPES = [
  { value: 'technical', label: 'Technical' },
  { value: 'behavioral', label: 'Behavioral' },
  { value: 'practical', label: 'Practical' },
  { value: 'psychometric', label: 'Psychometric' },
]

const PIPELINE = [
  { value: 'received', label: 'Received', color: 'slate' },
  { value: 'screening', label: 'Screening', color: 'blue' },
  { value: 'shortlisted', label: 'Shortlisted', color: 'amber' },
  { value: 'interview', label: 'Interview', color: 'violet' },
  { value: 'offer', label: 'Offer', color: 'cyan' },
  { value: 'hired', label: 'Hired', color: 'emerald' },
  { value: 'rejected', label: 'Rejected', color: 'rose' },
]

export default function Assessments() {
  const { user, name: userName } = useAuth()
  const [assessments, setAssessments] = useState([])
  const [candidates, setCandidates] = useState([])
  const [questions, setQuestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [showQuestions, setShowQuestions] = useState(null) // assessmentId
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState('')
  const [form, setForm] = useState({
    candidate_id: '',
    assessment_type: 'technical',
    test_name: '',
    pass_score: '70',
    total_score: '100',
    notes: '',
  })
  const [questionDraft, setQuestionDraft] = useState({ question_text: '', question_type: 'multiple_choice', correct_answer: '', options: '', difficulty: 'medium' })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [assessData, candData] = await Promise.all([
        supabase.from('hr_assessments').select('*').order('created_at', { ascending: false }),
        supabase.from('hr_candidates').select('id, full_name, email, application_status').order('created_at', { ascending: false }),
      ])
      if (assessData.error) throw assessData.error
      setAssessments(assessData.data || [])
      setCandidates(candData.data || [])
    } catch (e) {
      setError(e?.message || 'Failed to load assessments')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const create = async () => {
    setError('')
    setSuccess('')
    if (!form.candidate_id) { setError('Select a candidate.'); return }
    if (!form.test_name.trim()) { setError('Enter an assessment title.'); return }
    setBusy(true)
    try {
      const candidate = candidates.find((c) => c.id === form.candidate_id)
      const payload = {
        candidate_id: form.candidate_id,
        assessment_type: form.assessment_type,
        test_name: form.test_name,
        status: 'pending',
        pass_score: Number(form.pass_score) || 70,
        total_score: Number(form.total_score) || 100,
        notes: form.notes || null,
        created_by: user?.id,
      }
      const { data, error: insertErr } = await supabase.from('hr_assessments').insert([payload]).select().single()
      if (insertErr) throw insertErr

      await supabase.from('hr_candidates').update({ application_status: 'screening' }).eq('id', form.candidate_id)
      await logAction({ action: 'ASSESSMENT_CREATED', entityType: 'Assessment', entityId: data.id, details: `Assessment created for ${candidate?.full_name}`, userName })

      setSuccess(`Assessment "${form.test_name}" created for ${candidate?.full_name}.`)
      setShowForm(false)
      setForm({ candidate_id: '', assessment_type: 'technical', test_name: '', pass_score: '70', total_score: '100', notes: '' })
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to create assessment')
    } finally {
      setBusy(false)
    }
  }

  const loadQuestions = async (assessmentId) => {
    try {
      const { data, error } = await supabase.from('assessment_questions').select('*').eq('assessment_id', assessmentId).order('display_order', { ascending: true })
      if (error) throw error
      setQuestions(data || [])
    } catch {
      setQuestions([])
    }
  }

  const addQuestion = async () => {
    if (!questionDraft.question_text.trim()) return
    setBusy(true)
    try {
      const options = questionDraft.question_type === 'multiple_choice' && questionDraft.options
        ? questionDraft.options.split('\n').filter(Boolean)
        : []
      const { error } = await supabase.from('assessment_questions').insert([{
        assessment_id: showQuestions,
        question_text: questionDraft.question_text,
        question_type: questionDraft.question_type,
        correct_answer: questionDraft.correct_answer || null,
        options: options,
        difficulty: questionDraft.difficulty,
        display_order: questions.length,
      }])
      if (error) throw error
      setQuestionDraft({ question_text: '', question_type: 'multiple_choice', correct_answer: '', options: '', difficulty: 'medium' })
      await loadQuestions(showQuestions)
    } catch (e) {
      setError(e?.message || 'Failed to add question')
    } finally {
      setBusy(false)
    }
  }

  const deleteQuestion = async (id) => {
    if (!confirm('Delete this question?')) return
    try {
      await supabase.from('assessment_questions').delete().eq('id', id)
      await loadQuestions(showQuestions)
    } catch (e) {
      setError(e?.message || 'Failed to delete')
    }
  }

  const updateScore = async (id, score) => {
    try {
      const assessment = assessments.find((a) => a.id === id)
      const passed = Number(score) >= Number(assessment?.pass_score || 0)
      await supabase.from('hr_assessments').update({
        score: Number(score),
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('id', id)
      await logAction({ action: 'ASSESSMENT_SCORED', entityType: 'Assessment', entityId: id, details: `Score: ${score}/${assessment?.total_score || 100} (${passed ? 'Passed' : 'Failed'})`, userName })
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to update score')
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Assessments</h2>
          <p className="text-sm text-slate-500 mt-1">Create assessments, manage questions, and track candidate scores</p>
        </div>
        <button onClick={() => { setShowForm(true); setSuccess(''); setError('') }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
          <Plus className="w-4 h-4" /> New Assessment
        </button>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {success && (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {success}
        </div>
      )}

      {loading && <LoadingState label="Loading assessments..." />}
      {!loading && !error && assessments.length === 0 && <EmptyState title="No assessments yet" description="Create an assessment to evaluate candidates." />}
      {!loading && !error && assessments.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium">Assessment</th>
                <th className="px-6 py-3 font-medium">Candidate</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Score</th>
                <th className="px-6 py-3 font-medium">Questions</th>
                <th className="px-6 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assessments.map((a) => {
                const candidate = candidates.find((c) => c.id === a.candidate_id)
                const passed = a.score != null && Number(a.score) >= Number(a.pass_score || 0)
                return (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-900">{a.test_name || a.assessment_type || 'Assessment'}</div>
                      <div className="text-xs text-slate-400 capitalize">{a.assessment_type}</div>
                    </td>
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-700">{candidate?.full_name || '—'}</div>
                      <div className="text-xs text-slate-400">{candidate?.email || ''}</div>
                    </td>
                    <td className="px-6 py-3">{status(a.status, ['completed'])}</td>
                    <td className="px-6 py-3">
                      {a.score != null ? (
                        <span className={`font-medium ${passed ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {a.score}/{a.total_score || 100}
                          <span className="text-xs ml-1">({passed ? 'Passed' : 'Failed'})</span>
                        </span>
                      ) : a.status === 'pending' ? (
                        <span className="text-slate-400 text-xs">Awaiting completion</span>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3">
                      <button onClick={() => { setShowQuestions(a.id); loadQuestions(a.id) }} className="inline-flex items-center gap-1 text-xs text-[#009944] hover:underline">
                        <ListChecks className="w-3.5 h-3.5" /> Manage
                      </button>
                    </td>
                    <td className="px-6 py-3 text-right">
                      {a.status === 'pending' && (
                        <input
                          type="number"
                          placeholder="Score"
                          className="w-16 h-8 text-center rounded border border-slate-300 text-sm"
                          onBlur={(e) => e.target.value && updateScore(a.id, e.target.value)}
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Assessment Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">New Assessment</h3>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Candidate *</label>
                <select className={inputCls} value={form.candidate_id} onChange={set('candidate_id')}>
                  <option value="">Select candidate…</option>
                  {candidates.map((c) => <option key={c.id} value={c.id}>{c.full_name} {c.email ? `(${c.email})` : ''}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Assessment Title *</label>
                  <input className={inputCls} value={form.test_name} onChange={set('test_name')} placeholder="e.g. Technical Assessment" />
                </div>
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls} value={form.assessment_type} onChange={set('assessment_type')}>
                    {ASSESSMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Pass Score (%)</label>
                  <input type="number" className={inputCls} value={form.pass_score} onChange={set('pass_score')} />
                </div>
                <div>
                  <label className={labelCls}>Total Score</label>
                  <input type="number" className={inputCls} value={form.total_score} onChange={set('total_score')} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Notes</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.notes} onChange={set('notes')} placeholder="Instructions or notes…" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={create} disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />} Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Question Management Modal */}
      {showQuestions && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Assessment Questions</h3>
              <button onClick={() => setShowQuestions(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            {/* Existing questions */}
            <div className="space-y-3 mb-6">
              {questions.length === 0 && <p className="text-sm text-slate-400 text-center py-4">No questions yet. Add questions below.</p>}
              {questions.map((q, i) => (
                <div key={q.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-slate-400">Q{i + 1}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">{q.question_type?.replace(/_/g, ' ')}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">{q.difficulty}</span>
                      </div>
                      <p className="text-sm text-slate-800">{q.question_text}</p>
                      {q.options && q.options.length > 0 && (
                        <ul className="mt-2 text-xs text-slate-500 list-disc list-inside">
                          {q.options.map((opt, j) => <li key={j}>{opt}{q.correct_answer === opt ? ' ✓' : ''}</li>)}
                        </ul>
                      )}
                      {q.correct_answer && q.question_type !== 'multiple_choice' && (
                        <p className="text-xs text-emerald-600 mt-1">Answer: {q.correct_answer}</p>
                      )}
                    </div>
                    <button onClick={() => deleteQuestion(q.id)} className="text-rose-500 hover:text-rose-700 text-xs">Delete</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Add question form */}
            <div className="border-t border-slate-200 pt-4">
              <h4 className="text-sm font-medium text-slate-700 mb-3">Add Question</h4>
              <div className="space-y-3">
                <div>
                  <label className={labelCls}>Question Text</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={questionDraft.question_text} onChange={(e) => setQuestionDraft({ ...questionDraft, question_text: e.target.value })} placeholder="Enter the question…" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Question Type</label>
                    <select className={inputCls} value={questionDraft.question_type} onChange={(e) => setQuestionDraft({ ...questionDraft, question_type: e.target.value })}>
                      <option value="multiple_choice">Multiple Choice</option>
                      <option value="true_false">True / False</option>
                      <option value="short_answer">Short Answer</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Difficulty</label>
                    <select className={inputCls} value={questionDraft.difficulty} onChange={(e) => setQuestionDraft({ ...questionDraft, difficulty: e.target.value })}>
                      <option value="easy">Easy</option>
                      <option value="medium">Medium</option>
                      <option value="hard">Hard</option>
                    </select>
                  </div>
                </div>
                {questionDraft.question_type === 'multiple_choice' && (
                  <div>
                    <label className={labelCls}>Options (one per line)</label>
                    <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={questionDraft.options} onChange={(e) => setQuestionDraft({ ...questionDraft, options: e.target.value })} placeholder="Option A&#10;Option B&#10;Option C" />
                  </div>
                )}
                <div>
                  <label className={labelCls}>Correct Answer</label>
                  <input className={inputCls} value={questionDraft.correct_answer} onChange={(e) => setQuestionDraft({ ...questionDraft, correct_answer: e.target.value })} placeholder="Enter the correct answer" />
                </div>
                <button onClick={addQuestion} disabled={busy || !questionDraft.question_text.trim()} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add Question
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
