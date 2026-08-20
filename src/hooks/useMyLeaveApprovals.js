import { useCallback, useEffect, useState } from 'react'
import { leaveRequests as svc } from '../services/supabaseService'
import { myQueue as computeMyQueue, currentStage, pendingAgeHours } from '../services/leaveApprovalsService'
import { useAuth } from './useAuth'

const POLL_MS = 60000 // refresh once a minute — enough for a live demo without hammering Supabase

// One shared read of "what's pending, and what's in MY queue" for the
// authenticated approver. The bell, the dashboard widget, and SARA all
// call this instead of each running their own Supabase query — one
// data source, one definition of "pending for me".
export function useMyLeaveApprovals() {
  const { user, role, isAdmin } = useAuth()
  const [all, setAll] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!user) { setAll([]); setLoading(false); return }
    try {
      const data = await svc.list()
      setAll(data)
      setError(null)
    } catch (e) {
      setError(e?.message || 'Failed to load leave requests')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const queue = computeMyQueue(all, { userId: user?.id, role, isAdmin })
  const oldest = queue.length ? queue.reduce((a, b) => (pendingAgeHours(a) > pendingAgeHours(b) ? a : b)) : null

  return {
    loading,
    error,
    queue,               // requests waiting on ME right now
    count: queue.length,
    oldest,               // the single oldest one, for "pending since ..." copy
    stageLabel: (r) => currentStage(r)?.label,
    refresh,
  }
}
