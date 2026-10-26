import React, { useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, BarChart3, Building2, CalendarDays, Clock3, GraduationCap, Loader2, Map, Users, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { trainingService } from '../services/trainingService'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import ExcelJS from 'exceljs'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5'
const today = new Date().toISOString().slice(0, 10)
const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)

export default function ManHourIntelligence() {
  const [filters, setFilters] = useState({ startDate: monthStart, endDate: today, area: '', branchId: '', department: '', employeeId: '' })
  const [options, setOptions] = useState({ areas: [], branches: [], departments: [], employees: [] })
  const [data, setData] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true); setError('')
    try {
      const [filterOptions, snapshot] = await Promise.all([trainingService.getFilterOptions(), trainingService.getManHourIntelligence(filters)])
      setOptions(filterOptions); setData(snapshot)
    } catch (e) {
      setError(e?.message || 'Man-hour intelligence could not be loaded. Run the Phase 51 migration first if this is a new environment.')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const exportPdf = () => {
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' })
    const W = doc.internal.pageSize.getWidth()
    // Header with logo
    try { doc.addImage(LOGO_DATA_URL, 'PNG', 14, 8, 22, 22) } catch (e) {}
    doc.setFontSize(18)
    doc.setTextColor(13, 110, 253)
    doc.text('Man-Hour Intelligence Report', 40, 16)
    doc.setFontSize(9)
    doc.setTextColor(100, 100, 100)
    doc.text(`Generated on: ${genStamp}`, 40, 22)
    doc.text(`Report period: ${filters.startDate} to ${filters.endDate}`, 40, 27)

    const summary = data?.summary || {}
    const kpis = [
      ['Scheduled hours', Number(summary.scheduled_hours || 0).toFixed(2)],
      ['Actual attendance hours', Number(summary.actual_attendance_hours || 0).toFixed(2)],
      ['Overtime hours', Number(summary.overtime_hours || 0).toFixed(2)],
      ['Absence hours', Number(summary.absence_hours || 0).toFixed(2)],
      ['Attendance Compliance', `${summary.attendance_compliance || 0}%`],
      ['Working days in period', summary.working_days || 0],
      ['Total Employees', data?.by_employee?.length || 0],
      ['Employees with no attendance record', (data?.by_employee || []).filter((r) => !r.actual_hours).length],
    ]
    // KPI box
    let y = 34
    doc.setFillColor(248, 250, 252)
    doc.rect(14, y, W - 28, 8, 'F')
    doc.setFontSize(11); doc.setTextColor(13, 110, 253)
    doc.text('Executive Summary KPIs', 16, y + 5.5)
    y += 10
    autoTable(doc, {
      startY: y,
      head: [['Metric', 'Value']],
      body: kpis,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [13, 110, 253], textColor: [255, 255, 255] },
      columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 40, halign: 'right' } },
    })
    y = doc.lastAutoTable.finalY + 8

    // Charts (simple bar charts drawn with rectangles)
    const drawBarChart = (title, rows, labelKey, valueKey, x, yy, w, h) => {
      doc.setFontSize(10); doc.setTextColor(13, 110, 253)
      doc.text(title, x, yy)
      const max = Math.max(...rows.map((r) => Number(r[valueKey] || 0)), 1)
      const barW = w / Math.max(rows.length, 1) - 2
      let cx = x
      rows.slice(0, 10).forEach((r) => {
        const val = Number(r[valueKey] || 0)
        const bh = (val / max) * (h - 6)
        doc.setFillColor(13, 110, 253)
        doc.rect(cx, yy + 4 + (h - 6 - bh), barW, bh, 'F')
        doc.setFontSize(6); doc.setTextColor(80, 80, 80)
        doc.text(String(r[labelKey] || '').slice(0, 10), cx, yy + h + 2, { angle: 45 })
        cx += barW + 2
      })
    }
    const areaRows = data?.by_area || []
    const deptRows = data?.by_department || []
    const branchRows = (data?.by_branch || []).slice(0, 10)
    drawBarChart('Hours by Area', areaRows, 'area', 'actual_hours', 14, y, 80, 30)
    drawBarChart('Hours by Department', deptRows, 'department', 'actual_hours', 110, y, 80, 30)
    drawBarChart('Hours by Branch (Top 10)', branchRows, 'branch_name', 'actual_hours', 206, y, 80, 30)
    y += 46

    // Detailed table on new page
    doc.addPage()
    doc.setFontSize(14); doc.setTextColor(13, 110, 253)
    doc.text('Detailed Data Table', 14, 16)
    // repeated header
    autoTable(doc, {
      startY: 22,
      head: [['Employee','Area','Branch','Department','Scheduled','Actual','Present Days','Absent Days','Late Days','Attendance %','Training Hrs','KSS Hrs','Training MH','Overtime','Absence Hrs']],
      body: (data?.by_employee || []).map((r) => [
        r.full_name, r.area || 'Unassigned', r.branch_name || 'Unassigned', r.department || 'Unassigned',
        Number(r.scheduled_hours||0).toFixed(2), Number(r.actual_hours||0).toFixed(2),
        r.days_present || 0, r.days_absent || 0, r.days_late || 0,
        r.scheduled_hours ? ((Number(r.actual_hours||0)/Number(r.scheduled_hours))*100).toFixed(1)+'%' : '0%', Number(r.training_hours||0).toFixed(2),
        Number(r.kss_hours||0).toFixed(2), Number(r.training_man_hours||0).toFixed(2),
        Number(r.overtime_hours||0).toFixed(2), Number(r.absence_hours||0).toFixed(2),
      ]),
      styles: { fontSize: 7 },
      headStyles: { fillColor: [13, 110, 253], textColor: [255, 255, 255] },
      didDrawPage: (d) => {
        // footer
        const str = `Page ${d.pageNumber} of ${doc.internal.getNumberOfPages()}  |  Infinity Microfinance Bank - Confidential`
        doc.setFontSize(8); doc.setTextColor(150, 150, 150)
        doc.text(str, 14, doc.internal.pageSize.getHeight() - 6)
      },
    })
    doc.save('man-hour-intelligence.pdf')
  }

  const exportExcel = async () => {
    const wb = new ExcelJS.Workbook()
    const summary = data?.summary || {}
    const green = '0D6EFD'
    const dark = '1E293B'

    // ---- Summary sheet ----
    const ws2 = wb.addWorksheet('Summary')
    ws2.columns = [{ width: 34 }, { width: 22 }]
    const titleRow = ws2.addRow(['Man-Hour Intelligence Report'])
    titleRow.font = { bold: true, size: 14, color: { argb: green } }
    ws2.addRow([`Generated on: ${genStamp}`])
    ws2.addRow([`Report period: ${filters.startDate} to ${filters.endDate}`])
    ws2.addRow([])
    const audit = [
      ['Report period start', filters.startDate],
      ['Report period end', filters.endDate],
      ['Working days in period', summary.working_days || 0],
      ['Daily work hours', 8.5],
      ['Daily break hours', 1],
      ['Holidays excluded', 0],
      ['Unassigned area rows', (data?.by_area || []).filter((r) => !r.area || r.area === 'Unassigned').length],
      ['Unassigned branch rows', (data?.by_branch || []).filter((r) => !r.branch_name || r.branch_name === 'Unassigned').length],
      ['Name missing rows', (data?.by_employee || []).filter((r) => !r.full_name || r.full_name === 'Name missing').length],
      ['Generation date', new Date().toISOString().slice(0, 10)],
    ]
    audit.forEach((r) => ws2.addRow(r))
    ws2.addRow([])
    const kpiHeader = ws2.addRow(['Metric', 'Value'])
    kpiHeader.font = { bold: true, color: { argb: 'FFFFFF' } }
    kpiHeader.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dark } }; c.border = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} } })
    const kpis = [
      ['Total Employees', data?.by_employee?.length || 0],
      ['Scheduled hours', Number(summary.scheduled_hours || 0)],
      ['Actual attendance hours', Number(summary.actual_attendance_hours || 0)],
      ['Overtime', Number(summary.overtime_hours || 0)],
      ['Absence hours', Number(summary.absence_hours || 0)],
      ['Attendance Compliance', summary.attendance_compliance || 0],
      ['Employees with no attendance record', (data?.by_employee || []).filter((r) => !r.actual_hours).length],
    ]
    kpis.forEach((r) => {
      const row = ws2.addRow(r)
      if (r[0] === 'Attendance Compliance') row.getCell(2).numFmt = '0.0%'
    })
    ws2.addRow([])
    const areaHeader = ws2.addRow(['By Area'])
    areaHeader.font = { bold: true, color: { argb: green } }
    const ah = ws2.addRow(['Area','Employees','Working Days','Days Present','Days Absent','Scheduled Hours','Actual Hours','Attendance %'])
    ah.font = { bold: true, color: { argb: 'FFFFFF' } }
    ah.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dark } } })
    ;(data?.by_area || []).forEach((r) => {
      const row = ws2.addRow([r.area || 'Unassigned', r.employees || 0, '', r.days_present || 0, r.days_absent || 0, Number(r.scheduled_hours||0), Number(r.actual_hours||0), r.scheduled_hours ? Number(r.actual_hours||0)/Number(r.scheduled_hours) : 0])
      row.getCell(8).numFmt = '0.0%'
    })
    ws2.addRow([])
    const bh = ws2.addRow(['By Branch'])
    bh.font = { bold: true, color: { argb: green } }
    const bbh = ws2.addRow(['Branch','Employees','Working Days','Days Present','Days Absent','Scheduled Hours','Actual Hours','Attendance %'])
    bbh.font = { bold: true, color: { argb: 'FFFFFF' } }
    bbh.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dark } } })
    ;(data?.by_branch || []).forEach((r) => {
      const row = ws2.addRow([r.branch_name || 'Unassigned', r.employees || 0, '', r.days_present || 0, r.days_absent || 0, Number(r.scheduled_hours||0), Number(r.actual_hours||0), r.scheduled_hours ? Number(r.actual_hours||0)/Number(r.scheduled_hours) : 0])
      row.getCell(8).numFmt = '0.0%'
    })

    // ---- Details sheet ----
    const ws1 = wb.addWorksheet('Details')
    const cols = ['Employee','Area','Branch','Department','Period Working Days','Days Present','Days On Leave','Days Absent','Days Late','Scheduled Hours','Actual Hours','Overtime Hours','Absence Hours','Attendance %','Status','Training Hours','KSS Hours','Training Man-Hours']
    ws1.columns = cols.map((c) => ({ header: c, key: c, width: 16 }))
    // title row
    ws1.insertRow(1, ['Man-Hour Intelligence Details'])
    ws1.getRow(1).font = { bold: true, size: 14, color: { argb: green } }
    // header row is row 2 now? json_to_sheet puts headers at row 1; shift
    const headerRow = ws1.getRow(2)
    // Re-add header manually at row 2
    cols.forEach((c, i) => {
      const cell = ws1.getCell(2, i + 1)
      cell.value = c
      cell.font = { bold: true, color: { argb: 'FFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dark } }
      cell.border = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} }
    })
    let r = 3
    ;(data?.by_employee || []).forEach((row) => {
      const vals = [
        row.full_name, row.area || 'Unassigned', row.branch_name || 'Unassigned', row.department || 'Unassigned',
        row.period_working_days || 0, row.days_present || 0, row.days_on_leave || 0, row.days_absent || 0, row.days_late || 0,
        Number(row.scheduled_hours || 0), Number(row.actual_hours || 0), Number(row.overtime_hours || 0),
        Number(row.absence_hours || 0), row.scheduled_hours ? Number(row.actual_hours||0)/Number(row.scheduled_hours) : 0,
        row.status || 'OK', Number(row.training_hours || 0), Number(row.kss_hours || 0), Number(row.training_man_hours || 0),
      ]
      const rr = ws1.getRow(r)
      vals.forEach((v, i) => {
        const cell = rr.getCell(i + 1)
        cell.value = v
        cell.border = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} }
        if (i >= 9 && i <= 12) cell.numFmt = '#,##0.00'
        if (i === 13) cell.numFmt = '0.0%'
      })
      // zebra
      if (r % 2 === 0) rr.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F8FAFC' } } })
      r++
    })
    // freeze panes
    ws1.views = [{ state: 'frozen', ySplit: 2 }]
    // autoFilter
    ws1.autoFilter = { from: 'A2', to: `R${r - 1}` }

    const buf = await wb.xlsx.writeBuffer()
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'man-hour-intelligence.xlsx'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }


  const change = (key, value) => setFilters((current) => ({ ...current, [key]: value }))
  const openEmployee = async (row) => {
    setDetailLoading(true); setError('')
    try { setDetail({ row, records: await trainingService.getEmployeeManHourDetail(row.employee_id, filters) }) } catch (e) { setError(e?.message || 'Employee detail could not be loaded.') } finally { setDetailLoading(false) }
  }

  const exportButtons = (
    <div className="flex gap-2 mb-4">
      <button onClick={exportPdf} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><ArrowDownToLine className="w-4 h-4" /> Export PDF</button>
      <button onClick={exportExcel} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><ArrowDownToLine className="w-4 h-4" /> Export Excel</button>
    </div>
  )

  if (loading) return <LoadingState label="Calculating workforce man-hours..." />
  const summary = data?.summary || {}
  const cards = [
    ['Scheduled hours', summary.scheduled_hours, Clock3, 'Attendance schedule'],
    ['Actual attendance hours', summary.actual_attendance_hours, Users, 'Attendance source of truth'],
    ['Employee training hours', summary.training_hours, GraduationCap, 'Completed per employee'],
    ['KSS hours', summary.kss_hours, GraduationCap, 'Individual KSS time'],
    ['Training man-hours', summary.training_man_hours, BarChart3, 'Duration x participants'],
    ['Overtime', summary.overtime_hours, Clock3, 'Derived from attendance'],
    ['Absence hours', summary.absence_hours, CalendarDays, 'Scheduled without attendance'],
    ['Attendance compliance', `${summary.attendance_compliance || 0}%`, Map, 'Actual / scheduled'],
  ]
  return <div className="space-y-6">
    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#009944]">Workforce</p><h1 className="text-2xl font-semibold text-slate-900 mt-1">Man-Hour Intelligence</h1><p className="text-sm text-slate-500 mt-1">Business → Area → Branch → Employee. Attendance hours, training hours and training man-hours remain distinct.</p></div><Link to="/training" className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:border-[#009944] hover:text-[#009944]"><GraduationCap className="w-4 h-4" /> Training dashboard</Link></div>
    {error && <ErrorState message={error} />}
    <div className="bg-white border border-slate-200 rounded-xl p-4"><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3"><Filter label="From" type="date" value={filters.startDate} onChange={(v) => change('startDate', v)} /><Filter label="To" type="date" value={filters.endDate} onChange={(v) => change('endDate', v)} /><Filter label="Area" value={filters.area} onChange={(v) => change('area', v)} options={[['', 'All areas'], ...options.areas.map((item) => [item.area_code, item.area_name || item.area_code])]} /><Filter label="Branch" value={filters.branchId} onChange={(v) => change('branchId', v)} options={[['', 'All branches'], ...options.branches.map((item) => [item.id, item.branch_name])]} /><Filter label="Department" value={filters.department} onChange={(v) => change('department', v)} options={[['', 'All departments'], ...options.departments.map((item) => [item.name, item.name])]} /><Filter label="Employee" value={filters.employeeId} onChange={(v) => change('employeeId', v)} options={[['', 'All employees'], ...options.employees.map((item) => [item.id, item.full_name])]} /></div><button onClick={load} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]"><BarChart3 className="w-4 h-4" /> Recalculate intelligence</button></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">{cards.map(([label, value, Icon, hint]) => <button key={label} onClick={() => document.getElementById('man-hour-hierarchy')?.scrollIntoView({ behavior: 'smooth' })} className="text-left bg-white border border-slate-200 rounded-xl p-5 hover:border-[#009944]/50 hover:shadow-sm transition"><div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="text-2xl font-semibold text-slate-900 mt-2">{typeof value === 'number' ? Number(value || 0).toFixed(2) : value}</p><p className="text-xs text-slate-400 mt-1">{hint}</p></div><div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center"><Icon className="w-5 h-5 text-[#009944]" /></div></div><p className="text-[11px] text-[#009944] mt-3">Drill into hierarchy</p></button>)}</div>
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6"><MetricList title="Hours by area" rows={data?.by_area || []} label="area" onSelect={null} /><MetricList title="Hours by branch" rows={data?.by_branch || []} label="branch" onSelect={null} /><MetricList title="Hours by department" rows={data?.by_department || []} label="department" onSelect={null} /></div>
    {exportButtons}
      <section id="man-hour-hierarchy" className="bg-white border border-slate-200 rounded-xl overflow-hidden"><div className="p-5 border-b border-slate-100"><div className="flex items-center gap-2"><Building2 className="w-5 h-5 text-[#009944]" /><div><h2 className="font-semibold text-slate-900">Business → Area → Branch → Employee</h2><p className="text-sm text-slate-500 mt-1">Select an employee to see the attendance records and training records behind the aggregate.</p></div></div></div>{(data?.by_employee || []).length === 0 ? <EmptyState title="No workforce records in this range" /> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-slate-500"><tr>{['Employee', 'Area', 'Branch', 'Scheduled', 'Attendance', 'Training', 'KSS', 'Training MH', 'Overtime', 'Absence'].map((heading) => <th key={heading} className="px-4 py-3 font-medium whitespace-nowrap">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{data.by_employee.map((row) => <tr key={row.employee_id} className="hover:bg-slate-50"><td className="px-4 py-3"><button onClick={() => openEmployee(row)} className="font-medium text-[#009944] hover:underline text-left">{row.full_name}</button><span className="block text-xs text-slate-400">{row.department || 'Unassigned'}</span></td><td className="px-4 py-3">{row.area || 'Unassigned'}</td><td className="px-4 py-3">{row.branch_name || 'Unassigned'}</td><td className="px-4 py-3">{Number(row.scheduled_hours || 0).toFixed(2)}h</td><td className="px-4 py-3">{Number(row.actual_hours || 0).toFixed(2)}h</td><td className="px-4 py-3 text-[#007a4a]">{Number(row.training_hours || 0).toFixed(2)}h</td><td className="px-4 py-3 text-[#007a4a]">{Number(row.kss_hours || 0).toFixed(2)}h</td><td className="px-4 py-3 text-[#007a4a]">{Number(row.training_man_hours || 0).toFixed(2)}h</td><td className="px-4 py-3">{Number(row.overtime_hours || 0).toFixed(2)}h</td><td className="px-4 py-3">{Number(row.absence_hours || 0).toFixed(2)}h</td></tr>)}</tbody></table></div>}</section>
    {detailLoading && <div className="fixed inset-0 z-40 bg-slate-900/30 flex items-center justify-center"><div className="bg-white rounded-xl px-5 py-4 flex items-center gap-3 text-sm text-slate-700"><Loader2 className="w-5 h-5 animate-spin text-[#009944]" />Loading employee detail...</div></div>}
    {detail && <EmployeeDetail detail={detail} onClose={() => setDetail(null)} />}
  </div>
}

function Filter({ label, value, onChange, type = 'select', options = [] }) { return <div><label className={labelCls}>{label}</label>{type === 'date' ? <input type="date" className={inputCls} value={value || ''} onChange={(e) => onChange(e.target.value)} /> : <select className={inputCls} value={value || ''} onChange={(e) => onChange(e.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select>}</div> }

function MetricList({ title, rows, label }) { const max = Math.max(...rows.map((row) => Number(row.training_hours || row.actual_hours || 0)), 1); return <div className="bg-white border border-slate-200 rounded-xl p-5"><h2 className="font-semibold text-slate-900 mb-4">{title}</h2>{rows.length === 0 ? <p className="text-sm text-slate-400">No records.</p> : <div className="space-y-3">{rows.slice(0, 8).map((row) => { const value = Number(row.training_hours || row.actual_hours || 0); return <div key={row[label]}><div className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-slate-700">{row[label]}</span><span className="font-semibold text-slate-900 whitespace-nowrap">{value.toFixed(2)}h</span></div><div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-[#009944]" style={{ width: `${Math.max(3, value / max * 100)}%` }} /></div></div> })}</div>}</div> }

function EmployeeDetail({ detail, onClose }) { const row = detail.row; const attendance = detail.records?.attendance || []; const training = detail.records?.training || []; return <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-start justify-center overflow-y-auto p-4"><div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl my-4"><div className="p-5 border-b border-slate-100 flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-wide text-[#009944]">Employee drilldown</p><h2 className="text-xl font-semibold text-slate-900 mt-1">{row.full_name}</h2><p className="text-sm text-slate-500 mt-1">Attendance and training records · {detail.records?.start_date} to {detail.records?.end_date}</p></div><button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-5 h-5" /></button></div><div className="p-5 grid grid-cols-1 xl:grid-cols-2 gap-6"><div><h3 className="font-semibold text-slate-900 mb-3">Attendance source records ({attendance.length})</h3>{attendance.length === 0 ? <p className="text-sm text-slate-400">No attendance records.</p> : <div className="overflow-x-auto border border-slate-200 rounded-lg"><table className="w-full text-xs"><thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Worked</th><th className="px-3 py-2">Late</th><th className="px-3 py-2">Early</th></tr></thead><tbody className="divide-y divide-slate-100">{attendance.map((item) => <tr key={item.attendance_date}><td className="px-3 py-2">{item.attendance_date}</td><td className="px-3 py-2">{item.work_hours || 0}h</td><td className="px-3 py-2">{item.late_minutes || 0}m</td><td className="px-3 py-2">{item.early_departure_minutes || 0}m</td></tr>)}</tbody></table></div>}</div><div><h3 className="font-semibold text-slate-900 mb-3">Training records ({training.length})</h3>{training.length === 0 ? <p className="text-sm text-slate-400">No completed training records.</p> : <div className="space-y-2">{training.map((item, index) => <div key={`${item.training_date}-${item.training_title}-${index}`} className="rounded-lg border border-slate-200 p-3"><p className="text-sm font-medium text-slate-800">{item.training_title}</p><p className="text-xs text-slate-500 mt-1">{item.training_date} · {Number(item.duration_minutes || 0) / 60}h · {item.training_type}</p><p className="text-xs text-slate-400 mt-1">Assessment: {item.assessment_percentage == null ? 'Not required' : `${item.assessment_percentage}%`}</p></div>)}</div>}</div></div></div></div> }
