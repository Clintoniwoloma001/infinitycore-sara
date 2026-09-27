// ============================================================================
// Leave Schedule Planner (Phase 70)
// ============================================================================
// The central planning and visualisation layer for leave. Everything is read
// from the server in one aggregated RPC; the capacity verdict, the conflict
// explanations and the alternative dates all come from Postgres, so this page
// and the mobile app can never disagree about a number.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarRange, AlertTriangle, CheckCircle2, Users, Link2 } from 'lucide-react'
import {
  leavePlannerService, formatLeaveRange, eachDay, isoToday, isoDayOffset,
} from '../services/leavePlannerService'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import PlannerTimeline from '../components/leave/PlannerTimeline'
import CapacityHeatmap from '../components/leave/CapacityHeatmap'
import AvailabilityChecker from '../components/leave/AvailabilityChecker'
import CapacityRuleEditor from '../components/leave/CapacityRuleEditor'
import PlannerFilters from '../components/leave/PlannerFilters'
import OverviewCards from '../components/leave/OverviewCards'
import ExportButtons from '../components/leave/ExportButtons'
import BookingLinkManager from '../components/leave/BookingLinkManager'

const RANGES = [
  { id: 'week', label: 'This week', from: () => isoDayOffset(-3), to: () => isoDayOffset(3) },
  { id: 'month', label: 'This month', from: () => `${isoToday().slice(0, 8)}01`, to: () => isoToday() },
  { id: 'quarter', label: 'This quarter', from: () => isoDayOffset(-45), to: () => isoDayOffset(45) },
  { id: 'custom', label: 'Custom', from: () => isoToday(), to: () => isoDayOffset(30) },
]

const EMPTY_FILTERS = {
  department: '', branchId: '', area: '', role: '',
  leaveType: '', status: '',
}

export default function LeaveSchedulePlanner() {
  const [rangeId, setRangeId] = useState('month')
  const [from, setFrom] = useState(RANGES[1].from())
  const [to, setTo] = useState(RANGES[1].to())
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('timeline')
  const [linksOpen, setLinksOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setData(await leavePlannerService.planner({
        from, to,
        department: filters.department || null,
        branchId: filters.branchId || null,
        area: filters.area || null,
        role: filters.role || null,
        leaveType: filters.leaveType || null,
        status: filters.status || null,
      }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [from, to, filters])

  useEffect(() => { load() }, [load])

  const days = useMemo(() => eachDay(from, to), [from, to])
  const isPlanner = !!data?.scope?.is_planner
  const conflicts = (data?.capacity || []).filter((c) => c.is_conflict)
  const applyRange = (r) => { setRangeId(r.id); setFrom(r.from()); setTo(r.to()) }

  const tabs = [
    { id: 'timeline', label: 'Timeline', icon: CalendarRange },
    { id: 'capacity', label: 'Capacity', icon: Users },
    { id: 'check', label: 'Check availability', icon: CheckCircle2 },
    ...(isPlanner ? [{ id: 'rules', label: 'Capacity rules', icon: AlertTriangle }] : []),
  ]

  return (
    <div className="space-y-5 print:space-y-2">
      <header className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Leave Schedule Planner</h1>
          <p className="text-sm text-slate-500 mt-1">
            {formatLeaveRange(from, to)}
            {isPlanner ? '' : ' · showing your own leave only'}
          </p>
        </div>
        {isPlanner && (
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <button onClick={() => setLinksOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Link2 className="w-4 h-4" />Booking links
            </button>
            <ExportButtons data={data} from={from} to={to} />
          </div>
        )}
      </header>

      <OverviewCards
        summary={data?.summary || {}}
        conflictCount={conflicts.length}
        statusFilter={filters.status}
        onStatus={(s) => setFilters((f) => ({ ...f, status: f.status === s ? '' : s }))}
      />

      <PlannerFilters
        ranges={RANGES} rangeId={rangeId} from={from} to={to} filters={filters}
        onRange={applyRange}
        onFrom={(v) => { setRangeId('custom'); setFrom(v) }}
        onTo={(v) => { setRangeId('custom'); setTo(v) }}
        onFilters={setFilters}
        onClear={() => setFilters(EMPTY_FILTERS)}
      />

      <nav className="flex gap-1 border-b border-slate-200 print:hidden">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === id
              ? 'border-[#009944] text-[#009944]'
              : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </nav>

      {loading && <LoadingState label="Loading leave schedule..." />}
      {error && !loading && <ErrorState title="Unable to load the planner" message={error} />}

      {!loading && !error && data && (
        <>
          {tab === 'timeline' && data.entries.length > 0 && (
            <PlannerTimeline entries={data.entries} days={days} />
          )}
          {tab === 'timeline' && data.entries.length === 0 && (
            <EmptyState title="No leave in this range"
              description="Adjust the dates or clear the filters to see scheduled leave." />
          )}
          {tab === 'capacity' && <CapacityHeatmap capacity={data.capacity} days={days} />}
          {tab === 'check' && <AvailabilityChecker onChecked={load} />}
          {tab === 'rules' && isPlanner && <CapacityRuleEditor onChanged={load} />}
        </>
      )}

      <BookingLinkManager open={linksOpen} onClose={() => setLinksOpen(false)} />
    </div>
  )
}
