import React, { useEffect, useState } from 'react'
import { Loader2, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { leaveRulesService, LEAVE_TYPE_LABELS, EMPLOYEE_CATEGORIES } from '../services/leaveRulesService'
import { performanceService } from '../services/performanceService'
import { bankoneImportService } from '../services/bankoneImportService'
import { GeofencingTab, DevicesTab, BiometricTab, AttendancePolicyTab } from '../components/AttendanceSettings'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function Settings() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('hr_config.manage') || hasPermission('admin.manage_config') || hasPermission('attendance.config.manage')
  const [tab, setTab] = useState('leave-rules')

  const tabs = [
    { id: 'leave-rules', label: 'Leave Rules' },
    { id: 'attendance-policy', label: 'Attendance Policy' },
    { id: 'geofencing', label: 'Geofencing' },
    { id: 'devices', label: 'Devices & Terminals' },
    { id: 'biometric', label: 'Biometric Mapping' },
    { id: 'bankone-mapping', label: 'BankOne Mapping' },
    { id: 'transport-allowance', label: 'Transport Allowance' },
  ]

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-900 mb-1">⚙️ Settings</h2>
      <p className="text-sm text-slate-500 mb-6">Configure HR policies, leave rules, performance rules, BankOne import mappings, and allowances.</p>

      <div className="flex gap-2 overflow-x-auto pb-3 mb-6">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'leave-rules' && <LeaveRulesTab canManage={canManage} />}
      {tab === 'attendance-policy' && <AttendancePolicyTab canManage={canManage} />}
      {tab === 'geofencing' && <GeofencingTab canManage={canManage} />}
      {tab === 'devices' && <DevicesTab canManage={canManage} />}
      {tab === 'biometric' && <BiometricTab canManage={canManage} />}
      {tab === 'bankone-mapping' && <BankOneMappingTab canManage={canManage} />}
      {tab === 'transport-allowance' && <TransportAllowanceTab canManage={canManage} />}
    </div>
  )
}

