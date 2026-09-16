// Tiny, dependency-free CSV / Excel-export helpers used by payroll and
// BankOne exports. No third-party spreadsheet library is installed, so the
// "Excel" export is an HTML table served as .xls — Excel/LibreOffice/Sheets
// all open it natively and it round-trips to CSV cleanly.

function cell(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv(rows, columns) {
  const head = columns.map((c) => cell(c.label ?? c.key)).join(',')
  const body = rows.map((r) => columns.map((c) => cell(c.value ? c.value(r) : r[c.key])).join(','))
  return [head, ...body].join('\n')
}

export function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function downloadCsv(filename, rows, columns) {
  downloadBlob(filename, `\uFEFF${toCsv(rows, columns)}`, 'text/csv;charset=utf-8')
}

export function downloadExcel(filename, rows, columns) {
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const th = columns.map((c) => `<th>${esc(c.label ?? c.key)}</th>`).join('')
  const tr = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${esc(c.value ? c.value(r) : r[c.key])}</td>`).join('')}</tr>`)
    .join('')
  const html = `<html><head><meta charset="utf-8" /></head><body><table border="1"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></body></html>`
  downloadBlob(filename, html, 'application/vnd.ms-excel;charset=utf-8')
}
