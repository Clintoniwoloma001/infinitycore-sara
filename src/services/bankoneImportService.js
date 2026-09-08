import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { parseCSV } from './importService'

// ------------------------------------------------------------------
// BankOne Import Engine
//
// Flow: UPLOAD → VALIDATE → PREVIEW → MAP → NORMALIZE → DEDUP → CONFIRM → STORE
//
// Never directly modifies existing records. Preserves raw data.
// Deduplication by (source_system + transaction_reference) with
// deterministic fingerprint fallback.
// ------------------------------------------------------------------

// All InfinityCore target fields for BankOne transaction data
export const BANKONE_TARGET_FIELDS = [
  'transaction_reference',
  'transaction_date',
  'transaction_time',
  'staff_identifier',
  'branch',
  'transaction_type',
  'transaction_status',
  'amount',
  'channel',
  'product_service',
  'reversal_indicator',
  'original_transaction_reference',
  'customer_account_ref',
]

// Valid transaction statuses
const VALID_STATUSES = [
  'completed', 'failed', 'pending', 'reversed', 'incomplete',
  'successful', 'cancelled', 'declined',
]

// Normalize a status string to a canonical value
function normalizeStatus(raw) {
  if (!raw) return null
  const s = String(raw).toLowerCase().trim()
  if (['completed', 'successful', 'success', 'done'].includes(s)) return 'completed'
  if (['failed', 'fail', 'declined', 'rejected'].includes(s)) return 'failed'
  if (['pending', 'in progress', 'processing'].includes(s)) return 'pending'
  if (['reversed', 'reversal', 'reversed/cancelled'].includes(s)) return 'reversed'
  if (['incomplete', 'partial'].includes(s)) return 'incomplete'
  if (['cancelled', 'canceled'].includes(s)) return 'cancelled'
  return s
}

// Normalize a name for matching (case-insensitive, collapse spaces)
function normalizeName(name) {
  if (!name) return null
  return String(name).toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '')
}

// Deterministic fingerprint for rows without a usable transaction reference
// Uses: staff_identifier + amount + transaction_date + transaction_type
export function computeFingerprint(record) {
  const parts = [
    normalizeName(record.staff_identifier) || '',
    String(record.amount || '').replace(/[^0-9.]/g, ''),
    String(record.transaction_date || '').trim(),
    String(record.transaction_type || '').toLowerCase().trim(),
  ]
  return parts.join('|')
}

// Parse an uploaded file (CSV only for now; XLSX would need a library)
export async function parseFile(file) {
  const text = await file.text()
  const ext = file.name.toLowerCase().split('.').pop()

  if (ext === 'json') {
    const parsed = JSON.parse(text)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    if (arr.length === 0) throw new Error('The JSON file contains no records.')
    const headers = Array.from(new Set(arr.flatMap((o) => Object.keys(o))))
    return {
      headers,
      rows: arr.map((o) => {
        const clean = {}
        headers.forEach((h) => { clean[h] = o[h] === null || o[h] === undefined ? '' : String(o[h]).trim() })
        return clean
      }),
    }
  }

  // CSV
  const rows = parseCSV(text)
  if (rows.length < 2) throw new Error('CSV must contain a header row and at least one data row.')
  const headers = rows[0].map((h) => String(h).trim())
  const dataRows = rows.slice(1)
  return {
    headers,
    rows: dataRows.map((cells) => {
      const obj = {}
      headers.forEach((h, i) => { if (h) obj[h] = cells[i] ? String(cells[i]).trim() : '' })
      return obj
    }),
  }
}

// Apply column mapping: { sourceColumn: targetField }
export function applyColumnMapping(row, mapping) {
  const mapped = {}
  const additional = {}
  Object.entries(mapping || {}).forEach(([src, tgt]) => {
    if (!tgt) return
    const val = row[src]
    if (val !== undefined && val !== '') mapped[tgt] = val
  })
  // Preserve unmapped source fields in additional_fields
  Object.entries(row).forEach(([key, val]) => {
    if (!mapping || !(key in mapping) || !mapping[key]) {
      if (val) additional[key] = val
    }
  })
  return { mapped, additional }
}

// Validate a single normalized row
export function validateRow(mapped) {
  const errors = []
  const warnings = []

  // Transaction reference is strongly preferred but not strictly required
  if (!mapped.transaction_reference) {
    warnings.push('No transaction reference — deduplication will use fingerprint matching only.')
  }

  // Amount validation
  if (mapped.amount) {
    const num = Number(String(mapped.amount).replace(/[^0-9.-]/g, ''))
    if (Number.isNaN(num)) errors.push('Amount is not a valid number.')
  }

  // Date validation
  if (mapped.transaction_date) {
    const d = new Date(mapped.transaction_date)
    if (Number.isNaN(d.getTime())) errors.push('Transaction date is not a valid date.')
  }

  // Status validation
  if (mapped.transaction_status) {
    const normalized = normalizeStatus(mapped.transaction_status)
    if (!VALID_STATUSES.includes(normalized)) {
      warnings.push(`Unknown status "${mapped.transaction_status}" — will be stored as-is.`)
    }
  }

  // Staff identification
  if (!mapped.staff_identifier) {
    warnings.push('No staff identifier — transaction will enter unmatched queue.')
  }

  return {
    errors,
    warnings,
    hasErrors: errors.length > 0,
    hasWarnings: warnings.length > 0,
  }
}

