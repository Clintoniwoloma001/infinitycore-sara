import { supabase } from '../supabaseClient'
import { parsePayrollWorkbook } from '../lib/payrollExcel'
import { getClientIp } from '../lib/clientIp'

// ------------------------------------------------------------------
// Payroll Excel import — the Phase 64/66 "structure takeover" adapter.
//
// The uploaded workbook (.xlsx / .xls / .csv) is parsed client-side into
// the adopted column structure; the server persists it as the active
// payroll schema (payroll_imports), snapshots each matched employee and
// records a PAYROLL_STRUCTURE_OVERRIDE audit trail row (unless the actor
// is super_admin). A second upload only supersedes the active import
// after an explicit override confirmation.
// ------------------------------------------------------------------

function rpc(name, params) {
  return supabase.rpc(name, params)
}

export const payrollImportService = {
  // Current adopted workbook structure (columns + rows + match key).
  async getActive() {
    const { data, error } = await rpc('get_active_payroll_import')
    if (error) throw error
    return data || null
  },

  // Parse an uploaded workbook (ArrayBuffer) into the structure payload.
  parse(buffer, filename) {
    return parsePayrollWorkbook(buffer, filename)
  },

  // Adopt the parsed structure as the platform payroll schema.
  // Returns { ok, id, columns, rows, matched_profiles, override_applied }
  // or { ok:false, code:'override_required' } when an active import must
  // first be explicitly superseded.
  async save({ filename, sourceFormat, periodLabel, currency, matchKey, columns, rows, confirmOverride = false }) {
    const ip = await getClientIp()
    const { data, error } = await rpc('save_payroll_import', {
      p_filename: filename,
      p_source_format: sourceFormat,
      p_period_label: periodLabel || null,
      p_currency: currency || 'NGN',
      p_match_key: matchKey || null,
      p_columns: columns || [],
      p_rows: rows || [],
      p_confirm_override: !!confirmOverride,
      p_ip_address: ip,
    })
    if (error) throw error
    return data
  },

  // Revert to the derived master (clears employee snapshots).
  async deactivate(importId, reason = '') {
    const { data, error } = await rpc('deactivate_payroll_import', {
      p_import_id: importId,
      p_reason: reason || null,
    })
    if (error) throw error
    return data
  },
}

export default payrollImportService