import React, { useEffect, useState } from 'react'
import { Bot, CheckCircle2, FileText, Loader2, Plus, RefreshCw, Save, Settings2, Trash2, Upload, Wand2, X } from 'lucide-react'
import { assessmentService, DEFAULT_ANTI_CHEAT } from '../services/assessmentService'
import { recruitmentService } from '../services/recruitmentService'
import { date, ModuleTable } from './hrShared'
import { ErrorState } from '../components/PageStates'
import { StatusBadge } from '../lib/utils'

const Q_TYPES = ['multiple_choice', 'true_false', 'numerical', 'multiple_select', 'ranking']
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'
const toggleCls = 'inline-flex items-center gap-2 text-sm'

const emptyQuestion = { question_text: '', question_type: 'multiple_choice', options: ['', '', '', ''], correct_answer: '', marks: 1, difficulty: 'medium', competency: '' }

function mergeAntiCheat(input) {
  return { ...DEFAULT_ANTI_CHEAT, ...(input || {}) }
}

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

function AntiCheatBlock({ cfg, onChange }) {
  const set = (key) => (e) => onChange({ ...cfg, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const bool = (key, label, hint) => (
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" className="mt-0.5 accent-[#009944]" checked={!!cfg[key]} onChange={set(key)} />
      <span><span className="font-medium">{label}</span>{hint ? <span className="block text-xs text-slate-400">{hint}</span> : null}</span>
    </label>
  )
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Max flags before action</label>
          <input type="number" min="1" className={inputCls} value={cfg.max_flags} onChange={set('max_flags')} />
        </div>
        <div>
          <label className={labelCls}>Flag severity</label>
          <select className={inputCls} value={cfg.flag_severity} onChange={set('flag_severity')}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Retake limit</label>
          <input type="number" min="0" className={inputCls} value={cfg.retake_limit} onChange={set('retake_limit')} />
        </div>
        <div>
          <label className={labelCls}>Retake window (hours)</label>
          <input type="number" min="1" className={inputCls} value={cfg.retake_time_hours} onChange={set('retake_time_hours')} />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Inactivity timeout (minutes)</label>
          <input type="number" min="1" className={inputCls} value={cfg.inactivity_timeout_minutes} onChange={set('inactivity_timeout_minutes')} />
        </div>
      </div>
      <div className="border-t border-slate-100 pt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {bool('close_on_flag', 'Close attempt at flag threshold', 'Auto-closes the attempt when max flags is reached.')}
        {bool('require_hr_review', 'Require HR review when flagged', 'Flagged attempts go to HR for a manual decision.')}
        {bool('keep_previous_attempt', 'Keep previous attempt', 'Store the old attempt alongside a retake.')}
        {bool('track_copy_paste', 'Detect copy/paste', 'Logs paste attempts as monitoring events.')}
        {bool('track_context_menu', 'Detect right-click / context menu', 'Logs context-menu attempts.')}
        {bool('track_focus_changes', 'Detect tab/window switches', 'Logs tab visibility and window-blur events.')}
        {bool('require_fullscreen', 'Require fullscreen', 'Runs the attempt in fullscreen; exits are flagged.')}
        {bool('shuffle_options', 'Shuffle answer options', 'Shuffles options per attempts (deterministic per attempt).')}
      </div>
    </div>
  )
}

export default function AssessmentBuilder() {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [selected, setSelected] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSara, setShowSara] = useState(false)
  const [createForm, setCreateForm] = useState({ title: '', job_id: '', category: 'technical', duration_minutes: 30, pass_mark: 60, instructions: '', shuffle_questions: false, anti_cheat: { ...DEFAULT_ANTI_CHEAT } })
  const [settingsForm, setSettingsForm] = useState(null)
  const [qDraft, setQDraft] = useState(emptyQuestion)
  const [bulkJson, setBulkJson] = useState('')
  const [jobs, setJobs] = useState([])
  const [sara, setSara] = useState({ mode: 'role', job_id: '', category: 'technical', count: 10, roleTitle: '', jdFile: null, jdFileName: '', jdFileBase64: '', samplesFile: null, samplesFileName: '', samplesFileBase64: '', samplesMode: 'generate_similar' })
  const [genDrafts, setGenDrafts] = useState([])
  const [genMsg, setGenMsg] = useState('')
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
      const t = await assessmentService.createTemplate({
        ...createForm,
        anti_cheat: mergeAntiCheat(createForm.anti_cheat),
      })
      setShowCreate(false)
      setCreateForm({ title: '', job_id: '', category: 'technical', duration_minutes: 30, pass_mark: 60, instructions: '', shuffle_questions: false, anti_cheat: { ...DEFAULT_ANTI_CHEAT } })
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

  const openSettings = () => {
    const t = selected?.template
    if (!t) return
    setSettingsForm({
      title: t.title, job_id: t.job_id || '', category: t.category || 'technical',
      duration_minutes: t.duration_minutes, pass_mark: t.pass_mark, instructions: t.instructions || '',
      shuffle_questions: !!t.shuffle_questions, anti_cheat: mergeAntiCheat(t.anti_cheat),
    })
    setShowSettings(true)
  }

  const saveSettings = async () => {
    if (!settingsForm || !selected) return
    setBusy('settings')
    setMsg('')
    try {
      await assessmentService.updateTemplate(selected.template.id, {
        title: settingsForm.title,
        job_id: settingsForm.job_id || null,
        category: settingsForm.category,
        duration_minutes: Number(settingsForm.duration_minutes),
        pass_mark: Number(settingsForm.pass_mark),
        instructions: settingsForm.instructions || null,
        shuffle_questions: !!settingsForm.shuffle_questions,
        anti_cheat: mergeAntiCheat(settingsForm.anti_cheat),
      })
      setShowSettings(false)
      await Promise.all([loadTemplates(), loadSelected(selected.template.id)])
      setMsg('Template settings saved.')
    } catch (e) {
      setMsg(e?.message || 'Could not save settings.')
    } finally {
      setBusy('')
    }
  }

  // --- AI question generation (draft mode) ---
  const onGenFile = (key, file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setSara((s) => ({
        ...s,
        [key]: file.name,
        [key === 'jdFile' ? 'jdFileName' : 'samplesFileName']: file.name,
        [key === 'jdFile' ? 'jdFileBase64' : 'samplesFileBase64']: String(reader.result || '').split(',')[1] || '',
      }))
    }
    reader.readAsDataURL(file)
  }

  const runGenerate = async () => {
    setGenMsg('')
    setGenDrafts([])
    setBusy('gen')
    try {
      const params = {
        mode: sara.mode,
        jobId: sara.job_id || null,
        roleTitle: sara.roleTitle || null,
        category: sara.category,
        count: Number(sara.count) || 10,
        templateId: selected?.template?.id || null,
        jdFileName: sara.jdFileName || null,
        jdFileBase64: sara.jdFileBase64 || null,
        samplesFileName: sara.samplesFileName || null,
        samplesFileBase64: sara.samplesFileBase64 || null,
        samplesMode: sara.samplesMode,
      }
      const res = await assessmentService.generateQuestions(params)
      if (!res?.ok || !Array.isArray(res.questions) || res.questions.length === 0) {
        throw new Error(res?.error ? `Sara: ${res.error}` : 'Sara could not generate questions.')
      }
      setGenDrafts(res.questions.map((q, i) => ({ ...q, _draft: true, _keep: true, _id: `d-${i}-${Date.now()}` })))
    } catch (e) {
      setGenMsg(e?.message || 'Question generation failed.')
    } finally {
      setBusy('')
    }
  }

  const patchDraft = (id, patch) => setGenDrafts((ds) => ds.map((d) => (d._id === id ? { ...d, ...patch } : d)))

  const addDrafts = async () => {
    if (!selected) return
    setBusy('gen-add')
    setGenMsg('')
    try {
      const rows = genDrafts.filter((d) => d._keep).map(buildRow).filter((r) => r.question_text)
      if (rows.length === 0) { setGenMsg('No drafts selected to add.'); return }
      await assessmentService.saveQuestions(selected.template.id, rows)
      await loadSelected(selected.template.id)
      setGenDrafts([])
      setShowSara(false)
      setMsg(`Added ${rows.length} question(s) to "${selected.template.title}".`)
    } catch (e) {
      setGenMsg(e?.message || 'Could not add the questions.')
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
              { key: 'status', label: 'Status', render: (r) => <StatusBadge label={r.status} color={r.status === 'published' ? 'emerald' : 'amber'} /> },
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
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => publish()} disabled={busy === 'publish'} className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${selected.template.status === 'published' ? 'border border-slate-300 text-slate-600 hover:bg-slate-50' : 'bg-[#009944] text-white hover:bg-[#007a36]'}`}>
                    {busy === 'publish' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : (selected.template.status === 'published' ? 'Archive' : 'Publish')}
                  </button>
                  <button onClick={() => { setShowSara(true); setGenDrafts([]); setGenMsg('') }} className="inline-flex items-center gap-1.5 rounded-lg bg-white border border-slate-900 text-slate-800 px-3 py-2 text-sm font-medium hover:bg-slate-100"><Bot className="w-4 h-4" /> Sara generate</button>
                  <button onClick={openSettings} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 text-slate-600 px-3 py-2 text-sm font-medium hover:bg-slate-50"><Settings2 className="w-4 h-4" /> Settings</button>
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
              <label className={toggleCls}><input type="checkbox" className="accent-[#009944]" checked={createForm.shuffle_questions} onChange={(e) => setCreateForm({ ...createForm, shuffle_questions: e.target.checked })} /> Shuffle question order for candidates</label>
              <div><label className={labelCls}>Instructions shown to candidates</label><textarea rows="3" className={inputCls + ' !h-auto py-2'} value={createForm.instructions} onChange={(e) => setCreateForm({ ...createForm, instructions: e.target.value })} placeholder="You have 30 minutes. No external help…" /></div>
              <div className="border-t border-slate-100 pt-4">
                <h4 className="text-sm font-semibold text-slate-900 mb-3 inline-flex items-center gap-1.5"><Settings2 className="w-4 h-4" /> Anti-cheat &amp; security</h4>
                <AntiCheatBlock cfg={createForm.anti_cheat} onChange={(anti_cheat) => setCreateForm({ ...createForm, anti_cheat })} />
              </div>
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

      {/* Edit template settings modal */}
      {showSettings && settingsForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Template settings</h3>
                <p className="text-sm text-slate-500 mt-0.5">{settingsForm.title}</p>
              </div>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div><label className={labelCls}>Title *</label><input className={inputCls} value={settingsForm.title} onChange={(e) => setSettingsForm({ ...settingsForm, title: e.target.value })} /></div>
              <div className="grid grid-cols-3 gap-3">
                <div><label className={labelCls}>Category</label><select className={inputCls} value={settingsForm.category} onChange={(e) => setSettingsForm({ ...settingsForm, category: e.target.value })}>{['technical', 'aptitude', 'behavioral', 'analytical'].map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
                <div><label className={labelCls}>Duration (min)</label><input type="number" className={inputCls} value={settingsForm.duration_minutes} onChange={(e) => setSettingsForm({ ...settingsForm, duration_minutes: e.target.value })} /></div>
                <div><label className={labelCls}>Pass mark (%)</label><input type="number" className={inputCls} value={settingsForm.pass_mark} onChange={(e) => setSettingsForm({ ...settingsForm, pass_mark: e.target.value })} /></div>
              </div>
              <label className={toggleCls}><input type="checkbox" className="accent-[#009944]" checked={settingsForm.shuffle_questions} onChange={(e) => setSettingsForm({ ...settingsForm, shuffle_questions: e.target.checked })} /> Shuffle question order for candidates</label>
              <div><label className={labelCls}>Instructions shown to candidates</label><textarea rows="3" className={inputCls + ' !h-auto py-2'} value={settingsForm.instructions} onChange={(e) => setSettingsForm({ ...settingsForm, instructions: e.target.value })} /></div>
              <div className="border-t border-slate-100 pt-4">
                <h4 className="text-sm font-semibold text-slate-900 mb-3 inline-flex items-center gap-1.5"><Settings2 className="w-4 h-4" /> Anti-cheat &amp; security</h4>
                <AntiCheatBlock cfg={settingsForm.anti_cheat} onChange={(anti_cheat) => setSettingsForm({ ...settingsForm, anti_cheat })} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-5">
              <button onClick={() => setShowSettings(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={saveSettings} disabled={busy === 'settings'} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busy === 'settings' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SARA generate modal — draft mode */}
      {showSara && selected && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Generate questions with Sara</h3>
                <p className="text-sm text-slate-500 mt-0.5">Draft questions for “{selected.template.title}” — review and edit before adding.</p>
              </div>
              <button onClick={() => setShowSara(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            {/* Mode picker */}
            <div className="grid grid-cols-3 gap-2 mb-4">
              {[
                { value: 'role', label: 'By role', icon: <FileText className="w-4 h-4" /> },
                { value: 'jd', label: 'By job description', icon: <Upload className="w-4 h-4" /> },
                { value: 'samples', label: 'By sample questions', icon: <Wand2 className="w-4 h-4" /> },
              ].map((m) => (
                <button
                  key={m.value}
                  onClick={() => setSara({ ...sara, mode: m.value })}
                  className={`flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-xs font-medium transition ${sara.mode === m.value ? 'border-[#009944] bg-emerald-50/60 text-emerald-800' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
                >
                  {m.icon}
                  {m.label}
                </button>
              ))}
            </div>

            <div className="space-y-4 mb-4">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Questions to generate</label><input type="number" min="1" max="40" className={inputCls} value={sara.count} onChange={(e) => setSara({ ...sara, count: e.target.value })} /></div>
                <div><label className={labelCls}>Category</label><select className={inputCls} value={sara.category} onChange={(e) => setSara({ ...sara, category: e.target.value })}>{['technical', 'aptitude', 'behavioral', 'analytical'].map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
              </div>

              {sara.mode === 'role' && (
                <div>
                  <label className={labelCls}>Role *</label>
                  <select className={inputCls} value={sara.job_id} onChange={(e) => setSara({ ...sara, job_id: e.target.value })}>
                    <option value="">Select a role…</option>
                    {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_title}</option>)}
                  </select>
                  <div className="mt-2"><label className={labelCls}>Role title override (optional)</label><input className={inputCls} value={sara.roleTitle} onChange={(e) => setSara({ ...sara, roleTitle: e.target.value })} placeholder="e.g. Compliance Officer" /></div>
                </div>
              )}

              {sara.mode === 'jd' && (
                <div>
                  <label className={labelCls}>Job description file (.txt / .pdf / .docx, ≤ 2 MB) *</label>
                  <label className="flex items-center gap-3 rounded-lg border border-dashed border-slate-300 px-4 py-4 cursor-pointer hover:border-[#009944]">
                    <Upload className="w-5 h-5 text-slate-400" />
                    <span className="text-sm text-slate-600">{sara.jdFileName || 'Choose a JD file…'}</span>
                    <input type="file" accept=".txt,.pdf,.docx" className="hidden" onChange={(e) => onGenFile('jdFile', e.target.files?.[0])} />
                  </label>
                  <div className="mt-2"><label className={labelCls}>Role (optional — enriches the prompt)</label><select className={inputCls} value={sara.job_id} onChange={(e) => setSara({ ...sara, job_id: e.target.value })}><option value="">None</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.job_title}</option>)}</select></div>
                </div>
              )}

              {sara.mode === 'samples' && (
                <div>
                  <label className={labelCls}>Sample questions file (.xlsx / .csv / .txt / .pdf / .docx, ≤ 2 MB) *</label>
                  <label className="flex items-center gap-3 rounded-lg border border-dashed border-slate-300 px-4 py-4 cursor-pointer hover:border-[#009944]">
                    <Upload className="w-5 h-5 text-slate-400" />
                    <span className="text-sm text-slate-600">{sara.samplesFileName || 'Choose a sample file…'}</span>
                    <input type="file" accept=".xlsx,.csv,.txt,.pdf,.docx" className="hidden" onChange={(e) => onGenFile('samplesFile', e.target.files?.[0])} />
                  </label>
                  <div className="mt-3">
                    <label className={labelCls}>Draft mode</label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className={`rounded-lg border px-3 py-2.5 text-sm cursor-pointer flex items-center gap-2 ${sara.samplesMode === 'generate_similar' ? 'border-[#009944] bg-emerald-50/60' : 'border-slate-200'}`}>
                        <input type="radio" name="samples-mode" className="accent-[#009944]" checked={sara.samplesMode === 'generate_similar'} onChange={() => setSara({ ...sara, samplesMode: 'generate_similar' })} />
                        <span><span className="font-medium">Generate similar</span><span className="block text-xs text-slate-400">Sara drafts new questions inspired by your samples (recommended).</span></span>
                      </label>
                      <label className={`rounded-lg border px-3 py-2.5 text-sm cursor-pointer flex items-center gap-2 ${sara.samplesMode === 'use_direct' ? 'border-[#009944] bg-emerald-50/60' : 'border-slate-200'}`}>
                        <input type="radio" name="samples-mode" className="accent-[#009944]" checked={sara.samplesMode === 'use_direct'} onChange={() => setSara({ ...sara, samplesMode: 'use_direct' })} />
                        <span><span className="font-medium">Use directly</span><span className="block text-xs text-slate-400">Import the file's questions as-is (spreadsheet/text parsing).</span></span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {genMsg && <div className="mb-3 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 px-3 py-2 text-sm">{genMsg}</div>}

            {genDrafts.length > 0 && (
              <div className="mb-4 space-y-3 max-h-72 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-900">Review drafts ({genDrafts.length})</h4>
                  <button onClick={() => setGenDrafts((ds) => ds.map((d) => ({ ...d, _keep: !d._keep })))} className="text-xs font-medium text-[#009944]">Toggle all</button>
                </div>
                {genDrafts.map((d) => (
                  <div key={d._id} className={`rounded-lg border p-3 ${d._keep ? 'border-slate-200' : 'border-slate-100 opacity-60'}`}>
                    <div className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1 accent-[#009944]" checked={d._keep} onChange={(e) => patchDraft(d._id, { _keep: e.target.checked })} />
                      <div className="flex-1 space-y-1.5">
                        <textarea rows="2" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" value={d.question_text} onChange={(e) => patchDraft(d._id, { question_text: e.target.value })} />
                        <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                          <select className="rounded border border-slate-300 px-2 py-1 text-xs" value={d.question_type} onChange={(e) => patchDraft(d._id, { question_type: e.target.value })}>
                            {Q_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                          </select>
                          <input className="w-20 rounded border border-slate-300 px-2 py-1 text-xs" value={d.marks} onChange={(e) => patchDraft(d._id, { marks: Number(e.target.value) || 1 })} title="marks" />
                          <select className="rounded border border-slate-300 px-2 py-1 text-xs" value={d.difficulty} onChange={(e) => patchDraft(d._id, { difficulty: e.target.value })}>
                            {['easy', 'medium', 'hard'].map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        </div>
                        {d.question_type !== 'true_false' && d.options && d.options.length > 0 && (
                          <input className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs" value={d.options.join(' | ')} onChange={(e) => patchDraft(d._id, { options: e.target.value.split('|').map((s) => s.trim()).filter(Boolean) })} placeholder="Options separated by |" />
                        )}
                        <input className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs" value={typeof d.correct_answer === 'string' ? d.correct_answer : (Array.isArray(d.correct_answer) ? d.correct_answer.join(', ') : '')} onChange={(e) => {
                          const v = e.target.value
                          patchDraft(d._id, { correct_answer: d.question_type === 'multiple_select' || d.question_type === 'ranking' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v })
                        }} placeholder="Correct answer" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button onClick={() => setShowSara(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              {genDrafts.length > 0 ? (
                <button onClick={addDrafts} disabled={busy === 'gen-add'} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                  {busy === 'gen-add' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Add selected to template
                </button>
              ) : (
                <button onClick={runGenerate} disabled={busy === 'gen' || (sara.mode === 'role' && !sara.job_id)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-60">
                  {busy === 'gen' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className={`w-4 h-4 ${genDrafts.length ? 'hidden' : ''}`} />}
                  {busy === 'gen' ? 'Generating…' : genDrafts.length ? 'Regenerate' : 'Generate draft questions'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}