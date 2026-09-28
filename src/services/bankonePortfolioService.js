// ============================================================================
// BankOne Portfolio persistence service
// ============================================================================
// Persists the result of the pure import pipeline (src/domains/bankone) and
// exposes the review/resolve actions. Every consequential write goes through a
// role-gated, audited RPC; this module never writes a mapping table directly,
// because RLS deliberately grants no write policy on those tables.
//
// An import is an immutable SNAPSHOT. Nothing here overwrites a previous one.
import { supabase } from '../supabaseClient'
import { runImport } from '../domains/bankone/importPipeline'

/** Rows are inserted in chunks; PostgREST caps a single statement. */
const CHUNK = 500

async function unwrap(promise) {
  const { data, error } = await promise
  if (error) throw new Error(error.message || 'The server rejected that request.')
  if (data && data.ok === false) throw new Error(data.error || 'That request could not be completed.')
  return data
}

export const bankonePortfolioService = {
  /**
   * Parse + resolve + persist one dated snapshot.
   * @param matrix  raw sheet rows (header NOT yet located)
   * @param opts    { sourceType, asAtDate, filename, uploadedBy, uploadedByName }
   */
  async createImport({ matrix, sourceType, asAtDate, filename, uploadedBy, uploadedByName }) {
    const [{ data: employees }, { data: branches }, { data: empMaps }, { data: brMaps }] = await Promise.all([
      supabase.from('employees').select('id, full_name'),
      supabase.from('branches').select('id, branch_name'),
      supabase.from('bankone_employee_mappings')
        .select('normalized_source_name, employee_id, status, match_type').eq('status', 'active'),
      supabase.from('bankone_branch_mappings')
        .select('normalized_bankone_branch_name, canonical_branch_id, status').eq('status', 'active'),
    ])

    const result = runImport({
      rows: matrix,
      sourceType,
      asAtDate,
      employees: employees || [],
      branches: branches || [],
      savedEmployeeMappings: new Map((empMaps || []).map((m) => [m.normalized_source_name, m])),
      savedBranchMappings: new Map((brMaps || []).map((m) => [m.normalized_bankone_branch_name, m])),
    })

    // No header / missing required column / no as-at date: STOP. Nothing is
    // written, so a misaligned file can never become a snapshot.
    if (!result.ok) return { ...result, persisted: false }
    if (result.records.length === 0) {
      return { ...result, persisted: false, error: 'No usable rows were found in this file.' }
    }

    const s = result.summary
    const { data: batch, error: batchError } = await supabase
      .from('bankone_import_batches')
      .insert({
        filename: filename || `${sourceType}-${asAtDate}.xlsx`,
        source_format: 'xlsx',
        source_type: sourceType,
        // 'par' | 'disbursement' - the report type, not a vague "portfolio".
        // Both are admitted by bankone_import_batches_operation_type_check.
        operation_type: sourceType === 'disbursement' ? 'disbursement' : 'par',
        status: 'pending_review',
        as_at_date: asAtDate,
        reporting_period: asAtDate,
        source_row_count: s.sourceRowCount,
        total_rows: s.sourceRowCount,
        parsed_row_count: s.parsedRowCount,
        imported_rows: s.parsedRowCount,
        valid_rows: s.parsedRowCount,
        rejected_rows: s.invalidRows,
        branch_count: s.branchCount,
        employee_match_count: s.matchedAutomatically,
        unresolved_count: s.needsReview + s.unmatchedEmployees,
        branch_issue_count: s.branchIssues + s.mergedStructures,
        validation_status: 'passed',
        validation_errors: result.invalidRows.slice(0, 50),
        mapping_version: 1,
        calculation_version: 1,
        uploaded_by: uploadedBy,
        uploaded_by_name: uploadedByName,
        uploaded_at: new Date().toISOString(),
      })
      .select()
      .single()
    if (batchError) throw batchError
    const batchId = batch.id

    const payload = result.records.map((r) => {
      const autoOfficer = r.officer?.status === 'auto_resolved'
      const autoBranch = r.branch?.status === 'auto_resolved'
      return {
        batch_id: batchId,
        row_number: r.rowNumber,
        account_no: r.accountNo,
        as_at_date: asAtDate,
        branch_name_raw: r.branchNameRaw || null,
        officer_name_raw: r.officerNameRaw || null,
        officer_employee_id: autoOfficer ? r.officer.employeeId : null,
        resolved_branch_id: autoBranch ? r.branch.branchId : null,
        match_status: autoOfficer ? 'auto_resolved'
          : (r.officer?.status === 'pending_review' ? 'pending_review' : 'unresolved'),
        match_type: r.officer?.matchType ?? null,
        match_confidence: r.officer?.confidence ?? null,
        raw_data: r.raw,
        normalized_data: {
          loan_amount: r.loanAmount,
          total_outstanding: r.totalOutstanding,
          status: r.status,
          days_overdue: r.daysOverdue,
          non_performing: r.nonPerforming,
          ...r.dates,
        },
        employee_id: autoOfficer ? r.officer.employeeId : null,
        employee_match_method: r.officer?.matchType ?? null,
      }
    })
    for (let i = 0; i < payload.length; i += CHUNK) {
      const { error } = await supabase.from('bankone_import_rows').insert(payload.slice(i, i + CHUNK))
      if (error) throw error
    }

    // Unresolved officers are RETAINED so the unresolved portfolio stays
    // reportable. They are never dropped and never guessed at.
    if (result.unresolvedOfficers.length) {
      const { error } = await supabase.from('bankone_unresolved_officers').insert(
        result.unresolvedOfficers.map((u) => ({
          batch_id: batchId,
          as_at_date: asAtDate,
          bankone_source_name: u.sourceName,
          normalized_source_name: u.normalizedSourceName,
          branch_name_raw: u.branchNames[0] ?? null,
          loan_count: u.loanCount,
          outstanding_total: u.outstandingTotal,
          first_seen_import_id: batchId,
          status: 'unresolved',
        }))
      )
      if (error) throw error
    }

    await supabase.from('audit_logs').insert({
      action: 'BANKONE_IMPORT_CREATED',
      entity_type: 'bankone_import_batch',
      entity_id: batchId,
      user_name: uploadedByName,
      details: JSON.stringify({
        source_type: sourceType, as_at_date: asAtDate, filename,
        source_rows: s.sourceRowCount, parsed: s.parsedRowCount,
        auto_matched: s.matchedAutomatically, needs_review: s.needsReview,
        unmatched: s.unmatchedEmployees, branch_issues: s.branchIssues,
        invalid_rows: s.invalidRows,
      }),
      severity: 'info',
    })

    return { ...result, persisted: true, batchId }
  },

  /** Re-open a snapshot for review. */
  async getImport(batchId) {
    const { data, error } = await supabase
      .from('bankone_import_batches').select('*').eq('id', batchId).single()
    if (error) throw error
    return data
  },

  async listImports(limit = 50) {
    const { data, error } = await supabase
      .from('bankone_import_batches')
      .select('*')
      .in('source_type', ['par', 'disbursement'])
      .order('as_at_date', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  /** Officers still awaiting a decision, largest exposure first. */
  async listUnresolvedOfficers(batchId) {
    const { data, error } = await supabase
      .from('bankone_unresolved_officers')
      .select('*').eq('batch_id', batchId).eq('status', 'unresolved')
      .order('outstanding_total', { ascending: false })
    if (error) throw error
    return data || []
  },

  /** Approve or reject a snapshot. Rejecting never deletes it. */
  async setImportStatus(batchId, status, reason) {
    const { data: { user } } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('bankone_import_batches')
      .update({ status, confirmed_by: user?.id ?? null, confirmed_at: new Date().toISOString() })
      .eq('id', batchId).select().single()
    if (error) throw error
    await supabase.from('audit_logs').insert({
      action: status === 'approved' ? 'BANKONE_IMPORT_APPROVED' : 'BANKONE_IMPORT_REJECTED',
      entity_type: 'bankone_import_batch',
      entity_id: batchId,
      details: JSON.stringify({ status, reason }),
      severity: status === 'approved' ? 'info' : 'warning',
    })
    return data
  },

  // --- §9/§19 resolution actions (all audited, all role-gated) ------------

  /** Confirm which employee a BankOne officer name refers to. */
  async confirmOfficer({ normalizedSourceName, sourceName, employeeId, matchType, confidence, reason }) {
    return unwrap(supabase.rpc('confirm_bankone_employee_mapping', {
      p_normalized_source_name: normalizedSourceName,
      p_bankone_source_name: sourceName,
      p_employee_id: employeeId,
      p_match_type: matchType || 'manual',
      p_confidence: confidence ?? 1,
      p_reason: reason ?? null,
    }))
  },

  /** Explicitly leave an officer unresolved. Their portfolio stays unattributed. */
  async leaveOfficerUnresolved({ normalizedSourceName, sourceName, reason }) {
    return unwrap(supabase.rpc('mark_bankone_officer_unresolved', {
      p_normalized_source_name: normalizedSourceName,
      p_bankone_source_name: sourceName,
      p_reason: reason ?? null,
    }))
  },

  /** §12 Create a PENDING employee from BankOne facts only. No invented data. */
  async addEmployeeFromBankOne({ sourceName, normalizedSourceName, branchNameRaw, importId, branchId }) {
    return unwrap(supabase.rpc('add_employee_from_bankone', {
      p_bankone_source_name: sourceName,
      p_normalized_source_name: normalizedSourceName,
      p_branch_name_raw: branchNameRaw ?? null,
      p_source_import_id: importId ?? null,
      p_branch_id: branchId ?? null,
    }))
  },

  /** Map a BankOne branch to an existing InfinityCore branch. */
  async confirmBranch({ normalizedBranchName, bankoneBranchName, canonicalBranchId, mappingType, splitFromBranchId, reason }) {
    return unwrap(supabase.rpc('confirm_bankone_branch_mapping', {
      p_normalized_bankone_branch_name: normalizedBranchName,
      p_bankone_branch_name: bankoneBranchName,
      p_canonical_branch_id: canonicalBranchId,
      p_mapping_type: mappingType || 'manual',
      p_split_from_branch_id: splitFromBranchId ?? null,
      p_reason: reason ?? null,
    }))
  },

  /**
   * §15 Split a combined branch. The parent is DEACTIVATED, never deleted, and
   * every historical record keeps its original branch_id.
   */
  async splitBranch({ parentBranchId, newBranchNames, importId, reason }) {
    return unwrap(supabase.rpc('split_bankone_branch', {
      p_parent_branch_id: parentBranchId,
      p_new_branch_names: newBranchNames,
      p_source_import_id: importId ?? null,
      p_reason: reason ?? null,
    }))
  },

  /** Saved mappings, so the UI can show what will resolve automatically. */
  async listEmployeeMappings() {
    const { data, error } = await supabase
      .from('bankone_employee_mappings')
      .select('*, employee:employee_id(id, full_name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async listBranchMappings() {
    const { data, error } = await supabase
      .from('bankone_branch_mappings')
      .select('*, branch:canonical_branch_id(id, branch_name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },
}

export default bankonePortfolioService
