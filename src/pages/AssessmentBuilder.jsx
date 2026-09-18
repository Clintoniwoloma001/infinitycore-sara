import React, { useEffect, useState } from 'react'
import { Bot, CheckCircle2, Loader2, Plus, Save, Trash2, X } from 'lucide-react'
import { assessmentService } from '../services/assessmentService'
import { recruitmentService } from '../services/recruitmentService'
import { date, ModuleTable } from './hrShared'
import { ErrorState } from '../components/PageStates'
import { StatusBadge } from '../lib/utils'

const Q_TYPES = ['multiple_choice', 'true_false', 'numerical', 'multiple_select', 'ranking']
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

const emptyQuestion = { question_text: '', question_type: 'multiple_choice', options: ['', '', '', ''], correct_answer: '', marks: 1, difficulty: 'medium', competency: '' }

function parseAnswer(q) {
  if (q.question_type === 'multiple_select' || q.question_type === 'ranking') {
    try { return JSON.parse(q.correct_answer || '[]') } catch { return [] }
  }
  return q.correct_answer
}

function buildRow(q) {
  const options = (q.options || []).filter((o) => String(o).trim() !== '')
  const answer = q.question_type === 'multiple_select' || q.question_type === 'ranking'
    ? parseAnswer(q)
    : q.question_type === 'numerical' ? String(q.correct_answer)
      : q.correct_answer
  return {
    question_text: q.question_text.trim(),
    question_type: q.question_type,
    options: q.question_type === 'true_false' ? ['True', 'False'] : options,
    correct_answer: q.question_type === 'true_false' ? String(answer).toLowerCase() === 'true' ? 'True' : 'False' : answer ?? null,
    marks: Number(q.marks || 1),
    difficulty: q.difficulty || 'medium',
    competency: q.competency || null,
  }
}

