import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// Assessment service — question banks, invitations, attempts, retakes
// and anti-cheat monitoring for the CBT pipeline.
//
// Templates/questions are plain RLS-guarded rows (HR read + HR ops
// write). The token-gated *candidate* flows live in careerService.
// HR-only mutations that must be safe (invitation, retake decision,
// regrade) are SECURITY DEFINER RPCs from schema_phase41.
// ------------------------------------------------------------------

const EDGE = 'sara-candidate-analysis'

async function invoke(payload) {
  const { data, error } = await supabase.functions.invoke(EDGE, { body: payload })
  if (error) throw error
  return data
}

export const assessmentService = {
  // ---- Templates ---------------------------------------------------------

  async listTemplates(filters = {}) {
    let query = supabase.from('assessment_templates').select('*')
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.jobId) query = query.eq('job_id', filters.jobId)
    query = query.order('updated_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async getTemplate(templateId) {
    const [templateRes, questionsRes] = await Promise.all([
      supabase.from('assessment_templates').select('*').eq('id', templateId).maybeSingle(),
      supabase.from('assessment_template_questions').select('*').eq('template_id', templateId).order('display_order', { ascending: true }),
    ])
    if (templateRes.error) throw templateRes.error
    return { template: templateRes.data, questions: questionsRes.data || [] }
  },

  async createTemplate(data) {
    const payload = {
      title: data.title,
      job_id: data.job_id || null,
      description: data.description || null,
      category: data.category || 'technical',
      source: data.source || 'manual',
      instructions: data.instructions || null,
      status: 'draft',
      duration_minutes: Number(data.duration_minutes || 30),
      pass_mark: Number(data.pass_mark || 60),
      max_questions: data.max_questions ? Number(data.max_questions) : null,
      shuffle_questions: !!data.shuffle_questions,
      randomization: !!data.randomization,
      anti_cheat: data.anti_cheat || undefined,
    }
    const { data: row, error } = await supabase.from('assessment_templates').insert([payload]).select().single()
    if (error) throw error
    return row
  },

  async updateTemplate(templateId, updates) {
    const { data, error } = await supabase
      .from('assessment_templates')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', templateId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- Questions ---------------------------------------------------------

  async saveQuestions(templateId, questions) {
    const rows = questions.filter((q) => q.question_text && q.question_text.trim()).map((q, i) => ({
      template_id: templateId,
      question_text: q.question_text.trim(),
      question_type: q.question_type || 'multiple_choice',
      options: q.options || [],
      correct_answer: q.correct_answer ?? null,
      marks: Number(q.marks || 1),
      difficulty: q.difficulty || 'medium',
      competency: q.competency || null,
      display_order: Number(q.display_order ?? i),
    }))
    if (rows.length === 0) return []
    const { data, error } = await supabase.from('assessment_template_questions').insert(rows).select()
    if (error) throw error
    return data || []
  },

  async updateQuestion(questionId, fields) {
    const { data, error } = await supabase
      .from('assessment_template_questions')
      .update(fields)
      .eq('id', questionId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async deleteQuestion(questionId) {
    const { error } = await supabase.from('assessment_template_questions').delete().eq('id', questionId)
    if (error) throw error
  },

  async generateWithSara({ jobId, templateId = null, category, durationMinutes, passMark, count, competencies = [] }) {
    const result = await invoke({
      action: 'generate_assessment',
      job_id: jobId,
      template_id: templateId || null,
      category: category || 'technical',
      duration_minutes: durationMinutes,
      pass_mark: passMark,
      count,
      competencies,
    })
    return result
  },

  // ---- Invitations / assignments ----------------------------------------

  async listAssignments(filters = {}) {
    let query = supabase
      .from('hr_assessments')
      .select('*, hr_candidates(full_name, email, applied_role)')
    if (filters.candidateId) query = query.eq('candidate_id', filters.candidateId)
    if (filters.jobId) query = query.eq('job_id', filters.jobId)
    if (filters.status) query = query.eq('status', filters.status)
    query = query.order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async inviteCandidate({ candidateId, templateId, jobId = null, expiresDays = 7 }) {
    const { data, error } = await supabase.rpc('hr_create_assessment_invitation', {
      p_candidate_id: candidateId,
      p_template_id: templateId,
      p_job_id: jobId || null,
      p_expires_days: expiresDays,
    })
    if (error) throw error
    return data // { ok, assignment_id, invitation_token, url, expires_at }
  },

  async sendInvitationEmail({ assignmentId, invitationToken }) {
    const { data, error } = await supabase.functions.invoke('send-assessment-email', {
      body: { assignmentId, invitationToken },
    })
    if (error) throw error
    return data
  },

  async cancelAssignment(assignmentId) {
    const { data, error } = await supabase
      .from('hr_assessments')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', assignmentId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async getAssignmentAttempts(assignmentId) {
    const { data, error } = await supabase
      .from('assessment_attempts')
      .select('*')
      .eq('assignment_id', assignmentId)
      .order('attempt_number', { ascending: false })
    if (error) throw error
    return data || []
  },

  async getAttemptDetail(attemptId) {
    const [attemptRes, answersRes, eventsRes] = await Promise.all([
      supabase.from('assessment_attempts').select('*').eq('id', attemptId).maybeSingle(),
      supabase.from('assessment_attempt_answers').select('*').eq('attempt_id', attemptId).order('answered_at', { ascending: true }),
      supabase.from('assessment_monitoring_events').select('*').eq('attempt_id', attemptId).order('sequence_number', { ascending: true }),
    ])
    if (attemptRes.error) throw attemptRes.error
    return { attempt: attemptRes.data, answers: answersRes.data || [], monitoring: eventsRes.data || [] }
  },

  // ---- Retakes / review / grading ---------------------------------------

  async listRetakeRequests(filters = {}) {
    let query = supabase.from('assessment_retake_requests').select('*')
    if (filters.status) query = query.eq('status', filters.status)
    query = query.order('requested_at', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async decideRetake(requestId, decision, note = null) {
    const { data, error } = await supabase.rpc('hr_decide_assessment_retake', {
      p_request_id: requestId,
      p_decision: decision,
      p_note: note,
    })
    if (error) throw error
    return data
  },

  async markAttemptReview(attemptId, status, notes = null) {
    const { data, error } = await supabase.rpc('hr_mark_attempt_review', {
      p_attempt_id: attemptId,
      p_status: status,
      p_notes: notes,
    })
    if (error) throw error
    return data
  },

  async gradeQuestion(attemptId, questionId, marks, feedback = null) {
    const { data, error } = await supabase.rpc('hr_grade_assessment_question', {
      p_attempt_id: attemptId,
      p_question_id: questionId,
      p_marks: Number(marks),
      p_feedback: feedback,
    })
    if (error) throw error
    return data
  },

  async analyzeAttempt(attemptId) {
    const result = await invoke({ action: 'analyze_assessment', attempt_id: attemptId })
    return result
  },

  async listMonitoring(attemptId) {
    const { data, error } = await supabase
      .from('assessment_monitoring_events')
      .select('*')
      .eq('attempt_id', attemptId)
      .order('sequence_number', { ascending: true })
    if (error) throw error
    return data || []
  },
}

export default assessmentService
