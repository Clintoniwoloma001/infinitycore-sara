import React from 'react'
import {
  AlertTriangle, Camera, Check, CheckCircle2, Clock, Copy, FileText,
  IdCard, Loader2, PenTool, Send, User, X,
} from 'lucide-react'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

function InfoRow({ label, value }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 py-1.5">
      <span className="text-xs text-slate-400 sm:w-40 flex-shrink-0">{label}</span>
      <span className="text-sm text-slate-800">{value || '—'}</span>
    </div>
  )
}

function SubSection({ title, icon: Icon, children }) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-3">
        {Icon && <Icon className="w-4 h-4 text-slate-400" />}
        <h4 className="text-sm font-semibold text-slate-700">{title}</h4>
      </div>
      {children}
    </div>
  )
}

export default function GuarantorTab({
  payload,
  verification,
  guarantorDocuments,
  canManage,
  busy,
  onSendLink,
  onApproveVerification,
  onGetSignedUrl,
  generatedLink,
  copied,
  onCopyLink,
}) {
  const guarantorName = payload?.guarantor_full_name || ''
  const guarantorEmail = payload?.guarantor_email || ''
  const guarantorRelationship = payload?.guarantor_relationship || ''

  return (
    <div className="space-y-5">
      {/* Guarantor info from onboarding form */}
      <SubSection title="Guarantor Information (from onboarding form)" icon={IdCard}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          <InfoRow label="Name" value={guarantorName || 'Not provided'} />
          <InfoRow label="Email" value={guarantorEmail || 'Not provided'} />
          <InfoRow label="Relationship" value={guarantorRelationship || '—'} />
        </div>
      </SubSection>

      {/* Verification status */}
      <SubSection title="Verification Status" icon={CheckCircle2}>
        {verification ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <InfoRow label="Status" value={verification.status?.replace(/_/g, ' ')} />
            <InfoRow label="Submitted" value={verification.submitted_at ? new Date(verification.submitted_at).toLocaleString() : '—'} />
            <InfoRow label="Reviewed" value={verification.reviewed_at ? new Date(verification.reviewed_at).toLocaleString() : '—'} />
            <InfoRow label="HR Comments" value={verification.hr_comments || '—'} />
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-center">
            <p className="text-sm text-slate-400">No guarantor verification has been initiated yet.</p>
            {canManage && guarantorName && (
              <button
                onClick={onSendLink}
                disabled={busy}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60"
              >
                <Send className="w-4 h-4" /> Send Guarantor Link
              </button>
            )}
          </div>
        )}
      </SubSection>

      {/* Verification details (identity) */}
      {verification && (
        <>
          <SubSection title="Guarantor Identity (verified)" icon={User}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
              <InfoRow label="Phone" value={verification.phone} />
              <InfoRow label="Residential Address" value={verification.residential_address} />
              <InfoRow label="Occupation" value={verification.occupation} />
              <InfoRow label="Employer / Business" value={verification.employer} />
              <InfoRow label="BVN" value={verification.bvn} />
              <InfoRow label="NIN" value={verification.nin} />
            </div>
          </SubSection>

          {/* Documents */}
          <SubSection title="Guarantor Documents" icon={FileText}>
            {guarantorDocuments.length === 0 ? (
              <p className="text-sm text-slate-400">No documents uploaded by guarantor.</p>
            ) : (
              <div className="space-y-2">
                {guarantorDocuments.map((doc) => (
                  <div key={doc.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-3">
                      <FileText className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-sm font-medium text-slate-700 capitalize">{doc.document_type?.replace(/_/g, ' ')}</p>
                        <p className="text-xs text-slate-400">{doc.file_name}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${
                        doc.status === 'verified' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                        doc.status === 'rejected' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                        doc.status === 'correction_requested' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                        'bg-slate-50 text-slate-600 border-slate-200'
                      }`}>
                        {doc.status || 'pending'}
                      </span>
                      <button
                        onClick={() => onGetSignedUrl(doc.file_path)}
                        className="text-xs px-2.5 py-1 rounded-md bg-[#009944] text-white hover:bg-[#007a36]"
                      >
                        View
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SubSection>

          {/* Selfie */}
          <SubSection title="Selfie Capture" icon={Camera}>
            {verification.selfie_data ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="w-4 h-4" /> <span className="font-medium">Selfie captured</span>
                  {verification.selfie_captured_at && (
                    <span className="text-xs text-slate-400">
                      — {new Date(verification.selfie_captured_at).toLocaleString()}
                    </span>
                  )}
                </div>
                <img src={verification.selfie_data} alt="Selfie" className="w-32 h-32 rounded-lg border border-slate-300 object-cover" />
                <p className="text-xs text-slate-400">Photo capture only — not biometric liveness verification.</p>
              </div>
            ) : (
              <p className="text-sm text-slate-400">No selfie captured.</p>
            )}
          </SubSection>

          {/* Signature */}
          <SubSection title="Signature" icon={PenTool}>
            {verification.signature_data ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="w-4 h-4" /> <span className="font-medium">Signature captured</span>
                  {verification.signature_date && (
                    <span className="text-xs text-slate-400">— {verification.signature_date}</span>
                  )}
                </div>
                <img src={verification.signature_data} alt="Signature" className="max-w-xs rounded-lg border border-slate-300" />
              </div>
            ) : (
              <p className="text-sm text-slate-400">No signature submitted.</p>
            )}
          </SubSection>

          {/* HR Actions */}
          {canManage && verification.status === 'submitted' && (
            <div className="flex gap-2 pt-3 border-t border-slate-200">
              <button
                onClick={onApproveVerification}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Approve Verification
              </button>
            </div>
          )}
        </>
      )}

      {/* Generated link */}
      {generatedLink && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm font-medium text-emerald-900 mb-2">Guarantor verification link generated:</p>
          <div className="flex items-center gap-2">
            <input readOnly value={generatedLink.url} className={inputCls} />
            <button
              onClick={() => onCopyLink(generatedLink.url)}
              className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] whitespace-nowrap"
            >
              <Copy className="w-4 h-4" /> {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-emerald-700 mt-2">Send this link to the guarantor. They will complete the verification form securely.</p>
        </div>
      )}
    </div>
  )
}
