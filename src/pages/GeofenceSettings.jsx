import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Crosshair, MapPin, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { AccessDenied } from '../components/PageStates'
import { GEOFENCE_ADMIN_ROLES } from '../constants/permissions'
import { geofenceService, geofenceErrorMessage } from '../services/geofenceService'
import GeofenceList from '../components/geofences/GeofenceList'
import GeofenceMapEditor from '../components/geofences/GeofenceMapEditor'
import CoverageTester from '../components/geofences/CoverageTester'
import AddFenceDialog from '../components/geofences/AddFenceDialog'
import ConfirmDialog from '../components/geofences/ConfirmDialog'

// ============================================================
// GEOFENCE SETTINGS & MANAGEMENT — Super Admin / Head of HR.
//
// The sidebar and the router both gate this route on
// GEOFENCE_ADMIN_ROLES (canAccessRoute step 1b), and this page
// re-checks the role itself so a deep link cannot skip it. The
// real boundary is `require_geofence_admin()` inside every
// geofence RPC — SQLSTATE 42501, surfaced as HTTP 403.
//
// Three surfaces, one page:
//   A. the fence list (edit / enable / delete / test per row, plus
//      "Add fence" for branches that have none);
//   B. the map editor (draggable pin, lockable circle, 10–5000 m
//      radius slider with m/km units);
//   C. "Test My Coverage" — check_is_within_geofence() against a
//      GPS fix or manually entered coordinates.
// ============================================================

// Used only when a branch being added has no coordinates yet.
const FALLBACK_CENTRE = { lat: 6.5244, lng: 3.3792 }

export default function GeofenceSettings() {
  const { role, name } = useAuth()

  // The guard must run BEFORE any stateful hook is reached, so the body
  // lives in its own component below.
  if (!GEOFENCE_ADMIN_ROLES.includes(role)) return <AccessDenied />

  return <GeofenceSettingsBody userName={name} />
}

