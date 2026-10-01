/**
 * Employee Master Reconciliation — the HR review centre for the reviewed
 * workbook (Phase 9/10/16/17).
 *
 * Upload -> preview (nothing written) -> apply safe rows -> clear the rest.
 *
 * Three rules this page holds to deliberately:
 *   1. nothing is ever shown as resolved optimistically — every row renders the
 *      real server state, and a failed action shows the real server reason;
 *   2. a conflict is never hidden behind a summary number;
 *   3. the supervisor label shown is ALWAYS the verbatim workbook value, with
 *      the proposed employee shown beside it, so a wrong link is obvious
 *      before anyone confirms it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload, CheckCircle2, AlertTriangle, GitBranch, Building2, ShieldAlert,
  Loader2, X, Search, RefreshCw, Users, Info,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import {
  previewMasterImport, applyMasterImport, getReviewQueue,
} from '../services/hrMasterService';
import { LoadingState, ErrorState, EmptyState } from '../components/PageStates';

const TONE = { slate: 'text-slate-900', green: 'text-emerald-700', amber: 'text-amber-700', red: 'text-red-700' };

const Stat = ({ label, value, tone = 'slate', hint }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-3">
    <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
    <div className={`text-xl font-bold ${TONE[tone]}`}>{value ?? 0}</div>
    {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
  </div>
);

const IDENTITY_LABEL = {
  staff_id_conflict: 'Staff ID used by more than one person',
  duplicate_name: 'Name matches several employees',
  unidentifiable: 'No usable identity',
  new_employee: 'New employee',
  match_existing: 'Matched',
};

const TIER_HINT = {
  prefix_truncated: 'the workbook name is cut short',
  token_permutation: 'the same name words in a different order',
  token_prefix_set: 'part of the name is cut short',
  token_subset: 'part of the name is missing',
  token_affix: 'part of the name is inside a longer word',
  typo_variant: 'the workbook name is misspelled',
  token_majority: 'most name words point to one employee',
  ambiguous: 'several employees are possible',
  organisation_body: 'an organisational body, not a person',
  unresolved: 'no employee in the master matches',
};
export default function EmployeeMasterReconciliation() {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [queue, setQueue] = useState(null);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [tab, setTab] = useState('identity');
  const [employees, setEmployees] = useState([]);
  const [branches, setBranches] = useState([]);
  const [filter, setFilter] = useState('');
  const [asAt, setAsAt] = useState(new Date().toISOString().slice(0, 10));

  const sessionId = result?.sessionId || null;

  useEffect(() => {
    (async () => {
      const [emp, br] = await Promise.all([
        supabase.from('employees').select('id, full_name, employee_code, department, position').order('full_name'),
        supabase.from('branches').select('id, branch_name, branch_code').order('branch_name'),
      ]);
      setEmployees(emp.data || []);
      setBranches(br.data || []);
    })();
  }, []);

  const refreshQueue = useCallback(async (sid) => {
    if (!sid) return;
    setLoadingQueue(true);
    const q = await getReviewQueue(sid);
    if (q.errors.length) setError(q.errors.join(' · '));
    setQueue(q);
    setLoadingQueue(false);
  }, []);

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(''); setResult(null); setQueue(null);
    setBusy('preview');
    try {
      setPreview(await previewMasterImport(file, asAt));
    } catch (err) {
      setError(err.message);
      setPreview(null);
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onApply = async () => {
    if (!preview) return;
    setError('');
    setBusy('apply');
    try {
      const r = await applyMasterImport(preview);
      setResult(r);
      setPreview(null);
      await refreshQueue(r.sessionId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const identityRows = useMemo(() => (queue?.people || []).filter(p =>
    !filter || `${p.full_name} ${p.staff_id || ''}`.toLowerCase().includes(filter.toLowerCase())),
  [queue, filter]);
  const supervisorRows = queue?.supervisors || [];
  const branchRows = queue?.branches || [];
  const outstanding = (queue?.people?.length || 0) + supervisorRows.length + branchRows.length;
const TABS = [
    { key: 'identity', label: 'Identity conflicts', icon: ShieldAlert, n: queue?.people?.length || 0 },
    { key: 'supervisors', label: 'Supervisor links', icon: GitBranch, n: supervisorRows.length },
    { key: 'branches', label: 'Branches', icon: Building2, n: branchRows.length },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Employee Master Reconciliation</h1>
        <p className="mt-1 text-sm text-slate-500">
          Import the reviewed HR workbook, see every change before it is written, then resolve what needs a decision.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1"><div className="font-semibold">Action failed</div>{error}</div>
          <button onClick={() => setError('')} aria-label="Dismiss"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-[180px_1fr_auto] md:items-end">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-600">Effective as at</span>
            <input type="date" value={asAt} onChange={e => setAsAt(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <p className="text-xs text-slate-500">
            Existing user accounts, profiles and history are never deleted or recreated. Only rows the
            reconciliation can prove are safe are applied; everything else waits for a decision below.
          </p>
          <div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onPick} />
            <button onClick={() => fileRef.current?.click()} disabled={busy === 'preview'}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60">
              {busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Choose workbook
            </button>
          </div>
        </div>
      </div>

      {preview && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold text-slate-800">Preview — nothing has been written yet</h2>
              <p className="text-xs text-slate-500">{preview.fileName}</p>
            </div>
            <button onClick={onApply} disabled={busy === 'apply'}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60">
              {busy === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Apply safe rows
            </button>
          </div>
          <SummaryStrip counts={preview.counts} />
          {preview.conflicts?.size > 0 && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4" />
                {preview.conflicts.size} staff ID(s) are used by more than one person
              </div>
              {Array.from(preview.conflicts.entries()).map(([id, names]) => (
                <div key={id} className="mt-1">
                  <code>{id}</code> — {names.join(' / ')}. Treated as separate people; these rows will not be applied.
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 font-semibold text-slate-800">Applied</h2>
          <SummaryStrip counts={result.result} />
          <p className="mt-2 text-xs text-slate-500">
            Session {String(result.sessionId).slice(0, 8)} — re-uploading the same file reuses this
            session instead of creating people twice.
          </p>
        </div>
      )}

      {sessionId && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-slate-800">Decisions required ({outstanding})</h2>
            <button onClick={() => refreshQueue(sessionId)} disabled={loadingQueue}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
              {loadingQueue ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </button>
          </div>

          {loadingQueue ? <LoadingState label="Loading review queue…" /> : outstanding === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <CheckCircle2 className="h-9 w-9 text-emerald-500" />
              <div className="font-medium text-slate-800">Everything is resolved</div>
              <p className="text-sm text-slate-500">No identity conflicts, supervisor links or branch mappings are waiting.</p>
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-1 border-b border-slate-200">
                {TABS.map(t => (
                  <button key={t.key} onClick={() => setTab(t.key)}
                    className={`flex items-center gap-2 px-3 py-2 text-sm font-medium ${tab === t.key ? 'border-b-2 border-emerald-600 text-emerald-700' : 'text-slate-500 hover:text-slate-700'}`}>
                    <t.icon className="h-4 w-4" />{t.label}
                    {t.n > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{t.n}</span>}
                  </button>
                ))}
              </div>

              {tab === 'identity' && (
                <div className="relative mb-3">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input value={filter} onChange={e => setFilter(e.target.value)}
                    placeholder="Search by name or staff ID…"
                    className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm" />
                </div>
              )}

              <div className="space-y-2">
                {tab === 'identity' && identityRows.map(it => (
                  <IdentityRow key={it.id} item={it} employees={employees} onDone={() => refreshQueue(sessionId)} onError={setError} />
                ))}
                {tab === 'supervisors' && supervisorRows.map(it => (
                  <SupervisorRow key={it.id} item={it} employees={employees} onDone={() => refreshQueue(sessionId)} onError={setError} />
                ))}
                {tab === 'branches' && branchRows.map(it => (
                  <BranchRow key={it.id} item={it} branches={branches} onDone={() => refreshQueue(sessionId)} onError={setError} />
                ))}
                {((tab === 'identity' && identityRows.length === 0) ||
                  (tab === 'supervisors' && supervisorRows.length === 0) ||
                  (tab === 'branches' && branchRows.length === 0)) && (
                  <EmptyState title="Nothing in this queue" description="All items of this type are resolved." />
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryStrip({ counts }) {
  if (!counts) return null;
  const n = counts.people ?? counts.awaiting_review;
  const items = [
    ['People', n, 'slate'],
    ['Matched', counts.matched, 'green'],
    ['New', counts.new_employees, 'slate'],
    ['Conflicts', counts.conflicts, counts.conflicts ? 'red' : 'slate'],
    ['Multi-branch', counts.multi_branch_people, 'slate'],
    ['Supervisors applied', counts.supervisors_applied ?? counts.supervisor_links, 'green'],
    ['Awaiting review', counts.awaiting_review ?? counts.supervisors_pending, counts.awaiting_review ? 'amber' : 'slate'],
  ].filter(([, v]) => v !== undefined);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {items.map(([label, v, tone]) => <Stat key={label} label={label} value={v} tone={tone} />)}
    </div>
  );
}
const card = 'rounded-lg border border-amber-200 bg-amber-50/40 p-3';
const chip = 'rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800';

/** Shared confirm/skip controls. The real server error is surfaced, never swallowed. */
function ResolveBar({ hint, options, optionLabel, value, onChange, busy, onApply, onSkip, reason, setReason, applyLabel = 'Confirm' }) {
  const selected = options.find(o => o.id === value);
  return (
    <div className="mt-2 space-y-2">
      {hint && <p className="flex items-start gap-1.5 text-xs text-slate-600"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />{hint}</p>}
      {selected && (
        <p className="text-xs text-emerald-800">
          Will link to <strong>{optionLabel(selected)}</strong>. This is remembered, so the same workbook name resolves automatically next time.
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto]">
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-slate-600">Correct person / branch</span>
          <select value={value} onChange={e => onChange(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
            <option value="">— choose —</option>
            {options.map(o => <option key={o.id} value={o.id}>{optionLabel(o)}</option>)}
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-slate-600">Reason (recorded in the audit log)</span>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why this is correct"
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
        </label>
        <div className="flex items-end gap-2">
          <button onClick={onApply} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{applyLabel}
          </button>
          <button onClick={onSkip} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
            <X className="h-4 w-4" />Leave unresolved
          </button>
        </div>
      </div>
    </div>
  );
}

const empLabel = e => `${e.full_name || '(no name)'}${e.employee_code ? ` — ${e.employee_code}` : ''}`;
const brLabel = b => `${b.branch_name}${b.branch_code ? ` — ${b.branch_code}` : ''}`;

/** Shared resolver so all three row types behave identically and show real errors. */
function useResolve(rpcName, argName) {
  const [busy, setBusy] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [reason, setReason] = useState('');
  const act = async (skip, onDone, onError, extra) => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc(rpcName, {
        [argName]: extra, p_reason: reason,
        ...(skip ? {} : { p_employee_id: employeeId || null }),
      });
      if (error) throw new Error(error.message);
      setReason(''); setEmployeeId('');
      await onDone();
    } catch (err) {
      onError(err.message);
    } finally { setBusy(false); }
  };
  return { busy, employeeId, setEmployeeId, reason, setReason, act };
}

function IdentityRow({ item, employees, onDone, onError }) {
  const r = useResolve('hr_resolve_identity', 'p_person_id');
  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium text-slate-800">{item.full_name}</div>
          <div className="text-xs text-slate-500">
            {item.staff_id || 'no staff id'} · {item.designation || '—'} · {item.department || '—'}
            {item.sheets?.length ? ` · ${item.sheets.join(' + ')}` : ''}
          </div>
        </div>
        <span className={chip}>{IDENTITY_LABEL[item.identity_kind] || item.identity_kind}</span>
      </div>
      {item.reason && <p className="mt-1 text-xs text-amber-800">{item.reason}</p>}
      <ResolveBar hint="Choose which existing employee this workbook row belongs to, or leave it unresolved." options={employees}
        optionLabel={empLabel} value={r.employeeId} onChange={r.setEmployeeId} busy={r.busy}
        reason={r.reason} setReason={r.setReason}
        onApply={() => r.act(false, onDone, onError, item.id)}
        onSkip={() => r.act(true, onDone, onError, item.id)} />
    </div>
  );
}

