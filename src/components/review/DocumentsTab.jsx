import React from 'react'
import { CheckCircle2, FileText, Loader2, XCircle } from 'lucide-react'

export default function DocumentsTab({ documents, signatureData, declarationAccepted, onGetSignedUrl, loading }) {
  if (loading) return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>

  return (
    <div className="space-y-5">
      {/* Uploaded documents */}
      <div>
        <h4 className="text-sm font-semibold text-slate-700 mb-3">Submitted Documents</h4>
        {(!documents || documents.length === 0) ? (
          <div className="text-center py-8 rounded-lg border border-slate-200 bg-slate-50">
            <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No documents were uploaded with this onboarding submission.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc, idx) => (
              <div key={idx} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-5 h-5 text-slate-400 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{doc.file_name || doc.label || `Document ${idx + 1}`}</p>
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
