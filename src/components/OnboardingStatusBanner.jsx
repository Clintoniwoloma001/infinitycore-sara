import React from 'react'
import { ArrowRight, CheckCircle2, Clock3, FileCheck2, X } from 'lucide-react'
import { ONBOARDING_STATES } from '../services/onboardingStatusService'

export default function OnboardingStatusBanner({ status, onContinue, onDismiss }) {
  if (!status || status.state === ONBOARDING_STATES.COMPLETED) return null

  const pendingReview = status.state === ONBOARDING_STATES.PENDING_REVIEW
  const notStarted = status.state === ONBOARDING_STATES.NOT_STARTED
  const progress = Number(status.progress || 0)
  const missing = (status.missingFields || []).slice(0, 3).join(', ')

  return (
    <section
      role="status"
      aria-live="polite"
      className={`mb-6 rounded-xl border p-4 sm:p-5 ${pendingReview ? 'border-blue-200 bg-blue-50' : 'border-amber-200 bg-amber-50'}`}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${pendingReview ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
          {pendingReview ? <FileCheck2 className="h-5 w-5" /> : <Clock3 className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {pendingReview ? 'Onboarding submitted' : notStarted ? 'Start your InfinityCore profile' : 'Complete your InfinityCore profile'}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {pendingReview
                  ? 'Your onboarding information is awaiting HR review. You can continue using the dashboard while the review is in progress.'
                  : notStarted
                    ? 'Set up your employee profile to unlock the employee features available to you.'
                    : `Your onboarding is ${progress}% complete. Complete the remaining information to unlock all employee features.`}
              </p>
              {!pendingReview && !notStarted && missing && <p className="mt-1 text-xs text-slate-500">Still needed: {missing}{(status.missingFields || []).length > 3 ? ' and more' : ''}</p>}
            </div>
            {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss onboarding reminder" className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-white/70 hover:text-slate-700"><X className="h-4 w-4" /></button>}
          </div>

          {!pendingReview && !notStarted && (
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/80" aria-label={`${progress}% complete`}>
              <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!pendingReview && onContinue && (
              <button type="button" onClick={onContinue} className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-3 py-2 text-xs font-medium text-white hover:bg-[#007a36] focus:outline-none focus:ring-2 focus:ring-[#009944] focus:ring-offset-2">
                {notStarted ? 'Start Onboarding' : 'Continue Onboarding'} <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
            {pendingReview && <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700"><CheckCircle2 className="h-4 w-4" /> Awaiting HR review</span>}
          </div>
        </div>
      </div>
    </section>
  )
}
