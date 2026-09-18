import React from 'react'
import { QRCodeSVG } from 'qrcode.react'
import Logo from '../Logo'
import { screeningTypeLabel, formatMedDate, cardScreeningStatus } from './medicalUi'

// InfinityCore Medical Screening / Hospital Referral Card.
//
// This card is rendered from a referral + its QR URL. It contains NO health
// data — only the identity + referral metadata required by a hospital to run
// the screening, plus a QR code that resolves to the secure portal.
//
// Suitable for screen preview, printing (CSS print portal) and PNG capture
// (canvas in the parent modal). Reuses the existing InfinityCore branding,
// colour system and Logo component.
export default function MedicalCardPrint({ referral = {}, qrUrl = '', photoUrl = null }) {
  const status = referral.status || 'issued'
  const isEmployee = referral.hiring_route === 'employee'
  const subjectId = isEmployee ? referral.employee_id : referral.candidate_id
  const idLabel = isEmployee ? 'Employee ID' : 'Candidate ID'
  const initials = (referral.subject_name || '—')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join('') || 'IC'

  return (
    <div className="mx-auto max-w-[620px]">
      <div className="bg-white rounded-2xl overflow-hidden border border-slate-200 shadow-sm">
        {/* HEADER / GREEN BRAND BANNER */}
        <div className="bg-gradient-to-br from-[#009944] to-[#007a36] px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Logo size={34} variant="light" />
              <div>
                <p className="text-white text-sm font-bold tracking-wide leading-tight">Medical Screening Card</p>
                <p className="text-emerald-100 text-[10px] tracking-wider uppercase">Hospital Referral · Authorized Use Only</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-white font-mono text-[13px] font-bold">{referral.reference || '—'}</p>
              <p className="text-emerald-100 text-[9px] uppercase">Reference</p>
            </div>
          </div>
        </div>

        {/* ORANGE DIVIDER */}
        <div className="h-[3px] bg-gradient-to-r from-[#ff9d00] via-[#FF8C00] to-[#ffb84d]" />

        {/* PROFILE */}
        <div className="px-6 pt-5 pb-3">
          <div className="flex items-start gap-4">
            <div className="w-[76px] h-[92px] rounded-lg border border-slate-200 bg-slate-50 overflow-hidden flex-shrink-0 flex items-center justify-center">
              {photoUrl ? (
                <img src={photoUrl} alt="Subject" className="w-full h-full object-cover object-top" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-slate-100 to-emerald-50 flex items-center justify-center">
                  <span className="text-2xl font-bold text-[#009944]">{initials}</span>
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium">Candidate / Employee</p>
              <p className="text-lg font-bold text-slate-900 leading-snug break-words">{referral.subject_name || '—'}</p>
              <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-xs text-slate-600">
                <span><span className="text-slate-400">{idLabel}:</span>{' '}<span className="font-semibold text-slate-800">{subjectId ? String(subjectId).slice(0, 8).toUpperCase() : '—'}</span></span>
                <span><span className="text-slate-400">Position:</span>{' '}<span className="font-medium">{referral.subject_position || '—'}</span></span>
                <span><span className="text-slate-400">Dept:</span>{' '}<span className="font-medium">{referral.subject_department || '—'}</span></span>
                {referral.subject_branch && <span><span className="text-slate-400">Branch:</span>{' '}<span className="font-medium">{referral.subject_branch}</span></span>}
              </div>
            </div>
          </div>
        </div>

        {/* DETAIL GRID */}
        <div className="px-6 pb-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 bg-slate-50 rounded-xl border border-slate-100 p-3">
            <div>
              <p className="text-[9px] text-slate-400 uppercase tracking-wide">Screening Type</p>
              <p className="text-xs font-semibold text-slate-800 mt-0.5">{screeningTypeLabel(referral.screening_type, referral.other_screening_type)}</p>
            </div>
            <div>
              <p className="text-[9px] text-slate-400 uppercase tracking-wide">Screening Status</p>
              <p className="text-xs font-semibold text-slate-800 mt-0.5">{cardScreeningStatus(status)}</p>
            </div>
            <div>
              <p className="text-[9px] text-slate-400 uppercase tracking-wide">Date Issued</p>
              <p className="text-xs font-semibold text-slate-800 mt-0.5">{formatMedDate(referral.issued_at || referral.created_at)}</p>
            </div>
            <div>
              <p className="text-[9px] text-slate-400 uppercase tracking-wide">Expiry Date</p>
              <p className="text-xs font-semibold text-slate-800 mt-0.5">{formatMedDate(referral.expires_at)}</p>
            </div>
            <div>
              <p className="text-[9px] text-slate-400 uppercase tracking-wide">Referring HR Officer</p>
              <p className="text-xs font-semibold text-slate-800 mt-0.5 break-words">{referral.referring_hr_name || '—'}</p>
            </div>
            <div>
              <p className="text-[9px] text-slate-400 uppercase tracking-wide">Hospital / Provider</p>
              <p className="text-xs font-semibold text-slate-800 mt-0.5 break-words">{referral.hospital_name || 'To be assigned'}</p>
            </div>
          </div>

          {referral.notes && (
            <div className="mt-3 rounded-lg border border-slate-200 px-3 py-2">
              <p className="text-[9px] text-slate-400 uppercase tracking-wide">Notes / Instructions</p>
              <p className="text-xs text-slate-600 mt-0.5 whitespace-pre-wrap">{referral.notes}</p>
            </div>
          )}
        </div>

        {/* QR + HOSPITAL INSTRUCTIONS */}
        <div className="px-6 pb-5">
          <div className="flex flex-col sm:flex-row gap-4 items-start rounded-xl border border-slate-200 p-4">
            <div className="bg-white rounded-lg border border-slate-200 p-2 flex-shrink-0 mx-auto sm:mx-0">
              <QRCodeSVG value={qrUrl} size={116} level="M" marginSize={1} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide mb-1">Hospital Instructions</p>
              <ol className="text-[11px] text-slate-500 space-y-1 list-decimal list-inside">
                <li>Scan the QR code to open the InfinityCore Medical Screening Portal.</li>
                <li>Complete the structured screening form and investigations listed above.</li>
                <li>Enter your medical officer details and sign electronically.</li>
                <li>Submit — the result is transmitted directly to InfinityCore Human Resources.</li>
              </ol>
              <p className="mt-2 text-[10px] font-semibold text-[#009944] uppercase tracking-wide">For authorized medical screening use only</p>
            </div>
          </div>

          <div className="mt-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-[11px] text-slate-500">This card identifies the holder solely for authorized medical screening.</p>
              <p className="text-[10px] text-slate-400 mt-0.5">Scanned by the assigned medical facility only. Do not share beyond performing staff.</p>
            </div>
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">InfinityCore · HR</span>
          </div>
        </div>
      </div>
    </div>
  )
}