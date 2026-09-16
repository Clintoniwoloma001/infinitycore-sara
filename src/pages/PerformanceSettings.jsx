import React, { useEffect, useState } from 'react'
import { Loader2, RotateCcw, Save, ShieldCheck, History, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState } from '../components/PageStates'
import { performanceConfigService } from '../services/performanceConfigService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

function pretty(v) {
  try {
    return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2)
  } catch {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  }
}

export default function PerformanceSettings() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('performance.manage') || hasPermission('hr_config.manage') || hasPermission('hr.org.manage')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('items')
  const [audit, setAudit] = useState([])
  const [busyKey, setBusyKey] = useState(null)
  const [activeCode, setActiveCode] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await performanceConfigService.list()
      setData(res)
      if (!activeCode && res?.sections?.length) setActiveCode(res.sections[0].code)
    } catch (e) {
      setError(e?.message || 'Performance configuration is unavailable. Run the phase 26 migration in Supabase, then retry.')
    } finally {
      setLoading(false)
    }
  }

  const loadAudit = async () => {
    try {
      setAudit(await performanceConfigService.listAudit(50))
    } catch {
      setAudit([])
    }
  }

  useEffect(() => { load(); loadAudit() }, [])

  const saveItem = async (item) => {
    setBusyKey(item.config_key)
    setError('')
    try {
      let parsed
      try {
        parsed = typeof item.editValue === 'string' ? JSON.parse(item.editValue) : item.editValue
      } catch {
        throw new Error('Invalid JSON — check commas, quotes and brackets.')
      }
      await performanceConfigService.save(item.config_key, parsed, item.editReason || null)
      await load()
      await loadAudit()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusyKey(null)
    }
  }

  const resetItem = async (key) => {
    setBusyKey(key)
    setError('')
    try {
      await performanceConfigService.reset(key)
      await load()
      await loadAudit()
    } catch (e) {
      setError(e?.message || 'Reset failed')
    } finally {
      setBusyKey(null)
    }
  }

  const activeSection = data?.sections?.find((s) => s.code === activeCode) || data?.sections?.[0]

  return (
    <div>
      <h2 className="text-2xl font-semibold text-slate-900 mb-1">🏦 Performance & MPR Settings</h2>
      <p className="text-sm text-slate-500 mb-6">
        Presentation-derived defaults seeded from the bank master source, editable by HR and versioned in <code className="text-slate-700">performance_config</code>.
        Reset restores the bank default; every change is audited.
      </p>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {loading && <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>}

      {!loading && !data && (
        <div><ErrorState message="No sections returned. Run the phase 26 migration in Supabase, then retry." /></div>
      )}

      {!loading && data && (
        <>
          <div className="flex gap-2 overflow-x-auto pb-3 mb-5">
            <button onClick={() => setTab('items')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === 'items' ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
              Configuration
            </button>
            <button onClick={() => setTab('audit')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === 'audit' ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
              <History className="w-3 h-3 inline mr-1" />Change History
            </button>
          </div>

          {tab === 'items' ? (
            <div className="grid lg:grid-cols-4 gap-6">
              {/* Section nav */}
              <div className="space-y-2">
                {data.sections.map((s) => (
                  <button key={s.code} onClick={() => setActiveCode(s.code)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium border ${activeSection?.code === s.code ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                    {s.label}
                    <span className={`block text-xs ${activeSection?.code === s.code ? 'text-emerald-100' : 'text-slate-400'}`}>{s.code}</span>
                  </button>
                ))}
              </div>

              {/* Section items */}
              <div className="lg:col-span-3 space-y-3">
                {activeSection?.items?.length === 0 && <EmptyState title="No items in this section" description="Nothing configured yet." />}
                {activeSection?.items?.map((item) => (
                  <ConfigCard key={item.config_key} item={item} canManage={canManage} busy={busyKey === item.config_key} onSave={saveItem} onReset={resetItem} />
                ))}
              </div>
            </div>
          ) : (
            <AuditTable audit={audit} />
          )}
        </>
      )}
    </div>
  )
}

function ConfigCard({ item, canManage, busy, onSave, onReset }) {
  const [editValue, setEditValue] = useState(pretty(item.current_value))
  const [editReason, setEditReason] = useState('')
  const [editor, setEditor] = useState(false)

  useEffect(() => {
    setEditValue(pretty(item.current_value))
    setEditReason('')
    setEditor(false)
  }, [item.config_key, item.changed_at])

  const changed = (editValue || '') !== pretty(item.current_value)

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-slate-900">{item.label}</h4>
            <span className="text-xs text-slate-400 font-mono">{item.config_key}</span>
          </div>
          {item.notes && <p className="text-xs text-slate-400 mt-1">{item.notes}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
            <ShieldCheck className="w-3 h-3" /> v{item.version || 1}
          </span>
          {canManage && (
            <>
              <button onClick={async () => { if (window.confirm(`Reset ${item.label} to bank default?`)) await onReset(item.config_key) }} disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50 disabled:opacity-50">
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </button>
              <button onClick={() => setEditor((v) => !v)} disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36] disabled:opacity-50">
                <Save className="w-3.5 h-3.5" /> Edit
              </button>
            </>
          )}
        </div>
      </div>

      {!editor ? (
        <pre className="text-xs bg-slate-50 border border-slate-100 rounded-lg p-3 overflow-x-auto text-slate-700 whitespace-pre-wrap">{pretty(item.current_value)}</pre>
      ) : (
        <div className="space-y-3">
          <div>
            <label className={labelCls}>JSON Value</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={item.data_type === 'json' ? 14 : 3} value={editValue} onChange={(e) => setEditValue(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Reason for change (audited)</label>
            <input className={inputCls} value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="e.g. Updated PAR band after board review" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => onSave({ ...item, editValue, editReason })} disabled={busy || !changed}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Change
            </button>
            <button onClick={() => { setEditValue(pretty(item.current_value)); setEditReason(''); setEditor(false) }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function AuditTable({ audit }) {
  if (audit.length === 0) return <EmptyState title="No changes yet" description="Every save or reset appears here with the controlling user and reason." />
  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-left">
          <tr>
            <th className="px-4 py-3 font-medium">Config</th>
            <th className="px-4 py-3 font-medium">Old → New</th>
            <th className="px-4 py-3 font-medium">Reason</th>
            <th className="px-4 py-3 font-medium">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {audit.map((a) => (
            <tr key={a.id} className="hover:bg-slate-50 align-top">
              <td className="px-4 py-3 font-mono text-xs text-slate-700">{a.config_key}<div className="text-[10px] text-slate-400">{a.section}</div></td>
              <td className="px-4 py-3 text-xs text-slate-600 max-w-xs">
                <p className="text-slate-400 line-clamp-1">{pretty(a.old_value)}</p>
                <p className="text-[#009944] mt-1">↓</p>
                <p className="text-slate-800 line-clamp-1">{pretty(a.new_value)}</p>
              </td>
              <td className="px-4 py-3 text-xs text-slate-500 max-w-[240px]">{a.reason || '—'}</td>
              <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{a.changed_at ? new Date(a.changed_at).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}