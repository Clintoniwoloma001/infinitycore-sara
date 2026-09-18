import React from 'react'
import Logo from './Logo'

// InfinityCore Staff ID Card — front & back.
// Employee-facing ID is ALWAYS the official staff ID number
// (employee_number / staff_id / employee_code).
// Rendered straight into a body-level print portal for card printing.
// No BVN / NIN / salary / bank account data appears on the card.
//
// Expiry configuration:
//   expiryMode: 'none' | 'date'
//   expiryDate: ISO string used when expiryMode === 'date'
//   issueDate / issuedBy / status: HR-provided card metadata.
export default function StaffIdCard({
  employee = {},
  photoUrl = null,
  expiryMode = 'none',
  expiryDate = null,
  issueDate = null,
  issuedBy = 'Human Resources',
  status = 'active',
  managementSignature = null,
  cardHolderSignature = null,
}) {
  const name = employee?.full_name || '—'
  const number = employee?.employee_number || employee?.staff_id || employee?.employee_code || '—'
  const position = employee?.position || employee?.job_title || 'Staff'
  const department = employee?.department || '—'
  const branch = employee?.branch || 'Head Office'

  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join('') || 'IB'

  const issue = issueDate
    ? new Date(issueDate).toLocaleDateString('en-GB')
    : employee?.staff_id_issued_at
      ? new Date(employee.staff_id_issued_at).toLocaleDateString('en-GB')
      : new Date().toLocaleDateString('en-GB')

  const effectiveStatus =
    status ||
    (expiryMode === 'date' && expiryDate && new Date(expiryDate) < new Date()
      ? 'expired'
      : 'active')
  const isExpired = effectiveStatus === 'expired'

  const expiryLabel =
    expiryMode === 'date' && expiryDate
      ? new Date(expiryDate).toLocaleDateString('en-GB')
      : null

  return (
    <div className="flex flex-col gap-6 items-center">
      {/* ==================== FRONT ==================== */}
      <div className="idcard" data-status={effectiveStatus}>
        {/* HEADER / GREEN BRAND BANNER — normal flow, fixed height */}
        <div className="bg-gradient-to-br from-[#009944] to-[#007a36] px-5 py-4">
          <div className="flex items-center justify-between">
            <Logo size={32} variant="light" />
            <div className="text-right">
              <p className="text-white text-[10px] font-medium tracking-[0.2em] uppercase">
                Staff ID Card
              </p>
              <p className="text-emerald-100 text-[10px]">Identity &amp; Access</p>
            </div>
          </div>
        </div>

        {/* ORANGE DIVIDER — normal block, clear whitespace */}
        <div className="h-[3px] bg-gradient-to-r from-[#ff9d00] via-[#FF8C00] to-[#ffb84d]" />

        {/* PROFILE BLOCK — separate container below header */}
        <div className="px-5 pt-4 pb-3">
          <div className="flex items-start gap-4">
            <div className="w-[72px] h-[88px] rounded-lg border border-slate-200 shadow-sm overflow-hidden bg-white flex-shrink-0 flex items-center justify-center">
              {photoUrl ? (
                <img
                  src={photoUrl}
                  alt="Passport"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-slate-100 to-emerald-50 flex items-center justify-center">
                  <span className="text-2xl font-bold text-[#009944]">
                    {initials}
                  </span>
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">
                Full Name
              </p>
              <p className="text-[15px] font-bold text-slate-900 leading-snug break-words mt-0.5">
                {name}
              </p>
              <p className="text-[11px] text-slate-500 mt-1 break-words">
                {position}
              </p>
            </div>
          </div>
        </div>

        {/* META INFORMATION GRID — 2-column, proper flow */}
        <div className="px-5 pb-3">
          <div
            className="grid gap-y-2.5 gap-x-4"
            style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
          >
            <div>
              <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">
                Staff ID
              </p>
              <p className="text-xs font-bold text-[#009944] mt-0.5 break-all">
                {number}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">
                Department
              </p>
              <p className="text-xs font-medium text-slate-800 mt-0.5 break-words">
                {department}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">
                Branch
              </p>
              <p className="text-xs font-medium text-slate-800 mt-0.5 break-words">
                {branch}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">
                Status
              </p>
              <p
                className={`text-xs font-bold uppercase mt-0.5 ${
                  isExpired ? 'text-rose-600' : 'text-emerald-600'
                }`}
              >
                {isExpired ? 'EXPIRED' : effectiveStatus}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">
                Issue Date
              </p>
              <p className="text-xs font-medium text-slate-800 mt-0.5">
                {issue}
              </p>
            </div>
            {expiryLabel && (
              <div>
                <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wide">
                  Expiry Date
                </p>
                <p className="text-xs font-medium text-slate-800 mt-0.5">
                  {expiryLabel}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ORANGE DIVIDER — normal block element */}
        <div className="mx-5 my-3 h-[2px] bg-gradient-to-r from-[#ff9d00] via-[#FF8C00] to-[#ffb84d]" />

        {/* HUMAN RESOURCES SECTION */}
        <div className="px-5 pb-2">
          <p className="text-[11px] font-semibold text-slate-800 uppercase tracking-wide">
            Human Resources
          </p>
          <p className="text-[10px] text-slate-500 mt-1">
            Infinity Microfinance Bank
          </p>
        </div>

        {/* FOOTER DISCLAIMER */}
        <div className="px-5 py-3 border-t border-slate-100">
          <p
            className="text-[9px] text-[#4B5563] leading-[1.4]"
            style={{ overflowWrap: 'anywhere' }}
          >
            This card remains the property of Infinity Microfinance Bank . If
            found, please return to the nearest branch or HR office.
          </p>
          <p
            className="text-[9px] text-[#374151] mt-1 leading-[1.4]"
            style={{ overflowWrap: 'anywhere' }}
          >
            This card is issued by Human Resources of Infinity Microfinance Bank
            and is valid for identification purposes only.
            {expiryLabel && ` Expires ${expiryLabel}.`}
          </p>
        </div>
      </div>

      {/* ==================== BACK ==================== */}
      <div className="idcard bg-white">
        <div className="h-[3px] bg-gradient-to-r from-[#ff9d00] via-[#FF8C00] to-[#ffb84d]" />
        <div className="px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">
              Human Resources
            </p>
            <span className="text-sm font-bold text-slate-900">{number}</span>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Employee</span>
              <span className="font-medium text-slate-800 text-right break-words ml-4">
                {name}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Emergency Contact</span>
              <span className="font-medium text-slate-800 text-right">
                {employee?.emergency_contact_phone || '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Branch</span>
              <span className="font-medium text-slate-800 text-right">
                {branch}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Issued By</span>
              <span className="font-medium text-slate-800 text-right">
                {issuedBy || 'Human Resources'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Issue Date</span>
              <span className="font-medium text-slate-800">{issue}</span>
            </div>
            {expiryLabel && (
              <div className="flex justify-between">
                <span className="text-slate-400">Expiry</span>
                <span className="font-medium text-slate-800">
                  {expiryLabel}
                </span>
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-2 gap-4">
            <SignatureArea label="Management Signature" src={managementSignature} caption="Management / HR" />
            <SignatureArea label="Card Holder Signature" src={cardHolderSignature} caption="Employee Signature" />
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100">
            <p
              className="text-[10px] text-[#4B5563] leading-relaxed"
              style={{ overflowWrap: 'anywhere' }}
            >
              This card remains the property of Infinity Microfinance Bank . If
              found, please return to the nearest branch or HR office.
            </p>
            <p
              className="text-[10px] text-[#374151] mt-2 leading-relaxed"
              style={{ overflowWrap: 'anywhere' }}
            >
              This card is issued by Human Resources of Infinity Microfinance
              Bank and is valid for identification purposes only.
              {expiryLabel ? ` Expires ${expiryLabel}.` : ' This card has no expiry.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function SignatureArea({ label, src, caption }) {
  return (
    <div className="min-w-0">
      <p className="text-[8px] text-slate-400 uppercase tracking-wide mb-1">{label}</p>
      <div className="h-8 flex items-end justify-center">
        {src && <img src={src} alt={label} className="max-h-8 max-w-full object-contain" />}
      </div>
      <div className="h-px bg-slate-400 mt-1" />
      <p className="text-[8px] text-slate-500 mt-1 text-center">{caption}</p>
    </div>
  )
}
