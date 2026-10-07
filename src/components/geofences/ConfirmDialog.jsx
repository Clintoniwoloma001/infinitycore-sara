import React from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import Modal from './Modal'

/**
 * Confirmation dialog for a destructive action (delete a fence).
 * The caller owns the error surface — pass `error` to show a message
 * returned by the server (already run through geofenceErrorMessage).
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal open={open} onClose={busy ? undefined : onCancel} closable={!busy}>
      <div className="p-5">
        <h2 id="gf-confirm-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h2>
        {message && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{message}</p>}
        {detail && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{detail}</p>}
        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${
              danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-[#009944] hover:bg-[#007a36]'
            }`}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {danger && !busy && <Trash2 className="w-4 h-4" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
