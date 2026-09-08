import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Reconciliation Engine — exception detection, case management,
// reversal protection, and reporting.
// ------------------------------------------------------------------

export const RECON_STATUS_LABELS = {
  new: 'New',
  pending: 'Pending',
  failed: 'Failed',
  incomplete: 'Incomplete',
  under_review: 'Under Review',
  resolution_requested: 'Resolution Requested',
  resolved: 'Resolved',
  closed: 'Closed',
  reopened: 'Reopened',
  duplicate: 'Duplicate',
  reversal_detected: 'Reversal Detected',
  reversal_already_processed: 'Reversal Already Processed',
}

export const EXCEPTION_TYPES = {
  failed: 'Failed Transaction',
  pending: 'Pending Transaction',
  incomplete: 'Incomplete Transaction',
  reversed: 'Reversed Transaction',
  duplicate: 'Duplicate',
  reversal_detected: 'Reversal Detected',
  reversal_already_processed: 'Reversal Already Processed',
  unknown_staff: 'Unknown Staff',
  other: 'Other',
}

export const reconciliationService = {
  // ---- Auto-detect exceptions from imported transactions ----
  async detectExceptions(batchId, userId, userName) {
    const { data: rows } = await supabase
      .from('bankone_import_rows')
      .select('transaction_id, normalized_data, employee_id, employee_match_method')
      .eq('batch_id', batchId)
      .eq('status', 'imported')
      .not('transaction_id', 'is', null)

    const casesCreated = []

    for (const row of rows || []) {
      const nd = row.normalized_data || {}
      const status = (nd.transaction_status || '').toLowerCase()

      // Determine exception type
      let exceptionType = null
      if (status === 'failed') exceptionType = 'failed'
      else if (status === 'pending') exceptionType = 'pending'
      else if (status === 'incomplete') exceptionType = 'incomplete'
      else if (status === 'reversed' || nd.reversal_indicator) exceptionType = 'reversal_detected'
      else if (!row.employee_id && nd.staff_identifier) exceptionType = 'unknown_staff'

      if (!exceptionType) continue

      // Check if a case already exists for this transaction
      const { data: existing } = await supabase
        .from('reconciliation_cases')
        .select('id, status')
        .eq('transaction_id', row.transaction_id)
        .maybeSingle()

      if (existing) {
        // Update status history, do NOT create duplicate case
        if (existing.status !== 'closed') {
          await supabase.from('reconciliation_cases').update({
            current_status: status,
            updated_at: new Date().toISOString(),
          }).eq('id', existing.id)

          await supabase.from('reconciliation_case_events').insert({
            case_id: existing.id,
            event_type: 'status_changed',
            comment: `Transaction status updated to ${status} in import batch ${batchId}`,
            created_by: userId,
            created_by_name: userName,
          })
        }
        continue
      }

      // Create new case
      const { data: newCase, error } = await supabase
        .from('reconciliation_cases')
        .insert({
          transaction_id: row.transaction_id,
          transaction_reference: nd.transaction_reference,
          employee_id: row.employee_id || null,
          employee_name: nd.staff_identifier || null,
          branch: nd.branch || null,
          amount: nd.amount ? Number(String(nd.amount).replace(/[^0-9.-]/g, '')) : null,
          transaction_date: nd.transaction_date || null,
          transaction_type: nd.transaction_type || null,
          original_status: status,
          current_status: status,
          exception_type: exceptionType,
          detected_by: batchId,
          status: exceptionType === 'unknown_staff' ? 'new' : exceptionType === 'reversal_detected' ? 'reversal_detected' : 'new',
          created_by: userId,
        })
        .select()
        .single()

      if (!error && newCase) {
        casesCreated.push(newCase)
        await supabase.from('reconciliation_case_events').insert({
          case_id: newCase.id,
          event_type: 'created',
          comment: `Case auto-created from import batch. Exception: ${exceptionType}`,
          created_by: userId,
          created_by_name: userName,
        })
      }
    }

    await logAction({
      action: 'reconciliation_cases_detected',
      entityType: 'reconciliation',
      entityId: batchId,
      details: `${casesCreated.length} new reconciliation cases created`,
      userName,
    })

    return casesCreated
  },

  // ---- List cases with filters ----
  async listCases({ status, exceptionType, employeeId, branch, limit = 100 } = {}) {
    let query = supabase.from('reconciliation_cases').select('*').order('created_at', { ascending: false }).limit(limit)
    if (status) query = query.eq('status', status)
    if (exceptionType) query = query.eq('exception_type', exceptionType)
    if (employeeId) query = query.eq('employee_id', employeeId)
    if (branch) query = query.eq('branch', branch)
    const { data, error } = await query
    if (error) throw error
    return data || []
  },

  async getCase(caseId) {
    const { data, error } = await supabase
      .from('reconciliation_cases')
      .select('*')
      .eq('id', caseId)
      .single()
    if (error) throw error
    return data
  },

  async getCaseEvents(caseId) {
    const { data, error } = await supabase
      .from('reconciliation_case_events')
      .select('*')
      .eq('case_id', caseId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  // ---- Case actions ----
  async assignCase(caseId, assignedTo, assignedToName, userId, userName) {
    const { data, error } = await supabase
      .from('reconciliation_cases')
      .update({ assigned_to: assignedTo, assigned_to_name: assignedToName, status: 'under_review', updated_at: new Date().toISOString() })
      .eq('id', caseId)
      .select()
      .single()
    if (error) throw error

    await supabase.from('reconciliation_case_events').insert({
      case_id: caseId,
      event_type: 'assigned',
      comment: `Case assigned to ${assignedToName}`,
      created_by: userId,
      created_by_name: userName,
    })

    return data
  },

  async addComment(caseId, comment, userId, userName) {
    await supabase.from('reconciliation_case_events').insert({
      case_id: caseId,
      event_type: 'commented',
      comment,
      created_by: userId,
      created_by_name: userName,
    })
  },

  async requestResolution(caseId, notes, userId, userName) {
    const { data, error } = await supabase
      .from('reconciliation_cases')
      .update({ status: 'resolution_requested', resolution_notes: notes, updated_at: new Date().toISOString() })
      .eq('id', caseId)
      .select()
      .single()
    if (error) throw error

    await supabase.from('reconciliation_case_events').insert({
      case_id: caseId,
      event_type: 'resolution_requested',
      comment: notes,
      created_by: userId,
      created_by_name: userName,
    })

    return data
  },

  async submitResolution(caseId, resolutionNotes, userId, userName) {
    if (!resolutionNotes || !resolutionNotes.trim()) {
      throw new Error('Resolution notes are required before submitting.')
    }

    const { data, error } = await supabase
      .from('reconciliation_cases')
      .update({
        status: 'under_review',
        resolution_notes: resolutionNotes,
        resolution_submitted_by: userId,
        resolution_submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId)
      .select()
      .single()
    if (error) throw error

    await supabase.from('reconciliation_case_events').insert({
      case_id: caseId,
      event_type: 'resolution_submitted',
      comment: resolutionNotes,
      created_by: userId,
      created_by_name: userName,
    })

    return data
  },

  async closeCase(caseId, userId, userName) {
    const { data: caseData } = await supabase
      .from('reconciliation_cases')
      .select('resolution_notes, status')
      .eq('id', caseId)
      .single()

    if (!caseData?.resolution_notes?.trim()) {
      throw new Error('Cannot close a case without resolution notes.')
    }

    const { data, error } = await supabase
      .from('reconciliation_cases')
      .update({
        status: 'closed',
        closed_by: userId,
        closed_by_name: userName,
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId)
      .select()
      .single()
    if (error) throw error

    await supabase.from('reconciliation_case_events').insert({
      case_id: caseId,
      event_type: 'closed',
      comment: 'Case closed',
      created_by: userId,
      created_by_name: userName,
    })

    return data
  },

  async reopenCase(caseId, reason, userId, userName) {
    const { data, error } = await supabase
      .from('reconciliation_cases')
      .update({ status: 'reopened', updated_at: new Date().toISOString() })
      .eq('id', caseId)
      .select()
      .single()
    if (error) throw error

    await supabase.from('reconciliation_case_events').insert({
      case_id: caseId,
      event_type: 'reopened',
      comment: reason || 'Case reopened',
      created_by: userId,
      created_by_name: userName,
    })

    return data
  },

  // ---- Dashboard metrics ----
  async getDashboardMetrics({ branch, dateFrom, dateTo } = {}) {
    let query = supabase.from('reconciliation_cases').select('status, exception_type, amount, created_at, resolved_at')
    if (branch) query = query.eq('branch', branch)
    if (dateFrom) query = query.gte('created_at', dateFrom)
    if (dateTo) query = query.lte('created_at', dateTo)

    const { data, error } = await query
    if (error) throw error

    const cases = data || []
    const total = cases.length
    const byStatus = {}
    const byException = {}
    let unresolvedValue = 0
    let resolvedValue = 0
    let resolvedCount = 0

    cases.forEach((c) => {
      byStatus[c.status] = (byStatus[c.status] || 0) + 1
      byException[c.exception_type] = (byException[c.exception_type] || 0) + 1

      if (['resolved', 'closed'].includes(c.status)) {
        resolvedCount++
        resolvedValue += Number(c.amount) || 0
      } else {
        unresolvedValue += Number(c.amount) || 0
      }
    })

    return {
      total,
      byStatus,
      byException,
      resolvedCount,
      resolutionRate: total > 0 ? Math.round((resolvedCount / total) * 100) : 0,
      unresolvedValue,
      resolvedValue,
    }
  },
}

export default reconciliationService
