import { supabase } from '../supabaseClient'

/**
 * HR Service - Manages recruitment, candidates, assessments, interviews
 */

export const hrService = {
  /**
   * ===== JOBS =====
   */

  async createJob(jobData) {
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('hr_jobs')
      .insert([{ ...jobData, created_by: user?.id }])
      .select()

    if (error) throw error
    return data[0]
  },

  async listJobs(filters = {}) {
    let query = supabase.from('hr_jobs').select('*')

    if (filters.status) {
      query = query.eq('status', filters.status)
    }
    if (filters.department) {
      query = query.eq('department', filters.department)
    }

    query = query.order('created_at', { ascending: false })

    const { data, error } = await query
    if (error) throw error
    return data
  },

  async updateJob(jobId, updates) {
    const { data, error } = await supabase
      .from('hr_jobs')
      .update(updates)
      .eq('id', jobId)
      .select()

    if (error) throw error
    return data[0]
  },

  /**
   * ===== CANDIDATES =====
   */

  async createCandidate(candidateData) {
    const { data, error } = await supabase
      .from('hr_candidates')
      .insert([candidateData])
      .select()

    if (error) throw error
    return data[0]
  },

  async listCandidates(filters = {}) {
    let query = supabase.from('hr_candidates').select('*')

    if (filters.jobId) {
      query = query.eq('job_id', filters.jobId)
    }
    if (filters.status) {
      query = query.eq('application_status', filters.status)
    }

    query = query.order('created_at', { ascending: false })

    const { data, error } = await query
    if (error) throw error
    return data
  },

  async getCandidateById(id) {
    const { data, error } = await supabase
      .from('hr_candidates')
      .select('*')
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  },

  async updateCandidate(candidateId, updates) {
    const { data, error } = await supabase
      .from('hr_candidates')
      .update(updates)
      .eq('id', candidateId)
      .select()

    if (error) throw error
    return data[0]
  },

  async screenCandidate(candidateId, score, notes) {
    const { data: { user } } = await supabase.auth.getUser()
    return this.updateCandidate(candidateId, {
      application_status: 'screening',
      screening_score: score,
      screening_notes: notes,
      screened_by: user?.id,
      screened_at: new Date().toISOString(),
    })
  },

  /**
   * ===== ASSESSMENTS =====
   */

  async createAssessment(assessmentData) {
    const { data, error } = await supabase
      .from('hr_assessments')
      .insert([assessmentData])
      .select()

    if (error) throw error
    return data[0]
  },

  async listAssessments(candidateId) {
    const { data, error } = await supabase
      .from('hr_assessments')
      .select('*')
      .eq('candidate_id', candidateId)

    if (error) throw error
    return data
  },

  async updateAssessment(assessmentId, updates) {
    const { data, error } = await supabase
      .from('hr_assessments')
      .update(updates)
      .eq('id', assessmentId)
      .select()

    if (error) throw error
    return data[0]
  },

  /**
   * ===== INTERVIEWS =====
   */

  async scheduleInterview(interviewData) {
    const { data, error } = await supabase
      .from('hr_interviews')
      .insert([interviewData])
      .select()

    if (!error) return data[0]

    // A Super Admin (and any role the INSERT policy forgot) hits
    // `new row violates row-level security policy for table "hr_interviews"`.
    // The guarded SECURITY DEFINER RPC writes the SAME row under its own role
    // gate — HR roles only, Super Admin included — so scheduling keeps working
    // on a database whose INSERT policy has not been patched yet. Any other
    // failure (constraint, connection) is still the caller's to see.
    if (!isRowLevelSecurityError(error)) throw error
    const row = await scheduleInterviewViaRpc(interviewData)
    if (row == null) throw error
    return row
  },

  async listInterviews(candidateId) {
    const { data, error } = await supabase
      .from('hr_interviews')
      .select('*')
      .eq('candidate_id', candidateId)
      .order('scheduled_date', { ascending: false })

    if (error) throw error
    return data
  },

  async updateInterview(interviewId, updates) {
    const { data, error } = await supabase
      .from('hr_interviews')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', interviewId)
      .select()

    if (error) throw error
    return data[0]
  },

  async getInterviewById(interviewId) {
    const { data, error } = await supabase
      .from('hr_interviews')
      .select('*')
      .eq('id', interviewId)
      .single()

    if (error) throw error
    return data
  },

  async submitInterviewFeedback(interviewId, feedback, rating) {
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('hr_interviews')
      .update({
        status: 'completed',
        feedback,
        rating,
      })
      .eq('id', interviewId)
      .select()

    if (error) throw error
    return data[0]
  },
}

/**
 * True for an RLS refusal — SQLSTATE 42501, or the message PostgREST/Supabase
 * returns for it. Both forms are matched so the guarded write path is taken
 * even when a proxy rewrites the code.
 */
function isRowLevelSecurityError(error) {
  if (!error) return false
  if (error.code === '42501') return true
  return /row[- ]level security/i.test(String(error.message || ''))
}

/**
 * The guarded write path for an interview: `hr_schedule_recruitment_interview`
 * is SECURITY DEFINER with the same role gate the Recruitment pipeline uses
 * (super_admin / admin / head_of_human_resources / hr_officer), so it inserts
 * the row even on a database whose direct-INSERT policy has not been widened.
 *
 * Returns null when the RPC does not exist (never-applied pipeline schema) so
 * the caller can surface the original RLS error instead of a "function not
 * found" one. Fields the RPC does not carry (email override, notification and
 * external meeting columns) are applied with a follow-up UPDATE — the UPDATE
 * policy already admits every HR role, Super Admin included.
 */
async function scheduleInterviewViaRpc(interviewData) {
  const d = interviewData || {}
  const { data, error } = await supabase.rpc('hr_schedule_recruitment_interview', {
    p_candidate_id: d.candidate_id,
    p_data: {
      candidate_name: d.candidate_name,
      candidate_email: d.candidate_email,
      position: d.position,
      interview_type: d.interview_type,
      location: d.location,
      platform: d.platform,
      meeting_url: d.meeting_url,
      scheduled_date: d.scheduled_date,
      duration_minutes: d.duration_minutes,
      interviewer_id: d.interviewer_id,
      notes: d.interview_instructions,
      interview_round: d.interview_round,
    },
  })

  if (error) {
    if (error.code === 'PGRST202' || error.code === '404') return null
    throw error
  }

  const row = Array.isArray(data) ? data[0] : data
  if (row == null) return null

  const leftovers = {}
  for (const [key, value] of Object.entries(interviewData || {})) {
    if (key === 'candidate_id') continue
    if (value === '' || value === undefined) continue
    leftovers[key] = value
  }

  if (Object.keys(leftovers).length === 0) return row
  return (await hrService.updateInterview(row.id, leftovers)) || row
}
