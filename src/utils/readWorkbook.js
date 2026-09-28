// ============================================================================
// Read an uploaded BankOne workbook into a plain row matrix.
// ============================================================================
// Returns rows exactly as they appear, INCLUDING the title/banner rows above the
// header. The pipeline DETECTS the header row, so nothing is stripped here and
// the parser is never handed a fixed position.
//
// Uses the SheetJS reader already used by payrollExcel.js and
// leavePlannerExport.js, so .xlsx and .csv both work with NO new dependency and
// no hand-rolled zip/XML handling.
import * as XLSX from 'xlsx'

/**
 * @param file  a File/Blob from an <input type="file">
 * @returns     array of arrays (row 0 is the first row in the sheet)
 */
export async function readWorkbook(file) {
  if (!file) throw new Error('Choose a file first.')
  const name = (file.name || '').toLowerCase()
  if (!/\.(xlsx|xls|csv|txt)$/.test(name)) {
    throw new Error('Only .xlsx, .xls and .csv BankOne exports are supported.')
  }
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array' })
  const first = wb.SheetNames[0]
  if (!first) throw new Error('This workbook has no readable sheet.')
  // header: 1 -> array of arrays. raw: true keeps the underlying values;
  // defval/blankrows keep empty cells so COLUMN POSITIONS are preserved, which
  // is what makes header detection meaningful.
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets[first], {
    header: 1, raw: true, defval: '', blankrows: true,
  })
  return matrix.map((r) => (Array.isArray(r) ? r : []))
}

export default readWorkbook
