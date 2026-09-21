import * as XLSX from 'xlsx'

// ------------------------------------------------------------------
// Pure client-side Excel payroll workbook parsing.
//
// Reads the .xlsx / .xls / .csv workbook that HR uploads and turns it
// into the "adopted structure" payload the server persists via
// save_payroll_import:
//   columns: [{ key, label }]           header order preserved
//   rows:    [{ <key>: value, ... }]    one object per data row
//   match_key / source_format           staff identifier + file kind
//
// This module is intentionally side-effect free so it can be unit-tested
// in node without Supabase/env wiring.
// ------------------------------------------------------------------

// Header label → stable machine key (lowercased, punctuation removed).
export function slugifyHeader(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim() || `column_${Math.random().toString(36).slice(2, 7)}`
}

export function normalizeValue(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? null : t
  }
  return v
}

// Heuristic match-key detection for the staff identifier column.
// Returns the key of the most likely identifier column.
const MATCH_HINTS = [
  'staffid',
  'staffno',
  'staffno_',
  'staff_number',
  'employeeno',
  'employee_number',
  'employee_code',
  'employeecode',
  'staff_code',
  'staffcode',
  'staff_id',
  'employeeid',
  'employee_id',
  'empno',
  'emp_no',
  'id',
  'staff',
  'employee',
  'emp',
]

export function detectMatchKey(columns, rows = []) {
  if (!columns || !columns.length) return ''
  const lk = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

  let best = { key: columns[0].key, score: -1 }
  columns.forEach((c) => {
    const norm = lk(c.label)
    let score = 0
    MATCH_HINTS.forEach((hint, idx) => {
      if (norm === hint) score += 20 - idx
      else if (norm.includes(hint)) score += 2
      else if (hint.includes(norm)) score += 1
    })
    if (norm.includes('staff') || norm.includes('employee') || norm.startsWith('emp')) score += 3
    if (norm.includes('number') || norm.includes('code') || norm.includes('id')) score += 1
    if (score > best.score) best = { key: c.key, score }
  })
  return best.key
}

// Parse an uploaded workbook (ArrayBuffer) into the adopted structure.
export function parsePayrollWorkbook(buffer, filename = '') {
  if (!buffer) throw new Error('No file selected')
  const wb = XLSX.read(buffer, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('The workbook contains no sheets')
  const ws = wb.Sheets[sheetName]
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })
  if (!matrix || !matrix.length) throw new Error('The workbook contains no rows')

  const headerRow = matrix[0] || []
  const columns = headerRow.map((h, i) => {
    const label = normalizeValue(h)
    return { key: slugifyHeader(label == null ? `column_${i + 1}` : label), label: label == null ? `Column ${i + 1}` : label }
  })
  if (!columns.some((c) => c.key && c.key !== 'column_')) {
    const deduped = columns.map((c, i) => ({ key: `column_${i + 1}`, label: c.label }))
    return { columns: columns.map((c, i) => ({ ...c, key: deduped[i].key })), rows: [], matchKey: '', sourceFormat: sourceFormatFor(filename) }
  }

  const rows = matrix
    .slice(1)
    .filter((r) => Array.isArray(r) && r.some((cell) => normalizeValue(cell) !== null))
    .map((r) => {
      const obj = {}
      columns.forEach((c, i) => {
        obj[c.key] = normalizeValue(r[i])
      })
      return obj
    })

  const matchKey = detectMatchKey(columns, rows)
  return { columns, rows, matchKey, sourceFormat: sourceFormatFor(filename) }
}

export function sourceFormatFor(filename = '') {
  const ext = String(filename || '').toLowerCase().split('.').pop()
  if (ext === 'xls') return 'xls'
  if (ext === 'csv') return 'csv'
  return 'xlsx'
}

// Display helper for arbitrary imported cell values (numeric strings /
// real numbers render as money, anything else as-is).
export function displayImportedValue(v) {
  if (v === null || v === undefined || v === '') return '—'
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''))
  if (typeof v === 'number' || (typeof v === 'string' && /^[\d,.]+(\.\d+)?$/.test(String(v).trim()))) {
    return Number.isFinite(n) ? n : v
  }
  return v
}