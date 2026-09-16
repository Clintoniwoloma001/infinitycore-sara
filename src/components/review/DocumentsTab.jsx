import React from 'react'
import { CheckCircle2, FileText, Loader2, XCircle } from 'lucide-react'

// Mirrors UPLOAD_SLOTS in OnboardingForm.jsx — the source of truth.
const DOC_SLOTS = [
  { key: 'passport', label: 'Passport Photograph', required: true },
  { key: 'utility_bill', label: 'Utility Bill', required: false },
  { key: 'nin', label: 'National ID (NIN)', required: false },
  { key: 'degree_certificate', label: 'Degree Certificate', required: false },
  { key: 'birth_certificate', label: 'Birth Certificate', required: false },
  { key: 'other_certification', label: 'Other Certifications', required: false },
]

export default function DocumentsTab({ documents, signatureData, declarationAccepted, onGetSignedUrl, loading }) {
  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>

  const docs = documents || []
  const slotDocs = (key) => docs.filter((d) => d.category === key)
  const slotCount = (key) => slotDocs(key).length
  const unclassified = docs.filter((d) => !DOC_SLOTS.some((s) => s.key === d.category))

  return (
    <div className="space-y-5">
      {/* Uploaded documents */}
      <div>
        <h4 className="text-sm font-semibold text-slate-700 mb-3">Submitted Documents</h4>
        {docs.length === 0 ? (
          <div className="text-center py-8 rounded-lg border border-slate-200 bg-slate-50">
            <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No documents were uploaded with this onboarding submission.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {DOC_SLOTS.map((slot) => {
              const shotDocs = slotDocs(slot.key)
              if (shotDocs.length === 0) return null
              return (
                <div key={slot.key} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-slate-700">{slot.label}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${slot.required ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                      {slot.required ? 'Required' : 'Optional'}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {shotDocs.map((doc, idx) => (
                      <div key={idx} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                        <div className="flex items-center gap-3 min-w-0">
                          <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm text-slate-700 truncate">{doc.file_name || doc.label || `${slot.label} ${idx + 1}`}</p>
                            <p className="text-xs text-slate-400">
                              {slotCount(slot.key) > 1 ? `${idx + 1}/${slotCount(slot.key)}` : slot.label}
                              {doc.size ? ` · ${(doc.size / 1024).toFixed(0)} KB` : ''}
                              {doc.mime ? ` · ${doc.mime}` : ''}
                            </p>
                          </div>
                        </div>
                        {doc.file_path && (
                          <button
                            onClick={() => onGetSignedUrl(doc.file_path)}
                            className="text-xs px-3 py-1.5 rounded-md bg-[#009944] text-white hover:bg-[#007a36] whitespace-nowrap flex-shrink-0"
                          >
                            View
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}

            {unclassified.length > 0 && (
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-sm font-medium text-slate-700 mb-2">Other documents</p>
                <div className="space-y-2">
                  {unclassified.map((doc, idx) => (
                    <div key={idx} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm text-slate-700 truncate">{doc.file_name || doc.label || `Document ${idx + 1}`}</p>
                          <p className="text-xs text-slate-400">
                            {doc.category || 'onboarding'}
                            {doc.size ? ` · ${(doc.size / 1024).toFixed(0)} KB` : ''}
                            {doc.mime ? ` · ${doc.mime}` : ''}
                          </p>
                        </div>
                      </div>
                      {doc.file_path && (
                        <button
                          onClick={() => onGetSignedUrl(doc.file_path)}
                          className="text-xs px-3 py-1.5 rounded-md bg-[#009944] text-white hover:bg-[#007a36] whitespace-nowrap flex-shrink-0"
                        >
                          View
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Declaration */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <h4 className="text-sm font-semibold text-slate-700 mb-3">Declaration & Consent</h4>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {declarationAccepted ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            ) : (
              <XCircle className="w-5 h-5 text-rose-400" />
            )}
            <span className="text-sm text-slate-700">
              {declarationAccepted ? 'Declaration accepted by candidate' : 'Declaration NOT accepted'}
            </span>
          </div>
          {signatureData && (
            <div>
              <p className="text-xs text-slate-400 mb-1">Candidate signature:</p>
              <img src={signatureData} alt="Signature" className="max-w-xs rounded-lg border border-slate-300 bg-white" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}