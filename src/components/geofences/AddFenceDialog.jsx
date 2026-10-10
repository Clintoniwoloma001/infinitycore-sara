import React from 'react'
import { Loader2, MapPinned, MapPin } from 'lucide-react'
import Modal from './Modal'
import { LoadingState, ErrorState } from '../PageStates'
import { branchDisplayName, formatRadius } from '../../services/geofenceService'

/**
 * "Add fence" — the branch picker. Every branch that is NOT already in
 * list_branch_geofences() is offered here; picking one opens the map
 * editor with that branch's stored coordinates (or the app centre when
 * the branch has none yet).
 *
 * "Use my location" is ALWAYS offered (it used to be rendered only after a fix
 * already existed, so a first fix could never be requested from here). While
 * it is acquiring, the button shows progress and is disabled — a tap can no
 * longer look like a dead button.
 */
export default function AddFenceDialog({ open, branches, loading, error, onRetry, onSelect, onClose, myPosition, myLocationBusy = false, myLocationError = null, onUseMyLocation }) {
  return (
    <Modal open={open} onClose={onClose} width="max-w-xl">
      <div className="p-5">
        <h2 id="gf-add-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Add a branch fence
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          These branches do not have a fence yet. Choose one to place it on the map.
        </p>

        {onUseMyLocation ? (
          <button
            type="button"
            onClick={onUseMyLocation}
            disabled={myLocationBusy}
            className="mb-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"
          >
            {myLocationBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
            {myLocationBusy ? 'Finding you…' : myPosition ? 'Re-locate me' : 'Use my location'}
          </button>
        ) : null}

        {myPosition ? (
          <p className="mb-3 text-xs text-emerald-600 dark:text-emerald-400">
            Your location is pinned at {myPosition.lat.toFixed(6)}, {myPosition.lng.toFixed(6)} · tap a branch to place its fence around it.
          </p>
        ) : null}

        {myLocationError ? (
          <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {myLocationError}
          </p>
        ) : null}

        <div className="mt-4 max-h-[55vh] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
          {loading && <LoadingState label="Loading branches..." />}
          {!loading && error && (
            <div className="p-4">
              <ErrorState title="Unable to load branches" message={error}>
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-2 rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
                >
                  Retry
                </button>
              </ErrorState>
            </div>
          )}
          {!loading && !error && branches.length === 0 && (
            <div className="p-6 text-center">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Every branch already has a fence</p>
              <p className="mt-1 text-sm text-slate-500">Edit an existing fence from the list instead.</p>
            </div>
          )}
          {!loading && !error && branches.length > 0 && (
            <ul className="divide-y divide-slate-100 dark:divide-slate-700">
              {branches.map((branch) => (
                <li key={branch.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(branch)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-700/60"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <MapPinned className="w-4 h-4 flex-shrink-0 text-[#009944]" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                          {branchDisplayName(branch)}
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {branch.branch_code || 'No code'}
                          {branch.latitude != null && branch.longitude != null
                            ? ` · ${Number(branch.latitude).toFixed(6)}, ${Number(branch.longitude).toFixed(6)} · default ${formatRadius(branch.geofence_radius || 150)}`
                            : ' · no coordinates yet'}
                        </span>
                      </span>
                    </span>
                    <span className="text-xs font-medium text-[#009944]">Add</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  )
}
