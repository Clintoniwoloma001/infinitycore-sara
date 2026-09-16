import React, { useEffect, useState } from 'react'
import { AlertTriangle, Building2, CheckCircle2, Database, Loader2, Mail, MapPin, Network, RefreshCw, ShieldAlert, UserCog, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { hrOrganisationService } from '../services/hrOrganisationService'
import { userInvitationService } from '../services/userInvitationService'
import { employeeService } from '../services/employeeService'

const CONFIRM_BADGE = {
  CONFIRMED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  UNCONFIRMED: 'bg-amber-50 text-amber-700 border-amber-200',
  'CONTRACT STAFF': 'bg-sky-50 text-sky-700 border-sky-200',
}

// Each card is its own server-side query. Cards do NOT sum to the employee
// total — an employee can legitimately appear on several cards.
const CARDS = [
  { key: 'employees', label: 'Employees', tone: 'bg-white', about: 'Every employee record on file.' },
  { key: 'confirmed', label: 'Confirmed', tone: 'bg-emerald-50', about: 'Employees confirmed by HR.' },
  { key: 'unconfirmed', label: 'Unconfirmed', tone: 'bg-amber-50', about: 'Employees still awaiting HR confirmation. Review and confirm from here.' },
  { key: 'contract_staff', label: 'Contract', tone: 'bg-sky-50', about: 'Staff engaged on contract terms.' },
  { key: 'imported', label: 'Imported', tone: 'bg-white', about: 'Records that came from the bank master file.' },
  { key: 'departments', label: 'Departments', tone: 'bg-white', about: 'Departments seeded from the master file.' },
  { key: 'designations', label: 'Designations', tone: 'bg-white', about: 'Job designations and their headcount.' },
  { key: 'branches', label: 'Branches', tone: 'bg-white', about: 'Branch network with managers and headcount.' },
  { key: 'areas', label: 'Areas', tone: 'bg-white', about: 'Areas, their managers and branches.' },
  { key: 'area_managers', label: 'Area Mgrs', tone: 'bg-white', about: 'Employees holding an area manager position.' },
  { key: 'branch_managers', label: 'Branch Mgrs', tone: 'bg-white', about: 'Employees holding a branch manager position.' },
  { key: 'uninvited', label: 'Uninvited', tone: 'bg-rose-50', about: 'Employees without an app account. Invite them from here.' },
  { key: 'invited', label: 'Invited', tone: 'bg-white', about: 'Account invitations that have been issued.' },
  { key: 'open_issues', label: 'Open Issues', tone: 'bg-rose-50', about: 'Open hierarchy and data-quality exceptions.' },
]

const EMPLOYEE_CARDS = new Set(['employees', 'confirmed', 'unconfirmed', 'contract_staff', 'imported', 'uninvited', 'area_managers', 'branch_managers'])

// Derived readiness signals for an employee record. These explain why a record
// may still be UNCONFIRMED; they are not a hard gate on confirmation.
function blockers(row) {
  const out = []
  if (row.missing_email) out.push('Missing email address')
  if (row.missing_branch) out.push('No branch assigned')
  if (row.not_active) out.push(`Employment status: ${row.employment_status || 'unknown'}`)
  if (row.has_no_account) out.push('No app account yet')
  if (!row.onboarding_completed) out.push('Onboarding not approved')
  if (!row.guarantor_approved) out.push('Guarantor not approved')
  return out
}

export default function HROrganisation() {
  const { role } = useAuth()
  const canManage = role === 'super_admin' || role === 'admin' || role === 'hr_manager'
  const [summary, setSummary] = useState(null)
  const [departments, setDepartments] = useState([])
  const [designations, setDesignations] = useState([])
  const [branches, setBranches] = useState([])
  const [areas, setAreas] = useState([])
  const [exceptions, setExceptions] = useState([])
  const [dataIssues, setDataIssues] = useState([])
  const [batches, setBatches] = useState([])
  const [employees, setEmployees] = useState([])
  const [roleMappings, setRoleMappings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('structure')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const [drawer, setDrawer] = useState(null)
  const [rows, setRows] = useState([])
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [drawerError, setDrawerError] = useState('')
  const [selected, setSelected] = useState([])
  const [actionReason, setActionReason] = useState('')

  const loadAll = async () => {
    setLoading(true)
    setError('')
    try {
      const [s, depts, desig, brs, ars, exc, di, batches] = await Promise.all([
        hrOrganisationService.getSummary(),
        hrOrganisationService.listDepartments(),
        hrOrganisationService.listDesignations(),
        hrOrganisationService.listBranches(),
        hrOrganisationService.listAreas(),
        hrOrganisationService.listHierarchyExceptions(),
        hrOrganisationService.listDataQualityExceptions(),
        hrOrganisationService.listImportedBatches(),
      ])
      setSummary(s)
      setDepartments(depts)
      setDesignations(desig)
      setBranches(brs)
      setAreas(ars)
      setExceptions(exc)
      setDataIssues(di)
      setBatches(batches)
      setRoleMappings(await hrOrganisationService.listRoleMappings())
      try { setEmployees(await employeeService.list()) } catch { /* optional enrichment only */ }
    } catch (e) {
      setError(e?.message || 'Organisation data is unavailable. Run the phase 26 migration in Supabase, then retry.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  const exec = async (fn, okMsg) => {
    setBusy(true)
    setError('')
    setMsg('')
    try {
      await fn()
      setMsg(okMsg)
      loadAll()
    } catch (e) {
      setError(e?.message || 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const fetchPopulation = async (key) => {
    setDrawerLoading(true)
    setDrawerError('')
    setRows([])
    try {
      const data = key === 'invited'
        ? await userInvitationService.listInvites()
        : await hrOrganisationService.getPopulation(key)
      setRows(data)
    } catch (e) {
      setDrawerError(e?.message || 'Could not load this population.')
    } finally {
      setDrawerLoading(false)
    }
  }

  const openDrawer = (cardDef) => {
    const value = summary?.[cardDef.key] ?? 0
    setDrawer({ ...cardDef, count: value })
    setSelected([])
    setActionReason('')
    fetchPopulation(cardDef.key)
  }

  const closeDrawer = () => setDrawer(null)

  const toggleSelected = (id) => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  const toggleAll = () => {
    const ids = rows.map((r) => r.id || r.employee_id).filter(Boolean)
    setSelected((cur) => (cur.length === ids.length ? [] : ids))
  }

  const refreshDrawer = async () => {
    if (drawer) await fetchPopulation(drawer.key)
  }

  const confirmSelected = async () => {
    setBusy(true)
    setError('')
    setMsg('')
    try {
      const res = await hrOrganisationService.confirmEmployees(selected, actionReason || 'HR confirmation')
      const skipped = res?.skipped ? `, ${res.skipped} already confirmed or missing` : ''
      setMsg(`Confirmed ${res?.confirmed ?? 0} employee(s)${skipped}.`)
      setSelected([])
      setActionReason('')
      await loadAll()
      await refreshDrawer()
    } catch (e) {
      setError(e?.message || 'Confirmation failed')
    } finally {
      setBusy(false)
    }
  }

  const inviteSelected = async () => {
    setBusy(true)
    setError('')
    setMsg('')
    try {
      const res = await userInvitationService.inviteEmployees(selected, 'staff', actionReason || 'Invited from HR Organisation')
      const results = res?.results || []
      const ok = results.filter((r) => r.result === 'SUCCESS').length
      const failed = results.filter((r) => r.result === 'FAILED' || r.result === 'INVALID_EMAIL').length
      const existing = results.filter((r) => r.result === 'ALREADY_EXISTS').length
      setMsg(`Invited ${ok} employee(s)${existing ? `, ${existing} already had an account` : ''}${failed ? `, ${failed} failed` : ''}.`)
      setSelected([])
      setActionReason('')
      await loadAll()
      await refreshDrawer()
    } catch (e) {
      setError(e?.message || 'Invitation failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">🏢 HR Organisation</h2>
          <p className="text-sm text-slate-500 mt-1">Organisational structure imported from the bank master file — departments, designations, branches, areas, hierarchy and the accounts still awaiting invitations.</p>
        </div>
        <button onClick={loadAll} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {msg && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm p-3 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> {msg}</div>}

      {loading && <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>}

      {!loading && summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          {CARDS.map((c) => (
            <button
              key={c.key}
              onClick={() => openDrawer(c)}
              className={`text-left rounded-xl border border-slate-200 ${c.tone} p-4 hover:border-[#009944] hover:shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-[#009944]`}
            >
              <p className="text-xs font-semibold text-slate-400 uppercase">{c.label}</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">
                {c.key === 'open_issues'
                  ? (summary.open_hierarchy_issues || 0) + (summary.open_data_issues || 0)
                  : (summary[c.key] ?? 0)}
              </p>
              <span className="text-[11px] text-slate-400">View population</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto pb-3 mb-5">
        {[
          { id: 'structure', label: 'Structure', icon: Building2 },
          { id: 'hierarchy', label: 'Hierarchy & Supervisors', icon: Network },
          { id: 'quality', label: 'Data Quality Issues', icon: AlertTriangle },
          { id: 'imports', label: 'Import Batch', icon: Database },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
            <t.icon className="w-3 h-3 inline mr-1" />{t.label}
          </button>
        ))}
      </div>

      {tab === 'structure' && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-900 mb-1">Departments</h3>
            <p className="text-xs text-slate-400 mb-4">Departments seeded from the master file.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr><th className="px-4 py-3 font-medium">Code</th><th className="px-4 py-3 font-medium">Name</th><th className="px-4 py-3 font-medium">Sort</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {departments.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-xs">{d.code}</td>
                      <td className="px-4 py-3 text-slate-700 font-medium">{d.name}</td>
                      <td className="px-4 py-3 text-slate-500">{d.sort_order ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-900 mb-1">Areas & Area Managers</h3>
            <p className="text-xs text-slate-400 mb-4">Assign or change the manager of an area. This also re-labels staff in the area's branches.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr><th className="px-4 py-3 font-medium">Area</th><th className="px-4 py-3 font-medium">Manager</th>{canManage && <th className="px-4 py-3 font-medium">Assign</th>}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {areas.map((a) => (
                    <AreaRow key={a.id} area={a} employees={employees} canManage={canManage} busy={busy}
                      onAssign={(empId) => exec(() => hrOrganisationService.assignAreaManager(a.area_code, empId, 'Assigned from HR Organisation'), `Area ${a.area_code} manager updated`)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-900 mb-1">Branches & Branch Managers</h3>
            <p className="text-xs text-slate-400 mb-4">Mapping is manager-name based from the master file. Changes are audited.</p>
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr><th className="px-4 py-3 font-medium">Branch</th><th className="px-4 py-3 font-medium">Code</th><th className="px-4 py-3 font-medium">Manager</th>{canManage && <th className="px-4 py-3 font-medium">Reassign</th>}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {branches.map((b) => (
                    <BranchRow key={b.id} branch={b} employees={employees} canManage={canManage} busy={busy}
                      onAssign={(empId) => exec(() => hrOrganisationService.assignBranchManager(b.id, empId, 'Assigned from HR Organisation'), `Branch ${b.branch_name} manager updated`)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-900 mb-1">Designations → System Roles</h3>
            <p className="text-xs text-slate-400 mb-4">Job designation is not a system role; these explicit maps decide the default app role. Anything unmapped safely resolves to <code className="text-slate-600">staff</code>.</p>
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr><th className="px-4 py-3 font-medium">Designation</th><th className="px-4 py-3 font-medium">System Role</th><th className="px-4 py-3 font-medium">Fallback</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {roleMappings.map((m) => (
                    <tr key={m.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 text-slate-700">{m.designation_title}</td>
                      <td className="px-4 py-2"><span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">{m.system_role}</span></td>
                      <td className="px-4 py-2 text-xs text-slate-400">{m.is_default_fallback ? 'Yes' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'hierarchy' && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-900 mb-1">Hierarchy Exceptions</h3>
          <p className="text-xs text-slate-400 mb-4">Supervisor references that could not be auto-resolved. These are never silently dropped — resolved or formally dismissed here.</p>
          {exceptions.length === 0 && <EmptyState title="No exceptions" description="Every supervisor reference resolved cleanly." />}
          {exceptions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr><th className="px-4 py-3 font-medium">Employee</th><th className="px-4 py-3 font-medium">Supervisor (source)</th><th className="px-4 py-3 font-medium">Level</th><th className="px-4 py-3 font-medium">Reason</th><th className="px-4 py-3 font-medium">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {exceptions.map((x) => (
                    <tr key={x.id} className="hover:bg-slate-50 align-top">
                      <td className="px-4 py-3 text-slate-700">{x.employee?.full_name || x.employee_id || '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{x.source_supervisor_name}</td>
                      <td className="px-4 py-3 text-slate-500">{x.level}</td>
                      <td className="px-4 py-3"><span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">{x.reason}</span></td>
                      <td className="px-4 py-3 text-xs text-slate-500">{x.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'quality' && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-900 mb-1">Data Quality Exceptions</h3>
          <p className="text-xs text-slate-400 mb-4">Master-file inconsistencies surfaced by the parser, e.g. duplicate emails and ambiguous names.</p>
          {dataIssues.length === 0 && <EmptyState title="No data quality issues" description="The source file parsed cleanly." />}
          {dataIssues.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr><th className="px-4 py-3 font-medium">Category</th><th className="px-4 py-3 font-medium">Detail</th><th className="px-4 py-3 font-medium">Severity</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dataIssues.map((d) => (
                    <tr key={d.id} className="hover:bg-slate-50 align-top">
                      <td className="px-4 py-3 text-xs font-semibold text-slate-700">{d.category.replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">{d.message}</td>
                      <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${d.severity === 'error' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{d.severity}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'imports' && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="font-semibold text-slate-900">Staff Import Batch</h3>
              <p className="text-xs text-slate-400 mt-1">Records the bank-master import as an auditable batch summary.</p>
            </div>
            {canManage && (
              <button onClick={() => exec(() => hrOrganisationService.recordImportBatch('bank_master_full_import', {
                totalRows: summary?.employees || 0,
                importedRows: summary?.imported || 0,
                matchedRows: summary?.confirmed || 0,
                notes: 'Full staff master imported from the bank source data',
              }), 'Import batch recorded')}
                disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />} Record Batch
              </button>
            )}
          </div>
          {batches.length === 0 && <EmptyState title="No import batch recorded" description="Click Record Batch to log the master-file import." />}
          {batches.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-left">
                <tr><th className="px-4 py-3 font-medium">Batch</th><th className="px-4 py-3 font-medium">Total</th><th className="px-4 py-3 font-medium">Imported</th><th className="px-4 py-3 font-medium">Matched</th><th className="px-4 py-3 font-medium">When</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batches.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{b.batch_key}</td>
                    <td className="px-4 py-3 text-slate-600">{b.total_rows}</td>
                    <td className="px-4 py-3 text-slate-600">{b.imported_rows}</td>
                    <td className="px-4 py-3 text-slate-600">{b.matched_rows}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{b.created_at ? new Date(b.created_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {drawer && (
        <PopulationDrawer
          drawer={drawer}
          rows={rows}
          loading={drawerLoading}
          error={drawerError}
          busy={busy}
          canManage={canManage}
          selected={selected}
          actionReason={actionReason}
          onReason={setActionReason}
          onToggle={toggleSelected}
          onToggleAll={toggleAll}
          onConfirm={confirmSelected}
          onInvite={inviteSelected}
          onClose={closeDrawer}
        />
      )}
    </div>
  )
}

function PopulationDrawer({ drawer, rows, loading, error, busy, canManage, selected, actionReason, onReason, onToggle, onToggleAll, onConfirm, onInvite, onClose }) {
  const isEmployee = EMPLOYEE_CARDS.has(drawer.key)
  const actionable = drawer.key === 'unconfirmed' || drawer.key === 'uninvited'
  const allIds = rows.map((r) => r.id || r.employee_id).filter(Boolean)
  const allSelected = allIds.length > 0 && selected.length === allIds.length

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative w-full max-w-3xl h-full bg-white shadow-xl flex flex-col">
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-slate-900">{drawer.label}</h3>
              <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-600 text-xs font-medium px-2 py-0.5">{drawer.count}</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">{drawer.about}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><X className="w-5 h-5" /></button>
        </div>

        {actionable && canManage && (
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={allSelected} onChange={onToggleAll} className="rounded border-slate-300" />
                Select all ({allIds.length})
              </label>
              <input
                value={actionReason}
                onChange={(e) => onReason(e.target.value)}
                placeholder={drawer.key === 'unconfirmed' ? 'Confirmation note (optional)' : 'Invitation reason (optional)'}
                className="flex-1 min-w-[200px] h-9 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
              />
              {drawer.key === 'unconfirmed' ? (
                <button onClick={onConfirm} disabled={busy || selected.length === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />} Confirm Selected ({selected.length})
                </button>
              ) : (
                <button onClick={onInvite} disabled={busy || selected.length === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />} Invite Selected ({selected.length})
                </button>
              )}
            </div>
            {drawer.key === 'unconfirmed' && (
              <p className="text-[11px] text-slate-400 mt-2">Confirmation is recorded server-side and audited. Readiness notes below explain why a record may still be pending.</p>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[#009944]" /></div>}
          {error && <ErrorState message={error} />}
          {!loading && !error && rows.length === 0 && (
            <EmptyState title="Nothing here" description="This card currently has no matching records." />
          )}
          {!loading && !error && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left sticky top-0">
                  <tr>
                    {actionable && canManage && <th className="px-3 py-2 font-medium w-8"></th>}
                    <th className="px-3 py-2 font-medium">Record</th>
                    <th className="px-3 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => (
                    <DrawerRow key={r.id || r.employee_id || i} row={r} cardKey={drawer.key} isEmployee={isEmployee}
                      selectable={actionable && canManage}
                      checked={selected.includes(r.id || r.employee_id)}
                      onToggle={() => onToggle(r.id || r.employee_id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DrawerRow({ row, cardKey, isEmployee, selectable, checked, onToggle }) {
  const id = row.id || row.employee_id
  const name = row.full_name || row.title || row.name || row.branch_name || row.area_name || row.batch_key || id
  const badge = row.confirmation_status && CONFIRM_BADGE[row.confirmation_status]

  return (
    <tr className="hover:bg-slate-50 align-top">
      {selectable && (
        <td className="px-3 py-3">
          <input type="checkbox" checked={checked} onChange={onToggle} className="rounded border-slate-300" />
        </td>
      )}
      <td className="px-3 py-3">
        <div className="font-medium text-slate-800">{name}</div>
        <div className="text-xs text-slate-400">
          {row.staff_id && <span className="font-mono">{row.staff_id}</span>}
          {row.email && <span> · {row.email}</span>}
        </div>
      </td>
      <td className="px-3 py-3 text-xs text-slate-600">
        {cardKey === 'departments' && <span>{row.code} · {row.employee_count} employee(s) · {row.confirmed_count} confirmed</span>}
        {cardKey === 'designations' && <span>{row.dept || '—'} · {row.category || '—'} · {row.count} employee(s)</span>}
        {cardKey === 'branches' && <span>{row.branch_code} · {row.area_code ? `Area ${row.area_code}` : 'No area'} · Mgr: {row.manager_name || '—'} · {row.employee_count} employee(s)</span>}
        {cardKey === 'areas' && <span>{row.area_code} · Mgr: {row.manager_name || '—'} · {row.branch_count} branch(es) · {row.employee_count} employee(s)</span>}
        {cardKey === 'open_issues' && (
          <span>
            <span className="inline-flex items-center rounded-full bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 mr-1">{row.issue_type}</span>
            {row.employee_name ? `${row.employee_name} · ` : ''}{row.reason} · {row.status}
          </span>
        )}
        {cardKey === 'invited' && <span>{row.result} · {row.invited_at ? new Date(row.invited_at).toLocaleString() : '—'}</span>}
        {isEmployee && (
          <div className="space-y-1">
            <div>
              <span className="text-slate-500">{row.department || '—'} · {row.position || row.designation_title || '—'}</span>
              {row.branch_name && <span> · {row.branch_name}</span>}
              {badge && <span className={`ml-2 inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${badge}`}>{row.confirmation_status}</span>}
            </div>
            {cardKey === 'unconfirmed' && (() => {
              const b = blockers(row)
              return b.length > 0
                ? <div className="flex flex-wrap gap-1">{b.map((x) => <span key={x} className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 text-[11px]">{x}</span>)}</div>
                : <span className="text-[11px] text-slate-400">No outstanding readiness flags — ready to confirm.</span>
            })()}
          </div>
        )}
      </td>
    </tr>
  )
}

function AreaRow({ area, employees, canManage, busy, onAssign }) {
  const candidates = employees.filter((e) => (e.position || '').startsWith('AREA MANAGER'))
  const [empId, setEmpId] = useState(area.manager_employee_id || '')
  useEffect(() => { setEmpId(area.manager_employee_id || '') }, [area.manager_employee_id])
  return (
    <tr className="hover:bg-slate-50 align-top">
      <td className="px-4 py-3 text-slate-700 font-medium">{area.area_code}<div className="text-xs text-slate-400">{area.area_name}</div></td>
      <td className="px-4 py-3 text-slate-600">{area.manager_employee?.full_name || '—'}</td>
      {canManage && (
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <select className="h-9 rounded-md border border-slate-300 px-2 text-xs max-w-[220px]" value={empId || ''} onChange={(e) => setEmpId(e.target.value)}>
              <option value="">— Select area manager —</option>
              {candidates.map((e) => <option key={e.id} value={e.id}>{e.full_name} · {e.staff_id} </option>)}
            </select>
            <button onClick={() => empId && onAssign(empId)} disabled={busy || !empId} className="px-3 py-1.5 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36] disabled:opacity-40">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserCog className="w-3.5 h-3.5" />} Save
            </button>
          </div>
        </td>
      )}
    </tr>
  )
}

function BranchRow({ branch, employees, canManage, busy, onAssign }) {
  const candidates = employees.filter((e) => (e.position || '') === 'BRANCH MANAGER')
  const [empId, setEmpId] = useState('')
  return (
    <tr className="hover:bg-slate-50 align-top">
      <td className="px-4 py-3 text-slate-700 font-medium">{branch.branch_name}</td>
      <td className="px-4 py-3 font-mono text-xs text-slate-500">{branch.branch_code}</td>
      <td className="px-4 py-3 text-slate-600">{branch.manager_name || '—'}</td>
      {canManage && (
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <select className="h-9 rounded-md border border-slate-300 px-2 text-xs max-w-[220px]" value={empId} onChange={(e) => setEmpId(e.target.value)}>
              <option value="">— Select branch manager —</option>
              {candidates.map((e) => <option key={e.id} value={e.id}>{e.full_name} · {e.staff_id} </option>)}
            </select>
            <button onClick={() => empId && onAssign(empId)} disabled={busy || !empId} className="px-3 py-1.5 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36] disabled:opacity-40">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />} Reassign
            </button>
          </div>
        </td>
      )}
    </tr>
  )
}
