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
import { rpcWithRetry } from './rpcHelper'
import { runImport } from '../domains/bankone/importPipeline'

/** Rows are inserted in chunks; PostgREST caps a single statement. */
const CHUNK = 500

/**
 * Surface the REAL server reason. Never collapse a Supabase failure into a
 * generic message: the reported "TypeError: Load failed" hid a CHECK-constraint
 * violation that only the database could explain.
 * A Supabase error is shaped { message, code, details, hint }.
 */
function surface(err, context) {
  const raw = err?.message || String(err ?? '')
  // Postgres prefixes the message with the SQLSTATE; keep the human part.
  const detail = raw.split(/:(.+)/s).slice(1).join(':').trim() || raw
  const out = new Error(context ? `${context}: ${detail}` : detail)
  out.raw = raw
  out.code = err?.code || (raw.split(':')[0] || '').trim()
  out.hint = err?.hint || null
  out.details = err?.details || null
  // Correlation id for the server log. No secrets, no payload.
  out.correlationId = `${context || 'bankone'}:${out.code || 'unknown'}`
  if (typeof console !== 'undefined' && console.error) {
    console.error('[bankone-import]', out.correlationId, { message: detail, code: out.code })
  }
  return out
}

async function unwrap(promise, context) {
  const { data, error } = await promise
  if (error) throw surface(error, context)
  // ok:false is the RPC's own structured refusal (e.g. role gate).
  if (data && data.ok === false) {
    throw surface({ message: data.error || data.reason || 'The server refused that request.' }, context)
  }
  return data
}

/** Seed the durable review state for a freshly imported batch. */
const bankoneSeed = (batchId) =>
  unwrap(supabase.rpc('bankone_seed_resolutions', { p_batch_id: batchId }),
    'Could not prepare the review list')

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * FLOW aggregate for one import batch: principal disbursed, loans booked and
 * principal recovered on loans BOOKED inside [startDate, endDate] — summed on
 * the per-loan business date `disbursementDate` (plain string comparison of
 * ISO dates, the same rule get_director_executive_snapshot applies in SQL).
 *
 * PostgREST caps a single response at `max_rows` (1000), so the rows are read
 * in pages: a truncated sum would silently disagree with SQL.
 *
 * Returns null when the rows cannot be read (a viewer without read access, or
 * a database where the columns are absent) so the caller can fall back to the
 * snapshot figures instead of reporting a fake 0.
 */
