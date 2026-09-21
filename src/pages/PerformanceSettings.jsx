import React, { useEffect, useMemo, useState } from 'react'
import { History, Loader2, RotateCcw, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../supabaseClient'
import { EmptyState, ErrorState } from '../components/PageStates'
import { performanceConfigService } from '../services/performanceConfigService'
import { hrOrganisationService } from '../services/hrOrganisationService'
import { getTranslator } from '../domains/performance/rules/index.js'
import SectionEditor from '../components/performance/SectionEditor.jsx'

function pretty(v) {
  try {
    return JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2)
  } catch {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  }
}

export default function PerformanceSettings() {
  const { hasPermission, role } = useAuth()
  const canManage = hasPermission('performance.manage') || hasPermission('hr_config.manage') || hasPermission('hr.org.manage')
  const isAdmin = ['super_admin', 'admin'].includes(role)

  const [data, setData] = useState(null)
  const [designations, setDesignations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('rules')
  const [audit, setAudit] = useState([])
  const [busyKey, setBusyKey] = useState(null)
  const [activeCode, setActiveCode] = useState('')

  const loadAudit = async () => {
    try {
      const rows = await performanceConfigService.listAudit(50)
      const ids = [...new Set(rows.map((r) => r.changed_by).filter(Boolean))]
      let nameById = {}
      if (ids.length) {
        try {
          const { data: profiles } = await supabase.from('profiles').select('id, first_name, last_name').in('id', ids)
          nameById = Object.fromEntries((profiles || []).map((p) => [p.id, [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || 'Unknown user']))
        } catch {
          /* profiles read is best-effort */
        }
      }
      setAudit(rows.map((r) => ({ ...r, actor: nameById[r.changed_by] || null })))
    } catch {
      setAudit([])
    }
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await performanceConfigService.list()
      setData(res)
      if (!activeCode && (res?.sections || []).length) setActiveCode(res?.sections[0].code)
      try {
        setDesignations(await hrOrganisationService.listDesignations())
      } catch {
        setDesignations([])
      }
    } catch (e) {
      setError(e?.message || 'Performance configuration is unavailable. Run the phase 26 migration in Supabase, then retry.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(); loadAudit() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const saveItem = async (item, value, reason) => {
    setBusyKey(item.config_key)
    setError('')
    try {
      await performanceConfigService.save(item.config_key, value, reason || null)
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

  const resetAll = async () => {
    if (!window.confirm('Reset ALL performance settings to the InfinityCore bank defaults?\n\nHistorical performance results are NOT touched — this affects future calculations only.')) return
    setBusyKey('__all__')
    setError('')
    try {
      await performanceConfigService.reset()
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
        No-code business rules for MPR, appraisal grades, loan PAR, mobility and productivity bonuses — seeded from the bank
        master source, editable by HR, versioned in <code className="text-slate-700">performance_config</code>. Every change is audited.
      </p>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {loading && <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>}

      {!loading && !data && (
        <div><ErrorState message="No sections returned. Run the phase 26 migration in Supabase, then retry." /></div>
      )}

      {!loading && data && (
        <>
          <div className="flex items-center gap-2 overflow-x-auto pb-3 mb-5">
            <button onClick={() => setTab('rules')}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === 'rules' ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
              <SlidersHorizontal className="w-3 h-3" /> Business Rules
            </button>
            <button onClick={() => setTab('audit')}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === 'audit' ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
              <History className="w-3 h-3" /> Change History
            </button>
            {isAdmin && (
              <button onClick={() => setTab('advanced')}
                className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === 'advanced' ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
                <ShieldAlert className="w-3 h-3" /> Advanced (JSON)
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {canManage && (
                <button onClick={resetAll} disabled={busyKey === '__all__'}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                  {busyKey === '__all__' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  Reset to InfinityCore Defaults
                </button>
              )}
            </div>
          </div>

          {tab === 'rules' && (
            <div className="grid lg:grid-cols-4 gap-6">
              <div className="space-y-2">
                {(data.sections || []).map((s) => (
                  <button key={s.code} onClick={() => setActiveCode(s.code)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium border ${activeSection?.code === s.code ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                    {s.label}
                    <span className={`block text-xs ${activeSection?.code === s.code ? 'text-emerald-100' : 'text-slate-400'}`}>{s.code}</span>
                  </button>
                ))}
              </div>

              <div className="lg:col-span-3 space-y-3">
                {activeSection?.items?.length === 0 && <EmptyState title="No items in this section" description="Nothing configured yet." />}
                {activeSection?.items?.map((item) => (
                  <SectionEditor
                    key={item.config_key}
                    item={item}
                    canManage={canManage}
                    busy={busyKey === item.config_key}
                    designations={designations}
                    onSave={saveItem}
                    onReset={resetItem}
                  />
                ))}
              </div>
            </div>
          )}

          {tab === 'advanced' && isAdmin && (
            <div className="grid lg:grid-cols-4 gap-6">
              <div className="space-y-2">
                {(data.sections || []).map((s) => (
                  <button key={s.code} onClick={() => setActiveCode(s.code)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium border ${activeSection?.code === s.code ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                    {s.label}
                    <span className={`block text-xs ${activeSection?.code === s.code ? 'text-emerald-100' : 'text-slate-400'}`}>{s.code}</span>
                  </button>
                ))}
              </div>

              <div className="lg:col-span-3 space-y-3">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  Escape hatch only — JSON edits bypass the business-rules editor and require expertise. Prefer the Business Rules tab.
                </div>
                {activeSection?.items?.length === 0 && <EmptyState title="No items in this section" description="Nothing configured yet." />}
                {activeSection?.items?.map((item) => (
                  <ConfigCard
                    key={item.config_key}
                    item={item}
                    canManage={canManage}
                    busy={busyKey === item.config_key}
                    onSave={saveItem}
                    onReset={resetItem}
                  />
                ))}
              </div>
            </div>
          )}

          {tab === 'audit' && <AuditTable audit={audit} />}
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

  const save = async () => {
    let parsed
    try {
      parsed = typeof editValue === 'string' ? JSON.parse(editValue) : editValue
    } catch {
      window.alert('Invalid JSON — check commas, quotes and brackets.')
      return
    }
    await onSave(item, parsed, editReason || null)
  }

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
            v{item.version || 1}
          </span>
          {canManage && (
            <>
              <button onClick={async () => { if (window.confirm(`Reset ${item.label} to bank default?`)) await onReset(item.config_key) }} disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50 disabled:opacity-50">
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </button>
              <button onClick={() => setEditor((v) => !v)} disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36] disabled:opacity-50">
                Edit JSON
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
            <label className="block text-sm font-medium text-slate-700 mb-1.5">JSON Value</label>
            <textarea className="w-full rounded-lg border border-slate-300 p-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={item.data_type === 'json' ? 14 : 3} value={editValue} onChange={(e) => setEditValue(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Reason for change (audited)</label>
            <input className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="e.g. Updated PAR band after board review" />
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy || !changed || !editReason.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save Change
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

function humanSummary(configKey, raw) {
  const t = getTranslator(configKey)
  let out = ''
  try {
    out = t.describe(t.fromConfig(raw)).map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).filter(Boolean).join('  •  ')
  } catch {
    out = ''
  }
  return out || pretty(raw)
}

function AuditTable({ audit }) {
  if (audit.length === 0) return <EmptyState title="No changes yet" description="Every save or reset appears here with the controlling user and reason." />
  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-left">
          <tr>
            <th className="px-4 py-3 font-medium">Config</th>
            <th className="px-4 py-3 font-medium">What changed</th>
            <th className="px-4 py-3 font-medium">Reason</th>
            <th className="px-4 py-3 font-medium">By</th>
            <th className="px-4 py-3 font-medium">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {audit.map((a) => (
            <tr key={a.id} className="hover:bg-slate-50 align-top">
              <td className="px-4 py-3 font-mono text-xs text-slate-700">{a.config_key}<div className="text-[10px] text-slate-400">{a.section}</div></td>
              <td className="px-4 py-3 text-xs text-slate-600 min-w-[260px] max-w-md">
                <p className="text-slate-400 line-clamp-2">{humanSummary(a.config_key, a.old_value)}</p>
                <p className="text-[#009944] mt-1">↓</p>
                <p className="text-slate-800 line-clamp-3">{humanSummary(a.config_key, a.new_value)}</p>
              </td>
              <td className="px-4 py-3 text-xs text-slate-500 max-w-[240px]">{a.reason || '—'}</td>
              <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{a.actor || '—'}</td>
              <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{a.changed_at ? new Date(a.changed_at).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}