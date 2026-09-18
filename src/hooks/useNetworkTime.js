import { useEffect, useState } from 'react'
import { getNetworkTime } from '../services/attendanceService'

const nowOnPerformanceClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Keeps a live clock anchored to Supabase server time. performance.now() is
 * monotonic, so changing the device clock after synchronization does not
 * move the displayed attendance time.
 */
export function useNetworkTime({ syncInterval = 5 * 60 * 1000 } = {}) {
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    let active = true

    const sync = async () => {
      try {
        const next = await getNetworkTime()
        if (!active) return
        setSnapshot(next)
        setError(null)
      } catch (e) {
        if (active) setError(e)
      }
    }

    sync()
    const syncId = setInterval(sync, syncInterval)
    return () => {
      active = false
      clearInterval(syncId)
    }
  }, [syncInterval])

  useEffect(() => {
    if (!snapshot) return undefined
    const tickId = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(tickId)
  }, [snapshot])

  const currentMs = snapshot
    ? snapshot.serverTimeMs + (nowOnPerformanceClock() - snapshot.referencePerformanceMs)
    : null

  return {
    now: currentMs == null ? null : new Date(currentMs),
    synced: Boolean(snapshot),
    error,
  }
}

export default useNetworkTime
