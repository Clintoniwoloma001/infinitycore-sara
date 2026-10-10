import React from 'react'

/**
 * DirectorGlobalFilterBar — the sticky global filter bar for the Director
 * Intelligence deep dive. Driven by the same filter shape as the legacy
 * dashboard (period + department + branch + area + role + designation + dates)
 * but slimmed to the brief: date range presets, Branch, Area manager, Department,
 * Position. Every filter within this component is a LINE OF BUSINESS filter:
 * changing any of them re-fetches the scorecards, branch breakdown, staff table
 * and best/worst lists. Nothing here computes a score or a bucket; it only
 * narrows the scope the RPCs query.
 */

const DATE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7 days' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'custom', label: 'Custom range' },
]

const FILTER_LABELS = {
  department: 'Department',
  branchId: 'Branch',
  area: 'Area manager',
  role: 'Role',
  position: 'Position',
  designationId: 'Designation',
}

const OPTION_KEY = {
  department: 'departments',
  branchId: 'branches',
  area: 'areaManagers',
  role: 'roles',
  position: 'positions',
  designationId: 'designations',
}

/**
 * options: { branches, areaManagers, departments, roles, positions, designations }
 */
export function DirectorGlobalFilterBar({ filters, setFilters, options = {} }) {
  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value || '' }))

  const select = (key) => (
    <select
      aria-label={FILTER_LABELS[key]}
      className="h-9 min-w-36 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none transition focus:border-[#009944] focus:ring-2 focus:ring-[#009944]/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
      value={filters[key]}
      onChange={(e) => set(key, e.target.value)}
    >
      <option value="">All {FILTER_LABELS[key]}</option>
      {(options[OPTION_KEY[key]] || []).map((o) => (
        <option key={o.id ?? o} value={o.id ?? o}>{o.name ?? o.title ?? o}</option>
      ))}
    </select>
  )

  const resetAll = () => {
    setFilters({ period: 'month', department: '', branchId: '', area: '', role: '', designationId: '', employeeId: '', startDate: '', endDate: '' })
  }

  return (
    <div className="sticky top-0 z-50 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 dark:bg-slate-900">
            <span className="text-[10px] font-bold uppercase tracking-[.14em] text-slate-400">Director Intelligence</span>
          </div>
          <div className="flex shrink-0 gap-1 rounded-lg bg-slate-100 px-2 py-1.5 dark:bg-slate-900">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  setFilters((f) => ({ ...f, period: p.value }))
                }}
                className={`h-7 rounded-md px-2.5 text-[11px] font-semibold capitalize transition focus-visible:outline-focus ${
                  filters.period === p.value
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {select('department')}
            {select('branchId')}
            {select('area')}
            {select('position')}
            <button
              type="button"
              onClick={resetAll}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
            >
              Reset
            </button>
          </div>
        </div>
        {filters.period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400">From</span>
            <input
              className="h-8 w-32 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-[#009944] dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
              placeholder="YYYY-MM-DD"
              value={filters.startDate}
              onChange={(e) => setFilters((f) => ({ ...f, startDate: e.target.value }))}
            />
            <span className="text-[10px] font-semibold uppercase tracking-[.1em] text-slate-400">To</span>
            <input
              className="h-8 w-32 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-[#009944] focus:ring-2 focus:ring-[#009944]/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
              placeholder="YYYY-MM-DD"
              value={filters.endDate}
              onChange={(e) => setFilters((f) => ({ ...f, endDate: e.target.value }))}
            />
            <button
              type="button"
              onClick={() => setFilters((f) => ({ ...f, period: 'custom' }))}
              className="h-8 rounded-md px-3 text-[11px] font-semibold text-[#009944]"
            >
              Apply
            </button>
          </div>
        )}
        <p className="text-[9px] text-slate-400">Sticky filter bar — changing any filter re-fetches the scorecards and branch data.</p>
      </div>
    </div>
  )
}
