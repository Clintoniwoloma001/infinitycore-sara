import React, { useMemo, useState } from 'react'
import { CheckCircle2, AlertTriangle, Loader2, Sparkles, ClipboardList, ArrowRight } from 'lucide-react'
import { analyzeOnboarding, saraGreeting, saraAssessmentMessage } from '../../services/saraPreReview'

const ASSESSMENT_STYLES = {
  'READY FOR HR REVIEW': {
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    icon: CheckCircle2,
    iconColor: 'text-emerald-500',
    barColor: 'from-emerald-500 to-emerald-400',
  },
  'CORRECTION RECOMMENDED': {
    badge: 'bg-amber-50 text-amber-700 border-amber-200',
    icon: AlertTriangle,
    iconColor: 'text-amber-500',
    barColor: 'from-amber-500 to-amber-400',
  },
  'ATTENTION REQUIRED': {
    badge: 'bg-rose-50 text-rose-700 border-rose-200',
    icon: AlertTriangle,
    iconColor: 'text-rose-500',
    barColor: 'from-rose-500 to-rose-400',
  },
}

export default function SaraPreReview({ submission, verification, onboardingCorrections, guarantorCorrections, userName, onContinueReview, onRequestCorrections }) {
  const [selectedRecs, setSelectedRecs] = useState(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const analysis = useMemo(
    () => analyzeOnboarding(submission, verification, onboardingCorrections, guarantorCorrections),
    [submission, verification, onboardingCorrections, guarantorCorrections]
  )

  const greeting = useMemo(() => saraGreeting(userName), [userName])
  const assessmentMsg = useMemo(() => saraAssessmentMessage(analysis), [analysis])
  const style = ASSESSMENT_STYLES[analysis.assessment] || ASSESSMENT_STYLES['READY FOR HR REVIEW']
  const AssesIcon = style.icon

  const toggleRec = (idx) => {
    setSelectedRecs((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const handleRequestCorrections = async () => {
    const selected = analysis.recommendations.filter((_, idx) => selectedRecs.has(idx))
    if (selected.length === 0) return
    setSubmitting(true)
    try {
      await onRequestCorrections(selected)
      setSubmitted(true)
    } catch (e) {
      // parent handles error display
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden mb-6 bg-white">
      {/* Gradient header bar */}
      <div className={`bg-gradient-to-r ${style.barColor} px-5 py-3 flex items-center gap-2`}>
        <Sparkles className="w-5 h-5 text-white" />
        <span className="text-white font-semibold text-sm tracking-wide">SARA Pre-Review</span>
        <span className="text-white/70 text-xs ml-auto">Smart Automated Reporting & Approval Analyst</span>
      </div>

      <div className="p-5">
        {/* Greeting + assessment */}
        <div className="flex items-start gap-4 mb-4">
          <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${style.barColor} flex items-center justify-center flex-shrink-0`}>
            <AssesIcon className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-700 leading-relaxed">{greeting}</p>
            <p className="text-sm text-slate-600 leading-relaxed mt-1">{assessmentMsg}</p>
          </div>
        </div>

        {/* Assessment badge */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs font-medium text-slate-500">Overall assessment:</span>
          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${style.badge}`}>
            <AssesIcon className="w-3.5 h-3.5" /> {analysis.assessment}
          </span>
        </div>

        {/* Issues list */}
        {analysis.issues.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Potential Issues</h4>
            <div className="space-y-1.5">
              {analysis.issues.map((issue, idx) => (
                <div key={idx} className="flex items-start gap-2 text-sm">
                  <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${issue.severity === 'high' ? 'bg-rose-500' : issue.severity === 'medium' ? 'bg-amber-500' : 'bg-slate-400'}`} />
                  <span className="text-slate-600">{issue.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* HR attention items */}
        {analysis.attentionItems.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">HR Should Pay Attention To</h4>
            <ol className="space-y-1.5">
              {analysis.attentionItems.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2 text-sm">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-slate-100 text-slate-500 text-xs font-medium flex items-center justify-center">{idx + 1}</span>
                  <span className="text-slate-600">{item}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* No issues message */}
        {analysis.issues.length === 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 mb-4">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            <span className="text-sm text-emerald-700">No obvious completeness issues detected. HR review recommended.</span>
          </div>
        )}

        {/* Recommended corrections */}
        {analysis.hasRecommendations && !submitted && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Recommended Corrections</h4>
            <div className="space-y-1.5">
              {analysis.recommendations.map((rec, idx) => (
                <label key={idx} className="flex items-start gap-2.5 text-sm cursor-pointer hover:bg-slate-50 rounded-lg p-2 -mx-2">
                  <input
                    type="checkbox"
                    checked={selectedRecs.has(idx)}
                    onChange={() => toggleRec(idx)}
                    className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#009944] focus:ring-[#009944]"
                  />
                  <div>
                    <span className="font-medium text-slate-700">{rec.fieldLabel}</span>
                    <span className="text-slate-500"> — {rec.reason}</span>
                  </div>
                </label>
              ))}
            </div>
            {selectedRecs.size > 0 && (
              <button
                onClick={handleRequestCorrections}
                disabled={submitting}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />}
                Request {selectedRecs.size} Correction{selectedRecs.size > 1 ? 's' : ''}
              </button>
            )}
          </div>
        )}

        {submitted && (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 mb-4">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            <span className="text-sm text-emerald-700">Correction requests have been submitted. The applicant will be notified.</span>
          </div>
        )}

        {/* Continue button */}
        <button
          onClick={onContinueReview}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#009944] hover:underline"
        >
          Continue Manual Review <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
