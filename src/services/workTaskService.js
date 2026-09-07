import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { sendInAppNotification } from './notificationService'

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

    // Create submission record
    const { data: sub, error: subError } = await supabase.from('task_submissions').insert({
      task_id: taskId,
      submitted_by: submission.submittedBy,
      submission_comment: submission.comment,
      completion_percentage: submission.completionPercentage ?? 100,
      completed_date: submission.completedDate || new Date().toISOString().slice(0, 10),
      reference_url: submission.referenceUrl || null,
      additional_note: submission.additionalNote || null,
      evidence_files: evidencePaths,
      status: 'under_review',
    }).select().single()
    if (subError) throw subError

    // Update task status to submitted
    await this.update(taskId, { status: 'submitted', completion_percentage: submission.completionPercentage ?? 100 })

    logAction({ action: 'TASK_SUBMISSION_CREATED', entityType: 'TaskSubmission', entityId: sub.id, details: 'Completion proof submitted' })

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
