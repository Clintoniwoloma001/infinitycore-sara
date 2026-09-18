import { supabase } from '../supabaseClient'
import { computeRemuneration, remunerationFromLegacy } from '../lib/remuneration'
import { DEFAULT_COMPANY, DEFAULT_LETTER } from '../config/offerLetterDefaults'
import { documentService } from './documentService'

const PLACEHOLDERS = [
  'candidate_name', 'position', 'company_name', 'company_address', 'department', 'branch', 'area',
  'start_date', 'probation_months', 'annual_salary', 'monthly_salary', 'mid_month_salary',
  'end_month_salary', 'benefits', 'reporting_manager', 'working_hours', 'working_days',
  'leave_entitlement', 'acceptance_deadline', 'offer_number', 'conditions', 'other_terms',
  'employment_type', 'resumption_time', 'lunch_break', 'hr_signatory', 'md_signatory',
]

// Legacy plain-text templates still render safely. Structured templates use the
// canonical renderer after the database assigns the server-side reference.
export function renderOfferBody(templateBody, values = {}) {
  if (!templateBody) return ''
  return PLACEHOLDERS.reduce(
    (body, key) => body.split(`{{${key}}}`).join(String(values[key] ?? '')),
    String(templateBody)
  )
}

function parseJson(value, fallback) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function formatTimeHHMM(value) {
  if (value == null) return null
  const match = String(value).match(/^(\d{1,2}):(\d{2})/)
  return match ? `${String(Number(match[1])).padStart(2, '0')}:${match[2]}` : null
}

async function settledData(request) {
  try {
    const result = await request
    return result?.data || null
  } catch {
    return null
  }
}

export async function getOfferEnvironment(branchName = '') {
  const [settings, attendance, branches, bankName] = await Promise.all([
    settledData(supabase.from('hr_platform_settings').select('*').eq('id', 1).maybeSingle()),
    settledData(supabase.from('attendance_config').select('*').eq('id', 1).maybeSingle()),
    settledData(supabase.from('branches').select('id, branch_name, working_days, work_start_time, work_end_time, grace_period_minutes').limit(100)),
    settledData(supabase.from('system_config').select('config_key, config_value').eq('config_key', 'bank_name').maybeSingle()),
  ])
  const selectedBranch = (branches || []).find((branch) => branchName && (
    branch.branch_name === branchName || branch.name === branchName || branch.id === branchName
  )) || null
  const startTime = formatTimeHHMM(selectedBranch?.work_start_time)
    || formatTimeHHMM(settings?.default_work_start_time)
    || formatTimeHHMM(attendance?.expected_start_time)
    || ''
  const endTime = formatTimeHHMM(selectedBranch?.work_end_time)
    || formatTimeHHMM(settings?.default_work_end_time)
    || formatTimeHHMM(attendance?.expected_end_time)
    || ''
  const workingDays = Array.isArray(selectedBranch?.working_days) && selectedBranch.working_days.length
    ? selectedBranch.working_days
    : (Array.isArray(settings?.default_working_days) ? settings.default_working_days : [])
  const configuredName = String(bankName?.config_value || '').trim()
  const companyName = configuredName && configuredName.toLowerCase() !== 'infinity bank'
    ? configuredName
    : DEFAULT_COMPANY.name

  return {
    workHours: {
      start_time: startTime,
      end_time: endTime,
      break_duration_minutes: settings?.default_break_duration_minutes ?? attendance?.break_duration_minutes ?? 0,
      grace_period_minutes: selectedBranch?.grace_period_minutes ?? settings?.default_grace_period_minutes ?? attendance?.grace_period_minutes ?? 0,
      working_days: workingDays,
      leave_annual_days: settings?.leave_annual_days ?? null,
    },
    currency: {
      currency_code: settings?.currency_code || DEFAULT_LETTER.currency,
      currency_symbol: settings?.currency_symbol || DEFAULT_LETTER.currency_symbol,
      currency_position: settings?.currency_position || DEFAULT_LETTER.currency_position,
      currency_decimal_places: settings?.currency_decimal_places ?? DEFAULT_LETTER.currency_decimals,
    },
    companyInfo: { name: companyName },
    bankName: companyName,
  }
}

