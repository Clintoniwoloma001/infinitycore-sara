import React, { useEffect, useState } from 'react'
import { Loader2, Plus, Star, X } from 'lucide-react'
import { date, ModuleTable, status, useTable } from './hrShared'
import { appraisalService } from '../services/appraisalService'
import { employeeService } from '../services/employeeService'
import { useAuth } from '../hooks/useAuth'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const RATING_OPTIONS = ['excellent', 'good', 'satisfactory', 'needs_improvement', 'unsatisfactory']
const APPRAISAL_TYPES = ['quarterly', 'annual', 'probation', 'mid_year', 'exit']
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4']
const YEARS = [2026, 2025, 2024, 2023]

export default function Appraisals() {
  const { hasPermission, user } = useAuth()
  const canManage = hasPermission('hr.onboarding.manage') || hasPermission('hr.employee.read')
  const { rows, loading, error, reload } = useTable('employee_appraisals')
  const [employees, setEmployees] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')
  const [form, setForm] = useState({})

  useEffect(() => {
    employeeService.list().then(setEmployees).catch(() => {})
  }, [])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const create = async () => {
    if (!form.employee_id) { setFormError('Please select an employee.'); return }
    setFormError('')
    setCreating(true)
    try {
      const emp = employees.find((e) => e.id === form.employee_id)
      await appraisalService.create({
        employee_id: form.employee_id,
        employee_name: emp?.full_name || '',
        appraisal_type: form.appraisal_type || 'quarterly',
        work_period: form.work_period || '',
        quarter: form.quarter || '',
        appraisal_year: form.appraisal_year ? parseInt(form.appraisal_year) : null,
        appraisal_date: form.appraisal_date || null,
        reviewer: form.reviewer || '',
        strengths: form.strengths || '',
        areas_for_improvement: form.areas_for_improvement || '',
        objectives: form.objectives || '',
        overall_rating: form.overall_rating || null,
        comments: form.comments || '',
        status: 'draft',
        created_by: user?.id,
      })
      setShowCreate(false)
      setForm({})
      reload()
    } catch (e) {
      setFormError(e?.message || 'Failed to create appraisal')
    } finally {
      setCreating(false)
    }
  }

  const ratingBadge = (rating) => {
    const colors = {
      excellent: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      good: 'bg-blue-50 text-blue-700 border-blue-200',
      satisfactory: 'bg-slate-50 text-slate-700 border-slate-200',
      needs_improvement: 'bg-amber-50 text-amber-700 border-amber-200',
      unsatisfactory: 'bg-rose-50 text-rose-700 border-rose-200',
    }
    if (!rating) return '-'
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${colors[rating] || colors.satisfactory}`}>{rating.replace(/_/g, ' ')}</span>
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Appraisals</h2>
          <p className="text-sm text-slate-500 mt-1">Employee performance and appraisal records.</p>
        </div>
        {canManage && (
          <button onClick={() => { setShowCreate(true); setFormError(''); setForm({}) }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> New Appraisal
          </button>
        )}
      </div>

      <ModuleTable
        title=""
        subtitle=""
        rows={rows}
        loading={loading}
        error={error}
        searchKeys={['employee_name', 'appraisal_type', 'quarter', 'status', 'reviewer']}
        columns={[
          { key: 'employee_name', label: 'Employee', render: (r) => <div className="font-medium text-slate-900">{r.employee_name || '-'}</div> },
          { key: 'appraisal_type', label: 'Type', render: (r) => <span className="capitalize">{(r.appraisal_type || 'quarterly').replace(/_/g, ' ')}</span> },
          { key: 'quarter', label: 'Period', render: (r) => `${r.quarter || ''} ${r.appraisal_year || ''}`.trim() || r.work_period || '-' },
          { key: 'reviewer', label: 'Reviewer', render: (r) => r.reviewer || '-' },
          { key: 'overall_rating', label: 'Rating', render: (r) => ratingBadge(r.overall_rating) },
          { key: 'status', label: 'Status', render: (r) => status(r.status, ['completed', 'acknowledged']) },
          { key: 'appraisal_date', label: 'Date', render: (r) => date(r.appraisal_date || r.created_at) },
        ]}
      />

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">New Appraisal</h3>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            {formError && <p className="text-sm text-rose-600 mb-3">{formError}</p>}
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Employee *</label>
                  <select className={inputCls} value={form.employee_id || ''} onChange={set('employee_id')}>
                    <option value="">Select employee…</option>
                    {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} — {e.department || 'N/A'}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Appraisal Type</label>
                  <select className={inputCls} value={form.appraisal_type || 'quarterly'} onChange={set('appraisal_type')}>
                    {APPRAISAL_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Quarter</label>
                  <select className={inputCls} value={form.quarter || ''} onChange={set('quarter')}>
                    <option value="">Select quarter…</option>
                    {QUARTERS.map((q) => <option key={q} value={q}>{q}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Year</label>
                  <select className={inputCls} value={form.appraisal_year || ''} onChange={set('appraisal_year')}>
                    <option value="">Select year…</option>
                    {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Appraisal Date</label>
                  <input type="date" className={inputCls} value={form.appraisal_date || ''} onChange={set('appraisal_date')} />
                </div>
                <div>
                  <label className={labelCls}>Reviewer</label>
                  <input className={inputCls} value={form.reviewer || ''} onChange={set('reviewer')} placeholder="Reviewer name" />
                </div>
              </div>
              <div><label className={labelCls}>Strengths</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.strengths || ''} onChange={set('strengths')} /></div>
              <div><label className={labelCls}>Areas for Improvement</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.areas_for_improvement || ''} onChange={set('areas_for_improvement')} /></div>
              <div><label className={labelCls}>Objectives</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.objectives || ''} onChange={set('objectives')} /></div>
              <div>
                <label className={labelCls}>Overall Rating</label>
                <select className={inputCls} value={form.overall_rating || ''} onChange={set('overall_rating')}>
                  <option value="">Select rating…</option>
                  {RATING_OPTIONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
              <div><label className={labelCls}>Comments</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.comments || ''} onChange={set('comments')} /></div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={create} disabled={creating} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create Appraisal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
