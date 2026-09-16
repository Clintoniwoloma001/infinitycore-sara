import React, { useEffect, useState } from 'react'
import { AlertTriangle, Building2, Loader2, MapPin, Network, RefreshCw, UserCog, Users, CheckCircle2, Database, ShieldAlert } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { hrOrganisationService } from '../services/hrOrganisationService'
import { employeeService } from '../services/employeeService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const CONFIRM_BADGE = {
  CONFIRMED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  UNCONFIRMED: 'bg-amber-50 text-amber-700 border-amber-200',
  'CONTRACT STAFF': 'bg-sky-50 text-sky-700 border-sky-200',
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

  const loadAll = async () => {
    setLoading(true)
    setError('')
    try {
      const [s, depts, desig, branches, areas, exc, di, batches] = await Promise.all([
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
      setBranches(branches)
      setAreas(areas)
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

  const card = (label, value, bg = 'bg-white') => (
    <div className={`rounded-xl border border-slate-200 ${bg} p-4`}>
      <p className="text-xs font-semibold text-slate-400 uppercase">{label}</p>
      <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
    </div>
  )

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
          {card('Employees', summary.employees)}
          {card('Confirmed', summary.confirmed, 'bg-emerald-50')}
          {card('Unconfirmed', summary.unconfirmed, 'bg-amber-50')}
          {card('Contract', summary.contract_staff, 'bg-sky-50')}
          {card('Imported', summary.imported)}
          {card('Departments', summary.departments)}
          {card('Designations', summary.designations)}
          {card('Branches', summary.branches)}
          {card('Areas', summary.areas)}
          {card('Area Mgrs', summary.area_managers)}
          {card('Uninvited', summary.uninvited, 'bg-rose-50')}
          {card('Open Issues', (summary.open_hierarchy_issues || 0) + (summary.open_data_issues || 0), 'bg-rose-50')}
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
            <p className="text-xs text-slate-400 mb-4">14 departments seeded from the master file.</p>
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
              <button onClick={() => exec(() => hrOrganisationService.recordImportBatch('bank_master_full_import', { totalRows: 215, importedRows: 215, matchedRows: 215, notes: 'Full staff master imported from INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md' }), 'Import batch recorded')}
                disabled={busy} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />} Record Batch
              </button>
            )}
          </div>
          {batches.length === 0 && <EmptyState title="No import batch recorded" description="Click Record Batch to log the 215-row import." />}
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
    </div>
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