import React, { useState } from 'react'
import { AlertTriangle, Loader2, Send, X } from 'lucide-react'

const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

export default function CorrectionRequestModal({ field, section, currentValue, onSubmit, onCancel, busy }) {
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')

  const handleSubmit = () => {
    if (!comment.trim()) return
    onSubmit({
      field_name: field.key,
      field_label: field.label,
      section: section?.id || '',
      hr_comment: comment.trim(),
    })
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            <h4 className="text-base font-semibold text-slate-900">Request Correction</h4>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className={labelCls}>Field</label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-800">
              {field.label}
            </div>
          </div>
          <div>
            <label className={labelCls}>Current Value</label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 max-h-24 overflow-y-auto break-words">
              {currentValue || <span className="text-slate-300 italic">No value submitted</span>}
            </div>
          </div>
          <div>
            <label className={labelCls}>Reason for Correction <span className="text-rose-500">*</span></label>
            <textarea
              className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain what is wrong with this field…"
            />
          </div>
          <div>
            <label className={labelCls}>HR Comment / Instruction <span className="text-rose-500">*</span></label>
            <textarea
              className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Tell the candidate what to correct and how…"
            />
            {!comment.trim() && (
              <p className="text-xs text-rose-500 mt-1">A comment is required.</p>
            )}
          </div>
        </div>
        <div className="sticky bottom-0 bg-white border-t border-slate-200 px-5 py-3 flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={busy || !comment.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Request Correction
          </button>
        </div>
      </div>
    </div>
  )
}