function SupervisorRow({ item, employees, onDone, onError }) {
  const r = useResolve('hr_resolve_supervisor_link', 'p_link_id');
  const suggested = Array.isArray(item.candidates) && item.candidates.length ? item.candidates[0] : null;
  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium text-slate-800">
            {item.person_name} <span className="text-slate-400">({item.person_staff_id || 'no staff id'})</span>
          </div>
          <div className="text-xs text-slate-500">
            Level {item.level} — the workbook says <code className="font-semibold text-slate-700">{item.label}</code>
          </div>
        </div>
        <span className={chip}>{item.tier}</span>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        {TIER_HINT[item.tier] || item.tier}
        {suggested && <> · closest match: <strong>{suggested.full_name}</strong></>}
      </p>
      <ResolveBar hint="Confirm who this supervisor is. The choice is stored permanently for future imports." options={employees}
        optionLabel={empLabel} value={r.employeeId} onChange={r.setEmployeeId} busy={r.busy}
        reason={r.reason} setReason={r.setReason}
        onApply={() => r.act(false, onDone, onError, item.id)}
        onSkip={() => r.act(true, onDone, onError, item.id)} />
    </div>
  );
}

function BranchRow({ item, branches, onDone, onError }) {
  const [busy, setBusy] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [reason, setReason] = useState('');
  const act = async (skip, create) => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc('hr_resolve_branch_link', {
        p_link_id: item.id, p_branch_id: skip ? null : (branchId || null),
        p_reason: reason, p_create_missing: create,
      });
      if (error) throw new Error(error.message);
      setReason(''); setBranchId('');
      await onDone();
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium text-slate-800">{item.label}</div>
          {item.is_combined && <div className="text-xs text-slate-500">Combined label covering: {item.parts?.join(' · ')}</div>}
        </div>
        <span className={chip}>{item.is_combined ? 'combined label' : 'no branch match'}</span>
      </div>
      <ResolveBar hint="Map this workbook branch label to an existing branch, or create the canonical branch." options={branches}
        optionLabel={brLabel} value={branchId} onChange={setBranchId} busy={busy}
        reason={reason} setReason={setReason} applyLabel="Map"
        onApply={() => act(false, !branchId)}
        onSkip={() => act(true, false)} />
    </div>
  );
}
