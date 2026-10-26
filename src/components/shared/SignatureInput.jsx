import React, { useRef, useState } from 'react'
import { Upload, PenLine, Trash2 } from 'lucide-react'

const ALLOWED = ['image/png','image/jpeg','application/pdf']
const MAX = 5 * 1024 * 1024

export default function SignatureInput({ onChange, mode = 'both' }) {
  const [tab, setTab] = useState('draw')
  const [preview, setPreview] = useState(null)
  const [file, setFile] = useState(null)
  const canvasRef = useRef(null)
  const drawing = useRef(false)

  const start = (e) => { drawing.current = true; const c = canvasRef.current; const r = c.getBoundingClientRect(); const ctx = c.getContext('2d'); ctx.beginPath(); ctx.moveTo(e.clientX - r.left, e.clientY - r.top) }
  const move = (e) => { if (!drawing.current) return; const c = canvasRef.current; const r = c.getBoundingClientRect(); const ctx = c.getContext('2d'); ctx.lineTo(e.clientX - r.left, e.clientY - r.top); ctx.stroke() }
  const end = () => { drawing.current = false; const c = canvasRef.current; const data = c.toDataURL('image/png'); setPreview(data); onChange?.({ mode: 'draw', dataUrl: data }) }

  const onUpload = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (!ALLOWED.includes(f.type)) { alert('Only PNG, JPG or PDF allowed.'); return }
    if (f.size > MAX) { alert('File exceeds 5 MB.'); return }
    setFile(f)
    const reader = new FileReader()
    reader.onload = () => { setPreview(reader.result); onChange?.({ mode: 'upload', file: f, dataUrl: reader.result }) }
    reader.readAsDataURL(f)
  }

  const clear = () => { setPreview(null); setFile(null); const c = canvasRef.current; c.getContext('2d').clearRect(0,0,c.width,c.height); onChange?.(null) }

  return (
    <div className="space-y-2">
      <div className="flex gap-2 text-xs">
        <button type="button" onClick={() => setTab('draw')} className={`rounded px-2 py-1 ${tab==='draw'?'bg-[#009944] text-white':'bg-slate-100'}`}>Draw</button>
        <button type="button" onClick={() => setTab('upload')} className={`rounded px-2 py-1 ${tab==='upload'?'bg-[#009944] text-white':'bg-slate-100'}`}>Upload</button>
      </div>
      {tab === 'draw' && (
        <canvas ref={canvasRef} width={400} height={120} className="border border-slate-300 rounded" onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end} />
      )}
      {tab === 'upload' && (
        <label className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm cursor-pointer">
          <Upload className="h-4 w-4" /> Choose file
          <input type="file" className="hidden" accept="image/png,image/jpeg,application/pdf" onChange={onUpload} />
        </label>
      )}
      {preview && (
        <div className="space-y-1">
          <img src={preview} alt="signature preview" className="max-h-24 border border-slate-200 rounded" />
          <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-xs text-red-600"><Trash2 className="h-3 w-3" /> Remove</button>
        </div>
      )}
    </div>
  )
}
