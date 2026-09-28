// ============================================================================
// Work Engine service - the new step/KPI engine (migrations 20260928000001-4)
// ============================================================================
// Every percentage in this module is computed SERVER-SIDE by
// work_task_step_rate / work_task_completion_rate / work_user_kpi_score. This
// service deliberately contains no arithmetic on completion percentages: it
// only sends intent and renders what comes back. A client cannot invent a score.
import { supabase } from '../supabaseClient'

/** Unwrap an RPC result, turning a {ok:false,...} payload into a thrown error. */
async function unwrap(promise) {
  const { data, error } = await promise
  if (error) throw new Error(error.message || 'The server rejected that request.')
  if (data && data.ok === false) throw new Error(data.error || 'That request could not be completed.')
  return data
}

/** Colour bands for the SLA badge. Mirrors public.work_task_sla_state(). */
export const SLA_STATE = {
  ok: { label: 'Within SLA', chip: 'bg-emerald-100 text-emerald-800' },
  warning: { label: 'SLA due soon', chip: 'bg-amber-100 text-amber-800' },
  breached: { label: 'SLA breached', chip: 'bg-red-100 text-red-800' },
  none: { label: 'No SLA', chip: 'bg-slate-100 text-slate-600' },
}

export const TASK_STATUS = {
  assigned: { label: 'Assigned', chip: 'bg-slate-100 text-slate-700' },
  accepted: { label: 'Accepted', chip: 'bg-slate-100 text-slate-700' },
  in_progress: { label: 'In Progress', chip: 'bg-blue-100 text-blue-800' },
  submitted: { label: 'Submitted', chip: 'bg-blue-100 text-blue-800' },
  under_review: { label: 'Under Review', chip: 'bg-violet-100 text-violet-800' },
  needs_revision: { label: 'Needs Revision', chip: 'bg-orange-100 text-orange-800' },
  completed: { label: 'Completed', chip: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Rejected', chip: 'bg-red-100 text-red-800' },
  overdue: { label: 'Overdue', chip: 'bg-red-100 text-red-800' },
  cancelled: { label: 'Cancelled', chip: 'bg-slate-100 text-slate-500' },
}

export const STEP_STATUS = {
  pending: { label: 'Not started', chip: 'bg-slate-100 text-slate-600' },
  submitted: { label: 'Awaiting review', chip: 'bg-violet-100 text-violet-800' },
  approved: { label: 'Approved', chip: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Rejected', chip: 'bg-red-100 text-red-800' },
  revision_requested: { label: 'Revision requested', chip: 'bg-orange-100 text-orange-800' },
}

export const workEngineService = {
  /** My Work: my tasks, steps, rates, submission history and KPI score. */
  async myWork() {
    return unwrap(supabase.rpc('get_my_work'))
  },

  /**
   * The Automation Command Centre work view. STRICTLY SCOPED SERVER-SIDE to the
   * caller's own automation_centre tasks - it never returns another user's
   * tasks, KPIs or targets, not even for a super admin.
   */
  async automationTasks() {
    return unwrap(supabase.rpc('get_automation_work_tasks'))
  },

  /**
   * "Add task" on the ACC. Creates (or refreshes) the ONE task this user has
   * per department and links it to the automation item.
   */
  async addAutomationTask({ department, label, description, dueDate, slaHours, status }) {
    return unwrap(supabase.rpc('add_automation_work_task', {
      p_department: department,
      p_label: label,
      p_description: description ?? null,
      p_due_date: dueDate ?? null,
      p_sla_review_hours: slaHours ?? 48,
      p_status: status ?? 'not_started',
    }))
  },

  /** Create a task with its ordered step deliverables (HR / manager side). */
  async createTask({
    title, description, assigneeUserId, employeeId, department, branch,
    priority, startDate, dueDate, slaReviewHours, taskWeight, requiresEvidence, steps,
  }) {
    return unwrap(supabase.rpc('create_work_task_with_steps', {
      p_title: title,
      p_assignee_user_id: assigneeUserId,
      p_employee_id: employeeId ?? null,
      p_description: description ?? null,
      p_department: department ?? null,
      p_branch: branch ?? null,
      p_priority: priority ?? 'medium',
      p_start_date: startDate ?? null,
      p_due_date: dueDate ?? null,
      p_sla_review_hours: slaReviewHours ?? 48,
      p_task_weight: taskWeight ?? 1,
      p_requires_evidence: requiresEvidence ?? false,
      p_steps: steps ?? [],
    }))
  },

  /**
   * File an iterative progress report. `steps` is a list of
   * { task_step_id, reported_value?, reported_boolean? }.
   * A pending report NEVER changes the approved score.
   */
  async submitProgress({ taskId, summary, steps, attachments }) {
    return unwrap(supabase.rpc('submit_task_progress', {
      p_task_id: taskId,
      p_summary: summary ?? null,
      p_steps: steps ?? [],
      p_attachments: attachments ?? [],
    }))
  },

  /**
   * Granular review. `decisions` is a list of
   * { task_step_id, approval_status: 'approved'|'rejected', rejection_reason? }.
   * A rejected step REQUIRES a reason. Cascades step -> task -> user KPI.
   */
  async reviewProgress({ progressReportId, decisions, overallAction, reviewerComment, feedbackFiles }) {
    return unwrap(supabase.rpc('review_task_progress', {
      p_progress_report_id: progressReportId,
      p_decisions: decisions ?? [],
      p_overall_action: overallAction ?? 'partial',
      p_reviewer_comment: reviewerComment ?? null,
      p_feedback_files: feedbackFiles ?? [],
    }))
  },

  /** Weighted KPI summary. Cross-user reads are role-gated server-side. */
  async kpiSummary(userId) {
    return unwrap(supabase.rpc('get_work_kpi_summary', {
      p_user_id: userId ?? null,
    }))
  },
}

export default workEngineService