export default function AssessmentBuilder() {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [selected, setSelected] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showSara, setShowSara] = useState(false)
  const [createForm, setCreateForm] = useState({ title: '', job_id: '', category: 'technical', duration_minutes: 30, pass_mark: 60, instructions: '' })
  const [qDraft, setQDraft] = useState(emptyQuestion)
  const [bulkJson, setBulkJson] = useState('')
  const [jobs, setJobs] = useState([])
  const [sara, setSara] = useState({ job_id: '', category: 'technical', count: 10, duration_minutes: 30, pass_mark: 60 })
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  const loadTemplates = async () => {
    setLoading(true)
    setError('')
    try {
      setTemplates((await assessmentService.listTemplates(filter ? { status: filter } : {})) || [])
    } catch (e) {
      setError(e?.message || 'Templates could not be loaded.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { loadTemplates() }, [filter])

  const loadSelected = async (id) => {
    setSelected(await assessmentService.getTemplate(id))
  }
  useEffect(() => { if (selectedId) loadSelected(selectedId) }, [selectedId])

  useEffect(() => {
    recruitmentService.listJobs().then((j) => setJobs(j || [])).catch(() => setJobs([]))
  }, [])

  const createTemplate = async () => {
    if (!createForm.title.trim()) { setMsg('Template title is required.'); return }
    setBusy('create')
    setMsg('')
    try {
      const t = await assessmentService.createTemplate(createForm)
      setShowCreate(false)
      setCreateForm({ title: '', job_id: '', category: 'technical', duration_minutes: 30, pass_mark: 60, instructions: '' })
      await loadTemplates()
      setSelectedId(t.id)
      setMsg(`Template "${t.title}" created. Add questions to publish it.`)
    } catch (e) {
      setMsg(e?.message || 'Template could not be created.')
    } finally {
      setBusy('')
    }
  }

  const saveQuestions = async () => {
    if (!selected) return
    setBusy('q')
    setMsg('')
    try {
      const rows = [buildRow(qDraft)].filter((r) => r.question_text)
      if (rows.length === 0) { setMsg('Enter a question first.'); return }
      await assessmentService.saveQuestions(selected.template.id, rows)
      setQDraft(emptyQuestion)
      await loadSelected(selected.template.id)
      setMsg('Question added.')
    } catch (e) {
      setMsg(e?.message || 'Question could not be saved.')
    } finally {
      setBusy('')
    }
  }

  const importBulk = async () => {
    if (!selected) return
    setBusy('import')
    setMsg('')
    try {
      const parsed = JSON.parse(bulkJson)
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).map(buildRow).filter((r) => r.question_text)
      if (rows.length === 0) throw new Error('No valid questions in the JSON.')
      await assessmentService.saveQuestions(selected.template.id, rows)
      setBulkJson('')
      await loadSelected(selected.template.id)
      setMsg(`Imported ${rows.length} question(s).`)
    } catch (e) {
      setMsg(`Import failed: ${e?.message || 'Invalid JSON'}`)
    } finally {
      setBusy('')
    }
  }

  const publish = async (target = selected, nextStatus = target?.template?.status === 'published' ? 'archived' : 'published') => {
    setBusy('publish')
    setMsg('')
    try {
      await assessmentService.updateTemplate(target.template.id, { status: nextStatus })
      await Promise.all([loadTemplates(), loadSelected(target.template.id)])
      setMsg(`Template ${nextStatus}.`)
    } catch (e) {
      setMsg(e?.message || 'Could not update the template.')
    } finally {
      setBusy('')
    }
  }

  const generateSara = async () => {
    if (!sara.job_id) { setMsg('Select a job first.'); return }
    setBusy('sara')
    setMsg('')
    try {
      const res = await assessmentService.generateWithSara({
        jobId: sara.job_id,
        category: sara.category,
        durationMinutes: Number(sara.duration_minutes),
        passMark: Number(sara.pass_mark),
        count: Number(sara.count),
      })
      if (res?.template_id) {
        setSelectedId(res.template_id)
        await loadTemplates()
        await loadSelected(res.template_id)
        setMsg(`SARA created template "${res.template?.title || ''}" — review questions before publishing.`)
      } else {
        setMsg(res?.error ? `SARA unavailable (${res.error}) — add questions manually or run a manual screening instead.` : 'SARA could not generate the assessment.')
      }
    } catch (e) {
      setMsg('SARA assessment generation failed.')
    } finally {
      setBusy('')
    }
  }

  const deleteQuestion = async (id) => {
    setBusy(`del-${id}`)
    try {
      await assessmentService.deleteQuestion(id)
      await loadSelected(selected.template.id)
    } catch (e) {
      setMsg(e?.message || 'Could not delete the question.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Assessment Builder</h1>
          <p className="text-sm text-slate-500 mt-1">Question banks and CBT invitations. Publish a template before candidates can take it.</p>
        </div>
        <div className="flex gap-2">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className={inputCls + ' w-40'}>
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          <button onClick={() => { setShowCreate(true); setMsg('') }} className="inline-flex items-center gap-2 rounded-lg bg-[#009944] text-white px-4 py-2.5 text-sm font-medium hover:bg-[#007a36]"><Plus className="w-4 h-4" /> New template</button>
        </div>
      </div>

      {error && <ErrorState message={error} />}
      {msg && <div className={`rounded-lg px-4 py-2 text-sm ${msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('unavailable') ? 'bg-rose-50 text-rose-700 border border-rose-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'}`}>{msg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        {/* Templates list */}
        <div className="lg:col-span-2">
          <ModuleTable
            title="Templates"
            subtitle=""
            rows={templates}
            loading={loading}
            error={error}
            searchKeys={['title', 'category']}
            columns={[
              { key: 'title', label: 'Template', render: (r) => (
                <button onClick={() => { setSelectedId(r.id); setMsg('') }} className={`text-left ${selectedId === r.id ? 'text-[#009944] font-semibold' : 'text-slate-900 font-medium hover:text-[#009944]'}`}>{r.title}</button>
              ) },
              { key: 'category', label: 'Category', render: (r) => r.category || '-' },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge label={r.status} color={r.status === 'published' ? 'emerald' : r.status === 'published' ? 'emerald' : 'amber'} /> },
              { key: 'created_at', label: 'Updated', render: (r) => date(r.updated_at || r.created_at) },
            ]}
          />
        </div>

        {/* Editor pane */}
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <div>
                <h2 className="text-base font-bold text-slate-900">{selected?.template?.title || 'No template selected'}</h2>
                {selected && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    {selected.template.duration_minutes} min · pass {selected.template.pass_mark}% · {selected.questions?.length || 0} questions · source {selected.template.source}
                  </p>
                )}
              </div>
              {selected && (
                <div className="flex gap-2">
                  <button onClick={() => publish()} disabled={busy === 'publish'} className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${selected.template.status === 'published' ? 'border border-slate-300 text-slate-600 hover:bg-slate-50' : 'bg-[#009944] text-white hover:bg-[#007a36]'}`}>
                    {busy === 'publish' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : (selected.template.status === 'published' ? 'Archive' : 'Publish')}
                  </button>
                  <button onClick={() => setShowSara(true)} disabled={!selected} className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-slate-900 text-slate-800 px-3 py-2 text-sm font-medium hover:bg-slate-100 disabled:opacity-40"><Bot className="w-4 h-4" /> SARA generate</button>
                </div>
              )}
            </div>
            {!selected && <p className="text-sm text-slate-400 py-6 text-center">Select a template to edit its questions, or create a new one.</p>}
          </div>

          {selected && (
            <>
              {/* Question form */}
              <div className="bg-white border border-slate-200 rounded-xl p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-3">Add question</h3>
                <div className="space-y-3">
                  <textarea rows="2" className={inputCls + ' !h-auto py-2'} placeholder="Question text…" value={qDraft.question_text} onChange={(e) => setQDraft({ ...qDraft, question_text: e.target.value })} />
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div>
                      <label className={labelCls}>Type</label>
                      <select className={inputCls} value={qDraft.question_type} onChange={(e) => setQDraft({ ...qDraft, question_type: e.target.value })}>
                        {Q_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                      </select>
                    </div>
                    <div><label className={labelCls}>Marks</label><input type="number" min="1" className={inputCls} value={qDraft.marks} onChange={(e) => setQDraft({ ...qDraft, marks: e.target.value })} /></div>
                    <div>
                      <label className={labelCls}>Difficulty</label>
                      <select className={inputCls} value={qDraft.difficulty} onChange={(e) => setQDraft({ ...qDraft, difficulty: e.target.value })}>
                        {['easy', 'medium', 'hard'].map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                    <div className="col-span-2"><label className={labelCls}>Competency (optional)</label><input className={inputCls} value={qDraft.competency} onChange={(e) => setQDraft({ ...qDraft, competency: e.target.value })} placeholder="e.g. Risk Management" /></div>
                  </div>

                  {qDraft.question_type === 'true_false' && (
                    <p className="text-sm text-slate-500">Correct answer: <select className={inputCls + ' !w-32'} value={qDraft.correct_answer || 'True'} onChange={(e) => setQDraft({ ...qDraft, correct_answer: e.target.value })}><option>True</option><option>False</option></select></p>
                  )}

                  {qDraft.question_type === 'numerical' && (
                    <div><label className={labelCls}>Correct value</label><input className={inputCls + ' !w-48'} value={qDraft.correct_answer} onChange={(e) => setQDraft({ ...qDraft, correct_answer: e.target.value })} placeholder="e.g. 4200" /></div>
                  )}

                  {(qDraft.question_type === 'multiple_choice' || qDraft.question_type === 'multiple_select') && (
                    <div className="space-y-2">
                      {qDraft.options.map((opt, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <input className={inputCls} value={opt} onChange={(e) => { const opts = [...qDraft.options]; opts[i] = e.target.value; setQDraft({ ...qDraft, options: opts }) }} placeholder={`Option ${i + 1}`} />
                          {qDraft.question_type === 'multiple_choice' && (
                            <label className="text-xs text-slate-500 flex items-center gap-1 whitespace-nowrap">
                              <input
                                type="radio"
                                className="accent-[#009944]"
                                checked={opt === qDraft.correct_answer}
                                onChange={() => setQDraft({ ...qDraft, correct_answer: opt })}
                              /> Correct
                            </label>
                          )}
                        </div>
                      ))}
                      <button onClick={() => setQDraft({ ...qDraft, options: [...qDraft.options, ''] })} className="text-xs font-medium text-[#009944]">+ Add option</button>
                    </div>
                  )}

                  {qDraft.question_type === 'ranking' && (
                    <div>
                      <label className={labelCls}>Rank options in correct order (one per line, first is rank 1)</label>
                      <textarea rows="4" className={inputCls + ' !h-auto py-2'} value={qDraft.options.filter((o) => o.trim()).join('\n')} onChange={(e) => setQDraft({ ...qDraft, options: e.target.value.split('\n') })} />
                    </div>
                  )}

                  {(qDraft.question_type === 'multiple_select') && (
                    <div><label className={labelCls}>Correct answers (comma separated — match option text exactly)</label><input className={inputCls} value={Array.isArray(parseAnswer(qDraft)) ? parseAnswer(qDraft).join(', ') : ''} onChange={(e) => setQDraft({ ...qDraft, correct_answer: JSON.stringify(e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) })} /></div>
                  )}
                  {qDraft.question_type === 'ranking' && (
                    <div><label className={labelCls}>Correct order (comma separated — the exact values in rank order)</label><input className={inputCls} value={Array.isArray(parseAnswer(qDraft)) ? parseAnswer(qDraft).join(', ') : ''} onChange={(e) => setQDraft({ ...qDraft, correct_answer: JSON.stringify(e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) })} /></div>
                  )}

                  <button onClick={saveQuestions} disabled={busy === 'q' || !qDraft.question_text.trim()} className="rounded-lg bg-[#009944] text-white px-5 py-2.5 text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                    {busy === 'q' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : <Plus className="w-4 h-4 inline" />} Add question
                  </button>
                </div>
              </div>

              {/* Bulk import */}
              <div className="bg-white border border-slate-200 rounded-xl p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-1">Bulk import (JSON)</h3>
                <p className="text-xs text-slate-500 mb-3">Paste a JSON array — fields: question_text, question_type, options[], correct_answer, marks, difficulty, competency.</p>
                <textarea rows="5" className={inputCls + ' !h-auto py-2 font-mono text-xs'} value={bulkJson} onChange={(e) => setBulkJson(e.target.value)} placeholder='[{"question_text":"…","question_type":"multiple_choice","options":["A","B","C","D"],"correct_answer":"A","marks":1}]' />
                <button onClick={importBulk} disabled={busy === 'import' || !bulkJson.trim()} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  {busy === 'import' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Import
                </button>
              </div>

              {/* Questions list */}
              <div className="bg-white border border-slate-200 rounded-xl p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-3">Questions ({selected.questions?.length || 0})</h3>
                <div className="space-y-3">
                  {selected.questions?.length === 0 && <p className="text-sm text-slate-400">No questions yet.</p>}
                  {selected.questions.map((q, i) => (
                    <div key={q.id} className="rounded-lg border border-slate-200 p-4 flex items-start gap-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-800"><span className="text-slate-400">{i + 1}.</span> {q.question_text}</p>
                        <p className="text-xs text-slate-400 mt-1">{q.question_type} · {q.marks} mark{q.marks > 1 ? 's' : ''} · {q.difficulty}{q.competency ? ` · ${q.competency}` : ''}</p>
                        {q.question_type !== 'true_false' && Array.isArray(q.options) && q.options.length > 0 && (
                          <p className="text-xs text-slate-500 mt-1 truncate">{q.options.join(' | ')}</p>
                        )}
                      </div>
                      <button onClick={() => deleteQuestion(q.id)} disabled={!!busy} className="text-slate-300 hover:text-rose-500 disabled:opacity-40"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Create template modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">New assessment template</h3>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div><label className={labelCls}>Title *</label><input className={inputCls} value={createForm.title} onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })} placeholder="e.g. Technical Banking Skills — Level 1" /></div>
              <div>
                <label className={labelCls}>Linked job (optional)</label>
                <select className={inputCls} value={createForm.job_id} onChange={(e) => setCreateForm({ ...createForm, job_id: e.target.value })}>
                  <option value="">None</option>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_title}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div><label className={labelCls}>Category</label><select className={inputCls} value={createForm.category} onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}>{['technical', 'aptitude', 'behavioral', 'analytical'].map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
                <div><label className={labelCls}>Duration (min)</label><input type="number" className={inputCls} value={createForm.duration_minutes} onChange={(e) => setCreateForm({ ...createForm, duration_minutes: e.target.value })} /></div>
                <div><label className={labelCls}>Pass mark (%)</label><input type="number" className={inputCls} value={createForm.pass_mark} onChange={(e) => setCreateForm({ ...createForm, pass_mark: e.target.value })} /></div>
              </div>
              <div><label className={labelCls}>Instructions shown to candidates</label><textarea rows="3" className={inputCls + ' !h-auto py-2'} value={createForm.instructions} onChange={(e) => setCreateForm({ ...createForm, instructions: e.target.value })} placeholder="You have 30 minutes. No external help…" /></div>
            </div>
            <div className="flex justify-end gap-2 pt-5">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={createTemplate} disabled={busy === 'create'} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Create template
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SARA generate modal */}
      {showSara && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Generate assessment with SARA</h3>
                <p className="text-sm text-slate-500 mt-0.5">Creates a draft template from the job's skills and requirements. Review it before publishing.</p>
              </div>
              <button onClick={() => setShowSara(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Source job *</label>
                <select className={inputCls} value={sara.job_id} onChange={(e) => setSara({ ...sara, job_id: e.target.value })}>
                  <option value="">Select a job…</option>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_title}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Category</label><select className={inputCls} value={sara.category} onChange={(e) => setSara({ ...sara, category: e.target.value })}>{['technical', 'aptitude', 'behavioral', 'analytical'].map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
                <div><label className={labelCls}>Questions</label><input type="number" min="1" max="60" className={inputCls} value={sara.count} onChange={(e) => setSara({ ...sara, count: e.target.value })} /></div>
                <div><label className={labelCls}>Duration (min)</label><input type="number" className={inputCls} value={sara.duration_minutes} onChange={(e) => setSara({ ...sara, duration_minutes: e.target.value })} /></div>
                <div><label className={labelCls}>Pass mark (%)</label><input type="number" className={inputCls} value={sara.pass_mark} onChange={(e) => setSara({ ...sara, pass_mark: e.target.value })} /></div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-5">
              <button onClick={() => setShowSara(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={generateSara} disabled={busy === 'sara' || !sara.job_id} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-60">
                {busy === 'sara' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />} Generate with SARA
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}