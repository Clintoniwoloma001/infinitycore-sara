// ============================================================================
// §20 Branch review + §15 split workflow
// ============================================================================
// Two kinds of issue are surfaced separately:
//   * MISSING - BankOne has a branch InfinityCore does not
//   * MERGED  - InfinityCore has ONE row covering SEVERAL BankOne branches
//               (e.g. "MUSHIN/YABA", "AGEGE & EGBEDA"). These are never
//               auto-merged: that would fabricate a branch-level number.
import React, { useMemo, useState } from 'react'
import { Check, Scissors, Loader2, AlertTriangle } from 'lucide-react'
import bankonePortfolioService from '../../services/bankonePortfolioService'

const money = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG')

export default function BranchReview({ result, branches, batchId, onDone }) {
  const issues = result.branchIssues || []
  const merged = result.mergedStructures || []
  const [choice, setChoice] = useState({})
  const [busyKey, setBusyKey] = useState(null)
  const [splitFor, setSplitFor] = useState(null)
  const [splitNames, setSplitNames] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)

  // How many loans / naira each BankOne branch carries, so the decision shows
  // its financial weight rather than just a name.
  const weight = useMemo(() => {
    const m = new Map()
    for (const r of result.records || []) {
      const k = r.branchNameRaw || '(blank)'
      if (!m.has(k)) m.set(k, { loans: 0, outstanding: 0 })
      const e = m.get(k)
      e.loans += 1
      e.outstanding = Math.round((e.outstanding + r.totalOutstanding) * 100) / 100
    }
    return m
  }, [result])

  const active = branches.filter((b) => (b.status || 'active') === 'active')

  const run = async (key, fn) => {
    setBusyKey(key); setError(null)
    try { await fn() } catch (e) { setError(e.message) } finally { setBusyKey(null) }
  }

  const accept = (item) => {
    const branchId = choice[item.normalizedSourceName]
    if (!branchId) return
    return run(item.normalizedSourceName, async () => {
      await bankonePortfolioService.confirmBranch({
        normalizedBranchName: item.normalizedSourceName,
        bankoneBranchName: item.sourceName,
        canonicalBranchId: branchId,
        mappingType: item.matchType === 'merged' ? 'merged' : 'normalized',
      })
      onDone(`"${item.sourceName}" is now mapped to a branch.`)
    })
  }

  const doSplit = (m) => {
    const names = splitNames.split(',').map((s) => s.trim()).filter(Boolean)
    if (names.length < 2) { setError('List at least two real branch names, separated by commas.'); return }
    if (!reason.trim()) { setError('A reason is required to split a branch.'); return }
    return run(`split-${m.branch.id}`, async () => {
      await bankonePortfolioService.splitBranch({
        parentBranchId: m.branch.id, newBranchNames: names, importId: batchId, reason: reason.trim(),
      })
      setSplitFor(null); setSplitNames(''); setReason('')
      onDone(`"${m.branch.branch_name}" was split into ${names.length} branches. The original was deactivated, not deleted, so no history was lost.`)
    })
  }

  if (issues.length === 0 && merged.length === 0) {
    return <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      Every BankOne branch maps to exactly one InfinityCore branch.
    </p>
  }


  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {/* MERGED structures first - they change the bank-wide shape. */}
      {merged.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4" />Branch structure review
          </h3>
          <p className="mt-1 text-xs text-amber-800">
            InfinityCore has combined branches that BankOne reports separately. Nothing is merged
            automatically - that would invent a branch-level figure.
          </p>
          <ul className="mt-3 space-y-2">
            {merged.map((m) => (
              <li key={m.branch.id} className="rounded-xl border border-amber-200 bg-white p-3">
                <div className="text-sm font-medium text-slate-900">
                  Current InfinityCore branch: {m.branch.branch_name}
                </div>
                <div className="text-xs text-slate-600">
                  BankOne branches inside it: <strong>{m.covers.join(', ')}</strong>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={() => { setSplitFor(m); setSplitNames(m.covers.join(', ')) }}
                    className="inline-flex items-center gap-1 rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-medium text-amber-800">
                    <Scissors className="h-3.5 w-3.5" />Split into BankOne branches
                  </button>
                  <span className="self-center text-[11px] text-amber-700">
                    Splitting deactivates the combined row; employees, attendance and loans keep their original branch.
                  </span>
                </div>
                {splitFor?.branch.id === m.branch.id && (
                  <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3">
                    <label className="block">
                      <span className="text-xs font-medium text-slate-700">Real branch names (comma separated)</span>
                      <input value={splitNames} onChange={(e) => setSplitNames(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-slate-700">Reason (required)</span>
                      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being split?"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setSplitFor(null)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600">Cancel</button>
                      <button onClick={() => doSplit(m)} disabled={busyKey === `split-${m.branch.id}`}
                        className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                        {busyKey === `split-${m.branch.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Split branch'}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}


      {/* Per-branch mapping decisions */}
      {issues.length > 0 && (
        <ul className="space-y-2">
          {issues.map((item) => {
            const key = item.normalizedSourceName
            const w = weight.get(item.sourceName) || { loans: 0, outstanding: 0 }
            const selected = choice[key] || item.candidates?.[0]?.id || ''
            return (
              <li key={key} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">{item.sourceName}</div>
                    <div className="text-xs text-slate-500">{item.reason}</div>
                    {item.mergeCandidates && (
                      <div className="mt-0.5 text-xs text-amber-700">
                        InfinityCore has a combined branch containing: {item.mergeCandidates.join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 rounded-lg bg-slate-50 px-3 py-1.5 text-right">
                    <div className="text-xs text-slate-500">{w.loans} loan{w.loans === 1 ? '' : 's'}</div>
                    <div className="text-sm font-bold text-slate-800">{money(w.outstanding)}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select value={selected} onChange={(e) => setChoice((p) => ({ ...p, [key]: e.target.value }))}
                    className="min-w-[16rem] flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                    <option value="">Map to an InfinityCore branch…</option>
                    {active.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
                  </select>
                  <button onClick={() => accept(item)} disabled={busyKey === key || !selected}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#009944] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                    {busyKey === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Accept
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
