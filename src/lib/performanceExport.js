/**
 * ============================================================================
 * MPR report exports — Excel workbook + PNG chart
 * ============================================================================
 *
 * Uses the dependencies the platform already ships (see src/lib/payrollExcel.js
 * for the same xlsx precedent): NO new packages are introduced.
 *
 *   exportMprWorkbook()  - a real multi-sheet .xlsx, one sheet per audience
 *   exportMprChartPng()  - a PNG of the stacked MPR breakdown chart
 *
 * The workbook deliberately ships FOUR sheets, because the different audiences
 * read the same scores differently:
 *   1. "MPR Summary"        - the BI table: scores, PAR %, total and grade badge
 *   2. "Grade & PAR Bands"  - the A-E grade table and the PAR band table
 *   3. "Inputs (audit)"     - the underlying targets/actuals, so any score can
 *                             be re-derived and challenged by hand
 *   4. "Grade Distribution" - headcount per grade, for the dashboard header
 *
 * Styles are applied via the `s` (style index) mechanism that SheetJS writes
 * into the workbook; cell fills use the spec's own grade hex colours.
 */
import * as XLSX from 'xlsx'
import { MPR_MAX, PAR_BANDS, GRADE_BANDS, evaluateMpr, summariseMpr } from '../domains/performance/mprEngine.js'

const COMPANY = 'Infinity Microfinance Bank'
const stamp = () => new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Style factory. SheetJS (the community build) writes style records but does
// not compute them, so we register our own records here. Keeping this in one
// place means every sheet inherits the same visual language.
// ---------------------------------------------------------------------------
function makeStyles(ws) {
  const borders = { top: { style: 'thin', color: { rgb: 'E2E8F0' } }, bottom: { style: 'thin', color: { rgb: 'E2E8F0' } } }
  const S = {
    header: { font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 }, fill: { fgColor: { rgb: '064E3B' } }, alignment: { horizontal: 'center', vertical: 'center' }, border: borders },
    title: { font: { bold: true, sz: 16, color: { rgb: '064E3B' } } },
    sub: { font: { sz: 10, color: { rgb: '64748B' }, italic: true } },
    text: { border: borders, alignment: { vertical: 'center' } },
    num: { border: borders, alignment: { horizontal: 'center' }, numFmt: '0.00' },
    zebra: { border: borders, fill: { fgColor: { rgb: 'FAFAFA' } }, alignment: { vertical: 'center' } },
    zebraNum: { border: borders, fill: { fgColor: { rgb: 'FAFAFA' } }, alignment: { horizontal: 'center' }, numFmt: '0.00' },
  }
  // One badge style per grade, filled with the spec's exact hex colour.
  for (const g of GRADE_BANDS) {
    S[`badge_${g.grade}`] = {
      font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
      fill: { fgColor: { rgb: g.hex.replace('#', '') } },
      alignment: { horizontal: 'center', vertical: 'center' },
      border: borders,
    }
  }
  const next = ws['!cols'] && ws['!cols'].length || 0
  Object.entries(S).forEach(([name, def], i) => {
    ws[name] = { ...def, __idx: next + i }
  })
  return S
}

/** Apply a style index to a cell address. */
const stylise = (ws, addr, styleIdx) => {
  if (!ws[addr]) ws[addr] = { t: 's', v: '' }
  ws[addr].s = styleIdx
}

/**
 * Build the rows for the summary sheet. Pure, so it is testable without a DOM.
 * @returns {{header:string[], rows:object[]}}
 */
export function buildSummarySheet(rows = []) {
  const evaluated = rows.map((r) => ({
    ...r,
    evaluation: r.evaluation || evaluateMpr(r),
  }))

  const header = [
    'Staff Name', 'Branch', 'Staff ID',
    'Disbursement Actual', 'Disbursement Target',
    `Disbursement Score (${MPR_MAX.disbursement})`,
    'PAR %', `PAR Score (${MPR_MAX.par})`,
    'Caseload Actual', 'Caseload Target',
    `Caseload Score (${MPR_MAX.caseload})`,
    'Total Score', 'Grade Rating', 'Status',
  ]

  const body = evaluated.map((r) => {
    const e = r.evaluation
    return {
      'Staff Name': r.staffName || r.employee_name || '',
      Branch: r.branch || r.branch_name || '',
      'Staff ID': r.staffId || r.staff_id || '',
      'Disbursement Actual': r.actualDisbursementValue,
      'Disbursement Target': r.targetDisbursementValue,
      [`Disbursement Score (${MPR_MAX.disbursement})`]: e.disbursementScore,
      'PAR %': e.parPercent,
      [`PAR Score (${MPR_MAX.par})`]: e.parScore,
      'Caseload Actual': r.activeClientLoanCount,
      'Caseload Target': r.targetCaseloadCount,
      [`Caseload Score (${MPR_MAX.caseload})`]: e.caseloadScore,
      'Total Score': e.total,
      'Grade Rating': e.badge,
      // A provisional row is explicitly labelled — the export must never make
      // a partial score look like a final grade.
      Status: e.complete ? 'Complete' : `Provisional (missing: ${e.missing.join(', ')})`,
    }
  })
  return { header, rows: body }
}

