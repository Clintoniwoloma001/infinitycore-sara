import React, { useEffect } from 'react'
import { X } from 'lucide-react'

/**
 * Shared dialog shell for the geofence module: backdrop, focus trap-ish
 * Escape handling and the standard z-50 overlay used everywhere else in
 * the app.
 */
export default function Modal({
  open,
  onClose,
  children,
  labelledBy,
  width = 'max-w-lg',
  closable = true,
}) {
  useEffect(() => {
    if (!open || !closable) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, closable, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (closable && event.target === event.currentTarget) onClose?.()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`relative w-full ${width} rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800`}
      >
        {closable && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {children}
      </div>
    </div>
  )
}
