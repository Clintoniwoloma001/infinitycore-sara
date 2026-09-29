// ============================================================================
// §20 Branch review + §15 split workflow
// ============================================================================
// Two kinds of issue are surfaced separately:
//   * MISSING - BankOne has a branch InfinityCore does not
//   * MERGED  - InfinityCore has ONE row covering SEVERAL BankOne branches
//               (e.g. "MUSHIN/YABA", "AGEGE & EGBEDA"). These are never
//               auto-merged: that would fabricate a branch-level number.
import React, { useMemo, useState } from 'react'
import { Check, Loader2, Scissors, AlertTriangle } from 'lucide-react'
import bankonePortfolioService from '../../services/bankonePortfolioService'
import { normalizeBranch } from '../../domains/bankone/normalize.js'

/** Separators that indicate one InfinityCore row covers several real branches. */
const MERGE_SPLIT = /\s*[&/]\s*/i

const money = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG')

export default function BranchReview({ state, branches, batchId, onDone }) {
  // §16 The review screen is rebuilt from persisted decisions, so it survives a
  // refresh. branches: [{ raw_branch_name, normalized_branch_name, branch_id,
  //                      branch_name, decision, mapping_method, loan_count,
  //                      outstanding_total }]
  const decisions = state?.branches || []
  const issues = decisions.filter((b) => b.decision === 'pending')
  const resolved = decisions.filter((b) => b.decision !== 'pending')
  const [choice, setChoice] = useState({})
  const [busyKey, setBusyKey] = useState(null)
  const [splitFor, setSplitFor] = useState(null)
  const [splitNames, setSplitNames] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null)

  const active = branches.filter((b) => (b.status || 'active') === 'active')

  const run = async (key, fn) => {
    setBusyKey(key); setError(null)
    try { await fn() } catch (e) { setError(e.message || String(e)) } finally { setBusyKey(null) }
  }

  const accept = (item) => {
    const branchId = choice[item.normalized_branch_name]
    if (!branchId) {
      setError('Choose the InfinityCore branch this BankOne branch maps to.')
      return
    }
    return run(item.normalized_branch_name, async () => {
      // §17 The RPC now reports rows_affected. A mapping that changed nothing is
      // NOT reported as success - that silent no-op was the reported bug.
      const res = await bankonePortfolioService.confirmBranch({
        normalizedBranchName: item.normalized_branch_name,
        bankoneBranchName: item.raw_branch_name,
        canonicalBranchId: branchId,
        mappingType: 'normalized',
      })
      const affected = Number(res?.rows_affected ?? 0)
      await onDone(
        affected > 0
          ? `"${item.raw_branch_name}" mapped — ${affected} loan(s) updated.`
          : `"${item.raw_branch_name}" mapping saved, but no new loans matched it (they were already resolved).`,
      )
    })
  }

  /**
   * Turn an opaque PostgREST "in the schema cache" failure into a real
   * diagnosis, using the signature the server reports as actually deployed.
   */
  const describeSplitFailure = async (e) => {
    const base = e?.message || String(e)
    if (!/schema cache|Could not find the function|PGRST202/i.test(base)) return base
    let sig = null
    try { sig = await bankonePortfolioService.getSplitBranchSignature() } catch { /* probe absent */ }
    if (!sig) {
      return `${base}\n\nThe database does not expose the split-branch contract. Apply migration ` +
        `20260931000003_bankone_split_branch_contract.sql in the Supabase SQL Editor, then reload the schema.`
    }
    if (!sig.exists) {
      return `${base}\n\nsplit_bankone_branch is not present on the database. Apply migrations ` +
        `20260931000002 and 20260931000003, then reload the PostgREST schema.`
    }
    if (Number(sig.overload_count) > 1) {
      return `${base}\n\nThe database has ${sig.overload_count} overloads of split_bankone_branch, ` +
        `so PostgREST cannot resolve the call. Apply 20260931000003 to restore a single definition.`
    }
    const deployed = (sig.args || []).map((a) => `${a.name} ${a.type}`).join(', ')
    return `${base}\n\nThe database is expecting: (${deployed}). ` +
      `This build sends: (p_parent_branch_id, p_new_branch_names, p_source_import_id, p_reason). ` +
      `If those differ, reload the app so it runs the current build.`
  }

  const doSplit = (m) => {
    const names = splitNames.split(',').map((s) => s.trim()).filter(Boolean)
    if (names.length < 2) { setError('List at least two real branch names, separated by commas.'); return }
    if (!reason.trim()) { setError('A reason is required to split a branch.'); return }
    return run(`split-${m.branch_id}`, async () => {
      let res
      try {
        res = await bankonePortfolioService.splitBranch({
          parentBranchId: m.branch_id, newBranchNames: names, importId: batchId, reason: reason.trim(),
        })
      } catch (e) {
        // Replace the opaque PostgREST text with the real cause.
        const diagnosis = await describeSplitFailure(e)
        setError(diagnosis)
        throw new Error(diagnosis)
      }
      const repointed = Number(res?.rows_repointed ?? 0)
      const created = (res?.created_branch_ids || []).length
      const reused = (res?.reused_branch_ids || []).length
      const total = created + reused
      setSplitFor(null); setSplitNames(''); setReason('')
      await onDone(
        `Split into ${total} branch${total === 1 ? '' : 'es'} (${created} created, ${reused} reused), ` +
        `re-pointing ${repointed} loan(s). The combined branch was deactivated, not deleted, ` +
        `so no history was lost.`,
      )
    })
  }

  // §14 MERGED InfinityCore branches (e.g. "KETU & HEAD OFFICE", "MUSHIN/YABA")
  // that cover SEVERAL BankOne branches. Detected from the REAL branch master
  // now (not from a client-side guess), and never auto-merged: merging would
  // fabricate a branch-level figure.
  const merged = useMemo(() => {
    const byNorm = new Map(active.map((b) => [normalizeBranch(b.branch_name), b]))
    const covered = new Set(decisions.map((d) => d.normalized_branch_name))
    const out = []
    for (const b of active) {
      const parts = String(b.branch_name || '').split(MERGE_SPLIT)
        .map((p) => normalizeBranch(p)).filter(Boolean)
      if (parts.length < 2) continue
      const hits = parts.filter((p) => covered.has(p))
      if (hits.length) out.push({ branch: b, parts, covers: hits })
    }
    return out
  }, [active, decisions])

  if (decisions.length === 0) {
    return <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      Every BankOne branch in this import maps to exactly one InfinityCore branch.
    </p>
  }


  return (
    <div className="space-y-4">
      {/* whitespace-pre-line so a multi-line contract diagnosis stays readable */}
      {error && (
        <p className="whitespace-pre-line rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700">
          {error}
        </p>
      )}

      {/* §14 MERGED structures first - they change the bank-wide shape. */}
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
                    Splitting deactivates the combined row; employees, attendance and loans keep their
                    original branch.
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
                      <input value={reason} onChange={(e) => setReason(e.target.value)}
                        placeholder="Why is this being split?"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setSplitFor(null)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600">Cancel</button>
                      <button onClick={() => doSplit(m)} disabled={busyKey === `split-${m.branch_id}`}
                        className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                        {busyKey === `split-${m.branch_id}`
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Split branch'}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-branch mapping decisions. The loan count and outstanding are read
          from the persisted resolution, not recomputed from a local array. */}
      {issues.length > 0 && (
        <ul className="space-y-2">
          {issues.map((item) => {
            const key = item.normalized_branch_name
            const selected = choice[key] || ''
            const busy = busyKey === key
            return (
              <li key={key} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">{item.raw_branch_name}</div>
                    <div className="text-xs text-slate-500">
                      {item.branch_name
                        ? `Currently mapped to ${item.branch_name}`
                        : 'No InfinityCore branch match'}
                    </div>
                  </div>
                  <div className="shrink-0 rounded-lg bg-slate-50 px-3 py-1.5 text-right">
                    <div className="text-xs text-slate-500">{item.loan_count} loan{item.loan_count === 1 ? '' : 's'}</div>
                    <div className="text-sm font-bold text-slate-800">{money(item.outstanding_total)}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select value={selected}
                    onChange={(e) => setChoice((p) => ({ ...p, [key]: e.target.value }))}
                    className="min-w-[16rem] flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                    <option value="">Map to an InfinityCore branch…</option>
                    {active.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
                  </select>
                  <button onClick={() => accept(item)} disabled={busy || !selected}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#009944] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    {busy ? 'Saving...' : 'Accept'}
                  </button>
                  {busy && (
                    <span className="text-xs text-slate-500">
                      Saving branch mapping... updating {item.loan_count} loan(s)
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {resolved.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Resolved branches ({resolved.length})
          </h3>
          <ul className="mt-2 space-y-1">
            {resolved.map((b) => (
              <li key={b.normalized_branch_name}
                className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
                <span className="font-medium text-emerald-900">{b.raw_branch_name}</span>
                <span className="text-emerald-700">
                  → {b.branch_name || 'unresolved'} · {b.loan_count} loan(s)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