function mergeRemuneration(template, form) {
  const supplied = parseJson(form.remuneration, null)
  if (supplied) {
    return {
      ...supplied,
      annual_salary: form.annual_salary ?? supplied.annual_salary,
      monthly_salary: form.monthly_salary ?? supplied.monthly_salary,
      mid_month_salary: form.mid_month_salary ?? supplied.mid_month_salary,
      end_month_salary: form.end_month_salary ?? supplied.end_month_salary,
    }
  }
  const legacy = remunerationFromLegacy(form)
  const configured = parseJson(template?.salary_config, {}) || {}
  return {
    ...configured,
    ...legacy,
    pay: { ...(configured.pay || {}), ...(legacy.pay || {}) },
    coa: { ...(configured.coa || {}), ...(legacy.coa || {}) },
    benefit: { ...(configured.benefit || {}), ...(legacy.benefit || {}) },
    social: { ...(configured.social || {}), ...(legacy.social || {}) },
    custom: form.custom_components || configured.custom || [],
  }
}

// Build the server payload. The salary_structure.document object is an
// immutable document snapshot for fields that are not columns on legacy offers.
export function offerPayloadFromForm(template, form = {}, environment = null) {
  const remuneration = mergeRemuneration(template, form)
  const rem = computeRemuneration(remuneration)
  const documentSnapshot = {
    candidate_name: form.candidate_name || form.candidateName || '',
    email: form.email || '',
    phone: form.phone || '',
    candidate_address: form.candidate_address || '',
    area: form.area || '',
    work_id: form.work_id || form.employee_code || '',
    employment_status: form.employment_status || '',
    offer_date: form.offer_date || new Date().toISOString().slice(0, 10),
    company_info: form.company_info || environment?.companyInfo || undefined,
    signatories: form.signatories || undefined,
    work_hours: environment?.workHours || undefined,
  }
  Object.keys(documentSnapshot).forEach((key) => { if (documentSnapshot[key] === undefined) delete documentSnapshot[key] })

  return {
    position: form.position ?? '',
    company_name: form.company_name || template?.company_info?.name || environment?.companyInfo?.name || DEFAULT_COMPANY.name,
    department: form.department ?? '',
    branch: form.branch ?? '',
    employment_type: form.employment_type || 'full_time',
    annual_salary: rem.totals.annual_gross,
    monthly_salary: rem.totals.monthly_gross,
    mid_month_salary: rem.totals.mid_month,
    end_month_salary: rem.totals.month_end,
    salary: rem.totals.monthly_gross,
    allowances: rem.snapshot.custom || [],
    benefits: form.benefits ?? '',
    start_date: form.start_date || new Date().toISOString().slice(0, 10),
    probation_months: Number(form.probation_months || 0),
    reporting_manager: form.reporting_manager ?? '',
    working_hours: form.working_hours ?? '',
    leave_entitlement: form.leave_entitlement ?? '',
    conditions: form.conditions ?? '',
    other_terms: form.other_terms ?? '',
    acceptance_deadline: form.acceptance_deadline || null,
    template_id: template?.id || form.template_id || null,
    template_type: form.template_type || template?.template_type || 'standard',
    candidate_address: form.candidate_address ?? '',
    remuneration: rem.snapshot,
    salary_structure: {
      ...rem.snapshot,
      document: documentSnapshot,
    },
    body_content: form.body_content || (template?.body ? renderOfferBody(template.body, form) : ''),
    generated_by: template ? 'template' : 'manual',
  }
}

