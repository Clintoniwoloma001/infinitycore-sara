import React from 'react'
import { Link } from 'react-router-dom'
import { ClipboardCheck, Clock } from 'lucide-react'
import { formatDate } from '../lib/utils'
import { useMyLeaveApprovals } from '../hooks/useMyLeaveApprovals'

// Generic shape so a future loan/expense/recruitment approval queue can
// slot in next to this one: { title, count, oldestLabel, href, icon }.
function ApprovalCard({ icon: Icon, title, count, oldestLabel, href, accent }) {
  if (count === 0) return null
  return (
    <Link to={href} className="block bg-white rounded-2xl border border-slate-200 p-5 hover:border-slate-300 transition-colors">
      <div className="flex items-start justify-between">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accent}15`, color: accent }}>
          <Icon className="w-5 h-5" />
        </div>
        <span className="text-2xl font-semibold text-slate-900">{count}</span>
      </div>
      <div className="text-sm font-medium text-slate-700 mt-3">{title}</div>
      {oldestLabel && (
        <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Clock className="w-3 h-3" /> Oldest: {oldestLabel}</div>
      )}
      <div className="text-xs text-[#009944] font-medium mt-3">Review approvals →</div>
    </Link>
  )
}

export default function PendingApprovalsWidget() {
  const { count, oldest, loading } = useMyLeaveApprovals()

  if (loading || count === 0) return null

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">Pending Approvals</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <ApprovalCard
          icon={ClipboardCheck}
          title="Leave Requests"
          count={count}
          oldestLabel={oldest ? formatDate(oldest.created_at) : null}
          href="/leave-requests"
          accent="#009944"
        />
        {/* Loan / expense / recruitment / payroll approval cards can be
            added here later using the same ApprovalCard shape. */}
      </div>
    </div>
  )
}
