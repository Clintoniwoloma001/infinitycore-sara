import React, { useEffect, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { date, ModuleTable, status, useTable } from './hrShared'
import { hrQueryService } from '../services/hrQueryService'
import { employeeService } from '../services/employeeService'
import { useAuth } from '../hooks/useAuth'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const QUERY_TYPES = ['general', 'attendance', 'performance', 'conduct', 'compliance', 'financial', 'other']
const WORK_PERIODS = ['Q1', 'Q2', 'Q3', 'Q4', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export default function HRQueries() {
  const { hasPermission, user } = useAuth()
  const canManage = hasPermission('hr.onboarding.manage') || hasPermission('hr.employee.read')
  const { rows, loading, error, reload } = useTable('hr_queries')
  const [employees, setEmployees] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')
  const [form, setForm] = useState({})
  const [respondTarget, setRespondTarget] = useState(null)
  const [responseText, setResponseText] = useState('')
  const [hrComments, setHrComments] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    employeeService.list().then(setEmployees).catch(() => {})
  }, [])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const create = async () => {
    if (!form.query_title?.trim()) { setFormError('Query title is required.'); return }
    if (!form.employee_id) { setFormError('Please select an employee.'); return }
    setFormError('')
    setCreating(true)
    try {
      const emp = employees.find((e) => e.id === form.employee_id)
      await hrQueryService.create({
        employee_id: form.employee_id,
        employee_name: emp?.full_name || '',
        query_title: form.query_title,
        query_type: form.query_type || 'general',
        description: form.description || '',
        work_period: form.work_period || '',
        status: 'ISSUED',
        issued_by: user?.id,
      })
      setShowCreate(false)
      setForm({})
      reload()
    } catch (e) {
      setFormError(e?.message || 'Failed to create query')
    } finally {
      setCreating(false)
    }
  }

  const respond = async () => {
    if (!respondTarget) return
    setBusy(true)
    try {
      await hrQueryService.respond(respondTarget.id, responseText, hrComments)
      setRespondTarget(null)
      setResponseText('')
      setHrComments('')
      reload()
    } catch (e) {
      setFormError(e?.message || 'Failed to respond')
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (id) => {
    await hrQueryService.resolve(id)
    reload()
  }

  const close = async (id) => {
    await hrQueryService.close(id)
    reload()
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">HR Queries</h2>
          <p className="text-sm text-slate-500 mt-1">Issue and track queries against employees.</p>
        </div>
        {canManage && (
          <button onClick={() => { setShowCreate(true); setFormError(''); setForm({}) }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> New Query
          </button>
        )}
      </div>

      <ModuleTable
        title=""
        subtitle=""
        rows={rows}
        loading={loading}
        error={error}
        searchKeys={['query_title', 'employee_name', 'query_type', 'status', 'work_period']}
        columns={[
          { key: 'employee_name', label: 'Employee', render: (r) => <div className="font-medium text-slate-900">{r.employee_name || '-'}</div> },
          { key: 'query_title', label: 'Title', render: (r) => <div className="font-medium text-slate-700">{r.query_title}</div> },
          { key: 'query_type', label: 'Type', render: (r) => <span className="capitalize">{(r.query_type || 'general').replace(/_/g, ' ')}</span> },
          { key: 'work_period', label: 'Period', render: (r) => r.work_period || '-' },
          { key: 'status', label: 'Status', render: (r) => status(r.status?.toLowerCase(), ['resolved', 'closed']) },
          { key: 'created_at', label: 'Created', render: (r) => date(r.created_at) },
          { key: 'actions', label: 'Actions', render: (r) => (
            <div className="flex gap-1.5">
              {canManage && r.status !== 'RESPONDED' && r.status !== 'RESOLVED' && r.status !== 'CLOSED' && (
                <button onClick={() => { setRespondTarget(r); setResponseText(r.response || ''); setHrComments(r.hr_comments || '') }}
                  className="px-2 py-1 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">Respond</button>
              )}
              {canManage && r.status === 'RESPONDED' && (
                <button onClick={() => resolve(r.id)} className="px-2 py-1 rounded-md border border-emerald-300 text-emerald-600 text-xs hover:bg-emerald-50">Resolve</button>
              )}
              {canManage && r.status === 'RESOLVED' && (
                <button onClick={() => close(r.id)} className="px-2 py-1 rounded-md border border-slate-300 text-slate-500 text-xs hover:bg-slate-100">Close</button>
              )}
            </div>
          ) },
        ]}
      />

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">New HR Query</h3>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            {formError && <p className="text-sm text-rose-600 mb-3">{formError}</p>}
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Employee *</label>
                <select className={inputCls} value={form.employee_id || ''} onChange={set('employee_id')}>
                  <option value="">Select employee…</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} — {e.department || 'N/A'}</option>)}
                </select>
              </div>
              <div><label className={labelCls}>Query Title *</label><input className={inputCls} value={form.query_title || ''} onChange={set('query_title')} /></div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Query Type</label>
                  <select className={inputCls} value={form.query_type || 'general'} onChange={set('query_type')}>
                    {QUERY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Work Period</label>
                  <select className={inputCls} value={form.work_period || ''} onChange={set('work_period')}>
                    <option value="">Select period…</option>
                    {WORK_PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>
              <div><label className={labelCls}>Description</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={form.description || ''} onChange={set('description')} /></div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={create} disabled={creating} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create Query
              </button>
            </div>
          </div>
        </div>
      )}

      {respondTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Respond to Query</h3>
              <button onClick={() => setRespondTarget(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-slate-500 mb-1">Query: <span className="font-medium text-slate-700">{respondTarget.query_title}</span></p>
            <p className="text-sm text-slate-500 mb-4">Employee: <span className="font-medium text-slate-700">{respondTarget.employee_name}</span></p>
            {respondTarget.description && <p className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3 mb-4">{respondTarget.description}</p>}
            <div className="space-y-4">
              <div><label className={labelCls}>Response</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={responseText} onChange={(e) => setResponseText(e.target.value)} /></div>
              <div><label className={labelCls}>HR Comments</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={hrComments} onChange={(e) => setHrComments(e.target.value)} /></div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setRespondTarget(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={respond} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Submit Response
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
