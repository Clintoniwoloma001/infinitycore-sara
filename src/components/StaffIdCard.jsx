import React from 'react'
import Logo from './Logo'

// InfinityCore Staff ID Card — front & back.
// Printed alone (parent wraps it in .print-area) for card printing.
// No BVN / NIN / salary data on the card.
export default function StaffIdCard({ employee = {}, photoUrl = null }) {
  const name = employee?.full_name || '—'
  const number = employee?.staff_id || employee?.employee_number || employee?.employee_code || '—'
  const position = employee?.position || 'Staff'
  const department = employee?.department || '—'
  const branch = employee?.branch || 'Head Office'

  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join('') || 'IB'

  const issueDate = employee?.staff_id_issued_at ? new Date(employee.staff_id_issued_at).toLocaleDateString() : new Date().toLocaleDateString()
  const expiryDate = new Date()
  expiryDate.setFullYear(expiryDate.getFullYear() + 3)

  return (
    <div className="flex flex-col gap-6 items-start">
      {/* FRONT */}
      <div className="w-[340px] rounded-2xl overflow-hidden shadow-xl border border-slate-200 bg-white">
        <div className="h-[120px] bg-gradient-to-br from-[#009944] to-[#007a36] relative px-5 pt-4 pb-2">
          <div className="absolute -bottom-1 right-0 left-0 h-2 bg-gradient-to-r from-[#ff9d00] via-[#FF8C00] to-[#ffb84d]" />
          <div className="flex items-start justify-between">
            <Logo size={34} variant="light" />
            <div className="text-right">
              <p className="text-white text-[10px] font-medium tracking-[0.2em] uppercase">Staff ID Card</p>
              <p className="text-emerald-100 text-[10px]">Identity & Access</p>
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
            <div className="min-w-0">
              <p className="text-xs text-slate-400 mb-0.5">Full Name</p>
              <p className="text-lg font-semibold text-slate-900 leading-tight break-words">{name}</p>
              <p className="text-xs text-slate-500 mt-1 break-words">{position}</p>
            </div>
          </div>

          <div className="mt-5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">Staff ID</span>
              <span className="text-sm font-bold text-slate-900 tracking-wide">{number}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">Department</span>
              <span className="text-sm font-medium text-slate-800">{department}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">Branch</span>
              <span className="text-sm font-medium text-slate-800">{branch}</span>
            </div>
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
            <div>
              <p className="text-[10px] text-slate-400 uppercase">Issue Date</p>
              <p className="text-xs font-medium text-slate-700">{issueDate}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-slate-400 uppercase">Expiry Date</p>
              <p className="text-xs font-medium text-slate-700">{expiryDate.toLocaleDateString()}</p>
            </div>
          </div>
        </div>
      </div>

      {/* BACK */}
      <div className="w-[340px] rounded-2xl overflow-hidden shadow-xl border border-slate-200 bg-white min-h-[200px]">
        <div className="h-2 bg-gradient-to-r from-[#ff9d00] via-[#FF8C00] to-[#ffb84d]" />
        <div className="px-6 py-5">
          <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide mb-4">Human Resources</p>
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">HR Office</span>
              <span className="font-medium text-slate-800 text-right">hr@infinitycorebank.com</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">HR Line</span>
              <span className="font-medium text-slate-800">+234 800 INF CORE</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Emergency</span>
              <span className="font-medium text-slate-800">+234 700 EMERGENCY</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Branch</span>
              <span className="font-medium text-slate-800 text-right">{branch}</span>
            </div>
          </div>
          <div className="mt-5 pt-4 border-t border-slate-100">
            <p className="text-[11px] text-slate-400 leading-relaxed">
              This card remains the property of InfinityCore Bank Ltd. If found, please return to the nearest branch or HR office.
            </p>
            <p className="text-[10px] text-slate-300 mt-2">Generated by InfinityCore HR · Valid for identification purposes only</p>
          </div>
        </div>
      </div>
    </div>
  )
}