export const offerService = {
  async listTemplates() {
    const { data, error } = await supabase.from('offer_letter_templates').select('*').order('name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async listActiveTemplates() {
    return (await this.listTemplates()).filter((template) => template.archived !== true && template.active !== false)
  },

  async getTemplate(templateId) {
    if (!templateId) return null
    const { data, error } = await supabase.from('offer_letter_templates').select('*').eq('id', templateId).maybeSingle()
    if (error) throw error
    return data
  },

  async saveTemplate(template) {
    const payload = {
      name: String(template.name || '').trim(),
      subject: template.subject || '',
      opening: template.opening || template.opening_paragraph || '',
      body: template.body || '',
      template_type: template.template_type || 'standard',
      reference_prefix: template.reference_prefix || DEFAULT_LETTER.reference_prefix,
      validity_days: Number(template.validity_days || DEFAULT_LETTER.validity_days),
      sections: Array.isArray(template.sections) ? template.sections : [],
      company_info: template.company_info || {},
      signatories: template.signatories || {},
      salary_config: template.salary_config || {},
      date_format: template.date_format || DEFAULT_LETTER.date_format,
      is_default: !!template.is_default,
      active: template.active !== undefined ? !!template.active : true,
      archived: !!template.archived,
    }
    if (template.id) {
      const { data, error } = await supabase.from('offer_letter_templates').update(payload).eq('id', template.id).select().single()
      if (error) throw error
      return data
    }
    const { data, error } = await supabase.from('offer_letter_templates').insert([payload]).select().single()
    if (error) throw error
    return data
  },

  async setDefaultTemplate(templateId) {
    const { data: others, error: listError } = await supabase
      .from('offer_letter_templates').select('id').neq('id', templateId).eq('archived', false)
    if (listError) throw listError
    const updates = (others || []).map((row) => supabase.from('offer_letter_templates').update({ is_default: false }).eq('id', row.id))
    updates.push(supabase.from('offer_letter_templates').update({ is_default: true }).eq('id', templateId))
    const results = await Promise.all(updates)
    const failure = results.find((result) => result.error)
    if (failure) throw failure.error
    return true
  },

  // Kept for callers of the old service API, but never hard-deletes a template.
  async deleteTemplate(templateId) {
    return this.archiveTemplate(templateId)
  },

  async archiveTemplate(templateId) {
    const { error } = await supabase.from('offer_letter_templates').update({ archived: true, active: false, is_default: false }).eq('id', templateId)
    if (error) throw error
  },

  async duplicateTemplate(templateId) {
    const source = await this.getTemplate(templateId)
    if (!source) throw new Error('Template not found')
    return this.saveTemplate({ ...source, id: null, name: `${source.name} (Copy)`, is_default: false, active: true, archived: false })
  },

  async listOffers(filters = {}) {
    let query = supabase.from('offer_letters').select('*, hr_candidates(full_name, email, phone, applied_role, job_id)')
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.candidateId) query = query.eq('candidate_id', filters.candidateId)
    const { data, error } = await query.order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async getOffer(offerId) {
    const { data, error } = await supabase.from('offer_letters').select('*').eq('id', offerId).maybeSingle()
    if (error) throw error
    return data
  },

  async createOffer(candidateId, jobId, offer) {
    const { data, error } = await supabase.rpc('hr_create_offer', { p_candidate_id: candidateId, p_job_id: jobId || null, p_offer: offer })
    if (error) throw error
    return data
  },

  async allocateOfferReference(prefix = 'OFR') {
    const functionName = prefix && prefix !== 'OFR' ? 'hr_allocate_offer_reference_with_prefix' : 'hr_allocate_offer_reference'
    const params = functionName.endsWith('with_prefix') ? { p_prefix: prefix } : {}
    const { data, error } = await supabase.rpc(functionName, params)
    if (error) throw error
    return data
  },

  async issueOffer(offerId) {
    const { data, error } = await supabase.rpc('hr_issue_offer', { p_offer_id: offerId })
    if (error) throw error
    return data
  },

  async sendOffer(offerId, emailedTo = null, documentId = null) {
    const { data, error } = await supabase.rpc('hr_send_offer', { p_offer_id: offerId, p_emailed_to: emailedTo, p_document_id: documentId })
    if (error) throw error
    return data
  },

  async setOfferDocument(offerId, documentId, fileName = null) {
    const { data, error } = await supabase.rpc('hr_set_offer_document', { p_offer_id: offerId, p_document_id: documentId, p_file_name: fileName })
    if (error) throw error
    return data
  },

  async attachOfferPdf(offerId, file, fileName = null) {
    if (!file) throw new Error('No offer PDF was generated.')
    const pdf = file instanceof File ? file : new File([file], fileName || `offer-letter-${offerId}.pdf`, { type: 'application/pdf' })
    const doc = await documentService.upload(pdf, 'offer_letter', offerId, 'offer_letter_pdf')
    await this.setOfferDocument(offerId, doc.id, doc.file_name)
    return doc
  },

  async modifyOffer(offerId, offer) {
    const { data, error } = await supabase.rpc('hr_modify_offer', { p_offer_id: offerId, p_offer: offer })
    if (error) throw error
    return data
  },

  async updateDraftDocument(offerId, html) {
    return this.modifyOffer(offerId, { body_content: html })
  },

  async withdrawOffer(offerId, note = null) {
    const { data, error } = await supabase.rpc('hr_withdraw_offer', { p_offer_id: offerId, p_note: note })
    if (error) throw error
    return data
  },

  async createOnboardingLink(offerId, expiresDays = 7) {
    const { data, error } = await supabase.rpc('hr_create_onboarding_link_for_offer', { p_offer_id: offerId, p_expires_days: expiresDays })
    if (error) throw error
    return data
  },

  async getActiveVersion(offerId) {
    const offer = await this.getOffer(offerId)
    if (!offer || !offer.superseded_by) return offer
    return this.getActiveVersion(offer.superseded_by)
  },
}

export default offerService
