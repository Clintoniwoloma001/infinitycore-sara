import React, { useEffect } from 'react'
import { X } from 'lucide-react'

/**
 * Shared dialog shell for the geofence module: backdrop, focus trap-ish
 * Escape handling and the standard z-50 overlay used everywhere else in
 * the app.
 *
 * LAYOUT CONTRACT (fixed for the reported overlap and clipping)
 * ------------------------------------------------------------
 * The dialog is a column box capped to the viewport: `max-h-[calc(100dvh-32px)]`
 * with `100dvh` (and a `vh` fallback) so it survives mobile browser chrome. The
 * body is the only part that scrolls; the header, the optional `footer` and the
 * close button are outside that scroller, so they can never be pushed off-screen
 * or end up under the backdrop. Callers that need a pinned action row pass it as
 * `footer` instead of putting it in `children`.
 *
 * STACKING
 * --------
 * The overlay sits at z-[1100], deliberately above Leaflet's own control pane
 * (z-index 1000). Leaflet is the one element on this page that can paint above
 * an ordinary z-50 layer, because its map panes/markers/controls only form a
 * stacking context if their container declares one — see the `relative z-0`
 * note in GeofenceMapEditor.jsx. The overlay also traps its own stacking
 * context, and the modal darkens the page so nothing behind it is clickable
 * while it is open.
 */
export default function Modal({
  open,
  onClose,
  children,
  footer = null,
  labelledBy,
  width = 'max-w-lg',
  closable = true,
}) {
  // Freeze the page behind the dialog and give it back on close.
  useEffect(() => {
    if (!open) return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

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
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/50 p-4"
      style={{ maxHeight: '100dvh' }}
      onMouseDown={(event) => {
        if (closable && event.target === event.currentTarget) onClose?.()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800 ${width}`}
      >
        {closable && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {/* The only scrolling region. Shrinks (min-h-0) so its siblings keep
            their natural height instead of being squeezed off-screen. */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? (
          <div className="shrink-0 border-t border-slate-100 bg-white px-5 py-3 dark:border-slate-700 dark:bg-slate-800">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
