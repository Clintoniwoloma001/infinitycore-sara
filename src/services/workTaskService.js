import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { sendInAppNotification } from './notificationService'
import { averageItemCompletion, progressById } from '../domains/tasks/taskProgress'

export const workTaskService = {
  async list(filters = {}) {
    let query = supabase.from('work_tasks').select('*')
    if (filters.assignedTo) query = query.eq('assigned_to_user_id', filters.assignedTo)
    if (filters.assignedBy) query = query.eq('assigned_by', filters.assignedBy)
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.employeeId) query = query.eq('employee_id', filters.employeeId)
    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async getById(id) {
    const { data, error } = await supabase.from('work_tasks').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },

  async create(payload) {
    const { data, error } = await supabase.from('work_tasks').insert(payload).select().single()
    if (error) throw error
    logAction({ action: 'WORK_TASK_ASSIGNED', entityType: 'WorkTask', entityId: data.id, details: `Task "${payload.title}" assigned to ${payload.employee_name || 'employee'}` })
    // Notify the assigned employee
    if (payload.assigned_to_user_id) {
      sendInAppNotification({ userId: payload.assigned_to_user_id, title: 'New Task Assigned', message: `You have been assigned: ${payload.title}`, link: '#/my-work', type: 'task' }).catch(() => {})
    }
    return data
  },

  async update(id, updates) {
    const { data, error } = await supabase.from('work_tasks').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id).select().single()
    if (error) throw error
    logAction({ action: 'WORK_TASK_UPDATED', entityType: 'WorkTask', entityId: id, details: `Task updated — status: ${updates.status || 'unchanged'}` })
    return data
  },

  async submitCompletion(taskId, submission, evidenceFiles = []) {
    // Upload evidence files
    const evidencePaths = []
    for (const file of evidenceFiles) {
      const filePath = `task-evidence/${taskId}/${Date.now()}-${file.name.replace(/[^\w.\- ]+/g, '_')}`
      const { error: uploadError } = await supabase.storage.from('task-evidence').upload(filePath, file)
      if (!uploadError) evidencePaths.push({ path: filePath, name: file.name, type: file.type })
    }

    // Auto-calculate weighted completion from the itemized instructions
    // (untouched items count as 0 off the TOTAL sub-item count). Falls back to
    // the manually-entered single percentage only when the task has no
    // sub-items at all (legacy tasks). The stored instruction_progress + items
    // are the source of truth — never the single percentage when items exist.
    const items = Array.isArray(submission.instructionItems) ? submission.instructionItems : []
    const progress = Array.isArray(submission.instructionProgress) ? submission.instructionProgress : []
    const progressMap = progressById(progress)
    const autoCompletion = averageItemCompletion(items, progressMap)
    const effectivePercentage =
      autoCompletion !== null
        ? autoCompletion
        : Math.max(0, Math.min(100, Number(submission.completionPercentage ?? 100)))

    // Create submission record (a full snapshot; history is never overwritten)
    const { data: sub, error: subError } = await supabase.from('task_submissions').insert({
      task_id: taskId,
      submitted_by: submission.submittedBy,
      submission_comment: submission.comment,
      completion_percentage: effectivePercentage,
      completed_date: submission.completedDate || new Date().toISOString().slice(0, 10),
      reference_url: submission.referenceUrl || null,
      additional_note: submission.additionalNote || null,
      evidence_files: evidencePaths,
      status: 'under_review',
      instruction_items: items,
      instruction_progress: progress,
      // Itemized comments: distinct entries (Enter-to-add / Add more).
      comment_items: Array.isArray(submission.commentItems) ? submission.commentItems : [],
    }).select().single()
    if (subError) throw subError

    // Persist itemized progress + auto completion back onto the task. The task
    // status is deliberately NOT moved to 'submitted' so the task stays visible
    // in "My Tasks" and can be resubmitted at higher completion. The submission
    // row above is the durable review record.
    await this.update(taskId, {
      instruction_items: items,
      instruction_progress: progress,
      completion_percentage: effectivePercentage,
    })

    logAction({ action: 'TASK_SUBMISSION_CREATED', entityType: 'TaskSubmission', entityId: sub.id, details: `Completion proof submitted at ${effectivePercentage}% (${items.length} itemized sub-step${items.length === 1 ? '' : 's'})` })

    // Notify the assigner
    const task = await this.getById(taskId)
    if (task?.assigned_by) {
      sendInAppNotification({ userId: task.assigned_by, title: 'Task Submission for Review', message: `${task.employee_name || 'Employee'} submitted completion proof for: ${task.title}`, link: '#/work-management', type: 'task' }).catch(() => {})
    }
    return sub
  },

  async listSubmissions(taskId) {
    const { data, error } = await supabase.from('task_submissions').select('*').eq('task_id', taskId).order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // The employee's own submission history (Submitted tab) — drive it from the
  // submission records, not from task.status (which is no longer flipped).
  async listMySubmissions(userId) {
    const { data, error } = await supabase
      .from('task_submissions')
      .select('*, work_tasks(title, instructions, instruction_items)')
      .eq('submitted_by', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listPendingSubmissions(managerId) {
    const { data, error } = await supabase
      .from('task_submissions')
      .select('*, work_tasks!inner(assigned_by, title, employee_name)')
      .eq('status', 'under_review')
      .eq('work_tasks.assigned_by', managerId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async approveSubmission(submissionId, reviewComment, reviewerId) {
    const { data: sub, error } = await supabase.from('task_submissions')
      .update({ status: 'approved', review_comment: reviewComment, reviewed_by: reviewerId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', submissionId).select().single()
    if (error) throw error

    // Mark task as completed
    await this.update(sub.task_id, { status: 'completed', completed_at: new Date().toISOString(), completion_percentage: 100 })

    logAction({ action: 'TASK_APPROVED', entityType: 'TaskSubmission', entityId: submissionId, details: 'Task completion approved' })

    // Notify the employee
    const task = await this.getById(sub.task_id)
    if (task?.assigned_to_user_id) {
      sendInAppNotification({ userId: task.assigned_to_user_id, title: 'Task Approved', message: `Your completion for "${task.title}" has been approved.`, link: '#/my-work', type: 'task' }).catch(() => {})
    }
    return sub
  },

  async rejectSubmission(submissionId, rejectionReason, reviewerId) {
    const { data: sub, error } = await supabase.from('task_submissions')
      .update({ status: 'rejected', review_comment: rejectionReason, reviewed_by: reviewerId, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', submissionId).select().single()
    if (error) throw error

    // Mark task as rejected so employee can resubmit
    await this.update(sub.task_id, { status: 'rejected' })

    logAction({ action: 'TASK_REJECTED', entityType: 'TaskSubmission', entityId: submissionId, details: `Rejection reason: ${rejectionReason}` })

    // Notify the employee
    const task = await this.getById(sub.task_id)
    if (task?.assigned_to_user_id) {
      sendInAppNotification({ userId: task.assigned_to_user_id, title: 'Task Submission Rejected', message: `Your submission for "${task.title}" was rejected. Reason: ${rejectionReason}`, link: '#/my-work', type: 'task' }).catch(() => {})
    }
    return sub
  },

  async getSignedUrl(filePath, expiresIn = 3600) {
    const { data, error } = await supabase.storage.from('task-evidence').createSignedUrl(filePath, expiresIn)
    if (error) throw error
    return data.signedUrl
  },

  // Aggregate KPI/task completion rate for an employee over a date range —
  // single source of truth backed by the server-side `calculate_task_completion`.
  async getEmployeeTaskCompletionRate(employeeId, from, to) {
    const { data, error } = await supabase.rpc('get_employee_task_completion_rate', {
      p_employee_id: employeeId,
      p_from: from,
      p_to: to,
    })
    if (error) throw error
    return data || { task_count: 0, completion_rate: 0 }
  },

  async getStats(userId) {
    const [assigned, pending, inProgress, awaiting, completed, overdue, rejected] = await Promise.all([
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_by', userId),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_by', userId).in('status', ['assigned', 'accepted']),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_by', userId).eq('status', 'in_progress'),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_by', userId).eq('status', 'submitted'),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_by', userId).eq('status', 'completed'),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_by', userId).eq('status', 'overdue'),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_by', userId).eq('status', 'rejected'),
    ])
    return {
      assigned: assigned.count || 0,
      pending: pending.count || 0,
      inProgress: inProgress.count || 0,
      awaiting: awaiting.count || 0,
      completed: completed.count || 0,
      overdue: overdue.count || 0,
      rejected: rejected.count || 0,
    }
  },

  async getEmployeeStats(userId) {
    const [total, pending, inProgress, submitted, completed, overdue] = await Promise.all([
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_to_user_id', userId),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_to_user_id', userId).in('status', ['assigned', 'accepted']),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_to_user_id', userId).eq('status', 'in_progress'),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_to_user_id', userId).eq('status', 'submitted'),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_to_user_id', userId).eq('status', 'completed'),
      supabase.from('work_tasks').select('id', { count: 'exact', head: true }).eq('assigned_to_user_id', userId).in('status', ['overdue', 'rejected']),
    ])
    return {
      total: total.count || 0,
      pending: pending.count || 0,
      inProgress: inProgress.count || 0,
      submitted: submitted.count || 0,
      completed: completed.count || 0,
      overdue: overdue.count || 0,
    }
  },
}

export default workTaskService
