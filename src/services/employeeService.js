import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Employee profiles — core record plus the phase-6 child tables
// (education, work history, guarantors, fidelity bonds).
//
// Phase 12: Two new RPC-backed update paths:
//   - updateHrFields:      HR/Admin field-protected update via RPC
//   - updatePersonalInfo:  Self-service personal info via RPC
// ------------------------------------------------------------------

const CHILD_TABLES = ['employee_education', 'employee_work_history', 'employee_guarantors', 'employee_fidelity_bonds']

// PostgREST returns code PGRST202 when an RPC is missing from its schema
// cache (common right after a migration is applied). Retry once, then rethrow
// with `code = 'PGRST202'` so callers can surface a migrated-first message.
async function rpcWithRetry(fn) {
  const isMissing = (err) => {
    const msg = (err?.message || '').toLowerCase()
    return msg.includes('pgrst202') || msg.includes('schema cache') || msg.includes('could not find the function')
  }
  try {
    const out = await fn()
    if (out?.error && isMissing(out.error)) {
      const retried = await fn()
      if (retried?.error) throw renamed(retried.error)
      return retried
    }
    if (out?.error) throw out.error
    return out
  } catch (err) {
    if (isMissing(err)) {
      const retried = await fn()
      if (retried?.error && isMissing(retried.error)) throw renamed(retried.error)
      if (retried?.error) throw retried.error
      return retried
    }
    throw err
  }
}

function renamed(err) {
  const e = new Error(err?.message || 'Database function unavailable')
  e.code = 'PGRST202'
  return e
}

export const employeeService = {
  async list() {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .order('full_name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async getById(id) {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  // Server-side fuzzy match across every employee identity field. Used
  // by SARA to resolve a spoken/typed name or ID to a single employee
  // before asking for termination confirmation.
  async search(keyword) {
    const needle = String(keyword || '').trim()
    if (!needle) return []
    const { data, error } = await supabase
      .from('employees')
      .select('id, full_name, employee_code, employee_number, staff_id, department, position, branch, employment_status, hire_date, is_archived, created_at')
      .or(
        `full_name.ilike.%${needle}%,employee_code.ilike.%${needle}%,employee_number.ilike.%${needle}%,staff_id.ilike.%${needle}%`
      )
      .limit(10)
    if (error) throw error
    return data || []
  },
  async update(employeeId, payload) {
    const { data, error } = await supabase
      .from('employees')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', employeeId)
      .select()
      .single()
    if (error) throw error
    logAction({ action: 'EMPLOYEE_UPDATED', entityType: 'Employee', entityId: employeeId, details: 'Employee profile updated' })
    return data
  },

  // Phase 12: HR/Admin field-protected update via server-side RPC.
  // Only allows HR-controlled fields; rejects anything else. Retries once on a
  // stale PostgREST schema cache, then surfaces an actionable message.
  async updateHrFields(employeeId, fields) {
    try {
      return await rpcWithRetry(() =>
        supabase.rpc('update_employee_hr_fields', {
          p_employee_id: employeeId,
          p_fields: fields,
        })
      )
    } catch (err) {
      if (err?.code === 'PGRST202') {
        throw new Error(
          'The HR fields update function is not available in the database yet. ' +
          'Please run the phase14 migration (`schema_phase14_hr_documents_fixes.sql`) in Supabase, then retry.'
        )
      }
      throw err
    }
  },

  // ------------------------------------------------------------------
  // STRICT TERMINATION / ARCHIVE AUTHORIZATION (Phase 37).
  //
  // Termination and archive are employee-lifecycle operations reserved
  // for `super_admin` and `hr_manager` users. The authorization check
  // is enforced SERVER-SIDE by the SECURITY DEFINER RPCs and the
  // employees_termination_guard trigger — this client call never
  // supplies an actor/role; the backend derives the actor from the
  // authenticated session and rejects anything else.
  // ------------------------------------------------------------------

  // Permanent employment-status change to 'terminated' via the audited
  // terminate_employee RPC. Never deletes the record or its history.
  async terminate(employeeId, opts = {}) {
    const { data, error } = await supabase.rpc('terminate_employee', {
      p_employee_id: employeeId,
      p_effective_date: opts.effectiveDate || new Date().toISOString().slice(0, 10),
      p_reason: opts.reason || '',
      p_hr_notes: opts.notes || null,
      p_rehire_eligible: opts.rehireEligible ?? true,
      p_source: opts.source || 'ui',
    })
    if (error) throw error
    return data
  },

  // Delete (decommission) an employee end-to-end. Restricted to
  // super_admin/hr_manager on the server. The delete_employee RPC:
  //   - re-verifies the actor role (super_admin / hr_manager),
  //   - refuses to delete a Super Admin account or the actor's own record,
  //   - archives the employee (history preserved — never a physical delete),
  //   - cancels open payroll rows and drops the employee from the roster,
  //   - deactivates the linked platform login (suspended, reversible).
  async deleteEmployee(employeeId, reason = '') {
    try {
      return await rpcWithRetry(() =>
        supabase.rpc('delete_employee', {
          p_employee_id: employeeId,
          p_reason: reason || 'Deleted via employee action menu',
        })
      )
    } catch (err) {
      if (err?.code === 'PGRST202') {
        throw new Error(
          'The employee delete function is not available in the database yet. ' +
          'Please run the phase39 migration (`schema_phase39_employee_delete_authorization.sql`) in Supabase, then retry.'
        )
      }
      throw new Error(err?.message || 'Unable to delete employee')
    }
  },

  async archive(employeeId, reason = '', restore = false) {
    const { data, error } = await supabase.rpc('archive_employee', {
      p_employee_id: employeeId,
      p_reason: reason || '',
      p_restore: restore,
    })
    if (error) throw error
    return data
  },

  // Phase 12: Self-service personal info update via server-side RPC.
  // Only allows personal contact fields; cannot change employment data.
  async updatePersonalInfo(fields) {
    const { data, error } = await supabase.rpc('update_profile_personal', {
      p_fields: fields,
    })
    if (error) throw error
    return data
  },

  // Phase 13: Assign a permanent Employee Number / Staff ID (IMFB/<n>).
  // Idempotent — returns the existing number if already assigned.
  async ensureEmployeeNumber(employeeId) {
    try {
      const data = await rpcWithRetry(() =>
        supabase.rpc('generate_employee_number', { p_employee_id: employeeId })
      )
      return data
    } catch (err) {
      if (err?.code === 'PGRST202') {
        throw new Error(
          'Staff ID assignment is not available in the database yet. ' +
          'Please run the phase14 migration (`schema_phase14_hr_documents_fixes.sql`) in Supabase, then retry.'
        )
      }
      throw err
    }
  },

  async childTable(name) {
    if (!CHILD_TABLES.includes(name)) throw new Error(`Unknown child table ${name}`)
    const { data, error } = await supabase.from(name).select('*').order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async addChild(table, employeeId, payload) {
    const { data, error } = await supabase
      .from(table)
      .insert({ ...payload, employee_id: employeeId, source: 'manual' })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async removeChild(table, id) {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) throw error
  },

  async listChildrenForEmployee(employeeId) {
    const result = {}
    for (const t of CHILD_TABLES) {
      const { data, error } = await supabase
        .from(t)
        .select('*')
        .eq('employee_id', employeeId)
        .order('created_at', { ascending: false })
      if (!error) result[t] = data || []
      else result[t] = []
    }
    return result
  },
}

export default employeeService