import React, { useState, useEffect } from 'react'
import { X, Loader2, Send, Star, MessageSquare, FileText, Save, Check } from 'lucide-react'
import { attendanceEngineService } from '../services/attendanceEngineService'
import { supabase } from '../supabaseClient'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

// ============================================================
// APPRAISAL MODAL
// ============================================================
export function AppraisalModal({ employee, onClose, onSaved }) {
  const [form, setForm] = useState({
    period_name: '',
    period_start: '',
    period_end: '',
    overall_score: '',
    kpi_score: '',
    behavioral_score: '',
    strengths: '',
    areas_for_improvement: '',
    goals: '',
    comments: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const update = (k, v) => setForm((p) => ({ ...p, [k]: v }))

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await attendanceEngineService.createAppraisal({
        employee_id: employee.id,
        user_id: employee.user_id,
        period_name: form.period_name,
        period_start: form.period_start || null,
        period_end: form.period_end || null,
        overall_score: form.overall_score ? Number(form.overall_score) : null,
        kpi_score: form.kpi_score ? Number(form.kpi_score) : null,
        behavioral_score: form.behavioral_score ? Number(form.behavioral_score) : null,
        strengths: form.strengths || null,
        areas_for_improvement: form.areas_for_improvement || null,
        goals: form.goals || null,
        comments: form.comments || null,
        reviewer_id: user?.id,
        reviewer_name: user?.email,
        status: 'submitted',
        rating: 'submitted',
      })
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e?.message || 'Failed to save appraisal')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
              <Star className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Employee Appraisal</h3>
              <p className="text-sm text-slate-500">{employee.full_name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Period Name</label>
              <input className={inputCls} value={form.period_name} onChange={(e) => update('period_name', e.target.value)} placeholder="e.g. Q3 2026" />
            </div>
            <div>
              <label className={labelCls}>Start Date</label>
              <input type="date" className={inputCls} value={form.period_start} onChange={(e) => update('period_start', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>End Date</label>
              <input type="date" className={inputCls} value={form.period_end} onChange={(e) => update('period_end', e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Overall Score (0-100)</label>
              <input type="number" className={inputCls} value={form.overall_score} onChange={(e) => update('overall_score', e.target.value)} placeholder="85" />
            </div>
            <div>
              <label className={labelCls}>KPI Score (0-100)</label>
              <input type="number" className={inputCls} value={form.kpi_score} onChange={(e) => update('kpi_score', e.target.value)} placeholder="80" />
            </div>
            <div>
              <label className={labelCls}>Behavioral Score (0-100)</label>
              <input type="number" className={inputCls} value={form.behavioral_score} onChange={(e) => update('behavioral_score', e.target.value)} placeholder="90" />
            </div>
          </div>

          <div>
            <label className={labelCls}>Strengths</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.strengths} onChange={(e) => update('strengths', e.target.value)} placeholder="Key strengths demonstrated..." />
          </div>
          <div>
            <label className={labelCls}>Areas for Improvement</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.areas_for_improvement} onChange={(e) => update('areas_for_improvement', e.target.value)} placeholder="Areas needing development..." />
          </div>
          <div>
            <label className={labelCls}>Goals for Next Period</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.goals} onChange={(e) => update('goals', e.target.value)} placeholder="Targets and objectives..." />
          </div>
          <div>
            <label className={labelCls}>Reviewer Comments</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={form.comments} onChange={(e) => update('comments', e.target.value)} placeholder="Overall comments..." />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
            <button onClick={submit} disabled={busy || !form.period_name} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Appraisal
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// QUERY MODAL (employee raises a query/grievance)
// ============================================================
export function QueryModal({ employee, onClose, onSaved }) {
  const [form, setForm] = useState({
    subject: '',
    category: 'general',
    description: '',
    priority: 'normal',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await attendanceEngineService.createQuery({
        employee_id: employee.id,
        user_id: user?.id,
        subject: form.subject,
        category: form.category,
        description: form.description,
        priority: form.priority,
        status: 'open',
      })
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e?.message || 'Failed to submit query')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-lg shadow-xl">
        <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
              <MessageSquare className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Raise a Query</h3>
              <p className="text-sm text-slate-500">{employee.full_name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

          <div>
            <label className={labelCls}>Subject</label>
            <input className={inputCls} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Brief subject of your query" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Category</label>
              <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="general">General</option>
                <option value="payroll">Payroll</option>
                <option value="attendance">Attendance</option>
                <option value="leave">Leave</option>
                <option value="performance">Performance</option>
                <option value="grievance">Grievance</option>
                <option value="policy">Policy</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Priority</label>
              <select className={inputCls} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Describe your query or concern in detail..." />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
            <button onClick={submit} disabled={busy || !form.subject} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Submit Query
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// QUERY RESOLUTION MODAL (HR resolves a query)
// ============================================================
export function QueryResolutionModal({ query, employee, onClose, onResolved }) {
  const [resolution, setResolution] = useState('')
  const [status, setStatus] = useState('resolved')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await attendanceEngineService.resolveQuery(query.id, { status, resolution })
      onResolved?.()
      onClose()
    } catch (e) {
      setError(e?.message || 'Failed to resolve query')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-lg shadow-xl">
        <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
              <Check className="w-5 h-5 text-emerald-600" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900">Resolve Query</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">{query.subject}</p>
            <p className="text-xs text-slate-500 mt-1">{query.description}</p>
            <p className="text-xs text-slate-400 mt-2">From: {employee?.full_name || 'Employee'} · {query.category}</p>
          </div>

          <div>
            <label className={labelCls}>Resolution Status</label>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Resolution Details</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Describe the resolution..." />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
            <button onClick={submit} disabled={busy || !resolution} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Resolve Query
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
