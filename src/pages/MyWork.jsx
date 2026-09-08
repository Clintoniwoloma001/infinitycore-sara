import React, { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { taskService } from '../services/taskService'
import { workManagementService } from '../services/workManagementService'
import { attendanceService } from '../services/attendanceService'
import { StatusBadge } from '../lib/utils'
import { AlertCircle, CheckCircle, Clock, Zap, Target, TrendingUp, FileText, Loader2, Send, X, ChevronDown, ChevronUp } from 'lucide-react'
import { LoadingState, EmptyState } from '../components/PageStates'

const PRIORITY_COLORS = {
  critical: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  high: { bg: 'bg-orange-100', text: 'text-orange-700', dot: 'bg-orange-500' },
  normal: { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
  low: { bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-400' },
}

export default function MyWork() {
  const { user, name, effectiveRole } = useAuth()
  const [tasks, setTasks] = useState([])
  const [kpis, setKpis] = useState([])
  const [kpiSubs, setKpiSubs] = useState([])
  const [attendanceSummary, setAttendanceSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [expandedTask, setExpandedTask] = useState(null)
  const [reportModal, setReportModal] = useState(null)
  const [kpiModal, setKpiModal] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ kind: '', text: '' })

  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  })()

  useEffect(() => {
    const load = async () => {
      if (!user?.id) return
      setLoading(true)
      try {
        const [taskList, myKpis, myKpiSubs] = await Promise.all([
          taskService.list({ assignedTo: user.id }),
          workManagementService.getMyKpis(user.id).catch(() => []),
          workManagementService.getMyKpiSubmissions(user.id).catch(() => []),
        ])
        setTasks(taskList)
        setKpis(myKpis)
        setKpiSubs(myKpiSubs)

        // Attendance summary
        try {
          const emp = await attendanceService.getMyEmployee()
          if (emp) {
            const hist = await attendanceService.getHistory(emp.id, 30)
            const present = hist.filter((r) => r.status === 'present' || (r.clock_in && r.clock_out)).length
            const late = hist.filter((r) => r.status === 'late').length
            setAttendanceSummary({ present, late, total: hist.length })
          }
        } catch { /* no employee linked */ }
      } catch (e) {
        console.error('Failed to load work data:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [user?.id])

  const today = new Date().toISOString().slice(0, 10)
  const stats = {
    total: tasks.length,
    dueToday: tasks.filter((t) => t.due_date && t.due_date === today).length,
    overdue: tasks.filter((t) => t.due_date && new Date(t.due_date) < new Date(today) && t.status !== 'completed').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    kpiProgress: kpis.length > 0 ? Math.round(kpis.reduce((sum, k) => {
      const latest = kpiSubs.find((s) => s.kpi_id === k.kpi_definitions?.id || s.kpi_id === k.kpi_id)
      return sum + (latest?.progress_pct || 0)
    }, 0) / kpis.length) : 0,
    completionRate: tasks.length > 0 ? Math.round((stats_completed() / tasks.length) * 100) : 0,
    reportsDue: tasks.filter((t) => t.status === 'in_progress' || t.status === 'submitted').length,
  }

  function stats_completed() {
    return tasks.filter((t) => t.status === 'completed').length
  }

  const filteredTasks = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter)

  const updateTaskStatus = async (taskId, newStatus, completionPct) => {
    setBusy(true)
    try {
      const updates = { status: newStatus }
      if (completionPct !== undefined) updates.completion_pct = completionPct
      if (newStatus === 'completed') {
        updates.completed_at = new Date().toISOString()
        updates.completion_pct = 100
      }
      await taskService.update(taskId, updates)
      setMessage({ kind: 'ok', text: 'Task updated successfully.' })
      // Reload
      const taskList = await taskService.list({ assignedTo: user.id })
      setTasks(taskList)
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Update failed' })
    } finally {
      setBusy(false)
    }
  }

  const submitReport = async (taskId, { progressPct, narrative }) => {
    setBusy(true)
    try {
      await workManagementService.submitTaskReport({
        task_id: taskId,
        submitted_by: user.id,
        progress_pct: progressPct,
        narrative,
      })
      // Also update task completion_pct
      if (progressPct >= 100) {
        await taskService.update(taskId, { status: 'completed', completed_at: new Date().toISOString(), completion_pct: 100 })
      } else {
        await taskService.update(taskId, { status: 'in_progress', completion_pct: progressPct })
      }
      setMessage({ kind: 'ok', text: 'Progress report submitted.' })
      setReportModal(null)
      const taskList = await taskService.list({ assignedTo: user.id })
      setTasks(taskList)
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Report submission failed' })
    } finally {
      setBusy(false)
    }
  }

  const submitKpiProgress = async (kpiId, assignmentId, { actualValue, narrative }) => {
    setBusy(true)
    try {
      const kpi = kpis.find((k) => k.kpi_definitions?.id === kpiId || k.kpi_id === kpiId)
      const def = kpi?.kpi_definitions || kpi
      const target = def?.target_value || 100
      const pct = target > 0 ? Math.round((actualValue / target) * 100 * 100) / 100 : 0

      await workManagementService.submitKpiProgress({
        kpi_id: kpiId,
        assignment_id: assignmentId,
        user_id: user.id,
        actual_value: actualValue,
        progress_pct: pct,
        narrative,
        period_label: def?.period_label || '',
      })
      setMessage({ kind: 'ok', text: 'KPI progress submitted for review.' })
      setKpiModal(null)
      const subs = await workManagementService.getMyKpiSubmissions(user.id)
      setKpiSubs(subs)
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'KPI submission failed' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading your work..." />

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">{greeting}, {name?.split(' ')[0] || 'there'}</h2>
        <p className="text-sm text-slate-500 mt-1">Your work today</p>
      </div>

      {message.text && (
        <div className={`mb-5 rounded-lg border p-4 text-sm ${message.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}>
          {message.text}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <SummaryCard icon={CheckCircle} label="Tasks" value={stats.total} color="text-blue-600" />
        <SummaryCard icon={Clock} label="Due Today" value={stats.dueToday} color="text-amber-600" />
        <SummaryCard icon={Zap} label="Overdue" value={stats.overdue} color="text-rose-600" />
        <SummaryCard icon={Target} label="KPI Progress" value={`${stats.kpiProgress}%`} color="text-violet-600" />
        <SummaryCard icon={TrendingUp} label="Completion Rate" value={`${stats.completionRate}%`} color="text-emerald-600" />
        <SummaryCard icon={FileText} label="Reports Due" value={stats.reportsDue} color="text-slate-600" />
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 mb-5 overflow-x-auto pb-1">
        {[
          { key: 'all', label: 'All Tasks' },
          { key: 'pending', label: 'Pending' },
          { key: 'in_progress', label: 'In Progress' },
          { key: 'completed', label: 'Completed' },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition ${filter === f.key ? 'bg-[#009944] text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Today Section */}
      <h3 className="text-lg font-semibold text-slate-900 mb-3">My Tasks</h3>
      {filteredTasks.length === 0 ? (
        <div className="text-center py-16 bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl border border-emerald-200">
          <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto mb-3 opacity-50" />
          <h3 className="text-lg font-semibold text-emerald-900 mb-1">All caught up!</h3>
          <p className="text-emerald-700 text-sm">No tasks match this filter.</p>
        </div>
      ) : (
        <div className="space-y-3 mb-8">
          {filteredTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              isExpanded={expandedTask === task.id}
              onToggle={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
              onStatusChange={updateTaskStatus}
              onReport={() => setReportModal(task)}
              busy={busy}
            />
          ))}
        </div>
      )}

      {/* KPI Section */}
      {kpis.length > 0 && (
        <div className="mb-8">
          <h3 className="text-lg font-semibold text-slate-900 mb-3">My KPIs</h3>
          <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-left">
                <tr>
                  <th className="px-4 py-3 font-medium">KPI</th>
                  <th className="px-4 py-3 font-medium">Target</th>
                  <th className="px-4 py-3 font-medium">Actual</th>
                  <th className="px-4 py-3 font-medium">Progress</th>
                  <th className="px-4 py-3 font-medium">Period</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {kpis.map((ka) => {
                  const def = ka.kpi_definitions || ka
                  const latest = kpiSubs.find((s) => s.kpi_id === def.id)
                  const actual = latest?.actual_value || 0
                  const pct = latest?.progress_pct || 0
                  return (
                    <tr key={ka.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-800">{def.name}</td>
                      <td className="px-4 py-3 text-slate-600">{def.target_value} {def.unit || ''}</td>
                      <td className="px-4 py-3 text-slate-600">{actual} {def.unit || ''}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                            <div className="h-full bg-[#009944] rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                          <span className="text-xs text-slate-600 tabular-nums">{pct}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{def.period_label || def.period || '—'}</td>
                      <td className="px-4 py-3">
                        {latest ? <StatusBadge label={latest.status} color={latest.status === 'accepted' ? 'emerald' : latest.status === 'rejected' ? 'rose' : 'amber'} /> : <StatusBadge label="No submission" color="slate" />}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setKpiModal({ kpi: def, assignmentId: ka.id })}
                          className="text-xs text-[#009944] hover:underline font-medium"
                        >
                          Submit Progress
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Performance Summary */}
      <div className="mb-8">
        <h3 className="text-lg font-semibold text-slate-900 mb-3">Performance Summary</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <PerfCard label="Tasks Completed" value={stats.completed} total={stats.total} color="emerald" />
          <PerfCard label="Completion Rate" value={`${stats.completionRate}%`} color="blue" />
          <PerfCard label="KPI Achievement" value={`${stats.kpiProgress}%`} color="violet" />
          <PerfCard label="Attendance (30d)" value={attendanceSummary ? `${attendanceSummary.present}/${attendanceSummary.total}` : '—'} color="amber" />
        </div>
      </div>

      {/* Report Modal */}
      {reportModal && (
        <ReportModal
          task={reportModal}
          onSubmit={(data) => submitReport(reportModal.id, data)}
          onClose={() => setReportModal(null)}
          busy={busy}
        />
      )}

      {/* KPI Submission Modal */}
      {kpiModal && (
        <KpiSubmitModal
          kpi={kpiModal.kpi}
          onSubmit={(data) => submitKpiProgress(kpiModal.kpi.id, kpiModal.assignmentId, data)}
          onClose={() => setKpiModal(null)}
          busy={busy}
        />
      )}
    </div>
  )
}

// ============================================================
// COMPONENTS
// ============================================================

function SummaryCard({ icon: Icon, label, value, color }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center gap-3">
        <Icon className={`w-5 h-5 ${color}`} />
        <div>
          <p className="text-xs text-slate-500 font-medium">{label}</p>
          <p className="text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
        </div>
      </div>
    </div>
  )
}

function PerfCard({ label, value, total, color }) {
  const colors = {
    emerald: 'text-emerald-600',
    blue: 'text-blue-600',
    violet: 'text-violet-600',
    amber: 'text-amber-600',
  }
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-xs text-slate-500 font-medium">{label}</p>
      <p className={`text-xl font-bold mt-1 tabular-nums ${colors[color] || 'text-slate-900'}`}>
        {value}{total !== undefined && <span className="text-sm text-slate-400"> / {total}</span>}
      </p>
    </div>
  )
}

function TaskCard({ task, isExpanded, onToggle, onStatusChange, onReport, busy }) {
  const pc = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.normal
  return (
    <div className={`bg-white rounded-xl border transition-all ${isExpanded ? 'border-[#009944] shadow-md' : 'border-slate-200 hover:shadow-sm'}`}>
      <div className="p-4 cursor-pointer" onClick={onToggle}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${pc.dot}`} />
              <h4 className="font-semibold text-slate-900 truncate">{task.title}</h4>
            </div>
            {task.description && <p className="text-sm text-slate-500 mt-1 line-clamp-2">{task.description}</p>}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${pc.bg} ${pc.text}`}>{task.priority}</span>
            {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-500 mt-3 flex-wrap">
          {task.due_date && (
            <span className={`px-2 py-0.5 rounded ${new Date(task.due_date) < new Date() && task.status !== 'completed' ? 'bg-rose-50 text-rose-600' : 'bg-slate-100'}`}>
              Due: {new Date(task.due_date).toLocaleDateString()}
            </span>
          )}
          {task.department && <span className="text-slate-400">· {task.department}</span>}
          <StatusBadge label={task.status?.replace(/_/g, ' ') || 'pending'} color={task.status === 'completed' ? 'emerald' : task.status === 'in_progress' ? 'blue' : 'amber'} />
          {task.completion_pct > 0 && task.completion_pct < 100 && (
            <div className="flex items-center gap-1">
              <div className="w-16 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                <div className="h-full bg-[#009944] rounded-full" style={{ width: `${task.completion_pct}%` }} />
              </div>
              <span className="tabular-nums">{task.completion_pct}%</span>
            </div>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="px-4 pb-4 pt-0 space-y-3 border-t border-slate-100">
          {task.description && (
            <div>
              <p className="text-xs text-slate-400 font-semibold mb-1">DESCRIPTION</p>
              <p className="text-sm text-slate-700">{task.description}</p>
            </div>
          )}
          {task.instructions && (
            <div>
              <p className="text-xs text-slate-400 font-semibold mb-1">INSTRUCTIONS</p>
              <p className="text-sm text-slate-700">{task.instructions}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div><span className="text-slate-400">Assigned: </span><span className="text-slate-600">{task.created_at ? new Date(task.created_at).toLocaleDateString() : '—'}</span></div>
            <div><span className="text-slate-400">Due: </span><span className="text-slate-600">{task.due_date ? new Date(task.due_date).toLocaleDateString() : '—'}</span></div>
            <div><span className="text-slate-400">Type: </span><span className="text-slate-600">{task.task_type}</span></div>
            <div><span className="text-slate-400">Assignment: </span><span className="text-slate-600">{task.assignment_type || 'individual'}</span></div>
          </div>
          <div className="flex gap-2 pt-2">
            {task.status === 'pending' && (
              <button onClick={() => onStatusChange(task.id, 'in_progress', 0)} disabled={busy} className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition disabled:opacity-50">
                Start
              </button>
            )}
            <button onClick={onReport} disabled={busy} className="flex-1 px-3 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200 transition disabled:opacity-50">
              Update / Submit
            </button>
            {task.status !== 'completed' && (
              <button onClick={() => onStatusChange(task.id, 'completed')} disabled={busy} className="flex-1 px-3 py-2 bg-[#009944] text-white text-sm rounded-lg hover:bg-[#007a36] transition disabled:opacity-50">
                Mark Complete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ReportModal({ task, onSubmit, onClose, busy }) {
  const [progressPct, setProgressPct] = useState(task.completion_pct || 0)
  const [narrative, setNarrative] = useState('')

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-slate-900">Submit Progress Report</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-4">
          <div>
            <p className="text-sm text-slate-500 mb-1">Task: <span className="font-medium text-slate-700">{task.title}</span></p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Progress: {progressPct}%</label>
            <input type="range" min="0" max="100" value={progressPct} onChange={(e) => setProgressPct(Number(e.target.value))} className="w-full accent-[#009944]" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Narrative</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={narrative} onChange={(e) => setNarrative(e.target.value)} placeholder="Describe what you've done..." />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={() => onSubmit({ progressPct, narrative })} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Submit
          </button>
        </div>
      </div>
    </div>
  )
}

function KpiSubmitModal({ kpi, onSubmit, onClose, busy }) {
  const [actualValue, setActualValue] = useState('')
  const [narrative, setNarrative] = useState('')

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-slate-900">Submit KPI Progress</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-4">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-sm font-medium text-slate-700">{kpi.name}</p>
            <p className="text-xs text-slate-500 mt-0.5">Target: {kpi.target_value} {kpi.unit || ''} · {kpi.period_label || kpi.period || ''}</p>
            {kpi.description && <p className="text-xs text-slate-400 mt-1">{kpi.description}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Actual Value ({kpi.unit || 'units'})</label>
            <input type="number" className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" value={actualValue} onChange={(e) => setActualValue(e.target.value)} placeholder="e.g. 75" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Narrative</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={narrative} onChange={(e) => setNarrative(e.target.value)} placeholder="Describe progress..." />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={() => onSubmit({ actualValue: Number(actualValue) || 0, narrative })} disabled={busy || !actualValue} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Submit
          </button>
        </div>
      </div>
    </div>
  )
}
