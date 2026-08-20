import React, { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { taskService } from '../services/taskService'
import { formatCurrency, StatusBadge } from '../lib/utils'
import { AlertCircle, CheckCircle, Clock, Zap, Eye, EyeOff } from 'lucide-react'

/**
 * My Work Dashboard - Central task queue for staff
 * Shows all tasks assigned to the current user
 * Primary productivity tool for operational staff
 */
export default function MyWork() {
  const { user, effectiveRole } = useAuth()
  const [tasks, setTasks] = useState([])
  const [filter, setFilter] = useState('pending')
  const [loading, setLoading] = useState(true)
  const [expandedTask, setExpandedTask] = useState(null)

  useEffect(() => {
    const load = async () => {
      if (!user?.id) return
      setLoading(true)
      try {
        const filters = {
          assignedTo: user.id,
        }
        if (filter !== 'all') {
          filters.status = filter
        }
        const taskList = await taskService.list(filters)
        setTasks(taskList)
      } catch (e) {
        console.error('Failed to load tasks:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [user?.id, filter])

  const tasksByPriority = {
    critical: tasks.filter((t) => t.priority === 'critical'),
    high: tasks.filter((t) => t.priority === 'high'),
    normal: tasks.filter((t) => t.priority === 'normal'),
    low: tasks.filter((t) => t.priority === 'low'),
  }

  const stats = {
    total: tasks.length,
    critical: tasksByPriority.critical.length,
    overdue: tasks.filter((t) => t.due_date && new Date(t.due_date) < new Date()).length,
    completed: tasks.filter((t) => t.status === 'completed').length,
  }

  const TaskCard = ({ task, isExpanded }) => (
    <div
      onClick={() => setExpandedTask(isExpanded ? null : task.id)}
      className={`bg-white rounded-lg border transition cursor-pointer ${
        isExpanded
          ? 'border-blue-400 shadow-lg'
          : task.priority === 'critical'
            ? 'border-red-300 hover:shadow-md'
            : task.priority === 'high'
              ? 'border-orange-300 hover:shadow-md'
              : 'border-slate-200 hover:shadow-md'
      }`}
    >
      <div className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1">
            <h4 className="font-semibold text-slate-900">{task.title}</h4>
            {task.related_customer_id && (
              <p className="text-xs text-slate-500 mt-0.5">Customer Task</p>
            )}
          </div>
          <span
            className={`px-2 py-1 rounded-full text-xs font-semibold ${
              task.priority === 'critical'
                ? 'bg-red-100 text-red-700'
                : task.priority === 'high'
                  ? 'bg-orange-100 text-orange-700'
                  : task.priority === 'normal'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-slate-100 text-slate-700'
            }`}
          >
            {task.priority.toUpperCase()}
          </span>
        </div>

        {task.description && <p className="text-sm text-slate-600 mb-3">{task.description}</p>}

        <div className="flex items-center gap-4 text-xs text-slate-500 flex-wrap">
          <span className="px-2 py-1 bg-slate-100 rounded">{task.task_type}</span>
          {task.due_date && (
            <span
              className={`px-2 py-1 rounded ${
                new Date(task.due_date) < new Date() ? 'bg-red-100 text-red-700' : 'bg-slate-100'
              }`}
            >
              Due: {new Date(task.due_date).toLocaleDateString()}
            </span>
          )}
          <StatusBadge label={task.status} color={task.status === 'completed' ? 'green' : 'blue'} />
        </div>

        {isExpanded && (
          <div className="mt-4 pt-4 border-t border-slate-200 space-y-3">
            {task.description && (
              <div>
                <p className="text-xs text-slate-500 font-semibold mb-1">DESCRIPTION</p>
                <p className="text-sm text-slate-700">{task.description}</p>
              </div>
            )}
            <div>
              <p className="text-xs text-slate-500 font-semibold mb-1">TYPE</p>
              <p className="text-sm text-slate-700">{task.task_type}</p>
            </div>
            <div className="flex gap-2 pt-2">
              <button className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition">
                Start Work
              </button>
              <button className="flex-1 px-3 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition">
                Mark Complete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  if (loading) {
    return (
      <div className="text-center py-24">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin mx-auto" />
        <p className="text-slate-500 mt-3">Loading your tasks...</p>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-slate-900">My Work</h2>
        <p className="text-slate-500 mt-1">Tasks assigned to you in {effectiveRole}</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-3">
            <Clock className="w-5 h-5 text-blue-600" />
            <div>
              <p className="text-xs text-slate-500 font-semibold">TOTAL TASKS</p>
              <p className="text-2xl font-bold text-slate-900">{stats.total}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-600" />
            <div>
              <p className="text-xs text-slate-500 font-semibold">CRITICAL</p>
              <p className="text-2xl font-bold text-slate-900">{stats.critical}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-3">
            <Zap className="w-5 h-5 text-orange-600" />
            <div>
              <p className="text-xs text-slate-500 font-semibold">OVERDUE</p>
              <p className="text-2xl font-bold text-slate-900">{stats.overdue}</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-600" />
            <div>
              <p className="text-xs text-slate-500 font-semibold">COMPLETED</p>
              <p className="text-2xl font-bold text-slate-900">{stats.completed}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filter Buttons */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {['pending', 'in_progress', 'completed', 'all'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition whitespace-nowrap ${
              filter === f
                ? 'bg-blue-600 text-white shadow-md'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1).replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* Tasks by Priority */}
      {tasks.length > 0 ? (
        <div className="space-y-6">
          {Object.entries(tasksByPriority).map(([priority, priorityTasks]) =>
            priorityTasks.length > 0 ? (
              <div key={priority}>
                <div className="flex items-center gap-2 mb-3">
                  {priority === 'critical' && <span className="text-lg">🔴</span>}
                  {priority === 'high' && <span className="text-lg">🟠</span>}
                  {priority === 'normal' && <span className="text-lg">🔵</span>}
                  {priority === 'low' && <span className="text-lg">⚪</span>}
                  <h3 className="text-sm font-semibold text-slate-700 capitalize">{priority} Priority</h3>
                  <span className="text-xs bg-slate-100 px-2 py-1 rounded-full text-slate-600">
                    {priorityTasks.length}
                  </span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {priorityTasks.map((task) => (
                    <TaskCard key={task.id} task={task} isExpanded={expandedTask === task.id} />
                  ))}
                </div>
              </div>
            ) : null
          )}
        </div>
      ) : (
        <div className="text-center py-20 bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg border border-green-200">
          <CheckCircle className="w-16 h-16 text-green-600 mx-auto mb-4 opacity-50" />
          <h3 className="text-lg font-semibold text-green-900 mb-1">All Caught Up!</h3>
          <p className="text-green-700">No tasks assigned to you right now</p>
        </div>
      )}
    </div>
  )
}
