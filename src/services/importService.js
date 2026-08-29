import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Data Import & Migration Centre.
//
// Responsibilities:
//   * parse CSV / JSON source files (no external parsers required)
//   * validate rows against each import type's rules
//   * stage validated rows into data_import_records (RLS-protected)
//   * execute a staged job through the run_data_import() RPC (SECURITY
//     DEFINER — the database is the authority, never the UI)
//   * generate CSV templates and downloadable error reports
// ------------------------------------------------------------------

export const IMPORT_TYPES = {
  employees: {
    label: 'Employees',
    required: ['full_name'],
    display: ['full_name', 'email', 'phone', 'department', 'position', 'employment_status', 'salary', 'branch'],
  },
  customers: {
    label: 'Customers',
    required: ['name'],
    display: ['name', 'email', 'phone', 'address', 'employment_status', 'employer', 'monthly_income'],
  },
  loans: {
    label: 'Loans',
    required: ['customer_name'],
    display: ['customer_name', 'customer_id', 'principal_amount', 'outstanding_balance', 'interest_rate', 'term_months', 'status'],
  },
  repayments: {
    label: 'Repayments',
    required: ['loan_id'],
    display: ['loan_id', 'customer_name', 'amount', 'due_date', 'payment_date', 'status'],
  },
  payroll: {
    label: 'Payroll',
    required: ['employee_name'],
    display: ['employee_name', 'employee_id', 'salary', 'allowances', 'deductions', 'payroll_period'],
  },
  recruitment: {
    label: 'Recruitment',
    required: ['full_name'],
    display: ['full_name', 'email', 'phone', 'current_company', 'years_experience', 'application_status'],
  },
}

const HEADERS = {
  employees: ['full_name', 'email', 'phone', 'department', 'position', 'employment_status', 'salary', 'employee_code', 'sex', 'date_of_birth', 'hire_date', 'bank_name', 'account_number', 'branch'],
  customers: ['name', 'email', 'phone', 'address', 'employment_status', 'employer', 'monthly_income', 'status', 'notes', 'date_of_birth'],
  loans: ['customer_id', 'customer_name', 'principal_amount', 'outstanding_balance', 'interest_rate', 'term_months', 'monthly_payment', 'status', 'disbursed_date', 'maturity_date'],
  repayments: ['loan_id', 'customer_id', 'customer_name', 'amount', 'due_date', 'payment_date', 'status', 'payment_method'],
  payroll: ['employee_id', 'employee_name', 'salary', 'allowances', 'deductions', 'payroll_period', 'period_start', 'period_end', 'status'],
  recruitment: ['full_name', 'email', 'phone', 'current_company', 'years_experience', 'application_status'],
}

// ---------------------------------------------------------------- CSV

export function parseCSV(text) {
  const rows = []
  let field = ''
  let row = []
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 }
        else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field.trim()); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field.trim()); field = ''
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  row.push(field.trim())
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