// ---- Leave Rules Tab ----
function LeaveRulesTab({ canManage }) {
  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState({ leave_type: 'annual', employee_category: 'normal_staff', entitled_days: '', description: '' })
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setRules(await leaveRulesService.listAllRules())
    } catch (e) {
      setError(e?.message || 'Failed to load leave rules. Run the Phase 8 migration first.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const payload = {
        leave_type: form.leave_type,
        employee_category: form.employee_category || null,
        entitled_days: Number(form.entitled_days),
        description: form.description,
        is_active: true,
      }
      if (editId) {
        await leaveRulesService.updateRule(editId, payload)
      } else {
        await leaveRulesService.createRule(payload)
      }
      setShowAdd(false)
      setEditId(null)
      setForm({ leave_type: 'annual', employee_category: 'normal_staff', entitled_days: '', description: '' })
      load()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Leave entitlements by employee category. These replace hardcoded values — HR can update without code changes.</p>
        {canManage && (
          <button onClick={() => { setShowAdd(true); setEditId(null); setForm({ leave_type: 'annual', employee_category: 'normal_staff', entitled_days: '', description: '' }) }} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> Add Rule
          </button>
        )}
      </div>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {loading && <div className="text-sm text-slate-500">Loading…</div>}
      {!loading && rules.length === 0 && <EmptyState title="No leave rules configured" description="Add rules for each leave type and employee category." />}
      {!loading && rules.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Leave Type</th>
                <th className="px-4 py-3 font-medium">Employee Category</th>
                <th className="px-4 py-3 font-medium">Entitled Days</th>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium">Active</th>
                {canManage && <th className="px-4 py-3 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rules.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{LEAVE_TYPE_LABELS[r.leave_type] || r.leave_type}</td>
                  <td className="px-4 py-3 text-slate-600">{r.employee_category ? EMPLOYEE_CATEGORIES[r.employee_category] || r.employee_category : 'All Staff'}</td>
                  <td className="px-4 py-3 text-slate-600">{r.entitled_days} days</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{r.description || '—'}</td>
                  <td className="px-4 py-3">{r.is_active ? '✅' : '❌'}</td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => { setEditId(r.id); setForm({ leave_type: r.leave_type, employee_category: r.employee_category || '', entitled_days: String(r.entitled_days), description: r.description || '' }); setShowAdd(true) }} className="text-xs text-[#009944] hover:underline mr-2">Edit</button>
                      <button onClick={async () => { await leaveRulesService.deleteRule(r.id); load() }} className="text-rose-500 hover:text-rose-700"><Trash2 className="w-4 h-4" /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">{editId ? 'Edit Leave Rule' : 'Add Leave Rule'}</h3>
              <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Leave Type</label>
                <select className={inputCls} value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}>
                  {Object.entries(LEAVE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Employee Category</label>
                <select className={inputCls} value={form.employee_category} onChange={(e) => setForm({ ...form, employee_category: e.target.value })}>
                  <option value="">All Staff</option>
                  {Object.entries(EMPLOYEE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Entitled Days</label>
                <input type="number" className={inputCls} value={form.entitled_days} onChange={(e) => setForm({ ...form, entitled_days: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <input className={inputCls} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowAdd(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- BankOne Mapping Tab ----
function BankOneMappingTab({ canManage }) {
  const [mappings, setMappings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setMappings(await bankoneImportService.listMappings())
    } catch (e) {
      setError(e?.message || 'Failed to load mappings. Run the Phase 8 migration first.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">Configure how BankOne export columns map to InfinityCore transaction fields. This allows new BankOne formats to be mapped without code changes.</p>
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {loading && <div className="text-sm text-slate-500">Loading…</div>}
      {!loading && mappings.length === 0 && <EmptyState title="No column mappings configured" description="The default mapping will be created when you run the Phase 8 migration." />}
      {!loading && mappings.length > 0 && (
        <div className="space-y-4">
          {mappings.map((m) => (
            <div key={m.id} className="bg-white rounded-lg border border-slate-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h4 className="font-semibold text-slate-900">{m.name} {m.is_default && <span className="text-xs text-[#009944] ml-2">Default</span>}</h4>
                  {m.description && <p className="text-xs text-slate-400">{m.description}</p>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(m.mapping || {}).map(([src, tgt]) => (
                  <div key={src} className="flex items-center gap-2">
                    <span className="text-slate-500">{src}</span>
                    <span className="text-slate-300">→</span>
                    <span className="font-medium text-slate-800">{tgt}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Transport Allowance Tab ----
function TransportAllowanceTab({ canManage }) {
  const [allowances, setAllowances] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ employee_category: '', branch: '', amount: '', frequency: 'monthly', eligibility: '' })
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setAllowances(await performanceService.listTransportAllowances())
    } catch (e) {
      setError(e?.message || 'Failed to load transport allowances. Run the Phase 8 migration first.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await performanceService.createTransportAllowance({
        employee_category: form.employee_category || null,
        branch: form.branch || null,
        amount: Number(form.amount),
        frequency: form.frequency,
        eligibility: form.eligibility || null,
        is_active: true,
      })
      setShowAdd(false)
      setForm({ employee_category: '', branch: '', amount: '', frequency: 'monthly', eligibility: '' })
      load()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Configure transport allowance by employee category, branch, and frequency. Amounts are not hardcoded — HR sets them here.</p>
        {canManage && (
          <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> Add Allowance
          </button>
        )}
      </div>
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {loading && <div className="text-sm text-slate-500">Loading…</div>}
      {!loading && allowances.length === 0 && <EmptyState title="No transport allowances configured" description="Add allowance rules by employee category and branch." />}
      {!loading && allowances.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Branch</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Frequency</th>
                <th className="px-4 py-3 font-medium">Eligibility</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {allowances.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-600">{a.employee_category || 'All'}</td>
                  <td className="px-4 py-3 text-slate-600">{a.branch || 'All'}</td>
                  <td className="px-4 py-3 text-slate-600">₦{a.amount?.toLocaleString()}</td>
                  <td className="px-4 py-3 text-slate-600">{a.frequency}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{a.eligibility || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Add Transport Allowance</h3>
              <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Employee Category</label>
                <select className={inputCls} value={form.employee_category} onChange={(e) => setForm({ ...form, employee_category: e.target.value })}>
                  <option value="">All Staff</option>
                  {Object.entries(EMPLOYEE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Branch (optional)</label>
                <input className={inputCls} value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} placeholder="All branches if empty" />
              </div>
              <div>
                <label className={labelCls}>Amount (₦)</label>
                <input type="number" className={inputCls} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Frequency</label>
                <select className={inputCls} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Eligibility</label>
                <input className={inputCls} value={form.eligibility} onChange={(e) => setForm({ ...form, eligibility: e.target.value })} placeholder="e.g. Active staff only" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowAdd(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={save} disabled={busy || !form.amount} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
