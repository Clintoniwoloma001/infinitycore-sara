import React from 'react'
import {
  AlertTriangle, Camera, Check, CheckCircle2, Clock, Copy, FileText,
  IdCard, Loader2, PenTool, Send, Shield, User, X,
} from 'lucide-react'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

// Mirrors DOC_TYPES in FidelityBondVerificationForm.jsx — the source of truth.
const DOC_TYPES = [
  { key: 'passport', label: 'Passport Photograph', required: true },
  { key: 'id_card', label: 'Valid Means of Identification', required: true },
  { key: 'nin', label: 'NIN Slip', required: false },
  { key: 'work_id', label: 'Work ID', required: false },
  { key: 'utility_bill', label: 'Utility Bill', required: false },
]

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

export default function FidelityBondTab({
  payload,
  verification,
  documents,
  canManage,
  busy,
  onSendLink,
  onApproveVerification,
  onGetSignedUrl,
  generatedLink,
  copied,
  onCopyLink,
}) {
  const suretyName = payload?.fidelity_surety_name || ''
  const suretyEmail = payload?.fidelity_email || ''
  const suretyRelationship = payload?.fidelity_relationship || ''

  return (
    <div className="space-y-5">
      {/* Fidelity bond info from onboarding form */}
      <SubSection title="Fidelity Bond (from onboarding form)" icon={Shield}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          <InfoRow label="Surety Name" value={suretyName || 'Not provided'} />
          <InfoRow label="Email" value={suretyEmail || 'Not provided'} />
          <InfoRow label="Relationship" value={suretyRelationship || '—'} />
          <InfoRow label="Occupation" value={payload?.fidelity_occupation || '—'} />
          <InfoRow label="Phone" value={payload?.fidelity_phone || '—'} />
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
            <p className="text-sm text-slate-400">No fidelity bond verification has been initiated yet.</p>
            {canManage && suretyName && suretyEmail && (
              <button
                onClick={onSendLink}
                disabled={busy}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60"
              >
                <Send className="w-4 h-4" /> Send Fidelity Link
              </button>
            )}
            {canManage && suretyName && !suretyEmail && (
              <p className="mt-3 text-xs text-amber-600">Add a surety email in the onboarding form before sending a verification link.</p>
            )}
          </div>
        )}
      </SubSection>

      {/* Verification details (identity) */}
      {verification && (
        <>
          <SubSection title="Surety Identity (verified)" icon={User}>
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
          <SubSection title="Surety Documents" icon={FileText}>
            {documents.length === 0 ? (
              <p className="text-sm text-slate-400">No documents uploaded by surety.</p>
            ) : (
              <div className="space-y-3">
                {DOC_TYPES.map((dt) => {
                  const shotDocs = documents.filter((doc) => doc.document_type === dt.key)
                  if (shotDocs.length === 0) return null
                  return (
                    <div key={dt.key} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-slate-700">{dt.label}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${dt.required ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                          {dt.required ? 'Required' : 'Optional'}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {shotDocs.map((doc) => (
                          <div key={doc.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                            <div className="flex items-center gap-3">
                              <FileText className="w-4 h-4 text-slate-400" />
                              <p className="text-sm text-slate-700">{doc.file_name}</p>
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
                    </div>
                  )
                })}

                {documents.some((doc) => !DOC_TYPES.some((dt) => dt.key === doc.document_type)) && (
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-sm font-medium text-slate-700 mb-2">Other documents</p>
                    <div className="space-y-2">
                      {documents.filter((doc) => !DOC_TYPES.some((dt) => dt.key === doc.document_type)).map((doc) => (
                        <div key={doc.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                          <div className="flex items-center gap-3">
                            <FileText className="w-4 h-4 text-slate-400" />
                            <div>
                              <p className="text-sm capitalize text-slate-700">{doc.document_type?.replace(/_/g, ' ') || 'Document'}</p>
                              <p className="text-xs text-slate-400">{doc.file_name}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs px-2 py-0.5 rounded-full border bg-slate-50 text-slate-600 border-slate-200">
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
                  </div>
                )}
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
            <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-200">
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
          <p className="text-sm font-medium text-emerald-900 mb-2">Fidelity bond verification link generated:</p>
          <div className="flex items-center gap-2">
            <input readOnly value={generatedLink.url} className={inputCls} />
            <button
              onClick={() => onCopyLink(generatedLink.url)}
              className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] whitespace-nowrap"
            >
              <Copy className="w-4 h-4" /> {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-emerald-700 mt-2">Send this link to the surety. They will complete the verification form securely.</p>
        </div>
      )}
    </div>
  )
}