function GeofenceSettingsBody({ userName }) {
  const [fences, setFences] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null) // { tone: 'ok' | 'error', text }
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const [editing, setEditing] = useState(null) // { fence } | { branch }
  const [addOpen, setAddOpen] = useState(false)
  const [addBranches, setAddBranches] = useState([])
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState(null)

  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState(null)

  const [testBranchId, setTestBranchId] = useState(null)

  const testerRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Unify initial fetch: Merge canonical geofences with branches that have
      // coordinates but no canonical fence yet (e.g. Head Office BR-06).
      const [fencesData, branchesData] = await Promise.all([
        geofenceService.listBranchGeofences(),
        geofenceService.list(),
      ])

      const existingFenceIds = new Set(fencesData.map((f) => f.branchId))
      const implicitFences = branchesData
        .filter((b) => !existingFenceIds.has(b.id) && b.latitude != null && b.longitude != null)
        .map((b) => ({
          id: null,
          branchId: b.id,
          branchName: b.branch_name,
          branchCode: b.branch_code,
          latitude: b.latitude,
          longitude: b.longitude,
          radiusMeters: b.geofence_radius || 150,
          isActive: b.geofence_active !== false,
        }))

      setFences([...fencesData, ...implicitFences])
    } catch (e) {
      setError(geofenceErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // The tester always has a target: the row's Test action wins, otherwise
  // the first fence in the list.
  const activeTestBranchId = fences.some((f) => f.branchId === testBranchId)
    ? testBranchId
    : (fences[0]?.branchId ?? null)

  const openAddDialog = async () => {
    setAddOpen(true)
    setAddLoading(true)
    setAddError(null)
    setAddBranches([])
    try {
      setAddBranches(await geofenceService.listBranchesWithoutFence(fences))
    } catch (e) {
      setAddError(geofenceErrorMessage(e))
    } finally {
      setAddLoading(false)
    }
  }

  const startAdd = (branch) => {
    setAddOpen(false)
    setEditing({ branch })
  }

  const handleSave = async ({ latitude, longitude, radiusMeters }) => {
    if (!editing) return
    const branchId = editing.fence ? editing.fence.branchId : editing.branch.id
    const branchName = editing.fence ? editing.fence.branchName : editing.branch.branch_name
    const isActive = editing.fence
      ? editing.fence.isActive
      : editing.branch.geofence_active !== false

    setBusy(true)
    setBusyId(branchId)
    setFlash(null)
    try {
      const result = await geofenceService.saveBranchGeofence({
        branchId,
        latitude,
        longitude,
        radiusMeters,
        isActive,
      })
      setFences(result.fences)
      setEditing(null)
      setFlash({ tone: 'ok', text: `Fence saved for ${branchName}.` })
    } catch (e) {
      setFlash({ tone: 'error', text: geofenceErrorMessage(e) })
    } finally {
      setBusy(false)
      setBusyId(null)
    }
  }

  const handleToggle = async (fence, next) => {
    setBusy(true)
    setBusyId(fence.branchId)
    setFlash(null)
    try {
      const result = await geofenceService.setBranchGeofenceActive(fence.branchId, next)
      setFences(result.fences)
      setFlash({
        tone: 'ok',
        text: `${next ? 'Enabled' : 'Disabled'} the fence for ${fence.branchName}.`,
      })
    } catch (e) {
      setFlash({ tone: 'error', text: geofenceErrorMessage(e) })
    } finally {
      setBusy(false)
      setBusyId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    setBusyId(deleteTarget.branchId)
    setDeleteError(null)
    try {
      const result = await geofenceService.deleteBranchGeofence(deleteTarget.branchId)
      setFences(result.fences)
      setFlash({ tone: 'ok', text: `Fence deleted for ${deleteTarget.branchName}. Legacy copies were disabled, not erased.` })
      setDeleteTarget(null)
      if (editing?.fence?.branchId === deleteTarget.branchId) setEditing(null)
    } catch (e) {
      // P0002 -> "No fence configured", 42501 -> the role message.
      setDeleteError(geofenceErrorMessage(e))
    } finally {
      setBusy(false)
      setBusyId(null)
    }
  }

  const handleTest = (fence) => {
    setTestBranchId(fence.branchId)
    testerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const editorTarget = editing?.fence || editing?.branch || null

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Crosshair className="h-6 w-6 text-[#009944]" />
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Geofence Settings</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Branch fences and the coverage tester. Signed in as {userName}.
          </p>
        </div>
      </div>

      {flash && (
        <div
          role="status"
          className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
            flash.tone === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          <span>{flash.text}</span>
          <button
            type="button"
            onClick={() => setFlash(null)}
            aria-label="Dismiss message"
            className="rounded p-0.5 opacity-60 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* A. Fence list */}
      <GeofenceList
        fences={fences}
        loading={loading}
        error={error}
        busy={busy}
        busyId={busyId}
        onRetry={load}
        onAdd={openAddDialog}
        onEdit={(fence) => setEditing({ fence })}
        onToggle={handleToggle}
        onDelete={(fence) => {
          setDeleteError(null)
          setDeleteTarget(fence)
        }}
        onTest={handleTest}
      />

      {/* B. Fence editor */}
      {editing ? (
        <GeofenceMapEditor
          key={`${editorTarget.branchId || editorTarget.id}-${editing.fence ? 'edit' : 'add'}`}
          branch={
            editing.fence
              ? { branchId: editing.fence.branchId, branchName: editing.fence.branchName, branchCode: editing.fence.branchCode }
              : { branchId: editing.branch.id, branchName: editing.branch.branch_name, branchCode: editing.branch.branch_code }
          }
          initial={{
            lat: editing.fence
              ? (editing.fence.latitude ?? FALLBACK_CENTRE.lat)
              : (editing.branch.latitude ?? FALLBACK_CENTRE.lat),
            lng: editing.fence
              ? (editing.fence.longitude ?? FALLBACK_CENTRE.lng)
              : (editing.branch.longitude ?? FALLBACK_CENTRE.lng),
            radiusMeters: editing.fence
              ? (editing.fence.radiusMeters ?? 150)
              : (editing.branch.geofence_radius || 150),
            locked: true,
          }}
          isActive={
            editing.fence ? editing.fence.isActive : editing.branch.geofence_active !== false
          }
          busy={busy}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center dark:border-slate-600 dark:bg-slate-800">
          <MapPin className="mx-auto mb-2 h-6 w-6 text-slate-400" />
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">No fence selected</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Press Edit on a row to move an existing fence, or Add fence to place one for a branch that has none.
          </p>
        </section>
      )}

      {/* C. Test My Coverage */}
      <div ref={testerRef}>
        <CoverageTester
          fences={fences}
          branchId={activeTestBranchId}
          onBranchChange={setTestBranchId}
        />
      </div>

      <AddFenceDialog
        open={addOpen}
        branches={addBranches}
        loading={addLoading}
        error={addError}
        onRetry={openAddDialog}
        onSelect={startAdd}
        onClose={() => setAddOpen(false)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget ? `Delete the fence for ${deleteTarget.branchName}?` : ''}
        message="The canonical fence row is removed. The legacy copies on branches and attendance are switched off (never erased) so historical clock-ins keep resolving."
        detail={deleteTarget && deleteTarget.latitude != null
          ? `Removing ${deleteTarget.latitude.toFixed(6)}, ${deleteTarget.longitude.toFixed(6)} · ${deleteTarget.radiusMeters} m`
          : null}
        confirmLabel="Delete fence"
        danger
        busy={busy}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (busy) return
          setDeleteTarget(null)
          setDeleteError(null)
        }}
      />
    </div>
  )
}