async function sumDisbursementFlow(batchId, startDate, endDate) {
  const flow = { disbursed: 0, loanCount: 0, repaid: 0, byEmployee: {}, rowsRead: 0 }
  const PAGE = 1000
  const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0)
  try {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('bankone_import_rows')
        .select('officer_employee_id, loan:normalized_data->>loan_amount, booked_on:normalized_data->>disbursementDate, outstanding:normalized_data->>total_outstanding')
        .eq('batch_id', batchId)
        // Inclusive end date: start <= disbursementDate <= end.
        .gte('normalized_data->>disbursementDate', startDate)
        .lte('normalized_data->>disbursementDate', endDate)
        .order('row_number', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) return null
      for (const r of data || []) {
        const booked = String(r.booked_on || '')
        // Mirror the server guard: only a clean ISO date counts as booked.
        if (!ISO_DATE.test(booked) || booked < startDate || booked > endDate) continue
        const loan = num(r.loan)
        const outstanding = num(r.outstanding)
        flow.disbursed += loan
        flow.loanCount += 1
        flow.repaid += Math.max(loan - outstanding, 0)
        flow.rowsRead += 1
        const key = r.officer_employee_id || '_unattributed'
        flow.byEmployee[key] = Math.round(((flow.byEmployee[key] || 0) + loan) * 100) / 100
      }
      if (!data || data.length < PAGE) break
    }
  } catch {
    return null
  }
  flow.disbursed = Math.round(flow.disbursed * 100) / 100
  flow.repaid = Math.round(flow.repaid * 100) / 100
  return flow
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

    // Seed the persistent decision rows and the BankOne branch master NOW, so
    // the review screen has durable state from the first paint and a refresh
    // loses nothing. If this fails the rows are still imported, so it is
    // reported without discarding the batch.
    let seedWarning = null
    try {
      await bankoneSeed(batchId)
    } catch (seedErr) {
      seedWarning = seedErr?.message || 'The import was stored, but the review list could not be prepared.'
    }

    return { ...result, persisted: true, batchId, seedWarning }
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

  // --- §17-§21: server-owned import state -------------------------------
  // Everything the review screen renders comes from the database, so a browser
  // refresh resumes the import instead of losing it, and the summary can never
  // disagree with the resolution lists.

  /**
   * Seed the persistent decision rows + BankOne branch master for a new batch.
   * Called once, after createImport() has written the rows. Idempotent.
   */
  async seedResolutions(batchId) {
    return unwrap(supabase.rpc('bankone_seed_resolutions', { p_batch_id: batchId }), null)
  },

  /** The single source of truth for the review screen. */
  async getImportState(batchId) {
    return unwrap(supabase.rpc('bankone_get_import_state', { p_batch_id: batchId }), null)
  },

  /** Unfinished imports, so the page can offer "Resume import" after a refresh. */
  async listOpenImports(limit = 10) {
    return unwrap(supabase.rpc('bankone_get_open_imports', { p_limit: limit }), null)
  },

  /**
   * Whether this batch may be published, and the exact blockers. Returns DATA
   * rather than raising, so the UI can show the real reason and persist
   * 'blocked' (a publish failure rolls back any status write).
   */
  async validatePublish(batchId) {
    return unwrap(supabase.rpc('bankone_validate_publish', { p_batch_id: batchId }), null)
  },

  /** Mark a batch blocked with a human-readable reason. Never deletes it. */
  async markBlocked(batchId, reason) {
    return unwrap(supabase.rpc('bankone_mark_publication_blocked', {
      p_batch_id: batchId,
      p_reason: reason,
    }), null)
  },

  /** Publish into the branch/officer snapshot tables. Throws the real reason. */
  async publish(batchId) {
    return rpcWithRetry(() => supabase.rpc('bankone_publish_snapshot', { p_batch_id: batchId }))
  },

  /**
   * Portfolio slice for a period filter (Performance page).
   *
   * Semantics — deliberately the same two rules the executive snapshot RPC
   * documents, so the UI and SQL always agree:
   *   * SNAPSHOT metrics (outstanding, PAR %) are POINT-IN-TIME: the latest
   *     published PAR snapshot on or before the range END date. Snapshots are
   *     never summed across a range.
   *   * FLOW metrics (disbursed, loans booked) are SUMMED over the range using
   *     the per-loan business date `disbursementDate`, scoped to that same
   *     snapshot's batch so a cumulative PAR report is never double counted.
   *
   * Optional enrichment: every part degrades instead of throwing (pre-migration
   * database, or a viewer without read access → empty parts + `error`).
   *
   * @param opts { startDate?: 'YYYY-MM-DD', endDate?: 'YYYY-MM-DD' }
   * @returns { snapshot, departments, flow, latestAvailable, error }
   */
  async getPortfolioForRange({ startDate, endDate } = {}) {
    const out = { snapshot: null, departments: [], flow: null, latestAvailable: null, error: null }

    let snapQuery = supabase
      .from('bankone_portfolio_snapshots')
      .select('id, batch_id, report_type, as_at_date, published_at, total_outstanding, par_ratio, total_disbursed, total_repaid, loan_count')
      .eq('status', 'published')
    // Inclusive end: `as_at_date <= range end` (plain date strings, no tz maths).
    if (endDate) snapQuery = snapQuery.lte('as_at_date', endDate)
    const [{ data: snaps, error: snapErr }, latest] = await Promise.all([
      snapQuery
        .order('as_at_date', { ascending: false })
        .order('published_at', { ascending: false })
        .limit(20),
      supabase
        .from('bankone_portfolio_snapshots')
        .select('as_at_date')
        .eq('status', 'published')
        .order('as_at_date', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    out.latestAvailable = latest?.data?.as_at_date || null
    if (snapErr) { out.error = snapErr.message || 'Could not read portfolio snapshots.'; return out }

    // Department rows only exist for published PAR snapshots, so prefer PAR
    // and walk backwards until one actually has rows — a newer disbursement
    // snapshot must never hide the department data.
    const ordered = [...(snaps || [])].sort(
      (a, b) => (a.report_type === 'par' ? 0 : 1) - (b.report_type === 'par' ? 0 : 1)
    )
    let fallback = ordered[0] || null
    for (const snap of ordered) {
      const { data, error } = await supabase
        .from('bankone_department_snapshots')
        .select('*')
        .eq('snapshot_id', snap.id)
        .order('total_outstanding', { ascending: false })
      if (error) { out.error = error.message || 'Could not read department snapshots.'; return out }
      if (data && data.length) { out.snapshot = snap; out.departments = data; break }
    }
    if (!out.snapshot) out.snapshot = fallback

    if (out.snapshot?.batch_id && startDate && endDate) {
      out.flow = await sumDisbursementFlow(out.snapshot.batch_id, startDate, endDate)
    }
    return out
  },

  /**
   * Department rows only (kept for callers that do not need the period
   * semantics — Director Intelligence renders them as portfolio context).
   */
  async listLatestDepartmentSnapshots(opts) {
    const slice = await this.getPortfolioForRange(opts || {})
    return slice.departments || []
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
    }), `Could not save the officer mapping for "${sourceName}"`)
  },

  /** Explicitly leave an officer unresolved. Their portfolio stays unattributed. */
  async leaveOfficerUnresolved({ normalizedSourceName, sourceName, reason }) {
    return unwrap(supabase.rpc('mark_bankone_officer_unresolved', {
      p_normalized_source_name: normalizedSourceName,
      p_bankone_source_name: sourceName,
      p_reason: reason ?? null,
    }), `Could not leave "${sourceName}" unresolved`)
  },

  /** §12 Create a PENDING employee from BankOne facts only. No invented data. */
  async addEmployeeFromBankOne({ sourceName, normalizedSourceName, branchNameRaw, importId, branchId }) {
    return unwrap(supabase.rpc('add_employee_from_bankone', {
      p_bankone_source_name: sourceName,
      p_normalized_source_name: normalizedSourceName,
      p_branch_name_raw: branchNameRaw ?? null,
      p_source_import_id: importId ?? null,
      p_branch_id: branchId ?? null,
    }), `Could not add "${sourceName}" as an employee`)
  },

  /**
   * Map a BankOne branch to an existing InfinityCore branch.
   * Returns { rows_affected } so the caller can refuse to claim success when the
   * mapping changed nothing - the exact failure that made Accept look broken.
   */
  async confirmBranch({ normalizedBranchName, bankoneBranchName, canonicalBranchId, mappingType, splitFromBranchId, reason }) {
    return unwrap(supabase.rpc('confirm_bankone_branch_mapping', {
      p_normalized_bankone_branch_name: normalizedBranchName,
      p_bankone_branch_name: bankoneBranchName,
      p_canonical_branch_id: canonicalBranchId,
      p_mapping_type: mappingType || 'manual',
      p_split_from_branch_id: splitFromBranchId ?? null,
      p_reason: reason ?? null,
    }), `Could not save the branch mapping for "${bankoneBranchName}"`)
  },

  /**
   * §15 Split a combined branch.
   *
   * CONTRACT — the argument names below MUST match the deployed PostgreSQL
   * signature exactly, because PostgREST matches RPC calls on argument NAME:
   *
   *   split_bankone_branch(
   *     p_parent_branch_id uuid,
   *     p_new_branch_names text[],
   *     p_source_import_id uuid default null,
   *     p_reason           text default null)
   *
   * Sending anything else (p_source_importId, _reason, positional args) produces
   * "Could not find the function ... in the schema cache", which reads like a
   * server outage but is actually a client/contract mismatch.
   */
  async splitBranch({ parentBranchId, newBranchNames, importId, reason }) {
    return unwrap(supabase.rpc('split_bankone_branch', {
      p_parent_branch_id: parentBranchId,
      p_new_branch_names: newBranchNames,
      p_source_import_id: importId ?? null,
      p_reason: reason ?? null,
    }), 'Could not split the branch')
  },

  /**
   * Read the DEPLOYED signature of split_bankone_branch.
   *
   * The "in the schema cache" error is opaque because PostgREST echoes the keys
   * the CALLER sent rather than what the database actually has. When a split
   * fails, this tells us what IS deployed, so the message can name the real
   * difference (missing migration, stale build, or an ambiguous overload)
   * instead of guessing. Safe to call on any database: if the function is
   * absent it reports exists = false rather than throwing.
   */
  async getSplitBranchSignature() {
    const { data, error } = await supabase.rpc('bankone_split_branch_signature')
    if (error) {
      // The probe itself is missing => migrations are behind. Say so plainly.
      const err = surface(error, 'Could not read the split-branch contract')
      err.contractMissing = true
      throw err
    }
    return data
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