// Match a staff_identifier to an InfinityCore employee
// Priority: employee_id → staff_code → bankone_officer_id → email → normalized_name → manual
export async function matchEmployee(staffIdentifier, employeeList, bankoneIdentifiers) {
  if (!staffIdentifier) return { employee_id: null, match_method: null }

  const normalized = normalizeName(staffIdentifier)

  // 1. Check bankone identifiers (employee_id, staff_code, bankone_officer_id, email)
  for (const id of bankoneIdentifiers) {
    if (id.identifier_type === 'manual' && !id.is_verified) continue
    const idNorm = id.identifier_type === 'normalized_name'
      ? id.identifier_value
      : normalizeName(id.identifier_value)
    if (idNorm === normalized || id.identifier_value === staffIdentifier) {
      return { employee_id: id.employee_id, match_method: id.identifier_type }
    }
  }

  // 2. Try matching against employee list
  for (const emp of employeeList) {
    // Employee code
    if (emp.employee_code && emp.employee_code === staffIdentifier) {
      return { employee_id: emp.id, match_method: 'staff_code' }
    }
    // Email
    if (emp.email && emp.email.toLowerCase() === staffIdentifier.toLowerCase()) {
      return { employee_id: emp.id, match_method: 'email' }
    }
    // Normalized name
    if (normalized && normalizeName(emp.full_name) === normalized) {
      return { employee_id: emp.id, match_method: 'name' }
    }
  }

  return { employee_id: null, match_method: null }
}

// Check for duplicate transaction by reference or fingerprint
export async function checkDuplicate(mapped, fingerprint) {
  // 1. Check by transaction reference (primary identity)
  if (mapped.transaction_reference) {
    const { data } = await supabase
      .from('bankone_transactions')
      .select('id, transaction_status')
      .eq('transaction_reference', mapped.transaction_reference)
      .maybeSingle()
    if (data) {
      return { isDuplicate: true, matchType: 'reference', existingId: data.id, existingStatus: data.transaction_status }
    }
  }

  // 2. Check by fingerprint (fallback)
  if (fingerprint) {
    const { data } = await supabase
      .from('bankone_transactions')
      .select('id, transaction_status')
      .eq('dedup_fingerprint', fingerprint)
      .maybeSingle()
    if (data) {
      return { isDuplicate: true, matchType: 'fingerprint', existingId: data.id, existingStatus: data.transaction_status }
    }
  }

  return { isDuplicate: false, matchType: null, existingId: null }
}

