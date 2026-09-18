import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
export { TRAINING_TYPES, formatTrainingType, hours, buildQuestionSets, calculateTrainingManHours, calculateManHourSummary, aggregateManHourRows } from './trainingCalculations'

async function currentUser() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  if (!data?.user) throw new Error('You must be signed in.')
  return data.user
}

function dataUrlToBlob(dataUrl) {
  const [header, body] = String(dataUrl || '').split(',')
  if (!header || !body) throw new Error('The signature could not be prepared.')
  const mime = header.match(/data:(.*?);base64/)?.[1] || 'image/png'
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mime })
}

export const trainingService = {
  async listSessions({ startDate, endDate } = {}) {
    let query = supabase
      .from('training_sessions')
      .select('*, branches(id, branch_name)')
      .order('training_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (startDate) query = query.gte('training_date', startDate)
    if (endDate) query = query.lte('training_date', endDate)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async listEmployees() {
    const { data, error } = await supabase
      .from('employees')
      .select('id, full_name, employee_number, employee_code, staff_id, department, area, branch, branch_id, employment_status')
      .eq('is_archived', false)
      .order('full_name')
      .limit(1000)
    if (error) throw error
    return data || []
  },

  async createSession(payload) {
    const user = await currentUser()
    const { data, error } = await supabase.from('training_sessions').insert({
      ...payload,
      created_by: user.id,
      updated_by: user.id,
      status: payload.status || 'scheduled',
    }).select().single()
    if (error) throw error
    return data
  },

  async generateQuestionSets(sessionId, sets) {
    const { data, error } = await supabase.rpc('generate_kss_question_sets', {
      p_session_id: sessionId,
      p_sets: sets,
    })
    if (error) throw error
    return data
  },

  async assignParticipants(sessionId, employeeIds) {
    const { data, error } = await supabase.rpc('assign_training_participants', {
      p_session_id: sessionId,
      p_employee_ids: employeeIds,
    })
    if (error) throw error
    return data
  },

  async getDashboard(filters = {}) {
    const { data, error } = await supabase.rpc('get_training_dashboard', {
      p_start_date: filters.startDate || null,
      p_end_date: filters.endDate || null,
      p_area: filters.area || null,
      p_branch_id: filters.branchId || null,
      p_department: filters.department || null,
      p_employee_id: filters.employeeId || null,
    })
    if (error) throw error
    return data || {}
  },

  async getManHourIntelligence(filters = {}) {
    const { data, error } = await supabase.rpc('get_man_hour_intelligence', {
      p_start_date: filters.startDate || null,
      p_end_date: filters.endDate || null,
      p_area: filters.area || null,
      p_branch_id: filters.branchId || null,
      p_department: filters.department || null,
      p_employee_id: filters.employeeId || null,
    })
    if (error) throw error
    return data || {}
  },

  async getEmployeeManHourDetail(employeeId, filters = {}) {
    const { data, error } = await supabase.rpc('get_employee_man_hour_detail', {
      p_employee_id: employeeId,
      p_start_date: filters.startDate || null,
      p_end_date: filters.endDate || null,
    })
    if (error) throw error
    return data || {}
  },

  async getMyAssignments() {
    const { data, error } = await supabase
      .from('training_participants')
      .select('id, status, assigned_at, opened_at, submitted_at, completed_at, training_sessions(id, title, training_type, description, facilitator, training_date, start_time, end_time, duration_minutes, location, virtual_link, assessment_required, certificate_enabled)')
      .order('assigned_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async getMyAssignment(participantId) {
    const { data, error } = await supabase.rpc('get_my_training_assignment', { p_participant_id: participantId })
    if (error) throw error
    return data
  },

  async submitAssignment({ participantId, answers, signature, declarationText }) {
    if (!signature) throw new Error('Please sign the training declaration before submitting.')
    const signatureBlob = dataUrlToBlob(signature)
    const signaturePath = `training-signatures/${participantId}/${crypto.randomUUID()}.png`
    const { error: uploadError } = await supabase.storage.from('documents').upload(signaturePath, signatureBlob, {
      contentType: 'image/png',
      upsert: false,
    })
    if (uploadError) throw uploadError

    try {
      const { data, error } = await supabase.rpc('submit_training_assessment', {
        p_participant_id: participantId,
        p_answers: answers || [],
        p_signature_path: signaturePath,
        p_declaration_accepted: true,
        p_declaration_text: declarationText,
      })
      if (error) throw error
      return data
    } catch (error) {
      await supabase.storage.from('documents').remove([signaturePath]).catch(() => {})
      throw error
    }
  },

  async listEmployeeRecords(employeeId) {
    const { data, error } = await supabase
      .from('employee_training_records')
      .select('*, training_certificates(id, certificate_number, verification_status, pdf_path, issued_at)')
      .eq('employee_id', employeeId)
      .order('training_date', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listMyRecords() {
    const user = await currentUser()
    const { data: employee, error: employeeError } = await supabase.from('employees').select('id').eq('user_id', user.id).limit(1).maybeSingle()
    if (employeeError) throw employeeError
    if (!employee) return []
    return this.listEmployeeRecords(employee.id)
  },

  async verifyCertificate(certificateNumber) {
    const { data, error } = await supabase.rpc('verify_training_certificate', { p_certificate_number: certificateNumber })
    if (error) throw error
    return data
  },

  async storeCertificatePdf(certificateId, blob) {
    const path = `training-certificates/${certificateId}/${Date.now()}.pdf`
    const { error: uploadError } = await supabase.storage.from('documents').upload(path, blob, {
      contentType: 'application/pdf',
      upsert: false,
    })
    if (uploadError) throw uploadError
    try {
      const { data, error } = await supabase.rpc('set_training_certificate_pdf', {
        p_certificate_id: certificateId,
        p_pdf_path: path,
      })
      if (error) throw error
      return data
    } catch (error) {
      await supabase.storage.from('documents').remove([path]).catch(() => {})
      throw error
    }
  },

  async certificateSignedUrl(pdfPath, expiresIn = 3600) {
    if (!pdfPath) return null
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(pdfPath, expiresIn)
    if (error) throw error
    return data?.signedUrl || null
  },

  async getFilterOptions() {
    const { data, error } = await supabase.rpc('get_dashboard_filter_options', {
      p_branch_id: null,
      p_department: null,
      p_area: null,
    })
    if (error) throw error
    return {
      areas: data?.areas || [],
      branches: data?.branches || [],
      departments: data?.departments || [],
      employees: data?.employees || [],
    }
  },
}

export async function recordTrainingDownload(certificate) {
  if (!certificate?.id && !certificate?.certificate_id) return
  await logAction({
    action: 'TRAINING_CERTIFICATE_DOWNLOADED',
    entityType: 'TrainingCertificate',
    entityId: certificate.id || certificate.certificate_id,
    details: certificate.certificate_number || 'Certificate download',
  })
}

export default trainingService
