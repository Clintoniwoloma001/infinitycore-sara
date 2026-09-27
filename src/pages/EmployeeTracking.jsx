// ============================================================================
// Employee Tracking (Phase 70)
// ============================================================================
// Super Admin by default; a delegated user or role can also reach it while the
// grant is live. The decision is made by employee_tracking_access() on the
// server - this page renders that answer, it does not compute its own.
//
// No geofence logic lives here. Location resolution, inside/outside and the
// human-readable label all come from resolve_employee_location() via the RPCs,
// which is why this page can never disagree with the clock-in screen.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  MapPin, ShieldCheck, Share2, History, RefreshCw,
  Clock, Lock, AlertTriangle, Check, X, Map as MapIcon,
} from 'lucide-react'
import {
  trackingService, describeFreshness, formatCoord, formatClockTime, buildMovementTimeline,
} from '../services/employeeTrackingService'
import { ROLES } from '../constants/roles'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState, AccessDenied } from '../components/PageStates'
import LivePositions from '../components/tracking/LivePositions'
import MovementHistory from '../components/tracking/MovementHistory'
import SharedAccess from '../components/tracking/SharedAccess'

export default function EmployeeTracking() {
  const { profile } = useAuth()
  const [access, setAccess] = useState(null)
  const [accessError, setAccessError] = useState(null)
  const [tab, setTab] = useState('live')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const a = await trackingService.myAccess()
        if (alive) setAccess(a)
      } catch (e) {
        if (alive) setAccessError(e.message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  if (loading) return <LoadingState label="Checking tracking access..." />
  if (accessError) return <ErrorState title="Unable to check access" message={accessError} />
  if (!access?.can_view) {
    return (
      <AccessDenied>
        <p className="text-sm text-slate-600 mt-2">
          {access?.reason || 'Employee tracking requires an explicit grant from the Super Admin.'}
        </p>
      </AccessDenied>
    )
  }

  const isSuper = access.via === 'super_admin'

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Employee Tracking</h1>
          <p className="text-sm text-slate-500 mt-1">
            Live positions and movement history from recorded observations.
          </p>
        </div>
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
          isSuper ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {isSuper ? <ShieldCheck className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
          <div>
            <p className="font-semibold">
              {isSuper ? 'Full tracking access' : 'Delegated access'}
            </p>
            {access.expires_at && (
              <p>Expires {new Date(access.expires_at).toLocaleString()}</p>
            )}
          </div>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-slate-200">
        {[
          { id: 'live', label: 'Live positions', icon: MapPin },
          { id: 'history', label: 'Movement history', icon: History },
          ...(access.can_manage ? [{ id: 'access', label: 'Shared access', icon: Share2 }] : []),
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id
                ? 'border-[#009944] text-[#009944]'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </nav>

      {tab === 'live' && <LivePositions />}
      {tab === 'history' && <MovementHistory />}
      {tab === 'access' && access.can_manage && <SharedAccess />}
    </div>
  )
}
