import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

export const toIsoDate = (d) => {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${m}-${day}`
}

export const fromIsoDate = (v) => {
  if (!v) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  const s = String(v).slice(0, 10)
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10))
  if (!y || !m || !d) return null
  const date = new Date(y, m - 1, d)
  return Number.isNaN(date.getTime()) ? null : date
}

const isSameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/**
 * Portal'd calendar popover.
 *
 * Rendered into `document.body` with `position: fixed` so it can never be
 * clipped by `overflow-x-auto` / `overflow-hidden` ancestors (the Director
 * filter bar scrolls horizontally, which is exactly where an inline
 * `<input type="date">` used to disappear).
 *
 * Controlled component: the caller owns `isOpen` (and anchors it via
 * `targetRef`), receives `onChange(Date | null)` and `onClose()`.
 */
export default function DatePicker({
  isOpen = false,
  selectedDate = null,
  onChange,
  onClose,
  targetRef,
  min = null,
  max = null,
  title = 'Select date',
}) {
  const popRef = useRef(null)
  const [pos, setPos] = useState(null)
  const selected = fromIsoDate(selectedDate)
  const [cursor, setCursor] = useState(() => selected || startOfDay(new Date()))

  useEffect(() => {
    if (isOpen) setCursor(selected || startOfDay(new Date()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useLayoutEffect(() => {
    if (!isOpen) {
      setPos(null)
      return undefined
    }
    const compute = () => {
      const el = targetRef?.current
      const pop = popRef.current
      if (!el || !pop) return null
      const r = el.getBoundingClientRect()
      const h = pop.offsetHeight
      const w = pop.offsetWidth
      const GAP = 8
      const MARGIN = 8
      let top = r.bottom + GAP
      if (top + h > window.innerHeight - MARGIN && r.top - GAP - h > MARGIN) top = r.top - GAP - h
      let left = r.left
      if (left + w > window.innerWidth - MARGIN) left = r.right - w
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN))
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))
      return { top, left }
    }
    setPos(compute())
    const onViewport = () => setPos(compute())
    window.addEventListener('resize', onViewport)
    window.addEventListener('scroll', onViewport, true)
    return () => {
      window.removeEventListener('resize', onViewport)
      window.removeEventListener('scroll', onViewport, true)
    }
  }, [isOpen, targetRef])

  // Outside click + Escape dismiss the popover.
  useEffect(() => {
    if (!isOpen) return undefined
    const onPointerDown = (e) => {
      if (popRef.current?.contains(e.target)) return
      if (targetRef?.current?.contains?.(e.target)) return
      onClose?.()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, onClose, targetRef])

  if (!isOpen) return null

  const year = cursor.getFullYear()
  const month = cursor.getMonth()
  const today = startOfDay(new Date())
  const minDate = fromIsoDate(min)
  const maxDate = fromIsoDate(max)
  const firstWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const yearOptions = Array.from({ length: 13 }, (_, i) => year - 6 + i)

  const inRange = (d) => {
    if (minDate && d < minDate) return false
    if (maxDate && d > maxDate) return false
    return true
  }
  const moveMonth = (delta) => setCursor(new Date(year, month + delta, 1))
  const pick = (d) => {
    if (!inRange(d)) return
    onChange?.(d)
    onClose?.()
  }

  const cellClass = (active, disabled) =>
    `h-8 w-8 rounded-lg text-xs leading-none transition ${
      disabled
        ? 'cursor-not-allowed text-slate-300'
        : active
          ? 'bg-blue-600 font-semibold text-white shadow'
          : 'text-slate-700 hover:bg-slate-100'
    }`

  const node = (
    <div
      ref={popRef}
      style={{ position: 'fixed', zIndex: 50, top: pos?.top ?? 0, left: pos?.left ?? 0 }}
      className="w-[300px] rounded-xl border border-slate-200 bg-white p-4 shadow-2xl"
      role="dialog"
      aria-label={title}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex items-center justify-between gap-1">
        <button type="button" onClick={() => moveMonth(-1)} aria-label="Previous month"
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-1">
          <select
            value={month}
            onChange={(e) => setCursor(new Date(year, Number(e.target.value), 1))}
            className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs font-semibold text-slate-700 focus:border-blue-500 focus:outline-none"
          >
            {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
          <select
            value={year}
            onChange={(e) => setCursor(new Date(Number(e.target.value), month, 1))}
            className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-xs font-semibold text-slate-700 focus:border-blue-500 focus:outline-none"
          >
            {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button type="button" onClick={() => moveMonth(1)} aria-label="Next month"
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => <div key={w} className="text-[10px] font-semibold uppercase text-slate-400">{w}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstWeekday }, (_, i) => <div key={`pad-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = new Date(year, month, i + 1)
          const disabled = !inRange(day)
          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => pick(day)}
              className={`${cellClass(isSameDay(day, selected) || isSameDay(day, today), disabled)} ${
                isSameDay(day, today) && !isSameDay(day, selected) ? 'border border-blue-200 font-semibold text-blue-600' : ''
              }`}
            >
              {i + 1}
            </button>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={() => { pick(startOfDay(new Date())) }}
          className="text-xs font-semibold text-blue-600 hover:text-blue-800"
        >
          Today
        </button>
        <button
          type="button"
          onClick={() => { onChange?.(null); onClose?.() }}
          className="text-xs font-semibold text-slate-500 hover:text-slate-800"
        >
          Clear
        </button>
      </div>
    </div>
  )

  const host = typeof document !== 'undefined' && document.getElementById('portal-root')
  return createPortal(node, host || (typeof document !== 'undefined' ? document.body : null))
}
