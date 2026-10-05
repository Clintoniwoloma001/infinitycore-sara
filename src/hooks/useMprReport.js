/**
 * Loads one period of MPR inputs and evaluates them with the shared engine.
 *
 * The hook owns the "which period?" decision and the loading/error lifecycle;
 * it deliberately does no scoring itself — evaluateMpr is the only scorer.
 */
import { useCallback, useEffect, useState } from 'react'
import { evaluateMpr } from '../domains/performance/mprEngine.js'
import { currentPeriodLabel, latestPeriodWithData, loadMprRows } from '../services/mprService'

export function useMprReport(periodLabel) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [resolvedPeriod, setResolvedPeriod] = useState(periodLabel || currentPeriodLabel())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // With no explicit period, show the most recent one that has data rather
      // than an empty current month.
      const period = periodLabel || (await latestPeriodWithData())
      const data = await loadMprRows(period)
      setResolvedPeriod(period)
      setRows(data.map((r) => ({ ...r, evaluation: evaluateMpr(r) })))
    } catch (e) {
      setError(e.message || 'Could not load MPR data.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [periodLabel])

  useEffect(() => { refresh() }, [refresh])

  return { rows, loading, error, periodLabel: resolvedPeriod, refresh }
}