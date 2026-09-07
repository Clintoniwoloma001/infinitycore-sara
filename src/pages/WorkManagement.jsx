import React, { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Clock, AlertCircle, Loader2, Plus, Target, TrendingUp, X, Upload, FileText, Eye } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState } from '../components/PageStates'
import { formatDate } from '../lib/utils'
import { employeeService } from '../services/employeeService'
import { workTaskService } from '../services/workTaskService'
import { targetService } from '../services/targetService'
import { kpiService } from '../services/kpiService'
import { logAction } from '../services/supabaseService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const PRIORITIES = ['low', 'medium', 'high', 'critical']
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'targets', label: 'Targets' },
  { id: 'kpis', label: 'KPIs' },
  { id: 'review', label: 'Awaiting Verification' },
  { id: 'overdue', label: 'Overdue' },
]

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${color}15` }}>
        <Icon className="w-5 h-5" style={{ color }} />
      </div>
      <div>
        <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
        <p className="text-2xl font-semibold text-slate-900">{value}</p>
      </div>
    </div>
  )
}

function PriorityBadge({ priority }) {
  const colors = { critical: 'bg-rose-50 text-rose-700 border-rose-200', high: 'bg-orange-50 text-orange-700 border-orange-200', medium: 'bg-blue-50 text-blue-700 border-blue-200', low: 'bg-slate-50 text-slate-600 border-slate-200' }
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${colors[priority] || colors.medium}`}>{priority}</span>
}

