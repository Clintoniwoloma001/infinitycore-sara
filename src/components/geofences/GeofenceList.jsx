import React from 'react'
import { Pencil, Plus, Loader2, Trash2, FlaskConical, MapPin } from 'lucide-react'
import { LoadingState, EmptyState, ErrorState } from '../PageStates'
import { formatRadius } from '../../services/geofenceService'

/**
 * The fence list: one row per branch fence with its centre (6 dp),
 * radius, assigned-employee count and active chip, plus the four row
 * actions — Edit, enable/disable, Test and Delete. "Add fence" lives in
 * the card header because it is not a row action.
 */
export default function GeofenceList({
  fences,
  loading,
  error,
  busy = false,
  busyId = null,
  onRetry,
  onEdit,
  onAdd,
  onToggle,
  onDelete,
  onTest,
}) {
  const rowBusy = (fence) => busy && (busyId == null || busyId === fence.branchId)

  return (
    <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-700">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Branch fences</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {loading
              ? 'Loading…'
              : `${fences.length} fence${fences.length === 1 ? '' : 's'} · ${fences.filter((f) => f.isActive).length} active`}
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          disabled={loading || Boolean(error)}
          className="inline-flex items-center gap-2 rounded-lg bg-[#009944] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-60"
        >
          <Plus className="w-4 h-4" />
          Add fence
        </button>
      </header>

      <div className="p-5">
        {loading && <LoadingState label="Loading geofences…" />}

        {!loading && error && (
          <ErrorState title="Unable to load geofences" message={error}>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
            >
              Retry
            </button>
          </ErrorState>
        )}

        {!loading && !error && fences.length === 0 && (
          <EmptyState
            title="No branch fences yet"
            description="Add the first fence to start enforcing (and testing) branch coverage."
          />
        )}

        {!loading && !error && fences.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-700">
                  <th scope="col" className="px-2 py-2 font-medium">Branch</th>
                  <th scope="col" className="px-2 py-2 font-medium">Centre</th>
                  <th scope="col" className="px-2 py-2 font-medium">Radius</th>
                  <th scope="col" className="px-2 py-2 font-medium">Employees</th>
                  <th scope="col" className="px-2 py-2 font-medium">Status</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {fences.map((fence) => {
                  const disabled = rowBusy(fence)
                  return (
                    <tr key={fence.branchId} className="align-middle">
                      <td className="px-2 py-3">
                        <span className="block font-medium text-slate-800 dark:text-slate-100">{fence.branchName}</span>
                        <span className="text-xs text-slate-400">{fence.branchCode || '—'}</span>
                      </td>
                      <td className="px-2 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {fence.latitude != null && fence.longitude != null
                          ? `${fence.latitude.toFixed(6)}, ${fence.longitude.toFixed(6)}`
                          : '—'}
                      </td>
                      <td className="px-2 py-3 text-slate-700 dark:text-slate-200">{formatRadius(fence.radiusMeters)}</td>
                      <td className="px-2 py-3 text-slate-700 dark:text-slate-200">{fence.assignedEmployees}</td>
                      <td className="px-2 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                            fence.isActive
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                              : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300'
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${fence.isActive ? 'bg-[#009944]' : 'bg-slate-400'}`} />
                          {fence.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-2 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => onEdit(fence)}
                            disabled={disabled}
                            title={`Edit the fence for ${fence.branchName}`}
                            aria-label={`Edit the fence for ${fence.branchName}`}
                            className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:border-[#009944] hover:text-[#009944] disabled:opacity-50 dark:border-slate-600"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>

                          <button
                            type="button"
                            role="switch"
                            aria-checked={fence.isActive}
                            aria-label={`${fence.isActive ? 'Disable' : 'Enable'} the fence for ${fence.branchName}`}
                            disabled={disabled}
                            onClick={() => onToggle(fence, !fence.isActive)}
                            className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${
                              fence.isActive ? 'bg-[#009944]' : 'bg-slate-300 dark:bg-slate-600'
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
                                fence.isActive ? 'left-[18px]' : 'left-0.5'
                              }`}
                            />
                          </button>

                          <button
                            type="button"
                            onClick={() => onTest(fence)}
                            disabled={disabled}
                            title={`Test coverage against ${fence.branchName}`}
                            aria-label={`Test coverage against ${fence.branchName}`}
                            className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:border-[#009944] hover:text-[#009944] disabled:opacity-50 dark:border-slate-600"
                          >
                            <FlaskConical className="w-4 h-4" />
                          </button>

                          <button
                            type="button"
                            onClick={() => onDelete(fence)}
                            disabled={disabled}
                            title={`Delete the fence for ${fence.branchName}`}
                            aria-label={`Delete the fence for ${fence.branchName}`}
                            className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:border-rose-400 hover:text-rose-600 disabled:opacity-50 dark:border-slate-600"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>

                          {busy && busyId === fence.branchId && (
                            <Loader2 className="w-4 h-4 animate-spin text-[#009944]" />
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && fences.length > 0 && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-slate-400">
            <MapPin className="w-3.5 h-3.5" />
            Centres and radii come straight from the server — distances shown in the tester are the server&apos;s own
            calculation.
          </p>
        )}
      </div>
    </section>
  )
}
