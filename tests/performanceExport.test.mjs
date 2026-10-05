/**
 * Export tests — proves the Excel workbook is a real, valid .xlsx that carries
 * the correct MPR numbers, and that the chart/table builders shape data safely.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  buildSummarySheet, buildGradeBandSheet, buildParBandSheet,
  buildChartData, buildMprWorkbookBuffer,
} from '../src/lib/performanceExport.js'

const SPEC_ROW = {
  staffName: 'Olamide Bankole',
  branch: 'Ikorodu',
  actualDisbursementValue: 928571,
  targetDisbursementValue: 1000000,
  passWatch: 140000,
  totalOutstandingPrincipal: 5000000,
  activeClientLoanCount: 90,
  targetCaseloadCount: 100,
}

// ---------------------------------------------------------------------------
// Summary sheet
// ---------------------------------------------------------------------------
test('summary sheet carries the spec worked example', () => {
  const { header, rows } = buildSummarySheet([SPEC_ROW])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]['Total Score'], 94.5)
  assert.equal(rows[0]['Grade Rating'], 'A - EXCELLENT')
  assert.equal(rows[0]['PAR %'], 2.8)
  assert.equal(rows[0]['Disbursement Score (35)'], 32.5)
  assert.equal(rows[0]['PAR Score (35)'], 35)
  assert.equal(rows[0]['Caseload Score (30)'], 27)
  assert.equal(rows[0].Status, 'Complete')
  assert.ok(header.includes('Grade Rating'))
})

test('a provisional row is LABELLED, never shown as a final grade', () => {
  const { rows } = buildSummarySheet([{ ...SPEC_ROW, activeClientLoanCount: null }])
  assert.equal(rows[0]['Total Score'], null)
  assert.equal(rows[0]['Grade Rating'], null)
  assert.match(rows[0].Status, /Provisional/)
  assert.match(rows[0].Status, /caseload/)
})

// ---------------------------------------------------------------------------
// Band sheets
// ---------------------------------------------------------------------------
test('grade band sheet mirrors the spec table', () => {
  const { rows } = buildGradeBandSheet()
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map((r) => r.Grade), ['A', 'B', 'C', 'D', 'E'])
  assert.equal(rows[0]['Hex Colour'], '#10B981')
  assert.equal(rows[4]['Description'], 'Bright Red')
})

test('PAR band sheet mirrors the spec table', () => {
  const { rows } = buildParBandSheet()
  assert.deepEqual(rows.map((r) => r['Points Awarded']), [35, 30, 20, 15, 7.5, 0])
  assert.equal(rows[0]['Status / Assessment'], 'Optimal Risk Control')
  assert.equal(rows[5]['PAR Range (%)'], '> 10.0%')
})

// ---------------------------------------------------------------------------
// Chart data
// ---------------------------------------------------------------------------
test('chart data EXCLUDES provisional rows and sorts by total descending', () => {
  const data = buildChartData([
    SPEC_ROW,
    { ...SPEC_ROW, staffName: 'Low', actualDisbursementValue: 571429, passWatch: 340000, activeClientLoanCount: 60 },
    { ...SPEC_ROW, staffName: 'Provisional', activeClientLoanCount: null },
  ])
  assert.equal(data.length, 2, 'provisional row must not be charted')
  assert.deepEqual(data.map((d) => d.name), ['Olamide Bankole', 'Low'])
  assert.equal(data[0].total, 94.5)
  assert.equal(data[1].total, 53)
})

// ---------------------------------------------------------------------------
// The workbook itself — a real xlsx, round-tripped
// ---------------------------------------------------------------------------
test('workbook is a valid .xlsx with all four sheets and the right numbers', () => {
  const { buffer, sheetNames, summary } = buildMprWorkbookBuffer([SPEC_ROW], { periodLabel: '2026-06' })
  assert.ok(buffer.length > 5000, `workbook looks empty (${buffer.length} bytes)`)

  // Round-trip: proves the file is a parseable workbook, not just a buffer.
  const wb = XLSX.read(buffer, { type: 'buffer' })
  assert.deepEqual(sheetNames, ['MPR Summary', 'Grade Bands', 'PAR Bands', 'Grade Distribution'])
  assert.deepEqual(wb.SheetNames, sheetNames)

  const back = XLSX.utils.sheet_to_json(wb.Sheets['MPR Summary'])
  assert.equal(back.length, 1)
  assert.equal(back[0]['Total Score'], 94.5)
  assert.equal(back[0]['Grade Rating'], 'A - EXCELLENT')

  const bands = XLSX.utils.sheet_to_json(wb.Sheets['PAR Bands'])
  assert.equal(bands.length, 6)
  assert.equal(bands[0]['Points Awarded'], 35)

  assert.equal(summary.headcount, 1)
  assert.equal(summary.average, 94.5)
})

test('workbook handles an empty staff list without throwing', () => {
  const { buffer, sheetNames, summary } = buildMprWorkbookBuffer([])
  assert.ok(buffer.length > 1000)
  assert.equal(sheetNames.length, 4)
  assert.equal(summary.headcount, 0)
  assert.equal(summary.average, null)
})