function StatusBadge({ status }) {
  const colors = { completed: 'emerald', approved: 'emerald', rejected: 'rose', overdue: 'rose', cancelled: 'rose', submitted: 'amber', under_review: 'amber', assigned: 'blue', accepted: 'blue', in_progress: 'violet', active: 'blue', achieved: 'emerald', missed: 'rose', draft: 'slate', in_review: 'amber' }
  const colorMap = { emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200', rose: 'bg-rose-50 text-rose-700 border-rose-200', amber: 'bg-amber-50 text-amber-700 border-amber-200', blue: 'bg-blue-50 text-blue-700 border-blue-200', violet: 'bg-violet-50 text-violet-700 border-violet-200', slate: 'bg-slate-100 text-slate-600 border-slate-200' }
  const c = colors[status] || 'slate'
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${colorMap[c]}`}>{(status || 'pending').replace(/_/g, ' ')}</span>
}

function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  const color = pct >= 100 ? 'bg-emerald-500' : pct >= 75 ? 'bg-blue-500' : pct >= 50 ? 'bg-amber-500' : 'bg-rose-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium text-slate-600 w-10 text-right">{pct}%</span>
    </div>
  )
}

export default function WorkManagement() {
  const navigate = useNavigate()
  const { user, hasPermission, isManager, isAdmin, role } = useAuth()
  const canManage = isAdmin || isManager || hasPermission('hr.employee.read') || role === 'super_admin'
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [employees, setEmployees] = useState([])
  const [tasks, setTasks] = useState([])
  const [targets, setTargets] = useState([])
  const [kpis, setKpis] = useState([])
  const [pendingSubs, setPendingSubs] = useState([])
  const [stats, setStats] = useState({})
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [showCreateTarget, setShowCreateTarget] = useState(false)
  const [showCreateKpi, setShowCreateKpi] = useState(false)
  const [reviewSub, setReviewSub] = useState(null)
  const [form, setForm] = useState({})
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [evidenceFiles, setEvidenceFiles] = useState([])

  const load = async () => {
    setLoading(true)
    try {
      const [emps, taskList, targetList, kpiList, subList, statData] = await Promise.all([
        employeeService.list().catch(() => []),
        workTaskService.list({ assignedBy: user?.id }).catch(() => []),
        targetService.list({ managerId: user?.id }).catch(() => []),
        kpiService.list({ managerId: user?.id }).catch(() => []),
        workTaskService.listPendingSubmissions(user?.id).catch(() => []),
        workTaskService.getStats(user?.id).catch(() => ({})),
      ])
      setEmployees(emps)
      setTasks(taskList)
      setTargets(targetList)
      setKpis(kpiList)
      setPendingSubs(subList)
      setStats(statData)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (user?.id) load() }, [user?.id])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const overdueTasks = useMemo(() => tasks.filter((t) => t.status === 'overdue' || (t.due_date && new Date(t.due_date) < new Date() && !['completed', 'cancelled'].includes(t.status))), [tasks])

  const createTask = async () => {
    if (!form.title?.trim()) { setFormError('Task title is required.'); return }
    if (!form.employee_id) { setFormError('Please select an employee.'); return }
    setFormError(''); setBusy(true)
    try {
      const emp = employees.find((e) => e.id === form.employee_id)
      await workTaskService.create({
        title: form.title,
        description: form.description || '',
        employee_id: form.employee_id,
        employee_name: emp?.full_name || '',
        assigned_to_user_id: emp?.user_id || null,
        assigned_by: user.id,
        assigned_by_name: user.email || '',
        department: emp?.department || form.department || '',
        branch: emp?.branch || '',
        priority: form.priority || 'medium',
        status: 'assigned',
        instructions: form.instructions || '',
        expected_outcome: form.expected_outcome || '',
        requires_evidence: form.requires_evidence === 'true',
        start_date: form.start_date || null,
        due_date: form.due_date || null,
      })
      setShowCreateTask(false); setForm({}); load()
    } catch (e) { setFormError(e?.message || 'Failed to create task') }
    finally { setBusy(false) }
  }

  const createTarget = async () => {
    if (!form.title?.trim()) { setFormError('Target title is required.'); return }
    if (!form.employee_id) { setFormError('Please select an employee.'); return }
    if (!form.target_value) { setFormError('Target value is required.'); return }
    setFormError(''); setBusy(true)
    try {
      const emp = employees.find((e) => e.id === form.employee_id)
      await targetService.create({
        title: form.title,
        description: form.description || '',
        employee_id: form.employee_id,
        employee_name: emp?.full_name || '',
        manager_id: user.id,
        department: emp?.department || '',
        branch: emp?.branch || '',
        measurement_type: form.measurement_type || '',
        target_value: parseFloat(form.target_value) || 0,
        starting_value: parseFloat(form.starting_value) || 0,
        current_value: parseFloat(form.starting_value) || 0,
        unit: form.unit || '',
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        frequency: form.frequency || 'monthly',
        status: 'active',
        notes: form.notes || '',
      })
      setShowCreateTarget(false); setForm({}); load()
    } catch (e) { setFormError(e?.message || 'Failed to create target') }
    finally { setBusy(false) }
  }

  const createKpi = async () => {
    if (!form.kpi_name?.trim()) { setFormError('KPI name is required.'); return }
    if (!form.employee_id) { setFormError('Please select an employee.'); return }
    if (!form.target_value) { setFormError('Target value is required.'); return }
    setFormError(''); setBusy(true)
    try {
      const emp = employees.find((e) => e.id === form.employee_id)
      await kpiService.create({
        kpi_name: form.kpi_name,
        employee_id: form.employee_id,
        employee_name: emp?.full_name || '',
        department: emp?.department || '',
        role: emp?.position || '',
        manager_id: user.id,
        category: form.category || '',
        description: form.description || '',
        measurement_method: form.measurement_method || '',
        target_value: parseFloat(form.target_value) || 0,
        actual_value: parseFloat(form.actual_value) || 0,
        unit: form.unit || '',
        weight: parseFloat(form.weight) || 100,
        review_period: form.review_period || 'quarterly',
        quarter: form.quarter || null,
        appraisal_year: form.appraisal_year ? parseInt(form.appraisal_year) : null,
        status: 'active',
      })
      setShowCreateKpi(false); setForm({}); load()
    } catch (e) { setFormError(e?.message || 'Failed to create KPI') }
    finally { setBusy(false) }
  }

  const approveSub = async (sub, comment) => {
    setBusy(true)
    try {
      await workTaskService.approveSubmission(sub.id, comment, user.id)
      setReviewSub(null); load()
    } catch (e) { setFormError(e?.message || 'Failed to approve') }
    finally { setBusy(false) }
  }

  const rejectSub = async (sub, reason) => {
    if (!reason?.trim()) { setFormError('Rejection reason is required.'); return }
    setBusy(true)
    try {
      await workTaskService.rejectSubmission(sub.id, reason, user.id)
      setReviewSub(null); load()
    } catch (e) { setFormError(e?.message || 'Failed to reject') }
    finally { setBusy(false) }
  }

  const updateTargetProgress = async (targetId, newValue) => {
    await targetService.updateProgress(targetId, parseFloat(newValue) || 0)
    load()
  }

  const updateKpiActual = async (kpiId, newActual) => {
    await kpiService.update(kpiId, { actual_value: parseFloat(newActual) || 0 })
    load()
  }

  if (loading) return <LoadingState label="Loading work management..." />

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Work Management</h2>
          <p className="text-sm text-slate-500 mt-1">Assign tasks, targets, and KPIs. Review submissions and monitor performance.</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button onClick={() => { setShowCreateTask(true); setFormError(''); setForm({}) }} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]"><Plus className="w-4 h-4" /> Task</button>
            <button onClick={() => { setShowCreateTarget(true); setFormError(''); setForm({}) }} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"><Target className="w-4 h-4" /> Target</button>
            <button onClick={() => { setShowCreateKpi(true); setFormError(''); setForm({}) }} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"><TrendingUp className="w-4 h-4" /> KPI</button>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <StatCard icon={Plus} label="Assigned" value={stats.assigned ?? 0} color="#3b82f6" />
        <StatCard icon={Clock} label="In Progress" value={stats.inProgress ?? 0} color="#8b5cf6" />
        <StatCard icon={Eye} label="Awaiting Review" value={stats.awaiting ?? 0} color="#f59e0b" />
        <StatCard icon={CheckCircle2} label="Completed" value={stats.completed ?? 0} color="#10b981" />
        <StatCard icon={AlertCircle} label="Overdue" value={overdueTasks.length} color="#ef4444" />
        <StatCard icon={X} label="Rejected" value={stats.rejected ?? 0} color="#f43f5e" />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-900 mb-3">Task Summary</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[{ l: 'Assigned', v: stats.assigned }, { l: 'In Progress', v: stats.inProgress }, { l: 'Awaiting Review', v: stats.awaiting }, { l: 'Completed', v: stats.completed }].map((s) => (
                <div key={s.l} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">{s.l}</div><div className="text-lg font-bold text-slate-800 mt-0.5">{s.v ?? 0}</div></div>
              ))}
            </div>
          </div>
          {pendingSubs.length > 0 && (
            <div className="bg-white rounded-lg border border-amber-200 p-5">
              <h3 className="font-semibold text-amber-700 mb-3">Submissions Awaiting Your Review ({pendingSubs.length})</h3>
              <div className="space-y-2">
                {pendingSubs.slice(0, 5).map((sub) => (
                  <div key={sub.id} className="flex items-center justify-between p-3 rounded-lg bg-amber-50 border border-amber-100">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{sub.work_tasks?.title || 'Task'}</p>
                      <p className="text-xs text-slate-500">{sub.work_tasks?.employee_name || 'Employee'} — {formatDate(sub.created_at)}</p>
                    </div>
                    <button onClick={() => setReviewSub(sub)} className="px-3 py-1.5 rounded-md bg-amber-600 text-white text-xs font-medium hover:bg-amber-700">Review</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'tasks' && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          {tasks.length === 0 ? <EmptyState title="No tasks assigned yet" description="Create a task to assign work to an employee." /> : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-left">
                <tr>{['Task', 'Employee', 'Priority', 'Due', 'Status', 'Progress'].map((h) => <th key={h} className="px-4 py-3 font-medium whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tasks.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><div className="font-medium text-slate-900">{t.title}</div><div className="text-xs text-slate-400">{t.description?.slice(0, 60)}</div></td>
                    <td className="px-4 py-3 text-slate-700">{t.employee_name || '-'}</td>
                    <td className="px-4 py-3"><PriorityBadge priority={t.priority} /></td>
                    <td className="px-4 py-3 text-slate-600">{formatDate(t.due_date)}</td>
                    <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                    <td className="px-4 py-3 w-32"><ProgressBar value={t.completion_percentage || 0} max={100} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'targets' && (
        <div className="space-y-3">
          {targets.length === 0 ? <EmptyState title="No targets set yet" description="Create a target to set measurable objectives for employees." /> : targets.map((t) => {
            const progress = targetService.calcProgress(t)
            return (
              <div key={t.id} className="bg-white rounded-lg border border-slate-200 p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h4 className="font-semibold text-slate-900">{t.title}</h4>
                    <p className="text-xs text-slate-500 mt-0.5">{t.employee_name} — {t.measurement_type || 'Target'} — {t.frequency}</p>
                  </div>
                  <StatusBadge status={t.status} />
                </div>
                {t.description && <p className="text-sm text-slate-600 mb-3">{t.description}</p>}
                <div className="flex items-center gap-4 mb-3">
                  <div className="text-sm text-slate-600">Current: <span className="font-semibold">{t.current_value || 0}</span> / {t.target_value} {t.unit || ''}</div>
                  <div className="flex-1"><ProgressBar value={t.current_value || 0} max={t.target_value || 1} /></div>
                </div>
                {canManage && (
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    <input type="number" placeholder="Update current value" className="w-40 h-8 rounded-lg border border-slate-300 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#009944]" defaultValue={t.current_value || 0} onBlur={(e) => { if (e.target.value != t.current_value) updateTargetProgress(t.id, e.target.value) }} />
                    <span className="text-xs text-slate-400">{t.unit || 'units'}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'kpis' && (
        <div className="space-y-3">
          {kpis.length === 0 ? <EmptyState title="No KPIs defined yet" description="Create a KPI to measure employee performance." /> : (
            <>
              {kpis.length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 p-5 mb-3">
                  <h4 className="font-semibold text-slate-900 mb-2">Overall Weighted KPI Score</h4>
                  <div className="flex items-center gap-4">
                    <div className="text-3xl font-bold text-[#009944]">{kpiService.calcWeightedScore(kpis)}%</div>
                    <div className="flex-1"><ProgressBar value={kpiService.calcWeightedScore(kpis)} max={100} /></div>
                  </div>
                </div>
              )}
              {kpis.map((k) => {
                const achievement = kpiService.calcAchievement(k)
                return (
                  <div key={k.id} className="bg-white rounded-lg border border-slate-200 p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className="font-semibold text-slate-900">{k.kpi_name}</h4>
                        <p className="text-xs text-slate-500 mt-0.5">{k.employee_name} — {k.category || 'General'} — {k.quarter || k.review_period} {k.appraisal_year || ''}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">Weight: {k.weight}%</span>
                        <StatusBadge status={k.status} />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4 mb-3">
                      <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Target</div><div className="text-lg font-bold text-slate-800">{k.target_value} {k.unit || ''}</div></div>
                      <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Actual</div><div className="text-lg font-bold text-slate-800">{k.actual_value || 0} {k.unit || ''}</div></div>
                      <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Achievement</div><div className="text-lg font-bold text-[#009944]">{achievement}%</div></div>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                        <input type="number" placeholder="Update actual value" className="w-40 h-8 rounded-lg border border-slate-300 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#009944]" defaultValue={k.actual_value || 0} onBlur={(e) => { if (e.target.value != k.actual_value) updateKpiActual(k.id, e.target.value) }} />
                        <span className="text-xs text-slate-400">{k.unit || 'units'}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}

      {tab === 'review' && (
        <div className="space-y-3">
          {pendingSubs.length === 0 ? <EmptyState title="No submissions awaiting review" description="Task completion submissions will appear here for your approval." /> : pendingSubs.map((sub) => (
            <div key={sub.id} className="bg-white rounded-lg border border-slate-200 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h4 className="font-semibold text-slate-900">{sub.work_tasks?.title || 'Task'}</h4>
                  <p className="text-xs text-slate-500 mt-0.5">{sub.work_tasks?.employee_name} — Submitted {formatDate(sub.created_at)}</p>
                </div>
                <StatusBadge status="under_review" />
              </div>
              {sub.submission_comment && <p className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3 mb-3">{sub.submission_comment}</p>}
              <div className="flex items-center gap-4 text-sm text-slate-500 mb-3">
                <span>Completion: {sub.completion_percentage}%</span>
                {sub.reference_url && <a href={sub.reference_url} target="_blank" rel="noreferrer" className="text-[#009944] hover:underline">Reference link</a>}
              </div>
              <button onClick={() => setReviewSub(sub)} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">Review Submission</button>
            </div>
          ))}
        </div>
      )}

      {tab === 'overdue' && (
        <div className="space-y-3">
          {overdueTasks.length === 0 ? <EmptyState title="No overdue tasks" description="Tasks past their due date will appear here." /> : overdueTasks.map((t) => (
            <div key={t.id} className="bg-white rounded-lg border border-rose-200 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-slate-900">{t.title}</h4>
                  <p className="text-xs text-slate-500 mt-0.5">{t.employee_name} — Due {formatDate(t.due_date)}</p>
                </div>
                <PriorityBadge priority={t.priority} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Task Modal */}
      {showCreateTask && <CreateModal title="Assign New Task" onClose={() => setShowCreateTask(false)} error={formError} busy={busy}>
        <div className="space-y-4">
          <div><label className={labelCls}>Task Title *</label><input className={inputCls} value={form.title || ''} onChange={set('title')} /></div>
          <div><label className={labelCls}>Description</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.description || ''} onChange={set('description')} /></div>
          <div><label className={labelCls}>Assign To *</label><select className={inputCls} value={form.employee_id || ''} onChange={set('employee_id')}><option value="">Select employee…</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} — {e.department || 'N/A'}</option>)}</select></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className={labelCls}>Priority</label><select className={inputCls} value={form.priority || 'medium'} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}</select></div>
            <div><label className={labelCls}>Requires Evidence</label><select className={inputCls} value={form.requires_evidence || 'false'} onChange={set('requires_evidence')}><option value="false">No</option><option value="true">Yes</option></select></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className={labelCls}>Start Date</label><input type="date" className={inputCls} value={form.start_date || ''} onChange={set('start_date')} /></div>
            <div><label className={labelCls}>Due Date</label><input type="date" className={inputCls} value={form.due_date || ''} onChange={set('due_date')} /></div>
          </div>
          <div><label className={labelCls}>Instructions</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.instructions || ''} onChange={set('instructions')} /></div>
          <div><label className={labelCls}>Expected Outcome</label><input className={inputCls} value={form.expected_outcome || ''} onChange={set('expected_outcome')} /></div>
        </div>
        <button onClick={createTask} disabled={busy} className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Assign Task</button>
      </CreateModal>}

      {/* Create Target Modal */}
      {showCreateTarget && <CreateModal title="Assign New Target" onClose={() => setShowCreateTarget(false)} error={formError} busy={busy}>
        <div className="space-y-4">
          <div><label className={labelCls}>Target Title *</label><input className={inputCls} value={form.title || ''} onChange={set('title')} /></div>
          <div><label className={labelCls}>Description</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.description || ''} onChange={set('description')} /></div>
          <div><label className={labelCls}>Assign To *</label><select className={inputCls} value={form.employee_id || ''} onChange={set('employee_id')}><option value="">Select employee…</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} — {e.department || 'N/A'}</option>)}</select></div>
          <div><label className={labelCls}>Measurement Type</label><input className={inputCls} value={form.measurement_type || ''} onChange={set('measurement_type')} placeholder="e.g. Sales, Revenue, Applications" /></div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className={labelCls}>Target Value *</label><input type="number" className={inputCls} value={form.target_value || ''} onChange={set('target_value')} /></div>
            <div><label className={labelCls}>Starting Value</label><input type="number" className={inputCls} value={form.starting_value || ''} onChange={set('starting_value')} /></div>
            <div><label className={labelCls}>Unit</label><input className={inputCls} value={form.unit || ''} onChange={set('unit')} placeholder="e.g. applications, ₦" /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className={labelCls}>Frequency</label><select className={inputCls} value={form.frequency || 'monthly'} onChange={set('frequency')}>{['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'custom'].map((f) => <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>)}</select></div>
            <div><label className={labelCls}>End Date</label><input type="date" className={inputCls} value={form.end_date || ''} onChange={set('end_date')} /></div>
          </div>
        </div>
        <button onClick={createTarget} disabled={busy} className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Target className="w-4 h-4" />} Assign Target</button>
      </CreateModal>}

      {/* Create KPI Modal */}
      {showCreateKpi && <CreateModal title="Define New KPI" onClose={() => setShowCreateKpi(false)} error={formError} busy={busy}>
        <div className="space-y-4">
          <div><label className={labelCls}>KPI Name *</label><input className={inputCls} value={form.kpi_name || ''} onChange={set('kpi_name')} /></div>
          <div><label className={labelCls}>Assign To *</label><select className={inputCls} value={form.employee_id || ''} onChange={set('employee_id')}><option value="">Select employee…</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} — {e.department || 'N/A'}</option>)}</select></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className={labelCls}>Category</label><input className={inputCls} value={form.category || ''} onChange={set('category')} placeholder="e.g. Productivity, Quality" /></div>
            <div><label className={labelCls}>Weight %</label><input type="number" className={inputCls} value={form.weight || 100} onChange={set('weight')} /></div>
          </div>
          <div><label className={labelCls}>Description</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.description || ''} onChange={set('description')} /></div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className={labelCls}>Target Value *</label><input type="number" className={inputCls} value={form.target_value || ''} onChange={set('target_value')} /></div>
            <div><label className={labelCls}>Actual Value</label><input type="number" className={inputCls} value={form.actual_value || ''} onChange={set('actual_value')} /></div>
            <div><label className={labelCls}>Unit</label><input className={inputCls} value={form.unit || ''} onChange={set('unit')} placeholder="%, count, ₦" /></div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className={labelCls}>Review Period</label><select className={inputCls} value={form.review_period || 'quarterly'} onChange={set('review_period')}>{['q1', 'q2', 'q3', 'q4', 'annual', 'mid_year'].map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}</select></div>
            <div><label className={labelCls}>Quarter</label><select className={inputCls} value={form.quarter || ''} onChange={set('quarter')}><option value="">—</option>{['Q1', 'Q2', 'Q3', 'Q4'].map((q) => <option key={q} value={q}>{q}</option>)}</select></div>
            <div><label className={labelCls}>Year</label><input type="number" className={inputCls} value={form.appraisal_year || ''} onChange={set('appraisal_year')} placeholder="2026" /></div>
          </div>
          <div><label className={labelCls}>Measurement Method</label><input className={inputCls} value={form.measurement_method || ''} onChange={set('measurement_method')} placeholder="How is this measured?" /></div>
        </div>
        <button onClick={createKpi} disabled={busy} className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />} Create KPI</button>
      </CreateModal>}

      {/* Review Submission Modal */}
      {reviewSub && <CreateModal title="Review Task Submission" onClose={() => setReviewSub(null)} error={formError} busy={busy}>
        <div className="space-y-4">
          <div className="bg-slate-50 rounded-lg p-4">
            <h4 className="font-semibold text-slate-900">{reviewSub.work_tasks?.title}</h4>
            <p className="text-sm text-slate-500 mt-1">{reviewSub.work_tasks?.employee_name}</p>
          </div>
          {reviewSub.submission_comment && <div><p className="text-xs font-semibold text-slate-400 uppercase mb-1">Comment</p><p className="text-sm text-slate-700">{reviewSub.submission_comment}</p></div>}
          <div className="grid grid-cols-2 gap-4">
            <div><p className="text-xs font-semibold text-slate-400 uppercase">Completion</p><p className="text-sm text-slate-700">{reviewSub.completion_percentage}%</p></div>
            <div><p className="text-xs font-semibold text-slate-400 uppercase">Date</p><p className="text-sm text-slate-700">{formatDate(reviewSub.completed_date)}</p></div>
          </div>
          {reviewSub.reference_url && <div><p className="text-xs font-semibold text-slate-400 uppercase mb-1">Reference</p><a href={reviewSub.reference_url} target="_blank" rel="noreferrer" className="text-sm text-[#009944] hover:underline">{reviewSub.reference_url}</a></div>}
          {reviewSub.additional_note && <div><p className="text-xs font-semibold text-slate-400 uppercase mb-1">Note</p><p className="text-sm text-slate-700">{reviewSub.additional_note}</p></div>}
          <div><label className={labelCls}>Review Comment / Rejection Reason</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} id="review-comment" /></div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={() => { const c = document.getElementById('review-comment')?.value || ''; rejectSub(reviewSub, c) }} disabled={busy} className="flex-1 px-4 py-2.5 rounded-lg border border-rose-300 text-rose-600 text-sm font-medium hover:bg-rose-50 disabled:opacity-60">Reject</button>
          <button onClick={() => { const c = document.getElementById('review-comment')?.value || ''; approveSub(reviewSub, c) }} disabled={busy} className="flex-1 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Approve</button>
        </div>
      </CreateModal>}
    </div>
  )
}

function CreateModal({ title, onClose, error, busy, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        {error && <p className="text-sm text-rose-600 mb-3">{error}</p>}
        {children}
      </div>
    </div>
  )
}
