import { supabase } from '../supabaseClient'
import { buildImportRows, sha256Hex } from '../domains/directorIntelligence/metricImport.js'

// Director multi-metric import service.
//
// SINGLE SOURCE OF TRUTH: this service NEVER computes a score or a bucket. It
// parses a sheet into {employee_id, as_of_date, metric_key, value} rows and hands
// them to director_upsert_metric_values(), which is the only writer. The scoring
// engine stays in SQL / mprEngine.js. The page only renders what comes back.

// Match a sheet row to a real employee by staff code first, then normalized name.
// Never creates an employee: unmatched rows are returned for the review queue.
function makeEmployeeResolver(employees) {
  const byCode = new Map()
  const byName = new Map()
  const normName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
  for (const e of employees) {
    if (e.employee_code) byCode.set(String(e.employee_code).trim().toUpperCase(), e.id)
    if (e.full_name) {
      const n = normName(e.full_name)
      if (!byName.has(n)) byName.set(n, e.id)
    }
  }
  return (row, mapping) => {
    if (mapping.staff_code && row[mapping.staff_code]) {
      const code = String(row[mapping.staff_code]).trim().toUpperCase()
      if (byCode.has(code)) return byCode.get(code)
    }
    if (mapping.staff_name && row[mapping.staff_name]) {
      const n = normName(row[mapping.staff_name])
      if (byName.has(n)) return byName.get(n)
    }
    return null
  }
}

export const directorMetricImportService = {
  // Load the employee roster used for matching (id, code, name only).
  async loadEmployees() {
    const { data, error } = await supabase
      .from('employees')
      .select('id, employee_code, full_name')
      .order('full_name')
    if (error) throw error
    return data || []
  },

  // Is this exact file already imported? Returns the prior batch or null.
  async findByHash(fileSha256) {
    if (!fileSha256) return null
    const { data, error } = await supabase
      .from('bankone_import_batches')
      .select('id, filename, uploaded_at, uploaded_by_name, file_sha256')
      .eq('file_sha256', fileSha256)
      .limit(1)
    if (error) throw error
    return data && data[0] ? data[0] : null
  },

  // Build the preview (upsert rows + counts) WITHOUT writing anything.
  preview(records, mapping, employees, defaultAsOf) {
    const resolver = makeEmployeeResolver(employees)
    const resolve = (row) => resolver(row, mapping)
    return buildImportRows(records, mapping, resolve, defaultAsOf)
  },

  // Commit the preview rows through the server RPC in one transaction.
  // confirmConflicts=false surfaces conflicts; true lets the newer value win.
  async commit(rows, batchId = null, confirmConflicts = false) {
    const { data, error } = await supabase.rpc('director_upsert_metric_values', {
      p_rows: rows,
      p_batch_id: batchId,
      p_confirm_conflicts: confirmConflicts,
    })
    if (error) throw error
    return data
  },

  // Record the batch (with its SHA-256) so re-upload is detected next time.
  async recordBatch({ filename, fileSha256, asOfDate, rowCount, operationType = 'hr_mpr' }) {
    const { data, error } = await supabase
      .from('bankone_import_batches')
      .insert({
        filename,
        operation_type: operationType,
        status: 'completed',
        as_at_date: asOfDate,
        reporting_period: asOfDate,
        file_sha256: fileSha256,
        total_rows: rowCount,
        imported_rows: rowCount,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  },

  sha256Hex,
}

export default directorMetricImportService
