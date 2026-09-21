import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Pencil, RotateCcw, Save, ShieldCheck, X } from 'lucide-react'
import { getTranslator } from '../../domains/performance/rules/index.js'
import { getSectionEditor, RuleSentence } from './editors.jsx'

const lineText = (line) => (typeof line === 'string' ? line : (line && line.text) || '')

// ------------------------------------------------------------------
// SECTION EDITOR — one performance_config item rendered as a no-code
// business-rules editor. The translator owns draft <-> stored JSON;
// this shell owns edit/save/reset state and the audited reason.
// ------------------------------------------------------------------
export default function SectionEditor({ item, canManage, busy, onSave, onReset, designations = [] }) {
  const translator = getTranslator(item.config_key)
  const Editor = getSectionEditor(item.config_key)
  const readOnly = !translator.editable || !Editor

  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(false)
  const [saved, setSaved] = useState(false)

  const [draft, setDraft] = useState(() => translator.fromConfig(item.current_value))

  // re-hydrate when server returns fresh data (save/reset/reload)
  useEffect(() => {
    setDraft(translator.fromConfig(item.current_value))
    setEditing(false)
    setReason('')
    setSaved(false)
  }, [item.config_key, item.changed_at, item.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const errors = useMemo(() => translator.validate(draft), [draft, translator])
  const preview = translator.describe(draft)

  const changesMade = editing && JSON.stringify(translator.toConfig(draft)) !== JSON.stringify(item.current_value)

  const startEdit = () => {
    setDraft(translator.fromConfig(item.current_value))
    setEditing(true)
    setReason('')
  }

  const cancel = () => {
    setDraft(translator.fromConfig(item.current_value))
    setEditing(false)
    setReason('')
  }

  const save = async () => {
    if (errors.length || !reason.trim() || !changesMade || busy) return
    setWorking(true)
    setSaved(false)
    try {
      await onSave(item, translator.toConfig(draft), reason.trim())
      setSaved(true)
      setEditing(false)
      setReason('')
    } catch {
      // the page surfaces the server error banner; stay in edit mode
    } finally {
      setWorking(false)
    }
  }

  const dirty = reason.trim().length > 0

  return (
    <div className="bg-white rounded-xl border border-slate-200">
      {/* header */}
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-slate-900">{item.label}</h4>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
              <ShieldCheck className="w-3 h-3" /> v{item.version || 1}
            </span>
            <span className="text-[11px] text-slate-400 font-mono">{item.config_key}</span>
          </div>
          {item.notes && <p className="text-xs text-slate-400 mt-1">{item.notes}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saved && (
            <span className="inline-flex items-center gap-1 text-xs text-[#009944] font-medium">
              <CheckCircle2 className="w-4 h-4" /> Saved
            </span>
          )}
          {canManage && !readOnly && !editing && (
            <>
              <button
                onClick={async () => { if (window.confirm(`Reset "${item.label}" to the bank default?`)) await onReset(item.config_key) }}
                disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50 disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </button>
              <button
                onClick={startEdit}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36]"
              >
                <Pencil className="w-3.5 h-3.5" /> Edit business rules
              </button>
            </>
          )}
        </div>
      </div>

      <div className="px-5 pb-5 space-y-4">
        {/* human-readable preview (or live editor) */}
        {!editing ? (
          <div className="rounded-lg bg-slate-50 border border-slate-100 p-3 space-y-1">
            {readOnly && (
              <p className="text-[11px] text-slate-400 mb-1">
                This item is engine metadata — inspect the reference values below; it is not directly editable.
              </p>
            )}
            {preview.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No readable summary.</p>
            ) : (
              preview.map((line, i) => (
                <p key={i} className="text-sm text-slate-700">
                  {lineText(line)}
                </p>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <Editor draft={draft} setDraft={setDraft} designations={designations} />

            {errors.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-1">
                {errors.map((e, i) => (
                  <p key={i} className="text-xs text-rose-700">• {e}</p>
                ))}
              </div>
            )}
            {!errors.length && preview.length > 0 && (
              <div className="rounded-lg bg-emerald-50/60 border border-emerald-100 p-3 space-y-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-600">Plain-language preview</p>
                {preview.map((line, i) => (
                  <p key={i} className="text-sm text-slate-700">{lineText(line)}</p>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Reason for change (audited)</label>
              <input
                className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Updated PAR band after board review"
              />
              <div className="flex gap-2">
                <button
                  onClick={save}
                  disabled={working || busy || errors.length > 0 || !changesMade || !dirty || !reason.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40"
                >
                  {working ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Change
                </button>
                <button onClick={cancel} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
                  <X className="w-4 h-4 inline mr-1" /> Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Reference sentence helper re-exported from editors.
export { RuleSentence }