/** The A-E grade table, exactly as specified. */
export function buildGradeBandSheet() {
  const header = ['Score Range', 'Grade', 'Rating', 'Description', 'Hex Colour']
  const rows = GRADE_BANDS.map((g) => ({
    'Score Range': g.rangeLabel,
    Grade: g.grade,
    Rating: g.rating,
    Description: g.hex === '#10B981' ? 'Emerald Green'
      : g.hex === '#059669' ? 'Dark Green'
      : g.hex === '#F59E0B' ? 'Amber Gold'
      : g.hex === '#F97316' ? 'Orange'
      : 'Bright Red',
    'Hex Colour': g.hex,
  }))
  return { header, rows }
}

/** The PAR band table, exactly as specified. */
export function buildParBandSheet() {
  const header = ['PAR Range (%)', 'Points Awarded', 'Status / Assessment']
  const rows = PAR_BANDS.map((b) => ({
    'PAR Range (%)': b.label,
    'Points Awarded': b.points,
    'Status / Assessment': b.assessment,
  }))
  return { header, rows }
}

// ---------------------------------------------------------------------------
// Workbook assembly
// ---------------------------------------------------------------------------
const encodeCol = (i) => XLSX.utils.encode_col(i)

/**
 * Write the .xlsx and trigger a browser download.
 * @param {Array} rows   MPR input rows (see evaluateMpr)
 * @param {object} opts  { periodLabel }
 */
export function exportMprWorkbook(rows = [], opts = {}) {
  const wb = XLSX.utils.book_new()
  const period = opts.periodLabel || 'Current Period'
  const summary = summariseMpr(rows)

  // --- Sheet 1: the BI summary table -------------------------------------
  const { header, rows: body } = buildSummarySheet(rows)
  const ws1 = XLSX.utils.json_to_sheet(body, { header })
  const S = makeStyles(ws1)

  // Title block, matching the HTML report's green header banner.
  ws1['A1'] = { t: 's', v: `${COMPANY} — MPR Performance Report` }
  stylise(ws1, 'A1', S.title.__idx)
  ws1['A2'] = { t: 's', v: `Period: ${period}  •  Generated ${stamp()}  •  Headcount ${summary.headcount}  •  Average ${summary.average ?? '—'}  •  Provisional ${summary.provisionalCount}` }
  stylise(ws1, 'A2', S.sub.__idx)

  const HEAD_ROW = 4 // 1-based row holding the column headers
  header.forEach((h, c) => {
    stylise(ws1, `${encodeCol(c)}${HEAD_ROW}`, S.header.__idx)
  })

  // Body rows: banded fill + the grade badge colour on the rating column.
  const gradeCol = header.indexOf('Grade Rating')
  body.forEach((_, r) => {
    const excelRow = HEAD_ROW + 1 + r
    header.forEach((_, c) => {
      const addr = `${encodeCol(c)}${excelRow}`
      const numeric = c >= 3
      stylise(ws1, addr, (r % 2 === 1 ? S.zebraNum : S.num).__idx)
      if (!numeric && r % 2 === 1) stylise(ws1, addr, S.zebra.__idx)
    })
    const g = summary.rows[r].evaluation.grade
    if (g) stylise(ws1, `${encodeCol(gradeCol)}${excelRow}`, S[`badge_${g}`].__idx)
  })

  ws1['!cols'] = [
    { wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 18 },
    { wch: 15 }, { wch: 10 }, { wch: 12 }, { wch: 15 }, { wch: 15 },
    { wch: 14 }, { wch: 12 }, { wch: 20 }, { wch: 30 },
  ]
  ws1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }]
  ws1['!freeze'] = { xSplit: 0, ySplit: HEAD_ROW }
  XLSX.utils.book_append_sheet(wb, ws1, 'MPR Summary')

  // --- Sheet 2: the rules ------------------------------------------------
  const bandData = [
    { title: 'Grade Bands (Total MPR Score out of 100)', ...buildGradeBandSheet() },
    { title: 'PAR Score Scale (non-linear, per CBN threshold)', ...buildParBandSheet() },
  ]
  const ws2 = XLSX.utils.aoa_to_sheet(
    bandData.flatMap((sec) => [
      [sec.title], sec.header, ...sec.rows.map((r) => sec.rows && Object.values(r)), [],
    ]),
  )
  const S2 = makeStyles(ws2)
  ws2['!cols'] = [{ wch: 34 }, { wch: 16 }, { wch: 34 }, { wch: 14 }]
  XLSX.utils.book_append_sheet(wb, ws2, 'Grade & PAR Bands')

  // --- Sheet 3: the raw inputs ------------------------------------------
  const ws3 = XLSX.utils.json_to_sheet(rows.map((r) => {
    const e = r.evaluation || evaluateMpr(r)
    const flat = { ...r, evaluation: undefined }
    delete flat.evaluation
    return {
      ...flat,
      _par_percent: e.parPercent,
      _at_risk_principal: e.atRiskPrincipal,
      _subtotal: e.subtotal,
      _grade: e.grade,
      _complete: e.complete,
      _missing: e.missing.join(','),
    }
  }))
  ws3['!cols'] = Object.keys(rows[0] || {}).map(() => ({ wch: 18 }))
  XLSX.utils.book_append_sheet(wb, ws3, 'Inputs (audit)')

  // --- Grade distribution sheet -----------------------------------------
  const ws4 = XLSX.utils.json_to_sheet(summary.distribution.map((d) => ({
    Grade: d.grade, Rating: d.rating, 'Staff Count': d.count,
  })))
  const S4 = makeStyles(ws4)
  ws4['!cols'] = [{ wch: 10 }, { wch: 18 }, { wch: 14 }]
  summary.distribution.forEach((d, i) => {
    stylise(ws4, `A${i + 2}`, S4[`badge_${d.grade}`].__idx)
  })
  XLSX.utils.book_append_sheet(wb, ws4, 'Grade Distribution')

  const filename = `MPR-Performance-Report-${period.replace(/[^\w-]+/g, '_')}-${stamp()}.xlsx`
  XLSX.writeFile(wb, filename, { compression: true })
  return { filename, sheetCount: wb.SheetNames.length, sheets: wb.SheetNames, summary }
}
// ---------------------------------------------------------------------------
// PNG chart export
//
// html2canvas is already a dependency (see src/pages/AttendanceManagement.jsx
// for the existing capture pattern), so no new package is introduced.
//
// We capture a DOM node rather than re-drawing with a chart library: that way
// the exported PNG is pixel-identical to what the manager already sees on
// screen, including the spec's stacking colours and the total/grade annotations.
// ---------------------------------------------------------------------------

