import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Recruitment service — HR side of the application pipeline.
// Status transitions / profile edits / notes route through the
// SECURITY DEFINER RPCs (which enforce HR role checks server-side).
// Reads use RLS-scoped selects with the standard nested relations.
// ------------------------------------------------------------------

const HR_CANDIDATE_SELECT =
  '*, hr_jobs:job_id(job_title, department, location, employment_type, status, requirements, description)'

export const recruitmentService = {
  async listJobs(filters = {}) {
    let query = supabase.from('hr_jobs').select('*')
    if (filters.status) query = query.eq('status', filters.status)
    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async getJob(jobId) {
    const { data, error } = await supabase.from('hr_jobs').select('*').eq('id', jobId).maybeSingle()
    if (error) throw error
    return data
  },

  async listApplications(filters = {}) {
    let query = supabase.from('hr_candidates').select(HR_CANDIDATE_SELECT)
    if (filters.jobId) query = query.eq('job_id', filters.jobId)
    if (filters.status) query = query.eq('application_status', filters.status)
    if (filters.search) {
      const term = `%${filters.search}%`
      query = query.or(`full_name.ilike.${term},email.ilike.${term},applied_role.ilike.${term}`)
    }
    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  // Everything needed for the candidate profile workspace.
  async getCandidateBundle(candidateId) {
    const [candidateRes, screeningRes, historyRes, notesRes, interviewsRes, offersRes, assignmentsRes] = await Promise.all([
      supabase.from('hr_candidates').select(HR_CANDIDATE_SELECT).eq('id', candidateId).maybeSingle(),
      supabase.from('candidate_screening_results').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('hr_candidate_status_history').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('hr_candidate_notes').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('hr_interviews').select('*').eq('candidate_id', candidateId).order('scheduled_date', { ascending: false }),
      supabase.from('offer_letters').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('hr_assessments').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
    ])
    if (candidateRes.error) throw candidateRes.error

    let cvSignedUrl = null
    if (candidateRes.data?.cv_file_path) {
      const { data: urlData } = await supabase.storage
        .from('documents')
        .createSignedUrl(candidateRes.data.cv_file_path, 3600)
      cvSignedUrl = urlData?.signedUrl || null
    }
    if (!cvSignedUrl && candidateRes.data?.cv_file_path?.startsWith('career/')) {
      const { data: urlData } = await supabase.storage
        .from('career')
        .createSignedUrl(candidateRes.data.cv_file_path, 3600)
      cvSignedUrl = urlData?.signedUrl || null
    }

    // Attempts (plus answers and monitoring) for every assignment.
    const assignments = assignmentsRes.data || []
    const attemptsByAssignment = {}
    const questionsByTemplate = {}
    for (const assignment of assignments) {
      if (assignment.template_id && !questionsByTemplate[assignment.template_id]) {
        const { data: qData } = await supabase
          .from('assessment_template_questions')
          .select('*')
          .eq('template_id', assignment.template_id)
          .order('display_order', { ascending: true })
        questionsByTemplate[assignment.template_id] = qData || []
      }
      const { data: attemptsData, error: attemptsError } = await supabase
        .from('assessment_attempts')
        .select('*')
        .eq('assignment_id', assignment.id)
        .order('attempt_number', { ascending: false })
      if (attemptsError) throw attemptsError
      const attempts = attemptsData || []
      const enriched = []
      for (const attempt of attempts) {
        const [answersRes, eventsRes] = await Promise.all([
          supabase.from('assessment_attempt_answers').select('*').eq('attempt_id', attempt.id).order('answered_at', { ascending: true }),
          supabase.from('assessment_monitoring_events').select('*').eq('attempt_id', attempt.id).order('sequence_number', { ascending: true }),
        ])
        enriched.push({ ...attempt, answers: answersRes.data || [], monitoring: eventsRes.data || [] })
      }
      attemptsByAssignment[assignment.id] = enriched
    }

    return {
      candidate: candidateRes.data,
      screening: (screeningRes.error ? [] : screeningRes.data) || [],
      history: historyRes.data || [],
      notes: notesRes.data || [],
      interviews: interviewsRes.data || [],
      offers: offersRes.data || [],
      assignments,
      attemptsByAssignment,
      questionsByTemplate,
      cvSignedUrl,
    }
  },

  async advanceStatus(candidateId, status, note = null) {
    const { data, error } = await supabase.rpc('hr_advance_application', {
      p_candidate_id: candidateId,
      p_status: status,
      p_note: note,
    })
    if (error) throw error
    logAction({ action: 'APPLICATION_STATUS_CHANGED', entityType: 'Candidate', entityId: candidateId, details: `Status → ${status}` }).catch(() => {})
    return data
  },

  async updateProfile(candidateId, data) {
    const { data: result, error } = await supabase.rpc('hr_update_candidate_profile', {
      p_candidate_id: candidateId,
      p_data: data,
    })
    if (error) throw error
    return result
  },

  async addNote(candidateId, note) {
    const { data, error } = await supabase.rpc('hr_add_candidate_note', {
      p_candidate_id: candidateId,
      p_note: note,
    })
    if (error) throw error
    return data
  },

  async addManualCandidate(payload) {
    const { data, error } = await supabase
      .from('hr_candidates')
      .insert([{
        full_name: payload.full_name,
        email: payload.email || null,
        phone: payload.phone || null,
        current_company: payload.current_company || null,
        years_experience: payload.years_experience || null,
        cover_letter: payload.cover_letter || null,
        job_id: payload.job_id || null,
        applied_role: payload.applied_role || null,
        department: payload.department || null,
        branch: payload.branch || null,
        application_status: 'received',
        application_source: 'manual',
        skills: payload.skills || [],
      }])
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'CANDIDATE_MANUALLY_ADDED', entityType: 'Candidate', entityId: data.id, details: `${data.full_name} added manually` }).catch(() => {})
    return data
  },
}

export default recruitmentService