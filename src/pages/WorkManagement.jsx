import React, { useEffect, useState } from 'react'
import { Plus, X, Loader2, Save, Trash2, Check, Ban, MessageSquare, Target, ListChecks, ClipboardCheck, FileText, TrendingUp, Calendar } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { workManagementService } from '../services/workManagementService'
import { useAuth } from '../hooks/useAuth'
import { StatusBadge } from '../lib/utils'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import { ROLES, ROLE_METADATA, assignableRoles } from '../constants/roles'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const ASSIGNMENT_TYPES = [
  { key: 'individual', label: 'Individual' },
  { key: 'team', label: 'Team' },
  { key: 'department', label: 'Department' },
  { key: 'branch', label: 'Branch' },
  { key: 'area', label: 'Area' },
]

const PERIODS = [
  { key: 'monthly', label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'annual', label: 'Annual' },
  { key: 'custom', label: 'Custom' },
]

export default function WorkManagement() {
  const { user, role: actorRole } = useAuth()
  const [tab, setTab] = useState('tasks')
  const [notice, setNotice] = useState({ kind: '', text: '' })

  const tabs = [
    { id: 'tasks', label: 'Tasks', icon: ListChecks },
    { id: 'kpis', label: 'KPIs', icon: Target },
    { id: 'targets', label: 'Targets', icon: TrendingUp },
    { id: 'plans', label: 'Work Plans', icon: ClipboardCheck },
    { id: 'reports', label: 'Reports', icon: FileText },
    { id: 'performance', label: 'Team Performance', icon: Calendar },
  ]

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">Work Management</h2>
        <p className="text-sm text-slate-500 mt-1">Create and assign tasks, KPIs, targets, and work plans. Review submitted reports and track team performance.</p>
      </div>

      {notice.text && (
        <div className={`mb-5 rounded-lg border p-4 text-sm ${notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}>
          {notice.text}
        </div>
      )}

      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {tabs.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition ${tab === t.id ? 'bg-[#009944] text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
            >
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'tasks' && <TasksTab user={user} actorRole={actorRole} setNotice={setNotice} />}
      {tab === 'kpis' && <KpisTab user={user} actorRole={actorRole} setNotice={setNotice} />}
      {tab === 'targets' && <TargetsTab user={user} setNotice={setNotice} />}
      {tab === 'plans' && <PlansTab user={user} setNotice={setNotice} />}
      {tab === 'reports' && <ReportsTab user={user} setNotice={setNotice} />}
      {tab === 'performance' && <PerformanceTab setNotice={setNotice} />}
    </div>
  )
}

// ============================================================
// TASKS TAB
// ============================================================
function TasksTab({ user, actorRole, setNotice }) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [users, setUsers] = useState([])
  const [departments, setDepartments] = useState([])
  const [branches, setBranches] = useState([])
  const [kpis, setKpis] = useState([])
  const [form, setForm] = useState(defaultTaskForm())
  const [busy, setBusy] = useState(false)

  function defaultTaskForm() {
    return {
      title: '', description: '', priority: 'normal', start_date: '', due_date: '',
      assignment_type: 'individual', assigned_to: '', department: '', branch: '', area: '',
      kpi_id: '', instructions: '',
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      const [taskList, userList, deptList, branchList, kpiList] = await Promise.all([
        workManagementService.listTasks(),
        workManagementService.listUsersForAssignment().catch(() => []),
        workManagementService.listDepartments().catch(() => []),
        workManagementService.listBranches().catch(() => []),
        workManagementService.listKpis({ activeOnly: true }).catch(() => []),
      ])
      setTasks(taskList)
      setUsers(userList)
      setDepartments(deptList)
      setBranches(branchList)
      setKpis(kpiList)
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load tasks' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const createTask = async () => {
    setBusy(true)
    try {
      const payload = {
        title: form.title,
        description: form.description,
        task_type: 'work_task',
        priority: form.priority,
        start_date: form.start_date || null,
        due_date: form.due_date || null,
        assignment_type: form.assignment_type,
        assigned_to: form.assignment_type === 'individual' ? form.assigned_to : null,
        department: form.assignment_type === 'department' ? form.department : form.department || null,
        branch: form.assignment_type === 'branch' ? form.branch : null,
        area: form.assignment_type === 'area' ? form.area : null,
        kpi_id: form.kpi_id || null,
        instructions: form.instructions || null,
        created_by: user.id,
        status: 'pending',
      }
      await workManagementService.createTask(payload)
      setNotice({ kind: 'ok', text: 'Task created and assigned successfully.' })
      setShowCreate(false)
      setForm(defaultTaskForm())
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to create task' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Create and assign tasks to individuals, teams, departments, branches, or areas.</p>
        <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
          <Plus className="w-4 h-4" /> Create Task
        </button>
      </div>

      {loading && <LoadingState label="Loading tasks..." />}
      {!loading && tasks.length === 0 && <EmptyState title="No tasks yet" description="Create a task to assign work to your team." />}
      {!loading && tasks.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Priority</th>
                <th className="px-4 py-3 font-medium">Assignment</th>
                <th className="px-4 py-3 font-medium">Due Date</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Progress</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tasks.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{t.title}</td>
                  <td className="px-4 py-3"><span className="text-xs font-medium capitalize">{t.priority}</span></td>
                  <td className="px-4 py-3 text-xs text-slate-500">{t.assignment_type || 'individual'}{t.department ? ` · ${t.department}` : ''}{t.branch ? ` · ${t.branch}` : ''}</td>
                  <td className="px-4 py-3 text-slate-600">{t.due_date ? new Date(t.due_date).toLocaleDateString() : '—'}</td>
                  <td className="px-4 py-3"><StatusBadge label={t.status?.replace(/_/g, ' ') || 'pending'} color={t.status === 'completed' ? 'emerald' : t.status === 'in_progress' ? 'blue' : 'amber'} /></td>
                  <td className="px-4 py-3">
                    {t.completion_pct > 0 && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-16 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                          <div className="h-full bg-[#009944] rounded-full" style={{ width: `${t.completion_pct}%` }} />
                        </div>
                        <span className="text-xs tabular-nums">{t.completion_pct}%</span>
                      </div>
                    )}
                    {(!t.completion_pct || t.completion_pct === 0) && <span className="text-xs text-slate-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateModal title="Create Task" onClose={() => setShowCreate(false)} onSave={createTask} busy={busy}>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Task Title</label>
              <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Q4 Customer Acquisition Campaign" />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Description</label>
              <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Priority</label>
              <select className={inputCls} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {['critical', 'high', 'normal', 'low'].map((p) => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Start Date</label>
              <input type="date" className={inputCls} value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Due Date</label>
              <input type="date" className={inputCls} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Assignment Type</label>
              <select className={inputCls} value={form.assignment_type} onChange={(e) => setForm({ ...form, assignment_type: e.target.value, assigned_to: '', department: '', branch: '', area: '' })}>
                {ASSIGNMENT_TYPES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </div>
            {form.assignment_type === 'individual' && (
              <div className="col-span-2">
                <label className={labelCls}>Assign To (Employee)</label>
                <select className={inputCls} value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })}>
                  <option value="">Select user...</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email} ({ROLE_METADATA[u.role]?.label || u.role})</option>)}
                </select>
              </div>
            )}
            {form.assignment_type === 'department' && (
              <div className="col-span-2">
                <label className={labelCls}>Department</label>
                <input list="dept-list-tasks" className={inputCls} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Select or type department" />
                <datalist id="dept-list-tasks">{departments.map((d) => <option key={d} value={d} />)}</datalist>
              </div>
            )}
            {form.assignment_type === 'branch' && (
              <div className="col-span-2">
                <label className={labelCls}>Branch</label>
                <select className={inputCls} value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                  <option value="">Select branch...</option>
                  {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}
            {form.assignment_type === 'area' && (
              <div className="col-span-2">
                <label className={labelCls}>Area</label>
                <input className={inputCls} value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} placeholder="e.g. Lagos North" />
              </div>
            )}
            <div className="col-span-2">
              <label className={labelCls}>KPI Linkage (optional)</label>
              <select className={inputCls} value={form.kpi_id} onChange={(e) => setForm({ ...form, kpi_id: e.target.value })}>
                <option value="">No KPI linkage</option>
                {kpis.map((k) => <option key={k.id} value={k.id}>{k.name} ({k.period_label || k.period})</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Instructions (optional)</label>
              <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
            </div>
          </div>
        </CreateModal>
      )}
    </div>
  )
}

// ============================================================
// KPIs TAB
// ============================================================
function KpisTab({ user, actorRole, setNotice }) {
  const [kpis, setKpis] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [users, setUsers] = useState([])
  const [departments, setDepartments] = useState([])
  const [branches, setBranches] = useState([])
  const [form, setForm] = useState(defaultKpiForm())
  const [busy, setBusy] = useState(false)
  const [showAssign, setShowAssign] = useState(null)

  function defaultKpiForm() {
    return {
      name: '', description: '', measurement_type: 'quantity', target_value: '100', unit: '',
      period: 'monthly', period_label: '', start_date: '', end_date: '', is_shared: false,
      assignment_type: 'individual', assigned_to: '', department: '', branch: '', area: '',
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      const [kpiList, userList, deptList, branchList] = await Promise.all([
        workManagementService.listKpis(),
        workManagementService.listUsersForAssignment().catch(() => []),
        workManagementService.listDepartments().catch(() => []),
        workManagementService.listBranches().catch(() => []),
      ])
      setKpis(kpiList)
      setUsers(userList)
      setDepartments(deptList)
      setBranches(branchList)
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load KPIs' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const createKpi = async () => {
    setBusy(true)
    try {
      const kpi = await workManagementService.createKpi({
        name: form.name,
        description: form.description,
        measurement_type: form.measurement_type,
        target_value: Number(form.target_value) || 100,
        unit: form.unit,
        period: form.period,
        period_label: form.period_label,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        is_shared: form.is_shared,
        is_active: true,
        created_by: user.id,
      })

      // Create assignment
      if (form.assignment_type === 'individual' && form.assigned_to) {
        await workManagementService.assignKpi({
          kpi_id: kpi.id,
          assignment_type: 'individual',
          user_id: form.assigned_to,
          target_value: Number(form.target_value) || 100,
          created_by: user.id,
        })
      } else if (form.assignment_type === 'department' && form.department) {
        await workManagementService.assignKpi({
          kpi_id: kpi.id,
          assignment_type: 'department',
          department: form.department,
          target_value: Number(form.target_value) || 100,
          created_by: user.id,
        })
      } else if (form.assignment_type === 'branch' && form.branch) {
        await workManagementService.assignKpi({
          kpi_id: kpi.id,
          assignment_type: 'branch',
          branch: form.branch,
          target_value: Number(form.target_value) || 100,
          created_by: user.id,
        })
      }

      setNotice({ kind: 'ok', text: 'KPI created and assigned successfully.' })
      setShowCreate(false)
      setForm(defaultKpiForm())
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to create KPI' })
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = async (kpi) => {
    try {
      await workManagementService.updateKpi(kpi.id, { is_active: !kpi.is_active })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Update failed' })
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Define KPIs with targets, measurement types, and periods. Assign to individuals, teams, or departments.</p>
        <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
          <Plus className="w-4 h-4" /> Create KPI
        </button>
      </div>

      {loading && <LoadingState label="Loading KPIs..." />}
      {!loading && kpis.length === 0 && <EmptyState title="No KPIs defined" description="Create a KPI to start measuring performance." />}
      {!loading && kpis.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {kpis.map((k) => (
            <div key={k.id} className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h4 className="font-semibold text-slate-900">{k.name}</h4>
                  {k.description && <p className="text-xs text-slate-500 mt-0.5">{k.description}</p>}
                </div>
                <StatusBadge label={k.is_active ? 'Active' : 'Inactive'} color={k.is_active ? 'emerald' : 'slate'} />
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                <div><span className="text-slate-400">Target: </span><span className="font-medium text-slate-700">{k.target_value} {k.unit || ''}</span></div>
                <div><span className="text-slate-400">Type: </span><span className="font-medium text-slate-700">{k.measurement_type}</span></div>
                <div><span className="text-slate-400">Period: </span><span className="font-medium text-slate-700">{k.period_label || k.period}</span></div>
              </div>
              {k.is_shared && <span className="inline-block mt-2 text-xs text-violet-600 bg-violet-50 px-2 py-0.5 rounded-full">Shared KPI</span>}
              <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                <button onClick={() => toggleActive(k)} className="text-xs text-slate-500 hover:text-slate-700">{k.is_active ? 'Deactivate' : 'Activate'}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateModal title="Create KPI" onClose={() => setShowCreate(false)} onSave={createKpi} busy={busy}>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>KPI Name</label>
              <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Customer Acquisition" />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Description</label>
              <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Measurement Type</label>
              <select className={inputCls} value={form.measurement_type} onChange={(e) => setForm({ ...form, measurement_type: e.target.value })}>
                <option value="quantity">Quantity (count)</option>
                <option value="monetary">Monetary (₦)</option>
                <option value="percentage">Percentage (%)</option>
                <option value="rating">Rating (1-5)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Target Value</label>
              <input type="number" className={inputCls} value={form.target_value} onChange={(e) => setForm({ ...form, target_value: e.target.value })} placeholder="e.g. 100" />
            </div>
            <div>
              <label className={labelCls}>Unit</label>
              <input className={inputCls} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="e.g. customers, ₦M, %" />
            </div>
            <div>
              <label className={labelCls}>Period</label>
              <select className={inputCls} value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
                {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Period Label</label>
              <input className={inputCls} value={form.period_label} onChange={(e) => setForm({ ...form, period_label: e.target.value })} placeholder="e.g. Q4 2026, January 2026" />
            </div>
            <div>
              <label className={labelCls}>Start Date</label>
              <input type="date" className={inputCls} value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>End Date</label>
              <input type="date" className={inputCls} value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.is_shared} onChange={(e) => setForm({ ...form, is_shared: e.target.checked })} className="accent-[#009944]" />
                <span className="text-slate-700">Share this KPI (visible to all assigned users)</span>
              </label>
            </div>
            <div className="col-span-2 border-t border-slate-100 pt-3">
              <label className={labelCls}>Assignment</label>
              <select className={inputCls} value={form.assignment_type} onChange={(e) => setForm({ ...form, assignment_type: e.target.value, assigned_to: '', department: '', branch: '' })}>
                {ASSIGNMENT_TYPES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </div>
            {form.assignment_type === 'individual' && (
              <div className="col-span-2">
                <label className={labelCls}>Assign To</label>
                <select className={inputCls} value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })}>
                  <option value="">Select user...</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
                </select>
              </div>
            )}
            {form.assignment_type === 'department' && (
              <div className="col-span-2">
                <label className={labelCls}>Department</label>
                <input list="dept-list-kpi" className={inputCls} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
                <datalist id="dept-list-kpi">{departments.map((d) => <option key={d} value={d} />)}</datalist>
              </div>
            )}
            {form.assignment_type === 'branch' && (
              <div className="col-span-2">
                <label className={labelCls}>Branch</label>
                <select className={inputCls} value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                  <option value="">Select branch...</option>
                  {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}
          </div>
        </CreateModal>
      )}
    </div>
  )
}

// ============================================================
// TARGETS TAB (uses KPIs with target values)
// ============================================================
function TargetsTab({ user, setNotice }) {
  const [kpis, setKpis] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const list = await workManagementService.listKpis({ activeOnly: true })
        setKpis(list)
      } catch (e) {
        setNotice({ kind: 'error', text: e?.message || 'Failed to load targets' })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">Targets are defined as part of KPIs. Each KPI has a target value, unit, and period. Manage targets by editing KPIs in the KPIs tab.</p>
      {loading && <LoadingState label="Loading targets..." />}
      {!loading && kpis.length === 0 && <EmptyState title="No targets defined" description="Create KPIs with target values in the KPIs tab." />}
      {!loading && kpis.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {kpis.map((k) => (
            <div key={k.id} className="bg-white rounded-xl border border-slate-200 p-5">
              <Target className="w-6 h-6 text-violet-500 mb-2" />
              <h4 className="font-semibold text-slate-900">{k.name}</h4>
              <div className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-slate-400">Target:</span><span className="font-medium text-slate-700">{k.target_value} {k.unit || ''}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Period:</span><span className="text-slate-600">{k.period_label || k.period}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Type:</span><span className="text-slate-600">{k.measurement_type}</span></div>
                {k.start_date && <div className="flex justify-between"><span className="text-slate-400">Start:</span><span className="text-slate-600">{new Date(k.start_date).toLocaleDateString()}</span></div>}
                {k.end_date && <div className="flex justify-between"><span className="text-slate-400">End:</span><span className="text-slate-600">{new Date(k.end_date).toLocaleDateString()}</span></div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// WORK PLANS TAB
// ============================================================
function PlansTab({ user, setNotice }) {
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [users, setUsers] = useState([])
  const [departments, setDepartments] = useState([])
  const [form, setForm] = useState(defaultPlanForm())
  const [busy, setBusy] = useState(false)

  function defaultPlanForm() {
    return {
      title: '', description: '', assignment_type: 'individual', user_id: '',
      department: '', start_date: '', end_date: '',
    }
  }

  const load = async () => {
    setLoading(true)
    try {
      const [planList, userList, deptList] = await Promise.all([
        workManagementService.listWorkPlans(),
        workManagementService.listUsersForAssignment().catch(() => []),
        workManagementService.listDepartments().catch(() => []),
      ])
      setPlans(planList)
      setUsers(userList)
      setDepartments(deptList)
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load work plans' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const createPlan = async () => {
    setBusy(true)
    try {
      await workManagementService.createWorkPlan({
        title: form.title,
        description: form.description,
        assignment_type: form.assignment_type,
        user_id: form.assignment_type === 'individual' ? form.user_id : null,
        department: form.assignment_type === 'department' ? form.department : null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        status: 'draft',
        created_by: user.id,
      })
      setNotice({ kind: 'ok', text: 'Work plan created.' })
      setShowCreate(false)
      setForm(defaultPlanForm())
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to create work plan' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Create work plans with timelines for individuals, teams, or departments.</p>
        <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
          <Plus className="w-4 h-4" /> Create Work Plan
        </button>
      </div>

      {loading && <LoadingState label="Loading work plans..." />}
      {!loading && plans.length === 0 && <EmptyState title="No work plans" description="Create a work plan to organize team activities." />}
      {!loading && plans.length > 0 && (
        <div className="space-y-3">
          {plans.map((p) => (
            <div key={p.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-slate-900">{p.title}</h4>
                  {p.description && <p className="text-sm text-slate-500 mt-0.5">{p.description}</p>}
                  <div className="flex items-center gap-3 text-xs text-slate-400 mt-2">
                    <span>{p.assignment_type}</span>
                    {p.start_date && <span>· {new Date(p.start_date).toLocaleDateString()}</span>}
                    {p.end_date && <span>→ {new Date(p.end_date).toLocaleDateString()}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge label={p.status} color={p.status === 'active' ? 'emerald' : p.status === 'completed' ? 'blue' : 'slate'} />
                  {p.progress_pct > 0 && <span className="text-xs text-slate-500">{p.progress_pct}%</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateModal title="Create Work Plan" onClose={() => setShowCreate(false)} onSave={createPlan} busy={busy}>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Title</label>
              <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Description</label>
              <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Assignment Type</label>
              <select className={inputCls} value={form.assignment_type} onChange={(e) => setForm({ ...form, assignment_type: e.target.value, user_id: '', department: '' })}>
                {ASSIGNMENT_TYPES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </div>
            {form.assignment_type === 'individual' && (
              <div className="col-span-2">
                <label className={labelCls}>Assign To</label>
                <select className={inputCls} value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })}>
                  <option value="">Select user...</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
                </select>
              </div>
            )}
            {form.assignment_type === 'department' && (
              <div className="col-span-2">
                <label className={labelCls}>Department</label>
                <input list="dept-list-plans" className={inputCls} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
                <datalist id="dept-list-plans">{departments.map((d) => <option key={d} value={d} />)}</datalist>
              </div>
            )}
            <div>
              <label className={labelCls}>Start Date</label>
              <input type="date" className={inputCls} value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>End Date</label>
              <input type="date" className={inputCls} value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
            </div>
          </div>
        </CreateModal>
      )}
    </div>
  )
}

// ============================================================
// REPORTS TAB — Review submitted task and KPI reports
// ============================================================
function ReportsTab({ user, setNotice }) {
  const [taskReports, setTaskReports] = useState([])
  const [kpiSubs, setKpiSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [subTab, setSubTab] = useState('task')

  const load = async () => {
    setLoading(true)
    try {
      const [tr, ks] = await Promise.all([
        supabase.from('task_progress_reports').select('*, tasks(title, description)').order('created_at', { ascending: false }).limit(50),
        supabase.from('kpi_submissions').select('*, kpi_definitions(name)').order('created_at', { ascending: false }).limit(50),
      ])
      setTaskReports(tr.data || [])
      setKpiSubs(ks.data || [])
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Failed to load reports' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const reviewReport = async (type, id, status, comment) => {
    setBusy(true)
    try {
      if (type === 'task') {
        await workManagementService.reviewTaskReport(id, { status, comment })
      } else {
        await workManagementService.reviewKpiSubmission(id, { status, comment })
      }
      setNotice({ kind: 'ok', text: `Report ${status}.` })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Review failed' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading reports..." />

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setSubTab('task')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${subTab === 'task' ? 'bg-[#009944] text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>Task Reports</button>
        <button onClick={() => setSubTab('kpi')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${subTab === 'kpi' ? 'bg-[#009944] text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>KPI Submissions</button>
      </div>

      {subTab === 'task' && (
        <div className="space-y-3">
          {taskReports.length === 0 && <EmptyState title="No task reports" description="Submitted progress reports will appear here." />}
          {taskReports.map((r) => (
            <div key={r.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-medium text-slate-900">{r.tasks?.title || 'Unknown task'}</h4>
                  {r.narrative && <p className="text-sm text-slate-500 mt-1">{r.narrative}</p>}
                  <div className="flex items-center gap-3 text-xs text-slate-400 mt-2">
                    <span>Progress: {r.progress_pct}%</span>
                    <span>· {new Date(r.created_at).toLocaleDateString()}</span>
                    <StatusBadge label={r.status} color={r.status === 'accepted' ? 'emerald' : r.status === 'rejected' ? 'rose' : 'amber'} />
                  </div>
                </div>
                {r.status === 'pending' && (
                  <div className="flex gap-1.5">
                    <button onClick={() => reviewReport('task', r.id, 'accepted', '')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Accept</button>
                    <button onClick={() => reviewReport('task', r.id, 'correction_requested', 'Needs revision')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-amber-50 text-amber-700 text-xs font-medium hover:bg-amber-100 disabled:opacity-50"><MessageSquare className="w-3.5 h-3.5" /> Request Fix</button>
                    <button onClick={() => reviewReport('task', r.id, 'rejected', 'Rejected')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-rose-50 text-rose-700 text-xs font-medium hover:bg-rose-100 disabled:opacity-50"><Ban className="w-3.5 h-3.5" /> Reject</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {subTab === 'kpi' && (
        <div className="space-y-3">
          {kpiSubs.length === 0 && <EmptyState title="No KPI submissions" description="Submitted KPI progress will appear here." />}
          {kpiSubs.map((s) => (
            <div key={s.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-medium text-slate-900">{s.kpi_definitions?.name || 'Unknown KPI'}</h4>
                  {s.narrative && <p className="text-sm text-slate-500 mt-1">{s.narrative}</p>}
                  <div className="flex items-center gap-3 text-xs text-slate-400 mt-2">
                    <span>Actual: {s.actual_value}</span>
                    <span>Progress: {s.progress_pct}%</span>
                    <span>· {new Date(s.created_at).toLocaleDateString()}</span>
                    <StatusBadge label={s.status} color={s.status === 'accepted' ? 'emerald' : s.status === 'rejected' ? 'rose' : 'amber'} />
                  </div>
                </div>
                {s.status === 'pending' && (
                  <div className="flex gap-1.5">
                    <button onClick={() => reviewReport('kpi', s.id, 'accepted', '')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Accept</button>
                    <button onClick={() => reviewReport('kpi', s.id, 'rejected', 'Rejected')} disabled={busy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-rose-50 text-rose-700 text-xs font-medium hover:bg-rose-100 disabled:opacity-50"><Ban className="w-3.5 h-3.5" /> Reject</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// TEAM PERFORMANCE TAB
// ============================================================
function PerformanceTab({ setNotice }) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const list = await workManagementService.listTasks()
        setTasks(list)
      } catch (e) {
        setNotice({ kind: 'error', text: e?.message || 'Failed to load performance data' })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) return <LoadingState label="Loading team performance..." />

  // Aggregate by assigned user
  const byUser = {}
  tasks.forEach((t) => {
    const uid = t.assigned_to || 'unassigned'
    if (!byUser[uid]) byUser[uid] = { total: 0, completed: 0, inProgress: 0, pending: 0, overdue: 0 }
    byUser[uid].total++
    if (t.status === 'completed') byUser[uid].completed++
    else if (t.status === 'in_progress') byUser[uid].inProgress++
    else if (t.status === 'pending') byUser[uid].pending++
    if (t.due_date && new Date(t.due_date) < new Date() && t.status !== 'completed') byUser[uid].overdue++
  })

  const entries = Object.entries(byUser)

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">Team performance overview based on task completion and KPI achievement.</p>
      {entries.length === 0 ? (
        <EmptyState title="No performance data" description="Assign tasks to team members to see performance metrics." />
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">User ID</th>
                <th className="px-4 py-3 font-medium">Total Tasks</th>
                <th className="px-4 py-3 font-medium">Completed</th>
                <th className="px-4 py-3 font-medium">In Progress</th>
                <th className="px-4 py-3 font-medium">Pending</th>
                <th className="px-4 py-3 font-medium">Overdue</th>
                <th className="px-4 py-3 font-medium">Completion Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map(([uid, s]) => (
                <tr key={uid} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800 text-xs">{uid.slice(0, 8)}...</td>
                  <td className="px-4 py-3 text-slate-600">{s.total}</td>
                  <td className="px-4 py-3 text-emerald-600 font-medium">{s.completed}</td>
                  <td className="px-4 py-3 text-blue-600">{s.inProgress}</td>
                  <td className="px-4 py-3 text-amber-600">{s.pending}</td>
                  <td className="px-4 py-3 text-rose-600">{s.overdue}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                        <div className="h-full bg-[#009944] rounded-full" style={{ width: `${s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0}%` }} />
                      </div>
                      <span className="text-xs tabular-nums">{s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ============================================================
// SHARED MODAL COMPONENT
// ============================================================
function CreateModal({ title, children, onClose, onSave, busy }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6">{children}</div>
        <div className="sticky bottom-0 bg-white border-t border-slate-200 px-6 py-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={onSave} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>
      </div>
    </div>
  )
}
