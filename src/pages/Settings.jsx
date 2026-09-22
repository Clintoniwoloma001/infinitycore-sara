import React, { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, Ban, CheckCircle2, FileUp, Loader2, Pencil, Plus, RefreshCw, Save, Settings2, Trash2, Upload, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { leaveRulesService, LEAVE_TYPE_LABELS, EMPLOYEE_CATEGORIES } from '../services/leaveRulesService'
import { getApprovalWorkflow, saveApprovalWorkflow, WORKFLOW_ROLES } from '../services/leaveApprovalsService'
import PlatformSettings from './PlatformSettings'
import { performanceService } from '../services/performanceService'
import { supabase } from '../supabaseClient'
import PeoplePicker from '../components/messages/PeoplePicker'
import {
  bankoneImportService,
  BANKONE_TARGET_FIELDS,
  BANKONE_FIELD_TYPES,
  BANKONE_FIELD_TYPES_DEFAULT,
  BANKONE_FIELD_FLAGS,
} from '../services/bankoneImportService'
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
    { id: 'platform', label: 'Platform Settings' },
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
      {tab === 'platform' && <PlatformSettings />}
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
      <LeaveWorkflowBuilder canManage={canManage} />

      <div className="flex items-center justify-between mb-4 mt-8">
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
  const [editorOpen, setEditorOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')
  const [rows, setRows] = useState([])
  const [template, setTemplate] = useState(null)

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

  // ---- field metadata helpers ----
  const metaFor = (target, md) => {
    const def = BANKONE_FIELD_FLAGS[target] || {}
    return {
      type: (md && md[target] && md[target].type) || BANKONE_FIELD_TYPES_DEFAULT[target] || 'text',
      required: !!(md && md[target] && md[target].required !== undefined ? md[target].required : def.required),
      unique: !!(md && md[target] && md[target].unique !== undefined ? md[target].unique : def.unique),
      matching: !!(md && md[target] && md[target].matching !== undefined ? md[target].matching : def.matching),
      performance: !!(md && md[target] && md[target].performance !== undefined ? md[target].performance : def.performance),
      reconciliation: !!(md && md[target] && md[target].reconciliation !== undefined ? md[target].reconciliation : def.reconciliation),
    }
  }

  // ---- add / edit ----
  const openAdd = () => {
    setEditing(null)
    setName('New BankOne Mapping')
    setVersion('')
    setDescription('')
    setRows(BANKONE_TARGET_FIELDS.map((t) => ({
      source: t, target: t, ...metaFor(t, {}),
      _customSource: false, _customTarget: false,
    })))
    setEditorOpen(true)
  }

  const openEdit = (m) => {
    setEditing(m)
    setName(m.name || '')
    setVersion(m.version || '')
    setDescription(m.description || '')
    const md = m.field_metadata || {}
    const entries = Object.entries(m.mapping || {})
    setRows(entries.length
      ? entries.map(([src, tgt]) => ({ source: src, target: tgt, ...metaFor(tgt, md) }))
      : [{ source: '', target: 'transaction_reference', ...metaFor('transaction_reference', {}) }])
    setEditorOpen(true)
  }

  const addRow = () => setRows((r) => [...r, { source: '', target: '', type: 'text', required: false, unique: false, matching: false, performance: false, reconciliation: false }])
  const setRow = (i, patch) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  const removeRow = (i) => setRows((r) => r.filter((_, idx) => idx !== i))

  const buildPayload = () => {
    const mapping = {}
    const field_metadata = {}
    rows.forEach((r) => {
      if (!r.source || !r.target) return
      if (r.target.startsWith('__')) return
      mapping[r.source] = r.target
      field_metadata[r.target] = {
        type: r.type || 'text',
        required: !!r.required,
        unique: !!r.unique,
        matching: !!r.matching,
        performance: !!r.performance,
        reconciliation: !!r.reconciliation,
      }
    })
    return { mapping, field_metadata }
  }

  const saveEditor = async (makeDefault = false) => {
    if (!name.trim()) { setError('A mapping name is required.'); return }
    const { mapping, field_metadata } = buildPayload()
    if (Object.keys(mapping).length === 0) { setError('Add at least one mapping row with a source column and destination field.'); return }
    setBusy(true)
    setError('')
    try {
      if (editing) {
        await bankoneImportService.updateMapping(editing.id, {
          name: name.trim(), version: version.trim() || null, description: description.trim() || null,
          mapping, field_metadata, is_default: makeDefault ? true : undefined,
        })
        if (makeDefault) await bankoneImportService.setDefaultMapping(editing.id)
      } else {
        await bankoneImportService.saveMapping(name.trim(), description.trim() || null, mapping, makeDefault, { field_metadata, version: version.trim() || null })
      }
      setEditorOpen(false)
      await load()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const deactivate = async (m) => {
    if (!window.confirm(`Deactivate mapping "${m.name}"?\n\nHistorical BankOne imports are NOT affected — this only stops the mapping from being used going forward.`)) return
    setBusy(true)
    setError('')
    try {
      await bankoneImportService.deactivateMapping(m.id)
      await load()
    } catch (e) {
      setError(e?.message || 'Deactivate failed')
    } finally {
      setBusy(false)
    }
  }

  const setDefault = async (m) => {
    setBusy(true)
    setError('')
    try {
      await bankoneImportService.setDefaultMapping(m.id)
      await load()
    } catch (e) {
      setError(e?.message || 'Set default failed')
    } finally {
      setBusy(false)
    }
  }

  // ---- template upload (discovery only — never imports transactions) ----
  const pickTemplate = async (file) => {
    if (!file) return
    setUploading(true)
    setError('')
    setTemplate(null)
    try {
      setTemplate(await bankoneImportService.parseTemplate(file))
    } catch (e) {
      setError(e?.message || 'Could not read the template. Use a CSV or JSON BankOne export with a header row.')
    } finally {
      setUploading(false)
    }
  }

  const setTemplateRow = (i, patch) => setTemplate((t) => t && { ...t, suggestions: t.suggestions.map((sg, idx) => (idx === i ? { ...sg, ...patch } : sg)) })

  const saveTemplateAsMapping = async (makeDefault = false) => {
    if (!template) return
    const active = template.suggestions.filter((sg) => sg.target)
    if (active.length === 0) { setError('No columns were mapped. Assign target fields to at least one column first.'); return }
    setBusy(true)
    setError('')
    try {
      const { mapping, field_metadata } = bankoneImportService.fromSuggestions(active)
      const fileName = (template.fileName || 'bankone_template').replace(/\.[^.]+$/, '')
      await bankoneImportService.saveMapping(`BankOne: ${fileName}`, `${template.headers.length} columns detected from template`, mapping, makeDefault, { field_metadata })
      setTemplate(null)
      setUploadOpen(false)
      await load()
    } catch (e) {
      setError(e?.message || 'Save template failed')
    } finally {
      setBusy(false)
    }
  }

  // ---- status badge helpers ----
  const badge = (label, cls) => <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{label}</span>

  const metaBadges = (r) => (
    <span className="inline-flex flex-wrap gap-1">
      {r.required && badge('Required', 'bg-rose-50 text-rose-600')}
      {r.unique && badge('Unique', 'bg-sky-50 text-sky-600')}
      {r.matching && badge('Matching', 'bg-[#009944]/10 text-[#009944]')}
      {r.performance && badge('Perf', 'bg-violet-50 text-violet-600')}
      {r.reconciliation && badge('Recon', 'bg-amber-50 text-amber-600')}
    </span>
  )

  const uploadBadge = (st) => {
    if (st === 'matched') return badge('Matched', 'bg-[#009944]/10 text-[#009944]')
    if (st === 'suggested') return badge('Suggested', 'bg-sky-50 text-sky-600')
    if (st === 'ambiguous') return badge('Duplicate / Ambiguous', 'bg-amber-50 text-amber-600')
    return badge('Unmapped', 'bg-slate-100 text-slate-500')
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-sm text-slate-500">
          Manage how BankOne export columns map to InfinityCore transaction fields. Mappings are
          versionable templates — new BankOne layouts can be added without code changes. Template
          discovery never imports transaction data.
        </p>
        {canManage && (
          <div className="flex gap-2 shrink-0">
            <button onClick={() => { setUploadOpen(true); setTemplate(null) }} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#009944] text-sm font-medium text-[#009944] hover:bg-[#009944]/5">
              <Upload className="w-4 h-4" /> Upload BankOne Template
            </button>
            <button onClick={openAdd} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <Plus className="w-4 h-4" /> Add Mapping
            </button>
          </div>
        )}
      </div>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {loading && <div className="text-sm text-slate-500">Loading…</div>}

      {!loading && mappings.length === 0 && (
        <EmptyState title="No mappings configured" description="The default mapping is created by the Phase 8 migration. Add a new mapping or upload a BankOne template." />
      )}

      {!loading && mappings.length > 0 && (
        <div className="space-y-4">
          {mappings.map((m) => {
            const md = m.field_metadata || {}
            const entries = Object.entries(m.mapping || {})
            return (
              <div key={m.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
                  <Settings2 className="w-4 h-4 text-[#009944]" />
                  <h4 className="font-semibold text-slate-900">{m.name}</h4>
                  {m.is_default && badge('Default', 'bg-[#009944] text-white')}
                  {m.version && badge(`v${m.version}`, 'bg-slate-100 text-slate-500')}
                  {!m.is_active && badge('Inactive', 'bg-slate-100 text-slate-500')}
                  {m.description && <p className="w-full text-xs text-slate-400">{m.description}</p>}
                </div>
                {entries.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-500 text-left">
                        <tr>
                          <th className="px-4 py-2 font-medium">BankOne / Excel Column</th>
                          <th className="px-4 py-2 font-medium">InfinityCore Field</th>
                          <th className="px-4 py-2 font-medium">Type</th>
                          <th className="px-4 py-2 font-medium">Flags</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {entries.map(([src, tgt]) => (
                          <tr key={src + tgt} className="hover:bg-slate-50">
                            <td className="px-4 py-2 font-mono text-xs text-slate-600">{src}</td>
                            <td className="px-4 py-2 font-medium text-slate-800">{tgt}</td>
                            <td className="px-4 py-2 text-slate-600">{metaFor(tgt, md).type}</td>
                            <td className="px-4 py-2">{metaBadges(metaFor(tgt, md))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="px-4 py-3 bg-slate-50/60 flex flex-wrap items-center gap-2">
                  {canManage && (
                    <>
                      <button onClick={() => openEdit(m)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50">
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                      {!m.is_default && m.is_active && (
                        <button onClick={() => setDefault(m)} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Set Default
                        </button>
                      )}
                      {m.is_active && (
                        <button onClick={() => deactivate(m)} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                          <Ban className="w-3.5 h-3.5" /> Deactivate
                        </button>
                      )}
                    </>
                  )}
                  <span className="ml-auto text-xs text-slate-400">{entries.length} fields</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ---------- Add / Edit Mapping ---------- */}
      {editorOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-3xl shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 bg-white">
              <h3 className="text-lg font-semibold text-slate-900">{editing ? 'Edit Mapping' : 'Add Mapping'}</h3>
              <button onClick={() => setEditorOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2">
                  <label className={labelCls}>Mapping Name *</label>
                  <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BankOne Quarterly Export" />
                </div>
                <div>
                  <label className={labelCls}>Version (optional)</label>
                  <input className={inputCls} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 2" />
                </div>
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <p className="text-sm text-slate-500">Field mappings — source is the BankOne/Excel column, destination is the InfinityCore field.</p>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={i} className="border border-slate-200 rounded-lg p-3 space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className={labelCls}>Source (BankOne/Excel column)</label>
                        <input className={inputCls} value={r.source} onChange={(e) => setRow(i, { source: e.target.value })} placeholder="e.g. Txn Ref" />
                      </div>
                      <div>
                        <label className={labelCls}>Destination (InfinityCore field)</label>
                        <select className={inputCls} value={r.target} onChange={(e) => setRow(i, { target: e.target.value })}>
                          <option value="">Select field…</option>
                          {BANKONE_TARGET_FIELDS.map((t) => (<option key={t} value={t}>{t}</option>))}
                          {r.target && !BANKONE_TARGET_FIELDS.includes(r.target) && !r.target.startsWith('__') && (
                            <option value={r.target}>{r.target}</option>
                          )}
                          <option value="__custom__">Custom field…</option>
                        </select>
                        {r.target === '__custom__' && (
                          <input className={`${inputCls} mt-1`} value={r._customTarget || ''} onChange={(e) => { setRow(i, { _customTarget: e.target.value, target: e.target.value }) }} placeholder="Custom InfinityCore field name" />
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 items-end">
                      <div>
                        <label className={labelCls}>Data Type</label>
                        <select className={inputCls} value={r.type} onChange={(e) => setRow(i, { type: e.target.value })}>
                          {BANKONE_FIELD_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
                        </select>
                      </div>
                      <div className="flex flex-wrap gap-3 pt-5">
                        {([
                          ['required', 'Required'], ['unique', 'Unique'], ['matching', 'Used for matching'],
                          ['performance', 'For performance'], ['reconciliation', 'For reconciliation'],
                        ]).map(([k, label]) => (
                          <label key={k} className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                            <input type="checkbox" checked={!!r[k]} onChange={(e) => setRow(i, { [k]: e.target.checked })} className="w-3.5 h-3.5 text-[#009944]" />
                            {label}
                          </label>
                        ))}
                      </div>
                      <div className="sm:justify-self-end">
                        <button onClick={() => removeRow(i)} className="inline-flex items-center gap-1 text-xs text-rose-500 hover:text-rose-700"><Trash2 className="w-3.5 h-3.5" /> Remove</button>
                      </div>
                    </div>
                  </div>
                ))}
                <button onClick={addRow} className="inline-flex items-center gap-1.5 text-sm font-medium text-[#009944] hover:underline"><Plus className="w-4 h-4" /> Add field mapping</button>
              </div>
              <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-slate-100">
                <button onClick={() => setEditorOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={() => saveEditor(true)} disabled={busy} className="px-4 py-2 rounded-lg border border-[#009944] text-sm font-medium text-[#009944] hover:bg-[#009944]/5 disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : null} Save as Default
                </button>
                <button onClick={() => saveEditor(false)} disabled={busy} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : <Save className="w-4 h-4 inline" />} Save Mapping
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Upload BankOne Template ---------- */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-3xl shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 bg-white">
              <h3 className="text-lg font-semibold text-slate-900">Upload BankOne Excel Template</h3>
              <button onClick={() => setUploadOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-slate-500">
                Column headers are detected and compared against known mappings. Nothing is imported —
                the proposal below is saved as a reusable template only after you confirm.
              </p>
              <label className={`${inputCls} flex items-center justify-center gap-2 cursor-pointer border-dashed !h-14`}>
                <FileUp className="w-5 h-5 text-[#009944]" />
                <span className="text-slate-600">{uploading ? 'Reading template…' : 'Choose a BankOne export (CSV / JSON)'}</span>
                <input type="file" accept=".csv,.tsv,.txt,.json,text/csv,application/json" className="hidden"
                  onChange={(e) => pickTemplate(e.target.files?.[0])} disabled={uploading} />
              </label>

              {!template && uploading && <p className="text-sm text-slate-400">Reading column headers…</p>}

              {template && (
                <>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-[#009944]" />
                    <p className="text-sm text-slate-700">
                      Detected <b>{template.headers.length}</b> columns · <b>{template.parsedRowCount}</b> sample row(s) read.
                      These rows are only previewed — no transactions are imported.
                    </p>
                  </div>
                  {template.missingRequired.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>Required-but-missing: <b>{template.missingRequired.join(', ')}</b>. Assign a source column before saving.</span>
                    </div>
                  )}
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-500 text-left">
                        <tr>
                          <th className="px-3 py-2 font-medium">Excel Column</th>
                          <th className="px-3 py-2 font-medium">Detection</th>
                          <th className="px-3 py-2 font-medium">Map To</th>
                          <th className="px-3 py-2 font-medium">Type</th>
                          <th className="px-3 py-2 font-medium">Flags</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {template.suggestions.map((sg, i) => (
                          <tr key={i} className={sg.status === 'ambiguous' ? 'bg-amber-50/40' : 'hover:bg-slate-50'}>
                            <td className="px-3 py-2 font-mono text-xs text-slate-600">{sg.header}</td>
                            <td className="px-3 py-2">{uploadBadge(sg.status)}</td>
                            <td className="px-3 py-2">
                              <select className="h-8 rounded-md border border-slate-300 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#009944]"
                                value={sg.target || ''} onChange={(e) => setTemplateRow(i, { target: e.target.value })}>
                                <option value="">(leave unmapped)</option>
                                {BANKONE_TARGET_FIELDS.map((t) => (<option key={t} value={t}>{t}</option>))}
                              </select>
                            </td>
                            <td className="px-3 py-2">
                              <select className="h-8 rounded-md border border-slate-300 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#009944]"
                                value={sg.type} onChange={(e) => setTemplateRow(i, { type: e.target.value })}>
                                {BANKONE_FIELD_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
                              </select>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {sg.target && metaBadges({ required: sg.required, unique: sg.unique, matching: sg.matching, performance: sg.performance, reconciliation: sg.reconciliation })}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2 pt-2">
                    <button onClick={() => setUploadOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                    <button onClick={() => saveTemplateAsMapping(true)} disabled={busy} className="px-4 py-2 rounded-lg border border-[#009944] text-sm font-medium text-[#009944] hover:bg-[#009944]/5 disabled:opacity-50">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : null} Save as Default Template
                    </button>
                    <button onClick={() => saveTemplateAsMapping(false)} disabled={busy} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : <Save className="w-4 h-4 inline" />} Save Template Mapping
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
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

// ---- Leave Approval Workflow Builder (Leave Rules tab) ----
const DEFAULT_LEVEL = { type: 'role', role: 'head_of_human_resources', user_id: null, label: '', sla_hours: 48, auto_escalate: true }

function LeaveWorkflowBuilder({ canManage }) {
  const [workflow, setWorkflow] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reason, setReason] = useState('')
  const [pickerIndex, setPickerIndex] = useState(null)
  const [people, setPeople] = useState([])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const wf = await getApprovalWorkflow()
      setWorkflow(Array.isArray(wf) ? wf : [])
    } catch (e) {
      setError(e?.message || 'Failed to load approval workflow.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const openPicker = async (idx) => {
    setPickerIndex(idx)
    if (people.length === 0) {
      const { data, error } = await supabase.rpc('get_messaging_directory', { p_search: null })
      if (error) { setError(error.message); return }
      setPeople((data || []).map((p) => ({ id: p.id, full_name: p.full_name || p.name, email: p.email, department: p.department, hasAccount: true })))
    }
  }

  const setLevel = (idx, patch) => setWorkflow((w) => w.map((lvl, i) => (i === idx ? { ...lvl, ...patch } : lvl)))

  const addLevel = (type = 'role') => setWorkflow((w) => [...w, { ...DEFAULT_LEVEL, type, role: type === 'role' ? 'head_of_human_resources' : null }])
  const removeLevel = (idx) => setWorkflow((w) => w.filter((_, i) => i !== idx))
  const moveLevel = (idx, dir) => {
    setWorkflow((w) => {
      const target = idx + dir
      if (target < 0 || target >= w.length) return w
      const copy = [...w]
      const tmp = copy[target]
      copy[target] = copy[idx]
      copy[idx] = tmp
      return copy
    })
  }

  const userName = (id) => {
    const p = people.find((x) => x.id === id)
    return p?.full_name || p?.email || id
  }

  const validate = () => {
    if (workflow.length === 0) return 'Add at least one approval level.'
    for (const lvl of workflow) {
      if (!lvl.label || lvl.label.trim() === '') return 'Every level needs a label.'
      if (lvl.type === 'role') {
        if (!lvl.role) return 'Role levels must specify a role.'
      } else {
        if (!lvl.user_id) return 'User levels must select a specific user.'
      }
      if (!Number.isInteger(lvl.sla_hours) || lvl.sla_hours < 1) return 'SLA hours must be a positive whole number.'
    }
    if (!reason.trim() || reason.trim().length < 5) return 'A reason (5+ characters) is required for audit.'
    return null
  }

  const save = async () => {
    const err = validate()
    if (err) { setError(err); return }
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const payload = workflow.map((lvl) => ({
        type: lvl.type,
        role: lvl.type === 'role' ? lvl.role : null,
        user_id: lvl.type === 'user' ? lvl.user_id : null,
        label: lvl.label.trim(),
        sla_hours: Number(lvl.sla_hours),
        auto_escalate: !!lvl.auto_escalate,
      }))
      await saveApprovalWorkflow(payload, reason.trim())
      setSaved(true)
      setReason('')
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 mb-6">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h3 className="font-semibold text-slate-900">Leave Approval Workflow</h3>
          <p className="text-sm text-slate-500">
            {workflow.length === 0
              ? 'Using the legacy approval-chain template (line manager → branch manager → area manager → Head of HR). Add levels to switch to the builder-driven workflow.'
              : 'Leave requests route through these levels in order. The workflow takes priority over the legacy template once it has at least one level.'}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2 shrink-0">
            <button onClick={() => addLevel('role')} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50">
              <Plus className="w-3.5 h-3.5" /> Add Role Level
            </button>
            <button onClick={() => addLevel('user')} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50">
              <Plus className="w-3.5 h-3.5" /> Add User Level
            </button>
          </div>
        )}
      </div>

      {loading && <div className="text-sm text-slate-500 py-2">Loading workflow…</div>}
      {!loading && workflow.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500 text-center">
          No custom workflow configured. The legacy chain is active.
        </div>
      )}

      <div className="space-y-3 mt-3">
        {workflow.map((lvl, i) => (
          <div key={`${lvl.type}-${i}`} className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-24">
                <label className="text-[10px] font-semibold uppercase text-slate-400">Level {i + 1}</label>
                <select
                  className={inputCls}
                  value={lvl.type}
                  disabled={!canManage}
                  onChange={(e) => setLevel(i, { type: e.target.value, role: e.target.value === 'role' ? 'head_of_human_resources' : null, user_id: null })}
                >
                  <option value="role">Role / Position</option>
                  <option value="user">Specific User</option>
                </select>
              </div>

              {lvl.type === 'role' ? (
                <div className="w-48">
                  <label className="text-[10px] font-semibold uppercase text-slate-400">Role</label>
                  <select className={inputCls} value={lvl.role || ''} disabled={!canManage} onChange={(e) => setLevel(i, { role: e.target.value, label: lvl.label || e.target.options[e.target.selectedIndex].text })}>
                    <option value="">Select role…</option>
                    {WORKFLOW_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                </div>
              ) : (
                <div className="flex-1 min-w-[180px]">
                  <label className="text-[10px] font-semibold uppercase text-slate-400">Approver</label>
                  <div className="flex items-center gap-2">
                    {lvl.user_id ? (
                      <span className="text-sm text-slate-800">{userName(lvl.user_id)}</span>
                    ) : (
                      <span className="text-sm text-slate-400">No user selected</span>
                    )}
                    {canManage && (
                      <button onClick={() => openPicker(i)} className="text-xs text-[#009944] hover:underline">
                        {lvl.user_id ? 'Change' : 'Pick user'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="w-40">
                <label className="text-[10px] font-semibold uppercase text-slate-400">Label</label>
                <input className={inputCls} value={lvl.label || ''} disabled={!canManage} onChange={(e) => setLevel(i, { label: e.target.value })} placeholder="e.g. Branch Manager" />
              </div>

              <div className="w-24">
                <label className="text-[10px] font-semibold uppercase text-slate-400">SLA (h)</label>
                <input type="number" className={inputCls} value={lvl.sla_hours} disabled={!canManage} min={1} onChange={(e) => setLevel(i, { sla_hours: parseInt(e.target.value || '1', 10) })} />
              </div>

              <label className="flex items-center gap-1.5 text-xs text-slate-600 pb-2">
                <input type="checkbox" checked={!!lvl.auto_escalate} disabled={!canManage} onChange={(e) => setLevel(i, { auto_escalate: e.target.checked })} className="w-4 h-4 text-[#009944]" />
                Escalate
              </label>

              {canManage && (
                <div className="flex items-center gap-1 ml-auto pb-2">
                  <button onClick={() => moveLevel(i, -1)} disabled={i === 0} className="p-1 rounded text-slate-500 hover:bg-white disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
                  <button onClick={() => moveLevel(i, 1)} disabled={i === workflow.length - 1} className="p-1 rounded text-slate-500 hover:bg-white disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" /></button>
                  <button onClick={() => removeLevel(i)} disabled={workflow.length <= 1} className="p-1 rounded text-rose-500 hover:bg-rose-50 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {canManage && workflow.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-100">
          <label className="text-sm font-medium text-slate-700">Reason for change (audited) *</label>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Added Head of Business as pre-HR approver" />
          <div className="flex items-center gap-3 mt-3">
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Workflow
            </button>
            {saved && <span className="text-sm text-emerald-600 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Saved</span>}
          </div>
        </div>
      )}

      {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}

      {pickerIndex !== null && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-5 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold text-slate-900">Select approver</h4>
              <button onClick={() => setPickerIndex(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <PeoplePicker
              title="Users"
              people={people}
              mode="single"
              onClose={() => setPickerIndex(null)}
              onPick={(ids) => {
                const id = ids?.[0]
                if (id) {
                  setLevel(pickerIndex, { user_id: id, label: workflow[pickerIndex]?.label || userName(id) })
                }
                setPickerIndex(null)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
