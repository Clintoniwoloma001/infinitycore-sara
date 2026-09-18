import {
  MEDICAL_STATUS_LABELS,
  MEDICAL_OUTCOME_LABELS,
  SCREENING_TYPE_LABEL,
} from '../../services/medicalScreeningService'

export const statusColorMap = {
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
  gray: 'bg-slate-100 text-slate-500 border-slate-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  orange: 'bg-orange-50 text-orange-700 border-orange-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
}

const STATUS_COLORS = {
  draft: 'gray',
  issued: 'blue',
  qr_opened: 'indigo',
  screening_started: 'violet',
  submitted: 'amber',
  under_review: 'orange',
  cleared: 'emerald',
  cleared_with_restrictions: 'orange',
  further_review: 'amber',
  not_cleared: 'rose',
  revoked: 'slate',
}

const OUTCOME_COLORS = {
  fit_for_work: 'emerald',
  fit_with_restrictions: 'orange',
  further_review: 'amber',
  not_cleared: 'rose',
  pending: 'slate',
}

export function medicalStatusBadge(status) {
  const label = MEDICAL_STATUS_LABELS[status] || status || '—'
  const color = STATUS_COLORS[status] || 'slate'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${statusColorMap[color] || statusColorMap.slate}`}>
      {label}
    </span>
  )
}

export function medicalOutcomeBadge(outcome) {
  const label = MEDICAL_OUTCOME_LABELS[outcome] || outcome || '—'
  const color = OUTCOME_COLORS[outcome] || 'slate'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${statusColorMap[color] || statusColorMap.slate}`}>
      {label}
    </span>
  )
}

export function screeningTypeLabel(value, other) {
  return SCREENING_TYPE_LABEL(value, other)
}

export function formatMedDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// A referral is effectively expired when its expiry timestamp has passed and
// it was never completed. Design A stores no explicit "expired" status.
export function isReferralExpired(referral) {
  if (!referral?.expires_at) return false
  if (['submitted', 'under_review', 'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared', 'revoked'].includes(referral.status)) return false
  return new Date(referral.expires_at) < new Date()
}

// Screening status shown on the card / landing page, derived from the
// referral lifecycle status.
export function cardScreeningStatus(status) {
  switch (status) {
    case 'submitted':
    case 'under_review':
      return 'Completed — Pending HR Review'
    case 'cleared':
    case 'cleared_with_restrictions':
    case 'further_review':
    case 'not_cleared':
      return 'Completed'
    case 'screening_started':
      return 'In Progress'
    case 'draft':
      return 'Not Yet Issued'
    case 'revoked':
      return 'Revoked'
    default:
      return 'Pending Medical Examination'
  }
}
