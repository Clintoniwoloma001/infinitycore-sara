import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Recruitment service — HR side of the application pipeline.
// Status transitions / profile edits / notes route through the
// SECURITY DEFINER RPCs (which enforce HR role checks server-side).
// Reads use RLS-scoped selects with the standard nested relations.
// ------------------------------------------------------------------

const HR_CANDIDATE_SELECT =
  '*, hr_jobs:job_id(job_title, department, branch, location, employment_type, status, requirements, description, responsibilities, qualifications, benefits, required_skills, preferred_skills, application_deadline)'

export const RESUME_MAX_BYTES = 10 * 1024 * 1024
export const RESUME_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

export function validateResume(file) {
  if (!file) return null
  if (file.size <= 0 || file.size > RESUME_MAX_BYTES) return 'Resume must be between 1 byte and 10 MB.'
  const validMime = RESUME_MIME_TYPES.includes(file.type)
  const validExtension = /\.(pdf|doc|docx)$/i.test(file.name || '')
  if (!validMime && !validExtension) return 'Resume must be a PDF, DOC, or DOCX file.'
  return null
}

function safeFileName(name) {
  return String(name || 'resume').replace(/[^\w.\- ]+/g, '_').slice(0, 160)
}

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
    const rows = data || []
    if (!rows.length) return rows

    const ids = rows.map((row) => row.id)
    const [screeningRes, assessmentRes] = await Promise.all([
      supabase.from('candidate_screening_results').select('candidate_id, overall_score, components, created_at').in('candidate_id', ids).order('created_at', { ascending: false }),
      supabase.from('hr_assessments').select('candidate_id, score, status, completed_at').in('candidate_id', ids).eq('status', 'completed').order('completed_at', { ascending: false }),
    ])
    const latestScreening = {}
    const latestAssessment = {}
    ;(screeningRes.data || []).forEach((item) => { if (!latestScreening[item.candidate_id]) latestScreening[item.candidate_id] = item })
    ;(assessmentRes.data || []).forEach((item) => { if (!latestAssessment[item.candidate_id]) latestAssessment[item.candidate_id] = item })
    return rows.map((row) => ({
      ...row,
      latest_screening: latestScreening[row.id] || null,
      assessment_score: latestAssessment[row.id]?.score ?? null,
    }))
  },

  // Everything needed for the candidate profile workspace.
  async getCandidateBundle(candidateId) {
    const [candidateRes, screeningRes, historyRes, notesRes, interviewsRes, offersRes, assignmentsRes, documentsRes, eventsRes, poolRes, poolMatchesRes] = await Promise.all([
      supabase.from('hr_candidates').select(HR_CANDIDATE_SELECT).eq('id', candidateId).maybeSingle(),
      supabase.from('candidate_screening_results').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('hr_candidate_status_history').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('hr_candidate_notes').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('hr_interviews').select('*').eq('candidate_id', candidateId).order('scheduled_date', { ascending: false }),
      supabase.from('offer_letters').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('hr_assessments').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('documents').select('*').eq('entity_type', 'hr_candidate').eq('entity_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('recruitment_application_events').select('*').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
      supabase.from('recruitment_talent_pool').select('*').eq('candidate_id', candidateId).maybeSingle(),
      supabase.from('recruitment_talent_pool_matches').select('*, hr_jobs:job_id(job_title, department)').eq('candidate_id', candidateId).order('created_at', { ascending: false }),
    ])
    if (candidateRes.error) throw candidateRes.error

    let cvSignedUrl = null
    if (candidateRes.data?.cv_file_path) {
      const bucket = candidateRes.data.cv_file_path.startsWith('cvs/') || candidateRes.data.cv_file_path.startsWith('recruitment/') ? 'career' : 'documents'
      const { data: urlData } = await supabase.storage
        .from(bucket)
        .createSignedUrl(candidateRes.data.cv_file_path, 3600)
      cvSignedUrl = urlData?.signedUrl || null
    }

    const documents = documentsRes.error ? [] : (documentsRes.data || [])
    const signedDocuments = []
    for (const document of documents) {
      const bucket = document.file_path?.startsWith('cvs/') || document.file_path?.startsWith('recruitment/') ? 'career' : 'documents'
      const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(document.file_path, 3600)
      signedDocuments.push({ ...document, signedUrl: signed?.signedUrl || null })
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
      documents: signedDocuments,
      events: eventsRes.error ? [] : (eventsRes.data || []),
      talentPool: poolRes.error ? null : poolRes.data,
      talentPoolMatches: poolMatchesRes.error ? [] : (poolMatchesRes.data || []),
    }
  },

  async getDashboardStats() {
    const { data, error } = await supabase.rpc('hr_recruitment_dashboard_stats')
    if (error) throw error
    return data || {}
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
    const { data, error } = await supabase.rpc('hr_create_manual_candidate', {
      p_data: {
        full_name: payload.full_name,
        email: payload.email || null,
        phone: payload.phone || null,
        location: payload.location || null,
        current_company: payload.current_company || null,
        years_experience: payload.years_experience ?? null,
        cover_letter: payload.cover_letter || null,
        job_id: payload.job_id || null,
        applied_role: payload.applied_role || null,
        department: payload.department || null,
        branch: payload.branch || null,
        source_detail: payload.source_detail || null,
        skills: payload.skills || [],
      },
    })
    if (error) throw error
    logAction({ action: 'CANDIDATE_MANUALLY_ADDED', entityType: 'Candidate', entityId: data.id, details: `${data.full_name} added manually` }).catch(() => {})
    return data
  },

  async uploadCandidateCV(file, candidateId, onProgress) {
    const validationError = validateResume(file)
    if (validationError) throw new Error(validationError)
    const path = `recruitment/${candidateId}/cv/${Date.now()}-${safeFileName(file.name)}`
    const mime = file.type || (/\.docx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : /\.doc$/i.test(file.name) ? 'application/msword' : 'application/pdf')
    onProgress?.(10)
    const { data, error } = await supabase.storage.from('career').upload(path, file, {
      contentType: mime,
      upsert: false,
    })
    if (error) throw error
    onProgress?.(75)
    const attached = await this.attachCandidateCV(candidateId, data?.path || path, { ...file, type: mime })
    onProgress?.(100)
    return attached
  },

  async attachCandidateCV(candidateId, path, file) {
    const { data, error } = await supabase.rpc('hr_attach_candidate_cv', {
      p_candidate_id: candidateId,
      p_path: path,
      p_name: file?.name || path.split('/').pop(),
      p_size: file?.size || null,
      p_mime: file?.type || null,
    })
    if (error) throw error
    return data
  },

  async moveToTalentPool(candidateId, note = '', preferredAreas = []) {
    const { data, error } = await supabase.rpc('hr_move_candidate_to_talent_pool', {
      p_candidate_id: candidateId,
      p_note: note || null,
      p_preferred_areas: preferredAreas,
    })
    if (error) throw error
    return data
  },

  async blacklistCandidate(candidateId, reason) {
    const { data, error } = await supabase.rpc('hr_blacklist_candidate', {
      p_candidate_id: candidateId,
      p_reason: reason,
    })
    if (error) throw error
    return data
  },

  async generateTalentPoolMatches(jobId) {
    const { data, error } = await supabase.rpc('hr_generate_talent_pool_matches', { p_job_id: jobId })
    if (error) throw error
    return data
  },

  async saveScreeningConfig(jobId, config) {
    const { data, error } = await supabase.rpc('upsert_screening_config', { p_job_id: jobId, p_config: config })
    if (error) throw error
    return data
  },

  async scheduleInterview(candidateId, data) {
    const { data: row, error } = await supabase.rpc('hr_schedule_recruitment_interview', {
      p_candidate_id: candidateId,
      p_data: data,
    })
    if (error) throw error
    return row
  },

  async completeInterview(interviewId, data) {
    const { data: row, error } = await supabase.rpc('hr_complete_recruitment_interview', {
      p_interview_id: interviewId,
      p_feedback: data.feedback || null,
      p_rating: Number(data.rating),
      p_competency_scores: data.competency_scores || {},
      p_strengths: data.strengths || null,
      p_concerns: data.concerns || null,
      p_recommendation: data.recommendation || 'hold',
      p_outcome: data.outcome || null,
    })
    if (error) throw error
    return row
  },
}

export default recruitmentService
