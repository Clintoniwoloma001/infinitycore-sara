// ============================================================================
// §18/§19 Employee match review
// ============================================================================
// Every item shows the BankOne name, the possible InfinityCore employee, WHY it
// matched, the confidence, AND the financial impact (loan count + outstanding).
// The money is never hidden behind an expand - a mapping decision is a decision
// about someone's portfolio.
//
// §19 unresolved officers: [Add as employee] [Map to existing] [Leave unresolved]
import React, { useMemo, useState } from 'react'
import { Check, X, UserPlus, Loader2, Search } from 'lucide-react'
import bankonePortfolioService from '../../services/bankonePortfolioService'

const money = (n) => '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG')

const REASON_LABEL = {
  token_reorder: 'Same name words in a different order',
  truncation: 'BankOne source name appears truncated',
  high_confidence: 'Closest possible employee found',
  unresolved: 'No InfinityCore employee matches this name',
  existing_mapping: 'Resolved by a saved mapping',
}

export default function EmployeeReview({ result, employees, batchId, onDone }) {
  const items = result.unresolvedOfficers || []
  const [busyKey, setBusyKey] = useState(null)
  const [choice, setChoice] = useState({})
  const [query, setQuery] = useState('')
  const [confirmAdd, setConfirmAdd] = useState(null)
  const [error, setError] = useState(null)

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q) return items
    return items.filter((i) => i.sourceName.toUpperCase().includes(q))
  }, [items, query])

  const run = async (key, fn) => {
    setBusyKey(key); setError(null)
    try { await fn() } catch (e) { setError(e.message) } finally { setBusyKey(null) }
  }

  const confirm = (item) => {
    const employeeId = choice[item.normalizedSourceName] || item.candidates?.[0]?.id
    if (!employeeId) return
    return run(item.normalizedSourceName, async () => {
      await bankonePortfolioService.confirmOfficer({
        normalizedSourceName: item.normalizedSourceName,
        sourceName: item.sourceName,
        employeeId,
        matchType: item.matchType === 'unresolved' ? 'manual' : item.matchType,
        confidence: item.confidence ?? 1,
      })
      onDone(`"${item.sourceName}" is now linked. Future imports resolve it automatically.`)
    })
  }

  const keepUnresolved = (item) => run(item.normalizedSourceName, async () => {
    await bankonePortfolioService.leaveOfficerUnresolved({
      normalizedSourceName: item.normalizedSourceName,
      sourceName: item.sourceName,
      reason: 'Left unresolved after review',
    })
    onDone(`"${item.sourceName}" remains unresolved. Its portfolio stays unattributed.`)
  })

  const addAsEmployee = (item) => run(item.normalizedSourceName, async () => {
    await bankonePortfolioService.addEmployeeFromBankOne({
      sourceName: item.sourceName,
      normalizedSourceName: item.normalizedSourceName,
      branchNameRaw: item.branchNames?.[0] ?? null,
      importId: batchId,
    })
    setConfirmAdd(null)
    onDone(`Pending employee created for "${item.sourceName}". No account or compensation was invented.`)
  })

  if (items.length === 0) {
    return <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
      Every officer in this import is linked to an employee.
    </p>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          {items.length} officer{items.length === 1 ? '' : 's'} need a decision. Their portfolio is
          currently unattributed and is not counted against any person.
        </p>
        <label className="relative">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter names"
            className="w-44 rounded-lg border border-slate-300 py-1.5 pl-7 pr-2 text-sm" />
        </label>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <ul className="space-y-2">
        {filtered.map((item) => {
          const key = item.normalizedSourceName
          const busy = busyKey === key
          const selected = choice[key] || item.candidates?.[0]?.id || ''
          return (
            <li key={key} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900">{item.sourceName}</div>
                  <div className="text-xs text-slate-500">
                    {REASON_LABEL[item.matchType] || item.matchType}
                    {item.confidence ? ` · confidence ${(item.confidence * 100).toFixed(0)}%` : ''}
                    {item.branchNames?.length ? ` · ${item.branchNames.join(', ')}` : ''}
                  </div>
                  {item.reason && <div className="mt-0.5 text-xs text-slate-400">{item.reason}</div>}
                </div>
                {/* Financial impact is always visible, never behind an expand. */}
                <div className="shrink-0 rounded-lg bg-slate-50 px-3 py-1.5 text-right">
                  <div className="text-xs text-slate-500">{item.loanCount} loan{item.loanCount === 1 ? '' : 's'}</div>
                  <div className="text-sm font-bold text-slate-800">{money(item.outstandingTotal)}</div>
                </div>
              </div>

              {(item.candidates || []).length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Possible employee:{' '}
                  <strong>{(item.candidates || []).map((c) => c.full_name).join(' · ')}</strong>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  value={selected}
                  onChange={(e) => setChoice((p) => ({ ...p, [key]: e.target.value }))}
                  className="min-w-[16rem] flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                  <option value="">Choose an employee…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.full_name}{e.branch ? ` — ${e.branch}` : ''}</option>
                  ))}
                </select>
                <button onClick={() => confirm(item)} disabled={busy || !selected}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#009944] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}Confirm
                </button>
                <button onClick={() => setConfirmAdd(item)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700">
                  <UserPlus className="w-3.5 h-3.5" />Add as employee
                </button>
                <button onClick={() => keepUnresolved(item)} disabled={busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700">
                  <X className="w-3.5 h-3.5" />Leave unresolved
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {/* §19 Add-as-employee confirmation */}
      {confirmAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" role="dialog" aria-modal="true">
            <h3 className="text-lg font-semibold text-slate-900">Create a pending employee?</h3>
            <p className="mt-2 text-sm text-slate-600">
              This will create a <strong>pending employee record</strong> from verified BankOne
              source information ({confirmAdd.sourceName}). HR can complete the record later.
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-500">
              <li>No sign-in account is created.</li>
              <li>No email, salary, department or designation is invented.</li>
              <li>Future BankOne imports of this name resolve to the new record automatically.</li>
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmAdd(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600">Cancel</button>
              <button onClick={() => addAsEmployee(confirmAdd)}
                className="rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white">
                Create pending employee
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

