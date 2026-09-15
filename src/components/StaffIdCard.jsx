import React from 'react'
import Logo from './Logo'

// InfinityCore Staff ID Card — front & back.
// Employee-facing ID is ALWAYS the official IMFB/<numeric> number
// (employee_number). Rendered straight into a body-level print portal
// for card printing (see .print-idcard page rules).
// No BVN / NIN / salary / bank account data appears on the card.
//
// Expiry configuration:
//   expiryMode: 'none' | 'date'
//   expiryDate: ISO string used when expiryMode === 'date'
//   issueDate / issuedBy / status: HR-provided card metadata.
export default function StaffIdCard({
  employee = {},
  photoUrl = null,
  expiryMode = 'date',
  expiryDate = null,
  issueDate = null,
  issuedBy = 'Human Resources',
  status = 'active',
}) {
  const name = employee?.full_name || '—'
  // Official staff ID — always IMFB/<n> when available.
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

  const issue = issueDate ? new Date(issueDate).toLocaleDateString('en-GB') : (employee?.staff_id_issued_at ? new Date(employee.staff_id_issued_at).toLocaleDateString('en-GB') : new Date().toLocaleDateString('en-GB'))
  const effectiveStatus = status || (expiryMode === 'date' && expiryDate && new Date(expiryDate) < new Date() ? 'expired' : 'active')
  const isExpired = effectiveStatus === 'expired'

  let expiryLabel = 'NO EXPIRY'
  if (expiryMode === 'date' && expiryDate) {
    expiryLabel = new Date(expiryDate).toLocaleDateString('en-GB')
  }

  const fmtDate = (v) => {
    if (!v) return '—'
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return String(v)
    return d.toLocaleDateString('en-GB')
  }

  return (
    <div className="flex flex-col gap-6 items-center">
      {/* FRONT */}
      <div className="idcard" data-status={effectiveStatus}>
        <div className="h-[120px] bg-gradient-to-br from-[#009944] to-[#007a36] relative px-5 pt-4 pb-2">
          <div className="absolute -bottom-1 right-0 left-0 h-2 bg-gradient-to-r from-[#ff9d00] via-[#FF8C00] to-[#ffb84d]" />
          <div className="flex items-start justify-between">
            <Logo size={34} variant="light" />
            <div className="text-right">
              <p className="text-white text-[10px] font-medium tracking-[0.2em] uppercase">Staff ID Card</p>
              <p className="text-emerald-100 text-[10px]">Identity &amp; Access</p>
            </div>
          </div>
        </div>

        <div className="px-6 pt-5 pb-5 -mt-12 relative z-10">
          <div className="flex items-center gap-4">
            <div className="w-[88px] h-[104px] rounded-lg border border-slate-200 shadow-md overflow-hidden bg-white flex items-center justify-center">
              {photoUrl ? (
                <img src={photoUrl} alt="Passport" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-slate-100 to-emerald-50 flex items-center justify-center">
                  <span className="text-3xl font-bold text-[#009944]">{initials}</span>
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-400 mb-0.5">Full Name</p>
              <p className="text-base font-semibold text-slate-900 leading-tight break-words">{name}</p>
              <p className="text-xs text-slate-500 mt-1 break-words">{position}</p>
            </div>
          </div>

          <div className="mt-5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">Staff ID</span>
              <span className="text-sm font-bold text-[#009944] tracking-wide">{number}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">Department</span>
              <span className="text-sm font-medium text-slate-800 text-right">{department}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">Branch</span>
              <span className="text-sm font-medium text-slate-800 text-right">{branch}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">Status</span>
              <span className={`text-xs font-bold uppercase ${isExpired ? 'text-rose-600' : 'text-emerald-600'}`}>
                {isExpired ? 'EXPIRED' : effectiveStatus}
              </span>
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
            <div>
              <p className="text-[10px] text-slate-400 uppercase">Issue Date</p>
              <p className="text-xs font-medium text-slate-700">{issue}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-slate-400 uppercase">Expiry Date</p>
              <p className="text-xs font-medium text-slate-700">{expiryLabel}</p>
            </div>
          </div>
        </div>
      </div>

      {/* BACK */}
      <div className="idcard bg-white min-h-[200px]">
        <div className="h-2 bg-gradient-to-r from-[#ff9d00] via-[#FF8C00] to-[#ffb84d]" />
        <div className="px-6 py-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">Human Resources</p>
            <span className="text-sm font-bold text-slate-900">{number}</span>
          </div>
          <div className="space-y-2.5 text-sm mt-3">
            <div className="flex justify-between">
              <span className="text-slate-400">Employee</span>
              <span className="font-medium text-slate-800 text-right break-words">{name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Emergency Contact</span>
              <span className="font-medium text-slate-800 text-right">{employee?.emergency_contact_phone || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Branch</span>
              <span className="font-medium text-slate-800 text-right">{branch}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Issued By</span>
              <span className="font-medium text-slate-800 text-right">{issuedBy || 'Human Resources'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Issue Date</span>
              <span className="font-medium text-slate-800">{issue}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Expiry</span>
              <span className="font-medium text-slate-800">{expiryLabel}</span>
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100">
            <p className="text-[11px] text-slate-400 leading-relaxed">
              This card remains the property of Infinity Microfinance Bank. If found, please return to the nearest branch or HR office.
            </p>
            <p className="text-[10px] text-slate-300 mt-2">This card is issued by Human Resources of Infinity Microfinance Bank and is valid for identification purposes only. {expiryMode === 'date' && expiryDate ? `Expires ${expiryLabel}.` : 'This card has no expiry.'}</p>
          </div>
        </div>
      </div>
    </div>
  )
}