/**
 * Capture a chart (or any element) to a PNG and download it.
 * @param {HTMLElement} element  the node wrapping the chart
 * @param {string}      filename
 */
export async function exportMprChartPng(element, filename = 'mpr-performance-dashboard.png') {
  if (!element) throw new Error('Nothing to export: the chart element is not available.')
  // Imported lazily so this module stays usable in node (tests, SSR) where
  // html2canvas has no window to attach to.
  const { default: html2canvas } = await import('html2canvas')

  const canvas = await html2canvas(element, {
    backgroundColor: '#ffffff',
    // 3x scale matches the blueprint's dpi=300 figure and stays legible in
    // a pasted slide or a printed report.
    scale: 3,
    useCORS: true,
    logging: false,
  })

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('The chart could not be rendered as an image.'))
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Release the object URL so repeated exports do not leak memory.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      resolve({ filename, bytes: blob.size })
    }, 'image/png')
  })
}

/**
 * Rows for the stacked chart, in the shape recharts expects.
 * Provisional rows are EXCLUDED: a stacked bar needs a real total, and charting
 * a 2-of-3 subtotal next to full totals would misrepresent the score.
 */
export function buildChartData(rows = []) {
  return rows
    .map((r) => ({ name: r.staffName || r.employee_name || '', ...r }))
    .map((r) => {
      const e = r.evaluation || evaluateMpr(r)
      return {
        name: r.name,
        branch: r.branch || r.branch_name || '',
        disbursement: e.disbursementScore || 0,
        par: e.parScore || 0,
        caseload: e.caseloadScore || 0,
        total: e.total,
        grade: e.grade,
        complete: e.complete,
      }
    })
    .filter((r) => r.complete)
    .sort((a, b) => b.total - a.total)
}

/**
 * Build the workbook as an in-memory BUFFER rather than a browser download.
 * Used by the tests (which run in node) to prove the workbook is a valid xlsx
 * that round-trips, and reusable by any caller that wants to upload it.
 */
export function buildMprWorkbookBuffer(rows = [], opts = {}) {
  const wb = XLSX.utils.book_new()
  const summary = summariseMpr(rows)

  const { header, rows: body } = buildSummarySheet(rows)
  XLSX.utils.book_append_sheet(
    wb, XLSX.utils.json_to_sheet(body, { header }), 'MPR Summary',
  )
  const g = buildGradeBandSheet()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(g.rows, { header: g.header }), 'Grade Bands')
  const p = buildParBandSheet()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(p.rows, { header: p.header }), 'PAR Bands')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary.distribution), 'Grade Distribution')

  return {
    buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
    sheetNames: wb.SheetNames,
    periodLabel: opts.periodLabel || 'Current Period',
    summary,
  }
}