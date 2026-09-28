// ============================================================================
// Automation Command Centre
// ============================================================================
// A TRACKER, not a report. Every bar on this page is derived from the status of
// that department's real automation_items rows by get_automation_portfolio().
// There is no stored percentage anywhere, so the view cannot drift from reality.
//
// The formula (live = 1.0, in progress = 0.5, not started = 0) is documented at
// the function that computes it, in the database.
import React, { useCallback, useEffect, useState } from 'react'
import { Gauge, RefreshCw, Loader2, ShieldCheck, Plus, ListChecks } from 'lucide-react'
import { auditService, AUTOMATION_STATUS } from '../services/auditService'
import { workEngineService } from '../services/workEngineService'
import { LoadingState, ErrorState, EmptyState } from '../components/PageStates'
import AddAutomationTask from '../components/work/AddAutomationTask'
import { SlaBadge, RateBar, TaskStatusChip } from '../components/work/WorkPrimitives'
import { useAuth } from '../hooks/useAuth'

/** Red -> amber -> green, so a bar reads as a health signal at a glance. */
function barColour(pct) {
  if (pct >= 75) return 'bg-emerald-500'
  if (pct >= 50) return 'bg-amber-500'
  if (pct > 0) return 'bg-orange-500'
  return 'bg-slate-300'
}

