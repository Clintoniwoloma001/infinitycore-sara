import React, { useState } from 'react'
import { CheckCircle2, Loader2, Upload, X } from 'lucide-react'
import SignaturePad from './SignaturePad'
import { fileToProcessedSignature } from '../services/signatureService'

export default function SignatureCaptureModal({ open, onClose, onSave, title = 'Add Signature', initialMode = 'pad' }) {
  const [mode, setMode] = useState(initialMode)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!open) return null

  const save = async () => {
    if (!preview) {
      setError('Please draw or upload a signature before saving.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSave(preview)
      onClose()
    } catch (e) {
      setError(e?.message || 'The signature could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg shadow-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex gap-2 mb-4">
          <button onClick={() => { setMode('pad'); setPreview(null); setError('') }} className={`px-3 py-2 rounded-lg text-sm ${mode === 'pad' ? 'bg-[#009944] text-white' : 'border border-slate-300 text-slate-600'}`}>Signature Pad</button>
          <button onClick={() => { setMode('upload'); setPreview(null); setError('') }} className={`px-3 py-2 rounded-lg text-sm ${mode === 'upload' ? 'bg-[#009944] text-white' : 'border border-slate-300 text-slate-600'}`}>Upload PNG</button>
        </div>
        {mode === 'pad' ? (
          <SignaturePad onChange={setPreview} height={160} />
        ) : (
          <div className="space-y-3">
            <label className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-8 text-sm text-slate-600 cursor-pointer hover:bg-slate-100">
              <Upload className="w-4 h-4" /> Select PNG image
              <input type="file" accept="image/png" className="hidden" onChange={async (event) => {
                try {
                  setError('')
                  setPreview(await fileToProcessedSignature(event.target.files?.[0]))
                } catch (e) { setError(e?.message || 'The image could not be processed.') }
              }} />
            </label>
            <p className="text-xs text-slate-400">White and near-white background pixels are removed while dark signature strokes are preserved.</p>
          </div>
        )}
        {preview && <div className="mt-4 rounded-lg border border-emerald-200 bg-[linear-gradient(45deg,#f8fafc_25%,transparent_25%),linear-gradient(-45deg,#f8fafc_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f8fafc_75%),linear-gradient(-45deg,transparent_75%,#f8fafc_75%)] bg-[length:16px_16px] bg-[position:0_0,0_8px,8px_-8px,-8px_0] p-4"><p className="text-xs font-medium text-slate-500 mb-2">Preview</p><img src={preview} alt="Signature preview" className="max-h-24 max-w-full object-contain" /></div>}
        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600">Cancel</button>
          <button onClick={save} disabled={busy || !preview} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Save Signature</button>
        </div>
      </div>
    </div>
  )
}
