import React, { useEffect, useRef, useState } from 'react'
import { Eraser, Undo2 } from 'lucide-react'

// Lightweight, dependency-free signature pad. Works with mouse,
// trackpad, and touch. Exposes the drawn signature as a PNG data URL
// via onChange(dataUrlOrNull).
export default function SignaturePad({ onChange, height = 160 }) {
  const canvasRef = useRef(null)
  const drawing = useRef(false)
  const strokes = useRef([]) // stack of {x,y} arrays, for undo
  const currentStroke = useRef([])
  const [isEmpty, setIsEmpty] = useState(true)

  const getCtx = () => canvasRef.current?.getContext('2d')

  const resize = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * ratio
    canvas.height = rect.height * ratio
    const ctx = getCtx()
    ctx.scale(ratio, ratio)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.lineWidth = 2.2
    ctx.strokeStyle = '#0f172a'
    redraw()
  }

  useEffect(() => {
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const redraw = () => {
    const canvas = canvasRef.current
    const ctx = getCtx()
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    strokes.current.forEach((stroke) => {
      if (stroke.length < 2) return
      ctx.beginPath()
      ctx.moveTo(stroke[0].x, stroke[0].y)
      stroke.slice(1).forEach((pt) => ctx.lineTo(pt.x, pt.y))
      ctx.stroke()
    })
  }

  const pointFromEvent = (e) => {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const point = e.touches ? e.touches[0] : e
    return { x: point.clientX - rect.left, y: point.clientY - rect.top }
  }

  const start = (e) => {
    e.preventDefault()
    drawing.current = true
    currentStroke.current = [pointFromEvent(e)]
  }

  const move = (e) => {
    if (!drawing.current) return
    e.preventDefault()
    const pt = pointFromEvent(e)
    currentStroke.current.push(pt)
    const ctx = getCtx()
    const s = currentStroke.current
    if (s.length >= 2) {
      ctx.beginPath()
      ctx.moveTo(s[s.length - 2].x, s[s.length - 2].y)
      ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y)
      ctx.stroke()
    }
  }

  const end = () => {
    if (!drawing.current) return
    drawing.current = false
    if (currentStroke.current.length > 1) {
      strokes.current.push(currentStroke.current)
      setIsEmpty(false)
      emit()
    }
    currentStroke.current = []
  }

  const emit = () => {
    const canvas = canvasRef.current
    const empty = strokes.current.length === 0
    onChange?.(empty ? null : canvas.toDataURL('image/png'))
  }

  const clear = () => {
    strokes.current = []
    setIsEmpty(true)
    redraw()
    onChange?.(null)
  }

  const undo = () => {
    strokes.current.pop()
    setIsEmpty(strokes.current.length === 0)
    redraw()
    emit()
  }

  return (
    <div>
      <div className="relative border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 overflow-hidden">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height }}
          className="touch-none cursor-crosshair block"
          onMouseDown={start}
          onMouseMove={move}
          onMouseUp={end}
          onMouseLeave={end}
          onTouchStart={start}
          onTouchMove={move}
          onTouchEnd={end}
        />
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-slate-400 text-sm">
            Sign here
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-2">
        <button type="button" onClick={undo} disabled={isEmpty} className="text-xs flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 text-slate-600 disabled:opacity-40 hover:bg-slate-100">
          <Undo2 className="w-3.5 h-3.5" /> Undo
        </button>
        <button type="button" onClick={clear} disabled={isEmpty} className="text-xs flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 text-slate-600 disabled:opacity-40 hover:bg-slate-100">
          <Eraser className="w-3.5 h-3.5" /> Clear
        </button>
      </div>
    </div>
  )
}
