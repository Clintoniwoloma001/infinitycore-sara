// PDF / Excel / print actions. The PDF is a real structured document and the
// Excel file is a real multi-sheet workbook - neither is a screenshot.
import React from 'react'
import { Download, Printer } from 'lucide-react'
import {
  exportLeavePdf, exportLeaveExcel, printLeaveSchedule,
} from '../../services/leavePlannerExport'

const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50'

export default function ExportButtons({ data, from, to }) {
  // A file with no rows is still a valid (empty) report, but there is no point
  // offering to export nothing.
  const hasRows = (data?.entries || []).length > 0

  return (
    <div className="flex items-center gap-2 print:hidden">
      <button onClick={() => exportLeavePdf(data, { from, to })}
        disabled={!hasRows} className={`${btn} disabled:opacity-50`}>
        <Download className="w-4 h-4" />PDF
      </button>
      <button onClick={() => exportLeaveExcel(data, { from, to })}
        disabled={!hasRows} className={`${btn} disabled:opacity-50`}>
        <Download className="w-4 h-4" />Excel
      </button>
      <button onClick={printLeaveSchedule} className={btn}>
        <Printer className="w-4 h-4" />Print
      </button>
    </div>
  )
}
