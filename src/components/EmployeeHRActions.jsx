import React, { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { logAction } from '../services/supabaseService'
import { ClipboardList, Star, FileText, Send, Loader2, MessageSquare } from 'lucide-react'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const TABS = [
  { id: 'query', label: 'Issue Query', icon: MessageSquare },
  { id: 'appraisal', label: 'Create Appraisal', icon: Star },
  { id: 'request', label: 'Request Update', icon: FileText },
  { id: 'history', label: 'History', icon: ClipboardList },
]

export default function EmployeeHRActions({ employee, canEdit }) {
  const [tab, setTab] = useState('query')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [history, setHistory] = useState({ queries: [], appraisals: [] })

  // Query form
  const [query, setQuery] = useState({ title: '', type: 'general', description: '', period: '', year: new Date().getFullYear(), quarter: 'Q1', date: '' })
  // Appraisal form
  const [appraisal, setAppraisal] = useState({ type: 'quarterly', period: '', year: new Date().getFullYear(), quarter: 'Q1', date: '', reviewer: '', strengths: '', improvements: '', objectives: '', rating: 'good', comments: '' })
  // Request update form
  const [request, setRequest] = useState({ fields: [], message: '' })

  useEffect(() => {
    loadHistory()
  }, [employee?.id])

  const loadHistory = async () => {
    if (!employee?.id) return
    try {
      const [q, a] = await Promise.all([
        supabase.from('hr_queries').select('*').eq('employee_id', employee.id).order('created_at', { ascending: false }),
        supabase.from('employee_appraisals').select('*').eq('employee_id', employee.id).order('created_at', { ascending: false }),
      ])
      setHistory({ queries: q.data || [], appraisals: a.data || [] })
    } catch { /* best-effort */ }
  }

  if (!canEdit) {
    return (
      <div className="text-sm text-slate-500 py-8 text-center">
        You don't have permission to perform HR actions.
      </div>
    )
  }

  const showToast = (m) => { setMsg(m); setTimeout(() => setMsg(''), 4000) }

  const saveQuery = async () => {
    if (!query.title.trim()) { showToast('Query title is required'); return }
    setSaving(true)
    try {
      const workPeriod = `${query.year} ${query.quarter}`.trim()
      const { error } = await supabase.from('hr_queries').insert({
        employee_id: employee.id,
        employee_name: employee.full_name,
        query_title: query.title,
        query_type: query.type,
        description: query.description,
        work_period: workPeriod,
        status: 'ISSUED',
        issued_at: new Date().toISOString(),
      })
      if (error) throw error
      logAction({ action: 'HR_QUERY_ISSUED', entityType: 'Employee', entityId: employee.id, details: `Query issued: ${query.title}` })
      showToast('Query issued successfully')
      setQuery({ title: '', type: 'general', description: '', period: '', year: new Date().getFullYear(), quarter: 'Q1', date: '' })
      loadHistory()
    } catch (e) { showToast(e?.message || 'Failed to issue query') }
    finally { setSaving(false) }
  }

  const saveAppraisal = async () => {
    setSaving(true)
    try {
      const workPeriod = `${appraisal.year} ${appraisal.quarter}`.trim()
      const { error } = await supabase.from('employee_appraisals').insert({
        employee_id: employee.id,
        employee_name: employee.full_name,
        appraisal_type: appraisal.type,
        work_period: workPeriod,
        quarter: appraisal.quarter,
        appraisal_year: appraisal.year,
        appraisal_date: appraisal.date || null,
        reviewer: appraisal.reviewer,
        strengths: appraisal.strengths,
        areas_for_improvement: appraisal.improvements,
        objectives: appraisal.objectives,
        overall_rating: appraisal.rating,
        comments: appraisal.comments,
        status: 'completed',
      })
      if (error) throw error
      logAction({ action: 'APPRAISAL_CREATED', entityType: 'Employee', entityId: employee.id, details: `Appraisal created for ${employee.full_name}` })
      showToast('Appraisal created successfully')
      setAppraisal({ type: 'quarterly', period: '', year: new Date().getFullYear(), quarter: 'Q1', date: '', reviewer: '', strengths: '', improvements: '', objectives: '', rating: 'good', comments: '' })
      loadHistory()
    } catch (e) { showToast(e?.message || 'Failed to create appraisal') }
    finally { setSaving(false) }
  }

  const saveRequest = async () => {
    if (request.fields.length === 0) { showToast('Select at least one field'); return }
    setSaving(true)
    try {
      const { error } = await supabase.rpc('request_employee_info_update', {
        p_employee_id: employee.id,
        p_fields: request.fields,
        p_message: request.message || null,
      })
      if (error) throw error
      showToast('Update request sent to employee')
      setRequest({ fields: [], message: '' })
    } catch (e) { showToast(e?.message || 'Failed to send request') }
    finally { setSaving(false) }
  }

  const toggleField = (f) => {
    setRequest(prev => ({
      ...prev,
      fields: prev.fields.includes(f) ? prev.fields.filter(x => x !== f) : [...prev.fields, f],
    }))
  }

  const FIELD_OPTIONS = ['Phone', 'Department', 'Position', 'Branch', 'Employment Type', 'Date Employed', 'Emergency Contact Name', 'Emergency Contact Phone', 'Next of Kin Name', 'Next of Kin Phone', 'Bank Name', 'Account Number', 'BVN']

  return (
    <div>
      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-slate-200 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              tab === t.id ? 'border-[#009944] text-[#009944]' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="mb-4 text-sm rounded-lg px-3 py-2 bg-emerald-50 text-emerald-700 border border-emerald-200">{msg}</div>}

      {/* Issue Query */}
      {tab === 'query' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Query Title *</label>
              <input className={inputCls} value={query.title} onChange={e => setQuery({ ...query, title: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Query Type</label>
              <select className={inputCls} value={query.type} onChange={e => setQuery({ ...query, type: e.target.value })}>
                <option value="general">General</option>
                <option value="attendance">Attendance</option>
                <option value="performance">Performance</option>
                <option value="conduct">Conduct</option>
                <option value="compliance">Compliance</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>Year</label>
              <input type="number" className={inputCls} value={query.year} onChange={e => setQuery({ ...query, year: Number(e.target.value) })} />
            </div>
            <div>
              <label className={labelCls}>Quarter</label>
              <select className={inputCls} value={query.quarter} onChange={e => setQuery({ ...query, quarter: e.target.value })}>
                <option>Q1</option><option>Q2</option><option>Q3</option><option>Q4</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Date</label>
              <input type="date" className={inputCls} value={query.date} onChange={e => setQuery({ ...query, date: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={query.description} onChange={e => setQuery({ ...query, description: e.target.value })} />
          </div>
          <button onClick={saveQuery} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Issue Query
          </button>
        </div>
      )}

      {/* Create Appraisal */}
      {tab === 'appraisal' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <label className={labelCls}>Year</label>
              <input type="number" className={inputCls} value={appraisal.year} onChange={e => setAppraisal({ ...appraisal, year: Number(e.target.value) })} />
            </div>
            <div>
              <label className={labelCls}>Quarter</label>
              <select className={inputCls} value={appraisal.quarter} onChange={e => setAppraisal({ ...appraisal, quarter: e.target.value })}>
                <option>Q1</option><option>Q2</option><option>Q3</option><option>Q4</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Date</label>
              <input type="date" className={inputCls} value={appraisal.date} onChange={e => setAppraisal({ ...appraisal, date: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Rating</label>
              <select className={inputCls} value={appraisal.rating} onChange={e => setAppraisal({ ...appraisal, rating: e.target.value })}>
                <option value="excellent">Excellent</option>
                <option value="good">Good</option>
                <option value="satisfactory">Satisfactory</option>
                <option value="needs_improvement">Needs Improvement</option>
                <option value="unsatisfactory">Unsatisfactory</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Reviewer</label>
            <input className={inputCls} value={appraisal.reviewer} onChange={e => setAppraisal({ ...appraisal, reviewer: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Strengths</label>
            <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={appraisal.strengths} onChange={e => setAppraisal({ ...appraisal, strengths: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Areas for Improvement</label>
            <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={appraisal.improvements} onChange={e => setAppraisal({ ...appraisal, improvements: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Objectives</label>
            <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={appraisal.objectives} onChange={e => setAppraisal({ ...appraisal, objectives: e.target.value })} />
          </div>
          <button onClick={saveAppraisal} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Star className="w-4 h-4" />} Create Appraisal
          </button>
        </div>
      )}

      {/* Request Update */}
      {tab === 'request' && (
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Select fields to request updates for:</label>
            <div className="flex flex-wrap gap-2 mt-2">
              {FIELD_OPTIONS.map(f => (
                <button
                  key={f}
                  onClick={() => toggleField(f)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    request.fields.includes(f) ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={labelCls}>Message (optional)</label>
            <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={request.message} onChange={e => setRequest({ ...request, message: e.target.value })} placeholder="Add a note for the employee..." />
          </div>
          <button onClick={saveRequest} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send Update Request
          </button>
        </div>
      )}

      {/* History */}
      {tab === 'history' && (
        <div className="space-y-6">
          <div>
            <h4 className="font-medium text-slate-800 mb-3">Previous Queries</h4>
            {history.queries.length === 0 ? (
              <p className="text-sm text-slate-400">No queries issued.</p>
            ) : (
              <div className="space-y-2">
                {history.queries.map(q => (
                  <div key={q.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm text-slate-800">{q.query_title}</span>
                      <span className="text-xs text-slate-400">{q.work_period || ''}</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">{q.query_type} · Status: {q.status}</div>
                    {q.description && <div className="text-xs text-slate-600 mt-1">{q.description}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h4 className="font-medium text-slate-800 mb-3">Previous Appraisals</h4>
            {history.appraisals.length === 0 ? (
              <p className="text-sm text-slate-400">No appraisals recorded.</p>
            ) : (
              <div className="space-y-2">
                {history.appraisals.map(a => (
                  <div key={a.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm text-slate-800">{a.appraisal_type} · {a.quarter} {a.appraisal_year}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 capitalize">{a.overall_rating?.replace('_', ' ')}</span>
                    </div>
                    {a.reviewer && <div className="text-xs text-slate-500 mt-1">Reviewer: {a.reviewer}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
