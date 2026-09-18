import { supabase } from '../supabaseClient'

export const ONBOARDING_STATES = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  PENDING_REVIEW: 'pending_review',
}

const PENDING_STATUSES = new Set([
  'submitted',
  'under_review',
  'pending_guarantor',
  'guarantor_submitted',
])

const COMPLETED_STATUSES = new Set(['approved', 'completed'])

function normaliseStatus(data) {
  if (!data) return null
  const progress = Math.max(0, Math.min(100, Number(data.progress_pct ?? data.completion_pct ?? 0) || 0))
  const workflowStatus = data.workflow_status || data.onboarding_status || null

  if (data.state && Object.values(ONBOARDING_STATES).includes(data.state)) {
    return {
      ...data,
      progress,
      workflowStatus,
      missingFields: data.missing_fields || [],
    }
  }

  if (COMPLETED_STATUSES.has(workflowStatus) || data.is_complete === true) {
    return { ...data, state: ONBOARDING_STATES.COMPLETED, progress: 100, workflowStatus, missingFields: [] }
  }
  if (PENDING_STATUSES.has(workflowStatus)) {
    return { ...data, state: ONBOARDING_STATES.PENDING_REVIEW, progress, workflowStatus, missingFields: data.missing_fields || [] }
  }
  if (progress > 0 || workflowStatus === 'correction_requested' || workflowStatus === 'rejected') {
    return { ...data, state: ONBOARDING_STATES.IN_PROGRESS, progress, workflowStatus, missingFields: data.missing_fields || [] }
  }
  return { ...data, state: ONBOARDING_STATES.NOT_STARTED, progress, workflowStatus, missingFields: data.missing_fields || [] }
}

async function getFromExistingTables(userId) {
  const { data: employee, error: employeeError } = await supabase
    .from('employees')
    .select('id, user_id, full_name, email, department, position, branch, branch_id, area, employment_status, employee_number, staff_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle()
  if (employeeError) throw employeeError

  if (!employee) {
    return {
      state: ONBOARDING_STATES.NOT_STARTED,
      progress: 0,
      missingFields: [],
      workflowStatus: null,
      employee: null,
      employeeId: null,
    }
  }

  const [completionResult, fileResult, submissionResult] = await Promise.all([
    supabase.rpc('get_employee_completion'),
    supabase.from('employee_digital_files').select('onboarding_completed, profile_completion_pct, updated_at').eq('employee_id', employee.id).maybeSingle(),
    supabase.from('employee_onboarding_submissions')
      .select('id, onboarding_status, status, submitted_at, reviewed_at, created_at')
      .eq('employee_id', employee.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const completion = completionResult.error ? null : completionResult.data
  const digitalFile = fileResult.error ? null : fileResult.data
  const submission = submissionResult.error ? null : submissionResult.data
  const progress = completion?.ok
    ? Number(completion.completion_pct || 0)
    : Number(digitalFile?.profile_completion_pct || 0)
  const isComplete = completion?.ok
    ? completion.is_complete === true
    : digitalFile?.onboarding_completed === true && progress >= 100
  const result = normaliseStatus({
    progress_pct: progress,
    completion_pct: progress,
    is_complete: isComplete,
    missing_fields: completion?.missing_fields || [],
    onboarding_status: submission?.onboarding_status || submission?.status || null,
    employee,
    employee_id: employee.id,
    submission,
  })

  return {
    ...result,
    employee,
    employeeId: employee.id,
    submission,
    completion,
    digitalFile,
  }
}

export const onboardingStatusService = {
  async getMyStatus(userId) {
    if (!userId) return null

    // The RPC uses the existing onboarding_status state machine and is the
    // preferred path once the additive onboarding status migration is live.
    try {
      const { data, error } = await supabase.rpc('get_my_onboarding_status')
      if (!error && data) return normaliseStatus(data)
    } catch {
      // Older deployments fall back to the existing completion RPC/tables.
    }

    try {
      return await getFromExistingTables(userId)
    } catch {
      // Onboarding is supplementary. A failed status read must never block
      // the authenticated application shell.
      return null
    }
  },
}

export default onboardingStatusService
