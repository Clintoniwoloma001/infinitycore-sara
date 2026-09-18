import { supabase } from '../supabaseClient'
import { documentService } from './documentService'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Employment letters.
//
// Generates the letter, stores the file in the private `documents`
// bucket through the existing documentService, and keeps a permanent
// versioned record in `employment_letters` (phase33). No new storage
// bucket, no new file pipeline.
// ------------------------------------------------------------------

const COMPANY = {
  name: 'Infinity Microfinance Bank Ltd',
  address: '',
  footer: 'This letter is issued by the Human Resources department and is confidential.',
}

const DEFAULT_CONDITIONS = [
  'You will abide by all company policies, procedures and the code of conduct.',
  'Your appointment is subject to the satisfactory completion of your probation period.',
  'You will not disclose confidential information belonging to the company.',
  'Either party may terminate this appointment in line with the company’s terms of service.',
]

export function buildEmploymentLetterHtml(employee, opts = {}) {
  const {
    salary = employee?.salary,
    allowances = {},
    conditions = DEFAULT_CONDITIONS,
    hrName = 'Human Resources',
    reference,
  } = opts

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const allowanceRows = Object.entries(allowances || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<tr><td>${k.replace(/_/g, ' ')}</td><td style="text-align:right">${Number(v).toLocaleString('en-NG')}</td></tr>`)
    .join('')

  const safe = (v) => (v === null || v === undefined || v === '' ? '—' : String(v))

  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; line-height: 1.6; margin: 0; padding: 48px; }
  .head { border-bottom: 3px solid #009944; padding-bottom: 12px; margin-bottom: 28px; }
  .head h1 { margin: 0; font-size: 22px; color: #005f2b; }
  .head p { margin: 2px 0; font-size: 12px; color: #555; }
  h2 { font-size: 16px; text-align: center; text-decoration: underline; margin: 24px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 12px 0; }
  td, th { border: 1px solid #ccc; padding: 6px 10px; }
  th { background: #f3f7f4; text-align: left; }
  .muted { font-size: 12px; color: #666; }
  .sign { margin-top: 48px; }
  .sign .line { border-top: 1px solid #111; width: 260px; margin-top: 40px; padding-top: 4px; font-size: 13px; }
</style></head><body>
  <div class="head">
    <h1>${COMPANY.name}</h1>
    <p>${COMPANY.address}</p>
    <p>Human Resources Department</p>
  </div>
  <p class="muted">Ref: ${safe(reference || `EL/${employee?.employee_code || employee?.employee_number || employee?.id?.slice(0, 8)}/${new Date().getFullYear()}`)}</p>
  <p class="muted">Date: ${today}</p>
  <p>Dear <strong>${safe(employee?.full_name)}</strong>,</p>
  <h2>LETTER OF EMPLOYMENT</h2>
  <p>
    Following your successful selection, we are pleased to confirm your appointment with
    ${COMPANY.name} on the terms set out below.
  </p>
  <table>
    <tbody>
      <tr><th style="width:40%">Employee Name</th><td>${safe(employee?.full_name)}</td></tr>
      <tr><th>Employee ID</th><td>${safe(employee?.employee_code || employee?.employee_number)}</td></tr>
      <tr><th>Position</th><td>${safe(employee?.position)}</td></tr>
      <tr><th>Department</th><td>${safe(employee?.department)}</td></tr>
      <tr><th>Branch</th><td>${safe(employee?.branch || employee?.branch_name)}</td></tr>
      <tr><th>Employment Type</th><td>${safe(employee?.employment_type)}</td></tr>
      <tr><th>Commencement Date</th><td>${safe(employee?.hire_date || employee?.start_date)}</td></tr>
      <tr><th>Annual Gross Salary (NGN)</th><td>${salary ? Number(salary).toLocaleString('en-NG') : '—'}</td></tr>
    </tbody>
  </table>
  ${allowanceRows ? `<table><thead><tr><th>Allowance</th><th style="text-align:right">Amount (NGN)</th></tr></thead><tbody>${allowanceRows}</tbody></table>` : ''}
  <p>Your appointment is subject to the following conditions:</p>
  <ol>${conditions.map((c) => `<li>${c}</li>`).join('')}</ol>
  <p>Please confirm your acceptance of this appointment by signing and returning a copy of this letter.</p>
  <div class="sign">
    <div class="line">${safe(hrName)}<br />For: ${COMPANY.name}</div>
  </div>
  <p class="muted" style="margin-top:32px">${COMPANY.footer}</p>
</body></html>`
}

export const employmentLetterService = {
  async listForEmployee(employeeId) {
    const { data, error } = await supabase
      .from('employment_letters')
      .select('*')
      .eq('employee_id', employeeId)
      .order('version', { ascending: false })
    if (error) throw error
    return data || []
  },

  async nextVersion(employeeId) {
    const letters = await this.listForEmployee(employeeId)
    return letters.length ? Math.max(...letters.map((l) => l.version || 0)) + 1 : 1
  },

  async issue(employee, opts = {}) {
    if (!employee?.id) throw new Error('Employee is required to generate an employment letter.')
    const version = await this.nextVersion(employee.id)
    const conditions = opts.conditions || DEFAULT_CONDITIONS
    const allowances = opts.allowances || {}

    const html = buildEmploymentLetterHtml(employee, { ...opts, conditions })
    const fileName = `employment-letter-v${version}.html`
    const file = new File([html], fileName, { type: 'text/html' })

    const doc = await documentService.upload(file, 'employee', employee.id, 'employment_letter')

    const { data: userRes } = await supabase.auth.getUser()
    const user = userRes?.user
    const hrName = user?.user_metadata?.full_name || user?.email || 'Human Resources'

    const { error: supersedeError } = await supabase
      .from('employment_letters')
      .update({ status: 'superseded' })
      .eq('employee_id', employee.id)
      .eq('status', 'issued')
    if (supersedeError) throw supersedeError

    const record = {
      employee_id: employee.id,
      version,
      status: 'issued',
      position: employee.position || null,
      department: employee.department || null,
      branch: employee.branch || employee.branch_name || null,
      employment_type: employee.employment_type || null,
      commencement_date: employee.hire_date || employee.start_date || null,
      salary: employee.salary || null,
      allowances,
      conditions,
      snapshot: {
        full_name: employee.full_name,
        employee_code: employee.employee_code || employee.employee_number || null,
        designation_id: employee.designation_id || null,
        branch_id: employee.branch_id || null,
        generated_from: 'EmployeeProfile',
      },
      document_id: doc?.id || null,
      generated_by: user?.id || null,
      generated_by_name: hrName,
    }

    const { data, error } = await supabase.from('employment_letters').insert(record).select().single()
    if (error) throw error

    await logAction({
      action: 'EMPLOYMENT_LETTER_ISSUED',
      entityType: 'EmploymentLetter',
      entityId: data.id,
      details: `Employment letter v${version} issued for ${employee.full_name || employee.id}`,
    }).catch(() => {})

    return data
  },

  // Attach a signed OFFER letter (from the Offer Letter Generator) to an
  // employee's permanent profile so it can be viewed / PDF-downloaded from
  // the employment letters tab.
  async issueOfferLetter(employee, offer, opts = {}) {
    if (!employee?.id) throw new Error('An employee must be selected to attach the offer letter to their profile.')
    const { html, pdfFile = null, fileName = null, hrName = 'Human Resources' } = opts
    if (!html) throw new Error('Offer letter HTML is required.')
    const version = await this.nextVersion(employee.id)

    const file = pdfFile || new File([html], fileName || `offer-letter-v${version}.html`, { type: pdfFile ? 'application/pdf' : 'text/html' })
    const doc = await documentService.upload(file, 'employee', employee.id, pdfFile ? 'offer_letter_pdf' : 'offer_letter')

    const { data: userRes } = await supabase.auth.getUser()
    const user = userRes?.user
    const officer = hrName || user?.user_metadata?.full_name || user?.email || 'Human Resources'

    const conditions = Array.isArray(offer?.conditions)
      ? offer.conditions
      : [offer?.conditions || 'This offer is subject to the company’s standard terms and conditions of employment.']

    const { error: supersedeError } = await supabase
      .from('employment_letters')
      .update({ status: 'superseded' })
      .eq('employee_id', employee.id)
      .eq('status', 'issued')
    if (supersedeError) throw supersedeError

    const record = {
      employee_id: employee.id,
      version,
      status: 'issued',
      position: offer.position || employee.position || null,
      department: offer.department || employee.department || null,
      branch: offer.branch || employee.branch || null,
      employment_type: offer.employment_type || employee.employment_type || null,
      commencement_date: offer.start_date || employee.hire_date || employee.start_date || null,
      salary: offer.annual_salary ? Number(offer.annual_salary) : employee.salary || null,
      allowances: {},
      conditions,
      snapshot: {
        full_name: employee.full_name,
        employee_code: employee.employee_code || employee.employee_number || null,
          offer_fields: offer,
          document_format: pdfFile ? 'pdf' : 'html',
        signature_captured: !!offer.signature_data,
        generated_from: 'OfferLetterGenerator',
      },
      document_id: doc?.id || null,
      generated_by: user?.id || null,
      generated_by_name: officer,
    }

    const { data, error } = await supabase.from('employment_letters').insert(record).select().single()
    if (error) throw error

    await logAction({
      action: 'OFFER_LETTER_ATTACHED',
      entityType: 'EmploymentLetter',
      entityId: data.id,
      details: `Offer letter v${version} attached for ${employee.full_name || employee.id}`,
    }).catch(() => {})

    return data
  },

  async getViewUrl(letter) {
    if (!letter?.document_id) throw new Error('This letter has no stored file.')
    const doc = await documentService.getById(letter.document_id)
    if (!doc?.file_path) throw new Error('Stored file could not be found.')
    return documentService.getSignedUrl(doc.file_path)
  },

  async revoke(letterId) {
    const { data, error } = await supabase
      .from('employment_letters')
      .update({ status: 'revoked' })
      .eq('id', letterId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  buildEmploymentLetterHtml,
  DEFAULT_CONDITIONS,
}

export default employmentLetterService
