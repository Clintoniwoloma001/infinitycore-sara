import React, { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../hooks/useAuth'
import { workTaskService } from '../services/workTaskService'
import { targetService } from '../services/targetService'
import { kpiService } from '../services/kpiService'
import { LoadingState, EmptyState } from '../components/PageStates'
import { formatDate } from '../lib/utils'
import { AlertCircle, CheckCircle2, Clock, Loader2, Upload, X, FileText, Zap } from 'lucide-react'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const TABS = [
  { id: 'tasks', label: 'My Tasks' },
  { id: 'targets', label: 'My Targets' },
  { id: 'kpis', label: 'My KPIs' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'completed', label: 'Completed' },
]

function PriorityBadge({ priority }) {
  const colors = { critical: 'bg-rose-50 text-rose-700 border-rose-200', high: 'bg-orange-50 text-orange-700 border-orange-200', medium: 'bg-blue-50 text-blue-700 border-blue-200', low: 'bg-slate-50 text-slate-600 border-slate-200' }
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${colors[priority] || colors.medium}`}>{priority}</span>
}

function StatusBadge({ status }) {
  const colors = { completed: 'bg-emerald-50 text-emerald-700 border-emerald-200', rejected: 'bg-rose-50 text-rose-700 border-rose-200', overdue: 'bg-rose-50 text-rose-700 border-rose-200', submitted: 'bg-amber-50 text-amber-700 border-amber-200', under_review: 'bg-amber-50 text-amber-700 border-amber-200', assigned: 'bg-blue-50 text-blue-700 border-blue-200', accepted: 'bg-blue-50 text-blue-700 border-blue-200', in_progress: 'bg-violet-50 text-violet-700 border-violet-200', active: 'bg-blue-50 text-blue-700 border-blue-200', achieved: 'bg-emerald-50 text-emerald-700 border-emerald-200', in_review: 'bg-amber-50 text-amber-700 border-amber-200' }
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${colors[status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>{(status || 'pending').replace(/_/g, ' ')}</span>
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

export default function MyWork() {
  const { user, effectiveRole } = useAuth()
  const [tab, setTab] = useState('tasks')
  const [loading, setLoading] = useState(true)
  const [tasks, setTasks] = useState([])
  const [targets, setTargets] = useState([])
  const [kpis, setKpis] = useState([])
  const [stats, setStats] = useState({})
  const [submitTarget, setSubmitTarget] = useState(null)
  const [submitForm, setSubmitForm] = useState({})
  const [evidenceFiles, setEvidenceFiles] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitSuccess, setSubmitSuccess] = useState('')

  const load = async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const [taskList, targetList, kpiList, statData] = await Promise.all([
        workTaskService.list({ assignedTo: user.id }).catch(() => []),
        targetService.list({ employeeId: null }).catch(() => []),
        kpiService.list({ employeeId: null }).catch(() => []),
        workTaskService.getEmployeeStats(user.id).catch(() => ({})),
      ])
      setTasks(taskList)
      // Filter targets and KPIs for this user's employee record
      const myTargets = targetList.filter((t) => {
        // If the target has no employee_id, or the employee's user_id matches
        return true // RLS handles filtering
      })
      setTargets(myTargets)
      setKpis(kpiList)
      setStats(statData)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [user?.id])

  const overdueTasks = useMemo(() => tasks.filter((t) => t.due_date && new Date(t.due_date) < new Date() && !['completed', 'cancelled', 'submitted'].includes(t.status)), [tasks])
  const submittedTasks = useMemo(() => tasks.filter((t) => ['submitted', 'under_review'].includes(t.status)), [tasks])
  const completedTasks = useMemo(() => tasks.filter((t) => t.status === 'completed'), [tasks])
  const activeTasks = useMemo(() => tasks.filter((t) => ['assigned', 'accepted', 'in_progress', 'rejected'].includes(t.status)), [tasks])

  const openSubmit = (task) => {
    setSubmitTarget(task)
    setSubmitForm({ completionPercentage: 100, comment: '', referenceUrl: '', additionalNote: '', completedDate: new Date().toISOString().slice(0, 10) })
    setEvidenceFiles([])
    setSubmitError('')
    setSubmitSuccess('')
  }

  const doSubmit = async () => {
    if (!submitTarget) return
    setSubmitError(''); setSubmitting(true)
    try {
      await workTaskService.submitCompletion(submitTarget.id, {
        submittedBy: user.id,
        comment: submitForm.comment,
        completionPercentage: parseInt(submitForm.completionPercentage) || 100,
        completedDate: submitForm.completedDate,
        referenceUrl: submitForm.referenceUrl,
        additionalNote: submitForm.additionalNote,
      }, evidenceFiles)
      setSubmitSuccess('Submission sent for review. Your manager will be notified.')
      setSubmitTarget(null)
      load()
    } catch (e) {
      setSubmitError(e?.message || 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingState label="Loading your work..." />

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">My Work</h2>
        <p className="text-sm text-slate-500 mt-1">Your tasks, targets, KPIs, and performance overview</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Clock} label="Active Tasks" value={stats.pending ?? 0} color="#3b82f6" />
        <StatCard icon={Zap} label="In Progress" value={stats.inProgress ?? 0} color="#8b5cf6" />
        <StatCard icon={AlertCircle} label="Overdue" value={overdueTasks.length} color="#ef4444" />
        <StatCard icon={CheckCircle2} label="Completed" value={stats.completed ?? 0} color="#10b981" />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>{t.label}</button>
        ))}
      </div>

      {/* Tasks */}
      {tab === 'tasks' && (
        <div className="space-y-3">
          {overdueTasks.length > 0 && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 p-4 mb-3">
              <p className="text-sm font-medium text-rose-700">{overdueTasks.length} overdue task{overdueTasks.length > 1 ? 's' : ''} — please prioritize these.</p>
            </div>
          )}
          {activeTasks.length === 0 ? <EmptyState title="No active tasks" description="Tasks assigned to you will appear here." /> : activeTasks.map((t) => (
            <div key={t.id} className="bg-white rounded-lg border border-slate-200 p-5">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1">
                  <h4 className="font-semibold text-slate-900">{t.title}</h4>
                  {t.description && <p className="text-sm text-slate-500 mt-1">{t.description}</p>}
                </div>
                <PriorityBadge priority={t.priority} />
              </div>
              {t.instructions && <p className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3 mb-3"><span className="font-medium">Instructions:</span> {t.instructions}</p>}
              <div className="flex items-center gap-4 text-xs text-slate-500 mb-3">
                <span>Due: {formatDate(t.due_date)}</span>
                <StatusBadge status={t.status} />
                {t.completion_percentage > 0 && <span>{t.completion_percentage}% complete</span>}
              </div>
              {t.status === 'rejected' && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 mb-3">
                  <p className="text-xs font-medium text-rose-700">Your last submission was rejected. Please review and resubmit.</p>
                </div>
              )}
              <button onClick={() => openSubmit(t)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
                <Upload className="w-4 h-4" /> Submit Completion
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Targets */}
      {tab === 'targets' && (
        <div className="space-y-3">
          {targets.length === 0 ? <EmptyState title="No targets assigned" description="Your performance targets will appear here." /> : targets.map((t) => {
            const progress = targetService.calcProgress(t)
            return (
              <div key={t.id} className="bg-white rounded-lg border border-slate-200 p-5">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h4 className="font-semibold text-slate-900">{t.title}</h4>
                    <p className="text-xs text-slate-500 mt-0.5">{t.measurement_type || 'Target'} — {t.frequency}</p>
                  </div>
                  <StatusBadge status={t.status} />
                </div>
                {t.description && <p className="text-sm text-slate-600 mb-3">{t.description}</p>}
                <div className="flex items-center gap-4 mb-3">
                  <div className="text-sm text-slate-600">Current: <span className="font-semibold">{t.current_value || 0}</span> / {t.target_value} {t.unit || ''}</div>
                  <div className="flex-1"><ProgressBar value={t.current_value || 0} max={t.target_value || 1} /></div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* KPIs */}
      {tab === 'kpis' && (
        <div className="space-y-3">
          {kpis.length === 0 ? <EmptyState title="No KPIs assigned" description="Your performance KPIs will appear here." /> : (
            <>
              {kpis.length > 0 && (
                <div className="bg-white rounded-lg border border-slate-200 p-5 mb-3">
                  <h4 className="font-semibold text-slate-900 mb-2">Overall KPI Score</h4>
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
                        <p className="text-xs text-slate-500 mt-0.5">{k.category || 'General'} — {k.quarter || k.review_period} {k.appraisal_year || ''}</p>
                      </div>
                      <StatusBadge status={k.status} />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Target</div><div className="text-lg font-bold text-slate-800">{k.target_value} {k.unit || ''}</div></div>
                      <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Actual</div><div className="text-lg font-bold text-slate-800">{k.actual_value || 0} {k.unit || ''}</div></div>
                      <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-400">Achievement</div><div className="text-lg font-bold text-[#009944]">{achievement}%</div></div>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}

      {/* Submitted */}
      {tab === 'submitted' && (
        <div className="space-y-3">
          {submittedTasks.length === 0 ? <EmptyState title="No submissions pending" description="Tasks you've submitted for review will appear here." /> : submittedTasks.map((t) => (
            <div key={t.id} className="bg-white rounded-lg border border-amber-200 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-slate-900">{t.title}</h4>
                  <p className="text-xs text-slate-500 mt-0.5">Awaiting manager review</p>
                </div>
                <StatusBadge status={t.status} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Completed */}
      {tab === 'completed' && (
        <div className="space-y-3">
          {completedTasks.length === 0 ? <EmptyState title="No completed tasks" description="Your completed tasks will appear here." /> : completedTasks.map((t) => (
            <div key={t.id} className="bg-white rounded-lg border border-emerald-200 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-slate-900">{t.title}</h4>
                  <p className="text-xs text-slate-500 mt-0.5">Completed {formatDate(t.completed_at)}</p>
                </div>
                <StatusBadge status="completed" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Submit Completion Modal */}
      {submitTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Submit Completion</h3>
                <p className="text-sm text-slate-500 mt-0.5">{submitTarget.title}</p>
              </div>
              <button onClick={() => setSubmitTarget(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            {submitError && <p className="text-sm text-rose-600 mb-3">{submitError}</p>}
            {submitSuccess && <p className="text-sm text-emerald-600 mb-3">{submitSuccess}</p>}
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Completion Percentage</label>
                <input type="number" min="0" max="100" className={inputCls} value={submitForm.completionPercentage || 100} onChange={(e) => setSubmitForm((f) => ({ ...f, completionPercentage: e.target.value }))} />
              </div>
              <div>
                <label className={labelCls}>Completion Comment</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={submitForm.comment || ''} onChange={(e) => setSubmitForm((f) => ({ ...f, comment: e.target.value }))} placeholder="Describe what was done..." />
              </div>
              <div>
                <label className={labelCls}>Evidence / Proof Files</label>
                <div className="border-2 border-dashed border-slate-300 rounded-lg p-4 text-center">
                  <input type="file" multiple onChange={(e) => setEvidenceFiles(Array.from(e.target.files))} className="hidden" id="evidence-upload" />
                  <label htmlFor="evidence-upload" className="cursor-pointer">
                    <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                    <p className="text-sm text-slate-500">Click to upload evidence files</p>
                    <p className="text-xs text-slate-400 mt-1">PDF, images, Excel, Word, screenshots</p>
                  </label>
                  {evidenceFiles.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {evidenceFiles.map((f, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-slate-600 bg-slate-50 rounded px-2 py-1">
                          <FileText className="w-3 h-3" /> {f.name} ({(f.size / 1024).toFixed(0)} KB)
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className={labelCls}>Date Completed</label><input type="date" className={inputCls} value={submitForm.completedDate || ''} onChange={(e) => setSubmitForm((f) => ({ ...f, completedDate: e.target.value }))} /></div>
                <div><label className={labelCls}>Reference URL (optional)</label><input className={inputCls} value={submitForm.referenceUrl || ''} onChange={(e) => setSubmitForm((f) => ({ ...f, referenceUrl: e.target.value }))} placeholder="https://..." /></div>
              </div>
              <div><label className={labelCls}>Additional Note (optional)</label><input className={inputCls} value={submitForm.additionalNote || ''} onChange={(e) => setSubmitForm((f) => ({ ...f, additionalNote: e.target.value }))} /></div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button onClick={() => setSubmitTarget(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={doSubmit} disabled={submitting} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Submit for Review
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
