import React from 'react'
import { AlertTriangle, ShieldAlert, Clock } from 'lucide-react'

export function LoadingState({ label = 'Loading...' }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" />
      <p className="text-sm text-slate-500 mt-3">{label}</p>
    </div>
  )
}

export function EmptyState({ title = 'No records found', description = 'There is no data to show yet.' }) {
  return (
    <div className="text-center py-14 bg-white rounded-lg border border-slate-200">
      <p className="font-medium text-slate-800">{title}</p>
      <p className="text-sm text-slate-500 mt-1">{description}</p>
    </div>
  )
}

export function ErrorState({ title = 'Unable to load data', message, children }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-600" />
      <div>
        <p className="font-semibold">{title}</p>
        {message && <p className="mt-1 text-amber-800">{message}</p>}
        {children}
      </div>
    </div>
  )
}

export function AccessDenied() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="max-w-md text-center bg-white border border-slate-200 rounded-lg p-8">
        <ShieldAlert className="w-12 h-12 text-amber-600 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Access Denied</h2>
        <p className="text-sm text-slate-500 mt-2">Your current role does not have permission to open this module.</p>
      </div>
    </div>
  )
}

export function ComingSoonPage({ title = 'Coming Soon', description = 'This module is not available yet. It will be delivered in a future update.', buttonLabel = 'Back to Dashboard', onBack }) {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center p-4">
      <div className="max-w-md bg-white border border-slate-200 rounded-xl p-10">
        <div className="w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-5">
          <Clock className="w-8 h-8 text-[#009944]" />
        </div>
        <h2 className="text-xl font-semibold text-slate-900 mb-2">{title}</h2>
        <p className="text-sm text-slate-500 mb-6">{description}</p>
        {buttonLabel && (
          <button
            onClick={onBack || (() => { window.location.hash = '#/' })}
            className="px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]"
          >
            {buttonLabel}
          </button>
        )}
      </div>
    </div>
  )
}