export default function AutomationCommandCentre() {
  const { hasPermission, profile } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyKey, setBusyKey] = useState(null)
  const [rowError, setRowError] = useState(null)
  // Personal automation work. Scoped SERVER-SIDE to the signed-in user, so this
  // section can only ever show YOUR automation tasks - never another person's.
  const [mine, setMine] = useState(null)
  const [showAdd, setShowAdd] = useState(false)

  // Editing is gated on the server too; this only decides whether to render the
  // control. View is open to anyone who can reach the page.
  const canEdit = hasPermission('automation.portfolio.manage')
    || ['super_admin', 'admin', 'head_of_human_resources', 'head_of_e_business']
      .includes(profile?.role)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData(await auditService.portfolio()) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  // Loaded separately and independently: a failure here must not blank the
  // portfolio tracker, and vice versa.
  const loadMine = useCallback(async () => {
    try { setMine(await workEngineService.automationTasks()) }
    catch (e) { setMine({ error: e.message, tasks: [] }) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadMine() }, [loadMine])

  const setStatus = async (itemKey, status) => {
    setBusyKey(itemKey); setRowError(null)
    try {
      await auditService.setItemStatus(itemKey, status)
      await load()
    } catch (e) { setRowError(e.message) }
    finally { setBusyKey(null) }
  }

  if (loading) return <LoadingState label="Loading automation portfolio..." />
  if (error) return <ErrorState title="Unable to load the portfolio" message={error} />

  const departments = data?.departments || []
  const items = data?.items || []
  const active = data?.active_workflows || []
  const itemsByDept = items.reduce((acc, i) => {
    (acc[i.department] ||= []).push(i); return acc
  }, {})

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
            <Gauge className="w-6 h-6 text-[#009944]" />Automation Command Centre
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Progress across every department's automation workstreams.
            {' '}Percentages are calculated from tracked items, not entered by hand.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-3 py-2 text-sm font-medium text-white"
          >
            <Plus className="w-4 h-4" />Add task
          </button>
          <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="w-4 h-4" />Refresh
          </button>
        </div>
      </header>

      {rowError && <p className="text-sm text-red-700">{rowError}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 px-4 py-3">
          <div className="text-xs text-slate-500">Tracked items</div>
          <div className="text-2xl font-semibold tabular-nums text-slate-900">
            {data?.totals?.items ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 px-4 py-3">
          <div className="text-xs text-slate-500">Live</div>
          <div className="text-2xl font-semibold tabular-nums text-emerald-600">
            {data?.totals?.live ?? 0}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 px-4 py-3">
          <div className="text-xs text-slate-500">Departments in scope</div>
          <div className="text-2xl font-semibold tabular-nums text-slate-900">
            {departments.length}
          </div>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-slate-800">Automation portfolio</h2>
        {departments.length === 0 ? (
          <EmptyState title="No departments tracked yet"
            description="Automation items appear here once they are seeded." />
        ) : (
          <div className="space-y-4">
            {departments.map((d) => (
              <div key={d.department}>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-sm font-medium text-slate-800">{d.label}</span>
                  <span className="text-xs tabular-nums text-slate-500">
                    {d.live} live · {d.in_progress} in progress · {d.not_started} not started
                    {' — '}
                    <span className="font-semibold text-slate-700">{d.completion_pct}%</span>
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${barColour(Number(d.completion_pct))}`}
                    style={{ width: `${Math.max(0, Math.min(100, Number(d.completion_pct)))}%` }} />
                </div>

                {(itemsByDept[d.department] || []).length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {(itemsByDept[d.department] || []).map((i) => (
                      <li key={i.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-sm text-slate-800">{i.label}</div>
                          {i.description && (
                            <div className="text-xs text-slate-500">{i.description}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {i.live_at && (
                            <span className="text-[11px] text-slate-400">
                              live since {String(i.live_at).slice(0, 10)}
                            </span>
                          )}
                          {canEdit ? (
                            <select
                              value={i.status}
                              disabled={busyKey === i.item_key}
                              onChange={(e) => setStatus(i.item_key, e.target.value)}
                              className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50">
                              {Object.entries(AUTOMATION_STATUS).map(([k, v]) => (
                                <option key={k} value={k}>{v.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${AUTOMATION_STATUS[i.status].chip}`}>
                              {AUTOMATION_STATUS[i.status].label}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Active workflows</h2>
        {active.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing is in progress right now.
          </p>
        ) : (
          <ul className="space-y-1">
            {active.map((i) => (
              <li key={i.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
                <span className="text-sm text-slate-800">
                  <span className="mr-2 text-xs uppercase tracking-wide text-slate-400">
                    {i.department}
                  </span>
                  {i.label}
                </span>
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
                  In Progress
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <ListChecks className="w-4 h-4 text-[#009944]" />
            My automation tasks
          </h2>
          {mine && !mine.error && (
            <span className="text-xs text-slate-500">
              KPI score <span className="font-semibold text-slate-800">{Number(mine.kpi_score ?? 0).toFixed(1)}%</span>
            </span>
          )}
        </div>

        {mine?.error ? (
          <ErrorState title="Unable to load your automation tasks" message={mine.error} />
        ) : (mine?.tasks || []).length === 0 ? (
          <div className="py-4 text-center">
            <p className="text-sm text-slate-500">
              You have no automation tasks yet.
            </p>
            <button
              onClick={() => setShowAdd(true)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-3 py-1.5 text-sm font-medium text-white"
            >
              <Plus className="w-4 h-4" />Add your first task
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {(mine?.tasks || []).map((t) => (
              <li key={t.id} className="rounded-xl border border-slate-100 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900">{t.title}</div>
                    <div className="text-xs uppercase tracking-wide text-slate-400">
                      {t.department || 'Unassigned department'}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <TaskStatusChip status={t.status} />
                    <SlaBadge state={t.sla_state} deadline={t.sla_review_deadline} />
                  </div>
                </div>
                <div className="mt-2">
                  <RateBar value={t.calculated_completion_rate} />
                  <div className="mt-1 text-xs text-slate-500">
                    {Number(t.calculated_completion_rate ?? 0).toFixed(1)}% complete
                    {' · '}
                    {(t.steps || []).length} deliverable{(t.steps || []).length === 1 ? '' : 's'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-xs text-slate-500">
          This list shows only your own automation tasks. Tasks, KPIs and targets
          assigned to other people are managed in Work Management, never here.
        </p>
      </section>

      {showAdd && (
        <AddAutomationTask
          departments={departments}
          onClose={() => setShowAdd(false)}
          onCreated={() => { loadMine(); load() }}
        />
      )}

      <p className="flex items-start gap-2 text-xs text-slate-500">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        Status changes are written to the audit log. Anyone with the portfolio
        permission can view it; only Super Admin, Admin, the Head of HR and the
        Head of E-Business can change a status.
      </p>
    </div>
  )
}