// The main import service
export const bankoneImportService = {
  // ---- Column Mappings ----
  async listMappings() {
    const { data, error } = await supabase
      .from('bankone_column_mappings')
      .select('*')
      .eq('is_active', true)
      .order('is_default', { ascending: false })
    if (error) throw error
    return data || []
  },

  async getDefaultMapping() {
    const { data, error } = await supabase
      .from('bankone_column_mappings')
      .select('*')
      .eq('is_default', true)
      .maybeSingle()
    if (error || !data) {
      // Fallback to hardcoded default
      const { data: any } = await supabase
        .from('bankone_column_mappings')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
      return any?.[0] || null
    }
    return data
  },

  async saveMapping(name, description, mapping, isDefault = false) {
    if (isDefault) {
      await supabase.from('bankone_column_mappings').update({ is_default: false }).neq('id', '00000000-0000-0000-0000-000000000000')
    }
    const { data, error } = await supabase
      .from('bankone_column_mappings')
      .insert({ name, description, mapping, is_default: isDefault, is_active: true })
      .select()
      .single()
    if (error) throw error
    return data
  },

  // ---- Import Batches ----
  async createBatch({ filename, sourceFormat, reportingPeriod, mappingConfig, uploadedByName, uploadedById }) {
    const { data, error } = await supabase
      .from('bankone_import_batches')
      .insert({
        filename,
        source_format: sourceFormat || 'csv',
        reporting_period: reportingPeriod || null,
        mapping_config: mappingConfig,
        uploaded_by_name: uploadedByName,
        uploaded_by: uploadedById,
        status: 'validating',
      })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async updateBatch(batchId, patch) {
    const { data, error } = await supabase
      .from('bankone_import_batches')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', batchId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async listBatches(limit = 50) {
    const { data, error } = await supabase
      .from('bankone_import_batches')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  async getBatch(batchId) {
    const { data, error } = await supabase
      .from('bankone_import_batches')
      .select('*')
      .eq('id', batchId)
      .single()
    if (error) throw error
    return data
  },

  async listBatchRows(batchId) {
    const { data, error } = await supabase
      .from('bankone_import_rows')
      .select('*')
      .eq('batch_id', batchId)
      .order('row_number', { ascending: true })
    if (error) throw error
    return data || []
  },

  // ---- Process & Validate ----
  // Processes parsed rows: validates, checks duplicates, matches staff
  // Returns a summary + per-row results (does NOT commit to DB yet)
  async processRows(batchId, parsedData, mapping) {
    // Fetch employees and bankone identifiers for staff matching
    const { data: employees } = await supabase
      .from('employees')
      .select('id, full_name, email, employee_code, department, position, employment_status')
      .eq('employment_status', 'active')
    const { data: identifiers } = await supabase
      .from('employee_bankone_identifiers')
      .select('*')

    const results = []
    let valid = 0, errors = 0, duplicates = 0, unmatched = 0

    for (let i = 0; i < parsedData.rows.length; i++) {
      const row = parsedData.rows[i]
      const { mapped, additional } = applyColumnMapping(row, mapping)
      const validation = validateRow(mapped)
      const fingerprint = computeFingerprint(mapped)

      let status = 'valid'
      const validationErrors = []

      if (validation.hasErrors) {
        status = 'error'
        errors++
        validation.errors.forEach((msg) => validationErrors.push({ message: msg, severity: 'ERROR' }))
        results.push({
          row_number: i + 2,
          raw_data: row,
          normalized_data: mapped,
          status,
          validation_errors: validationErrors,
          match_type: null,
          employee_id: null,
          employee_match_method: null,
        })
        continue
      }

      // Check for duplicates
      const dupCheck = await checkDuplicate(mapped, fingerprint)
      if (dupCheck.isDuplicate) {
        status = 'duplicate'
        duplicates++
        results.push({
          row_number: i + 2,
          raw_data: row,
          normalized_data: mapped,
          status,
          validation_errors: [{ message: `Duplicate detected via ${dupCheck.matchType} matching`, severity: 'WARNING' }],
          match_type: dupCheck.matchType,
          matched_transaction_id: dupCheck.existingId,
          employee_id: null,
          employee_match_method: null,
        })
        continue
      }

      // Match employee
      const empMatch = await matchEmployee(mapped.staff_identifier, employees || [], identifiers || [])
      if (mapped.staff_identifier && !empMatch.employee_id) {
        status = 'unmatched_staff'
        unmatched++
        validation.warnings.forEach((msg) => validationErrors.push({ message: msg, severity: 'WARNING' }))
        validationErrors.push({ message: 'Staff could not be matched to an employee', severity: 'WARNING' })
      } else {
        valid++
        validation.warnings.forEach((msg) => validationErrors.push({ message: msg, severity: 'WARNING' }))
      }

      results.push({
        row_number: i + 2,
        raw_data: row,
        normalized_data: { ...mapped, additional_fields: additional },
        status,
        validation_errors: validationErrors,
        match_type: null,
        employee_id: empMatch.employee_id,
        employee_match_method: empMatch.match_method,
        dedup_fingerprint: fingerprint,
      })
    }

    return { results, summary: { total: results.length, valid, errors, duplicates, unmatched } }
  },

  // ---- Stage Rows (save validated rows to DB for preview) ----
  async stageRows(batchId, results) {
    const rows = results.map((r) => ({
      batch_id: batchId,
      row_number: r.row_number,
      raw_data: r.raw_data,
      normalized_data: r.normalized_data,
      status: r.status,
      validation_errors: r.validation_errors,
      match_type: r.match_type || null,
      matched_transaction_id: r.matched_transaction_id || null,
      employee_id: r.employee_id || null,
      employee_match_method: r.employee_match_method || null,
    }))

    // Insert in chunks to avoid payload limits
    const CHUNK = 200
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from('bankone_import_rows').insert(rows.slice(i, i + CHUNK))
      if (error) throw error
    }

    // Update batch with summary
    const summary = {
      total_rows: results.length,
      valid_rows: results.filter((r) => r.status === 'valid').length,
      rejected_rows: results.filter((r) => r.status === 'error').length,
      duplicate_rows: results.filter((r) => r.status === 'duplicate').length,
      unmatched_staff_rows: results.filter((r) => r.status === 'unmatched_staff').length,
    }

    await this.updateBatch(batchId, { ...summary, status: 'preview' })
    return summary
  },

  // ---- Confirm Import (commit valid rows to bankone_transactions) ----
  async confirmImport(batchId, userId, userName) {
    const { data: rows, error } = await supabase
      .from('bankone_import_rows')
      .select('*')
      .eq('batch_id', batchId)
      .in('status', ['valid', 'unmatched_staff'])
    if (error) throw error

    await this.updateBatch(batchId, { status: 'importing' })

    let imported = 0
    const CHUNK = 100

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      const transactions = chunk.map((r) => {
        const nd = r.normalized_data || {}
        return {
          source_system: 'bankone',
          transaction_reference: nd.transaction_reference || null,
          transaction_date: nd.transaction_date || null,
          transaction_time: nd.transaction_time || null,
          staff_identifier: nd.staff_identifier || null,
          employee_id: r.employee_id || null,
          employee_match_method: r.employee_match_method || null,
          branch: nd.branch || null,
          transaction_type: nd.transaction_type || null,
          transaction_status: nd.transaction_status || null,
          amount: nd.amount ? Number(String(nd.amount).replace(/[^0-9.-]/g, '')) : null,
          channel: nd.channel || null,
          product_service: nd.product_service || null,
          reversal_indicator: nd.reversal_indicator || null,
          original_transaction_reference: nd.original_transaction_reference || null,
          customer_account_ref: nd.customer_account_ref || null,
          additional_fields: nd.additional_fields || {},
          dedup_fingerprint: r.dedup_fingerprint || computeFingerprint(nd),
          first_imported_batch_id: batchId,
        }
      })

      const { data: inserted, error: insertError } = await supabase
        .from('bankone_transactions')
        .insert(transactions)
        .select('id, transaction_reference')

      if (insertError) {
        // Some may have failed due to unique constraint (race condition)
        // Insert one by one for the failed chunk
        for (const txn of transactions) {
          const { data: one, error: oneErr } = await supabase
            .from('bankone_transactions')
            .insert(txn)
            .select('id')
            .maybeSingle()
          if (!oneErr && one) imported++
        }
        continue
      }

      imported += (inserted || []).length

      // Update import rows with transaction IDs
      const rowUpdates = chunk.map((r, idx) => ({
        id: r.id,
        transaction_id: inserted?.[idx]?.id || null,
        status: 'imported',
      })).filter((u) => u.transaction_id)

      if (rowUpdates.length > 0) {
        await supabase.from('bankone_import_rows')
          .upsert(rowUpdates, { onConflict: 'id' })
      }
    }

    // Check for reversals and create reconciliation cases
    await this.detectReversals(batchId, userId, userName)

    // Update batch
    await this.updateBatch(batchId, {
      status: 'completed',
      imported_rows: imported,
    })

    await logAction({
      action: 'bankone_import_confirmed',
      entityType: 'bankone_import_batch',
      entityId: batchId,
      details: `Imported ${imported} transactions from batch ${batchId}`,
      userName,
    })

    return { imported, total: rows.length }
  },

  // ---- Reversal Detection ----
  async detectReversals(batchId, userId, userName) {
    const { data: rows } = await supabase
      .from('bankone_import_rows')
      .select('transaction_id, normalized_data')
      .eq('batch_id', batchId)
      .eq('status', 'imported')
      .not('transaction_id', 'is', null)

    for (const row of rows || []) {
      const nd = row.normalized_data || {}
      // If this transaction has an original_transaction_reference, it's a reversal
      if (nd.original_transaction_reference) {
        const { data: original } = await supabase
          .from('bankone_transactions')
          .select('id')
          .eq('transaction_reference', nd.original_transaction_reference)
          .maybeSingle()

        if (original) {
          // Create relationship
          await supabase.from('transaction_relationships').upsert({
            parent_transaction_id: original.id,
            child_transaction_id: row.transaction_id,
            relationship_type: 'reversal',
          }, { onConflict: 'parent_transaction_id,child_transaction_id' })

          // Update or create reconciliation case for the original
          const { data: existingCase } = await supabase
            .from('reconciliation_cases')
            .select('id, status')
            .eq('transaction_id', original.id)
            .maybeSingle()

          if (existingCase) {
            // Update existing case — do NOT create a duplicate
            await supabase.from('reconciliation_cases').update({
              status: 'reversal_detected',
              related_reversal_ref: nd.transaction_reference,
              updated_at: new Date().toISOString(),
            }).eq('id', existingCase.id)

            await supabase.from('reconciliation_case_events').insert({
              case_id: existingCase.id,
              event_type: 'status_changed',
              comment: `Reversal detected: ${nd.transaction_reference} linked to original ${nd.original_transaction_reference}`,
              created_by: userId,
              created_by_name: userName,
            })
          }
        }
      }
    }
  },

  // ---- Cancel ----
  async cancelBatch(batchId) {
    return this.updateBatch(batchId, { status: 'cancelled' })
  },
}

export default bankoneImportService