function normalizeHeader(h) {
  return String(h).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

// Maps a source CSV row (header + cells) into an object keyed by the
// normalized source header. The user-controlled mapping (source → target)
// is applied afterwards in validateRows.
export function mapHeaderRow(headerRow, dataRows) {
  const header = headerRow.map(normalizeHeader)
  return dataRows.map((cells) => {
    const obj = {}
    header.forEach((h, idx) => { if (h) obj[h] = cells[idx] ? String(cells[idx]).trim() : '' })
    return obj
  })
}

// Applies { sourceColumn: targetColumn } to a source-keyed record.
export function applyMapping(record, mapping) {
  const target = {}
  Object.entries(mapping || {}).forEach(([src, tgt]) => {
    if (!tgt) return
    const v = record[src]
    if (v !== undefined && v !== '') target[tgt] = v
  })
  return target
}

export function validateRows(importType, records, mapping = {}) {
  const def = IMPORT_TYPES[importType]
  if (!def) throw new Error(`Unsupported import type: ${importType}`)
  return records.map((record, idx) => {
    const m = applyMapping(record, mapping)
    const errors = []
    const warnings = []
    def.required.forEach((field) => {
      if (!(m[field] || '').trim()) errors.push(`Missing required field "${field}".`)
    })
    if (importType === 'employees') {
      if (!m.email && !m.phone) warnings.push('No email or phone — duplicates cannot be detected for this row.')
      if (m.salary && Number.isNaN(Number(m.salary))) errors.push('"salary" must be a number.')
      const employmentStatus = normalizeHeader(m.employment_status || '')
      if (employmentStatus && !['active', 'onboarding', 'probation', 'on_leave', 'terminated', 'suspended', 'inactive', 'active_employee', 'active employee', 'employed'].includes(employmentStatus)) {
        warnings.push(`"${m.employment_status}" will be mapped to a valid employment status.`)
      }
    }
    if (importType === 'customers' && m.monthly_income && Number.isNaN(Number(m.monthly_income))) {
      errors.push('"monthly_income" must be a number.')
    }
    if (importType === 'loans' || importType === 'repayments') {
      const amounts = ['principal_amount', 'outstanding_balance', 'interest_rate', 'amount']
      amounts.forEach((a) => { if (m[a] && Number.isNaN(Number(m[a]))) errors.push(`"${a}" must be a number.`) })
    }
    if (importType === 'payroll') {
      ;['salary', 'allowances', 'deductions'].forEach((a) => { if (m[a] && Number.isNaN(Number(m[a]))) errors.push(`"${a}" must be a number.`) })
    }
    if (importType === 'recruitment' && m.years_experience && Number.isNaN(Number(m.years_experience))) {
      errors.push('"years_experience" must be a number.')
    }
    const status = errors.length ? 'error' : warnings.length ? 'warning' : 'valid'
    return { row_number: idx + 2, source_data: record, validation_errors: [...errors.map((e) => ({ message: e, severity: 'ERROR' })), ...warnings.map((w) => ({ message: w, severity: 'WARNING' }))], status, errorRows: errors.length, warningRows: warnings.length }
  })
}

// ---------------------------------------------------------------- Jobs

export const importService = {
  async createJob({ importType, filename, duplicateStrategy, mapping }) {
    const { data, error } = await supabase
      .from('data_import_jobs')
      .insert({
        import_type: importType,
        filename: filename || null,
        duplicate_strategy: duplicateStrategy || 'skip',
        mapping,
        status: 'pending',
      })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async stageRecords(jobId, validatedRecords) {
    const rows = validatedRecords.map((r) => ({
      job_id: jobId,
      row_number: r.row_number,
      source_data: r.source_data,
      validation_errors: r.validation_errors,
      status: r.status === 'warning' ? 'warning' : r.status,
    }))
    const total = rows.length
    const valid = rows.filter((r) => r.status === 'valid').length
    const warnings = rows.filter((r) => r.status === 'warning').length
    const errors = total - valid - warnings
    const { error } = await supabase.from('data_import_records').insert(rows)
    if (error) throw error
    await supabase
      .from('data_import_jobs')
      .update({ status: 'ready', total_rows: total, valid_rows: valid, warning_rows: warnings, error_rows: errors, updated_at: new Date().toISOString() })
      .eq('id', jobId)
    return { total, valid, warnings, errors }
  },

  async listJobs() {
    const { data, error } = await supabase
      .from('data_import_jobs')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async getJob(id) {
    const { data, error } = await supabase.from('data_import_jobs').select('*').eq('id', id).single()
    if (error) throw error
    return data
  },

  async listRecords(jobId) {
    const { data, error } = await supabase
      .from('data_import_records')
      .select('*')
      .eq('job_id', jobId)
      .order('row_number', { ascending: true })
    if (error) throw error
    return data || []
  },

  async run(jobId) {
    const { data, error } = await supabase.rpc('run_data_import', { p_job_id: jobId })
    if (error) throw error
    return data
  },

  async cancel(jobId) {
    const { data, error } = await supabase
      .from('data_import_jobs')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async downloadTemplate(importType) {
    const headers = HEADERS[importType]
    const csv = `\uFEFF${headers.join(',')}\n`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${importType}-import-template.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  },
}

export function recordSummary(counts) {
  return {
    total: (counts?.total_rows || 0) + (counts?.valid_rows || 0) + (counts?.warning_rows || 0) + (counts?.error_rows || 0),
    valid: counts?.valid_rows || 0,
    warnings: counts?.warning_rows || 0,
    errors: counts?.error_rows || 0,
    inserted: counts?.inserted_rows || 0,
    updated: counts?.updated_rows || 0,
    skipped: counts?.skipped_rows || 0,
  }
}

export function downloadErrorReport(job, records) {
  const failed = records.filter((r) => r.status === 'failed' || r.status === 'error')
  if (failed.length === 0) return 0
  const headers = ['row_number', 'status', 'errors', 'source']
  const lines = [headers.join(',')]
  failed.forEach((r) => {
    const errs = Array.isArray(r.validation_errors)
      ? r.validation_errors.map((e) => e?.message || '').join(' | ')
      : ''
    const source = JSON.stringify(r.source_data || {}).replace(/"/g, '""')
    lines.push([r.row_number, r.status, `"${errs.replace(/"/g, '""')}"`, `"${source}"`].join(','))
  })
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${job.import_type}-import-errors-${job.id.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
  return failed.length
}

export { HEADERS }
export default importService