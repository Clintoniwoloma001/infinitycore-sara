import { supabase } from '../supabaseClient'

/**
 * HR Service - Manages recruitment, candidates, assessments, interviews
 */

export const hrService = {
  /**
   * ===== JOBS =====
   */

  async createJob(jobData) {
    const { user } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('hr_jobs')
      .insert([{ ...jobData, created_by: user.id }])
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
    const { user } = await supabase.auth.getUser()
    return this.updateCandidate(candidateId, {
      application_status: 'screening',
      screening_score: score,
      screening_notes: notes,
      screened_by: user.id,
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

    if (error) throw error
    return data[0]
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

  async submitInterviewFeedback(interviewId, feedback, rating) {
    const { user } = await supabase.auth.getUser()
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
