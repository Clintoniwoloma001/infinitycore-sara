import React, { forwardRef, useMemo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import Logo from '../Logo'
import { formatDate } from '../../lib/utils'

function verificationUrl(certificate) {
  if (certificate?.verification_url) return certificate.verification_url
  if (typeof window === 'undefined') return certificate?.certificate_number || ''
  const base = import.meta.env.BASE_URL || '/'
  return `${window.location.origin}${base}#/certificate/verify/${encodeURIComponent(certificate?.certificate_number || '')}`
}

const TrainingCertificate = forwardRef(function TrainingCertificate({ certificate, employeeName }, ref) {
  const qrValue = useMemo(() => verificationUrl(certificate), [certificate])
  if (!certificate) return null

  const duration = Number(certificate.duration_minutes || 0)
  const type = certificate.training_type === 'kss' ? 'Knowledge Sharing Session' : 'Professional Development Training'

  return (
    <div ref={ref} className="training-certificate bg-white text-slate-900 relative overflow-hidden" style={{ width: '1120px', minHeight: '790px', fontFamily: 'Arial, sans-serif' }}>
      <div className="absolute inset-0 border-[18px] border-[#007a4a] pointer-events-none" />
      <div className="absolute top-0 left-0 right-0 h-3 bg-[#f58220]" />
      <div className="absolute bottom-0 left-0 right-0 h-3 bg-[#f58220]" />
      <div className="px-24 py-16 h-full flex flex-col items-center text-center">
        <Logo size={64} showText showTagline />
        <div className="mt-8 text-[13px] tracking-[0.28em] uppercase text-[#007a4a] font-semibold">Certificate of Completion</div>
        <div className="mt-4 text-[16px] text-slate-500">This certificate is proudly presented to</div>
        <div className="mt-3 text-[42px] font-bold tracking-tight text-slate-900">{employeeName || certificate.employee_name || 'Infinity Bank colleague'}</div>
        <div className="mt-5 h-px w-72 bg-[#f58220]" />
        <div className="mt-6 text-[17px] text-slate-500">for successfully completing</div>
        <div className="mt-3 text-[29px] font-semibold text-[#007a4a] max-w-[780px]">{certificate.training_title || certificate.title}</div>
        <div className="mt-2 text-[15px] text-slate-500">{type}</div>

        <div className="mt-9 grid grid-cols-5 gap-8 text-left w-full max-w-[960px]">
          <Meta label="Date" value={formatDate(certificate.training_date)} />
          <Meta label="Duration" value={`${hoursLabel(duration)} hours`} />
          <Meta label="Facilitator" value={certificate.facilitator || 'Infinity Bank'} />
          <Meta label="Employee ID" value={certificate.employee_identifier} />
          <Meta label="Certificate No." value={certificate.certificate_number} />
        </div>

        <div className="mt-auto w-full flex items-end justify-between gap-10">
          <div className="text-left text-[11px] text-slate-400">
            <div className="font-semibold text-slate-600">Certificate ID</div>
            <div className="font-mono mt-1">{certificate.id || certificate.certificate_id || '—'}</div>
            <div className="mt-2">Verify authenticity using the QR code.</div>
          </div>
          <div className="flex flex-col items-center gap-2">
            <QRCodeSVG value={qrValue} size={86} level="M" includeMargin bgColor="#ffffff" fgColor="#007a4a" />
            <span className="text-[10px] text-slate-400">Scan to verify</span>
          </div>
          <div className="text-right min-w-[190px]">
            <div className="h-10 border-b border-slate-400 mb-2" />
            <div className="text-[12px] font-semibold text-slate-700">Authorized Learning &amp; Development</div>
            <div className="text-[11px] text-slate-400">Infinity Bank</div>
          </div>
        </div>
      </div>
    </div>
  )
})

function Meta({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400 font-semibold">{label}</div>
      <div className="mt-1 text-[14px] font-semibold text-slate-700 break-words">{value || '—'}</div>
    </div>
  )
}

function hoursLabel(minutes) {
  return Number((Number(minutes || 0) / 60).toFixed(2)).toString()
}

export default TrainingCertificate
