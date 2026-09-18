import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Database, Eraser, Loader2, Search, ShieldAlert, Trash2 } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { AccessDenied, LoadingState } from '../components/PageStates'
import { platformResetService } from '../services/platformResetService'

// ============================================================
// PLATFORM RESET — Super Admin only.
// Lets a Super Admin reset the whole platform, clear selected
// areas, or delete specific records before going live.
// Server-side RPCs (schema_phase44) re-verify the role.
// ============================================================

function CountText({ count }) {
  return (
    <span className={`text-xs font-semibold tabular-nums ${count > 0 ? 'text-slate-700' : 'text-slate-400'}`}>
      {count.toLocaleString()} row{count === 1 ? '' : 's'}
    </span>
  )
}

export default function PlatformReset() {
  const { role, name } = useAuth()
  const [counts, setCounts] = useState(null)
  const [selected, setSelected] = useState([])
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState({ kind: '', text: '' })
  const [fullConfirm, setFullConfirm] = useState('')
  const [showFullWizard, setShowFullWizard] = useState(false)

  // Delete-particular-record state
  const [entity, setEntity] = useState('')
  const [recordId, setRecordId] = useState('')

  const isSuperAdmin = role === 'super_admin'

  const refreshCounts = async () => {
    try {
      const data = await platformResetService.getCounts()
      setCounts(data)
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Unable to load reset counts.' })
    }
  }

  useEffect(() => {
    if (isSuperAdmin) refreshCounts()
  }, [isSuperAdmin])

  const stats = useMemo(() => {
    if (!counts) return { byArea: {}, total: 0 }
    return { byArea: counts.areas || {}, total: counts.total || 0 }
  }, [counts])

  const selectedCount = useMemo(
    () => (selected || []).reduce((sum, key) => sum + (stats.byArea[key]?.count || 0), 0),
    [selected, stats.byArea],
  )

  if (!isSuperAdmin) return <AccessDenied />

  const toggleArea = (key) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  const runReset = async (areas) => {
    setBusy(true)
    setMessage({})
    try {
      const res = await platformResetService.resetAreas(areas)
      setMessage({ kind: 'ok', text: `Reset complete — ${res?.removed ?? 0} rows removed across ${areas.length} area${areas.length === 1 ? '' : 's'}.` })
      setSelected([])
      setConfirmText('')
      setShowFullWizard(false)
      setFullConfirm('')
      await refreshCounts()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Reset failed.' })
    } finally {
      setBusy(false)
    }
  }

  const runFullReset = async () => {
    setBusy(true)
    setMessage({})
    try {
      const res = await platformResetService.resetAll()
      setMessage({ kind: 'ok', text: `Full platform reset complete — ${res?.removed ?? 0} rows removed.` })
      setShowFullWizard(false)
      setFullConfirm('')
      await refreshCounts()
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Full reset failed.' })
    } finally {
      setBusy(false)
    }
  }

  const runDelete = async () => {
    if (!entity || !recordId.trim()) return
    setBusy(true)
    setMessage({})
    try {
      const res = await platformResetService.deleteRecord(entity, recordId.trim())
      if (res?.ok === false) {
        setMessage({ kind: 'error', text: res.message || 'Record not found.' })
      } else {
        setMessage({ kind: 'ok', text: `Deleted ${res?.deleted ?? 0} record(s).` })
        setRecordId('')
        await refreshCounts()
      }
    } catch (e) {
      setMessage({ kind: 'error', text: e?.message || 'Delete failed.' })
    } finally {
      setBusy(false)
    }
  }

  const selectedAreas = platformResetService.RESET_AREAS.filter((a) => selected.includes(a.key))
  const selectedNames = selectedAreas.map((a) => a.label.toLowerCase()).join(', ')

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 mb-1 flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-rose-600" /> Platform Reset
          </h2>
          <p className="text-sm text-slate-500">
            Super-admin only. Reset the whole platform, clear selected areas, or delete specific records — ideal before going live. Master data (employees, branches, departments, settings, configurations) is never touched.
          </p>
        </div>
      </div>

      {message.text && (
        <div className={`mb-5 px-4 py-3 rounded-xl text-sm border ${message.kind === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
          {message.text}
        </div>
      )}

      {stats.total > 0 && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800">
            There are currently <strong>{stats.total.toLocaleString()}</strong> transactional records across your reset areas. Clearing them is permanent and cannot be undone.
          </p>
        </div>
      )}

      {/* -------------------------------------------------- */}
      {/* FULL PLATFORM RESET                                */}
      {/* -------------------------------------------------- */}
      <div className="bg-white rounded-2xl border border-rose-200 p-5 mb-6 shadow-sm">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <h3 className="text-lg font-semibold text-rose-700 flex items-center gap-2">
              <Eraser className="w-5 h-5" /> Reset Entire Platform
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              Wipes every reset area (attendance, payroll, onboarding, chat, KPIs, audit, banking, and more) in one transaction. Employees, profiles, branches and all configurations are preserved.
            </p>
          </div>
          <CountText count={stats.total} />
        </div>

        {!showFullWizard ? (
          <button
            onClick={() => setShowFullWizard(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700"
          >
            <Eraser className="w-4 h-4" /> Begin Full Reset
          </button>
        ) : (
          <div className="border-t border-rose-100 pt-4 space-y-3">
            <p className="text-sm text-slate-700">
              This will permanently delete <strong>{stats.total.toLocaleString()}</strong> records. Type{' '}
              <code className="px-1.5 py-0.5 rounded bg-slate-100 text-rose-700 font-mono text-xs">RESET PLATFORM</code> to confirm.
            </p>
            <input
              type="text"
              value={fullConfirm}
              onChange={(e) => setFullConfirm(e.target.value)}
              placeholder="Type RESET PLATFORM"
              className="w-full sm:w-80 h-10 px-3 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-rose-500"
            />
            <div className="flex gap-2">
              <button
                onClick={runFullReset}
                disabled={busy || fullConfirm.trim().toUpperCase() !== 'RESET PLATFORM'}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-40"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eraser className="w-4 h-4" />} Confirm Full Reset
              </button>
              <button
                onClick={() => { setShowFullWizard(false); setFullConfirm('') }}
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* -------------------------------------------------- */}
      {/* SELECTED AREAS RESET                               */}
      {/* -------------------------------------------------- */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-6 shadow-sm">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Database className="w-5 h-5 text-[#009944]" /> Select Areas to Reset
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              Tick the areas you want to clear. Records removed: {selectedCount.toLocaleString()}.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setSelected(platformResetService.RESET_AREAS.map((a) => a.key))}
              className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium hover:bg-slate-50"
            >
              Select all
            </button>
            <button
              onClick={() => setSelected([])}
              className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium hover:bg-slate-50"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          {platformResetService.RESET_AREAS.map((area) => {
            const count = stats.byArea[area.key]?.count || 0
            const checked = selected.includes(area.key)
            return (
              <button
                key={area.key}
                onClick={() => toggleArea(area.key)}
                className={`text-left rounded-xl border p-3.5 transition ${checked ? 'border-[#009944] bg-emerald-50/60' : 'border-slate-200 hover:bg-slate-50'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <input type="checkbox" readOnly checked={checked} className="w-4 h-4 accent-[#009944]" />
                    <span className="text-sm font-medium text-slate-800">{area.label}</span>
                  </div>
                  <CountText count={count} />
                </div>
                <p className="text-xs text-slate-500 mt-1.5 pl-7">{area.description}</p>
              </button>
            )
          })}
        </div>

        {selected.length > 0 && (
          <div className="border-t border-slate-100 pt-4 space-y-3">
            <p className="text-sm text-slate-700">
              You are about to clear <strong>{selectedCount.toLocaleString()}</strong> records in:{' '}
              <strong className="text-rose-600">{selectedNames}</strong>.
              Type <code className="px-1.5 py-0.5 rounded bg-slate-100 text-rose-700 font-mono text-xs">RESET</code> to confirm.
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type RESET"
              className="w-full sm:w-64 h-10 px-3 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-rose-500"
            />
            <div className="flex gap-2">
              <button
                onClick={() => runReset(selected)}
                disabled={busy || confirmText.trim().toUpperCase() !== 'RESET'}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Reset Selected Areas
              </button>
              <button
                onClick={() => { setSelected([]); setConfirmText('') }}
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* -------------------------------------------------- */}
      {/* DELETE A SPECIFIC RECORD                           */}
      {/* -------------------------------------------------- */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2 mb-1">
          <Search className="w-5 h-5 text-slate-500" /> Delete a Specific Record
        </h3>
        <p className="text-sm text-slate-500 mb-4">
          Remove one precise record by type and ID — useful for cleaning up a single bad row without touching anything else.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Record type</label>
            <select
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              className="w-full h-10 px-3 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#009944]"
            >
              <option value="">Select record type...</option>
              {platformResetService.DELETE_ENTITIES.map((en) => (
                <option key={en.key} value={en.key}>{en.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Record ID (UUID)</label>
            <input
              type="text"
              value={recordId}
              onChange={(e) => setRecordId(e.target.value)}
              placeholder="e.g. 3f47e04c-…"
              className="w-full h-10 px-3 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#009944] font-mono"
            />
          </div>
          <button
            onClick={runDelete}
            disabled={busy || !entity || !recordId.trim()}
            className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete Record
          </button>
        </div>
      </div>
    </div>
  )
}