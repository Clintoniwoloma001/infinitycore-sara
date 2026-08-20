import React from 'react'
import { Trash2, Download, CheckCircle2, AlertCircle, Clock } from 'lucide-react'
import { documentService } from '../services/documentService'
import { formatDate } from '../lib/utils'

/**
 * DocumentList Component - Displays and manages documents for an entity
 * Shows upload status, verification status, and allows download/delete
 */
export default function DocumentList({ documents = [], entityType, entityId, canVerify = false, onVerify, onDelete }) {
  const [downloading, setDownloading] = React.useState(null)
  const [deleting, setDeleting] = React.useState(null)

  const handleDownload = async (doc) => {
    try {
      setDownloading(doc.id)
      const url = await documentService.getSignedUrl(doc.file_path)
      // In real scenario, trigger download
      window.open(url, '_blank')
    } catch (error) {
      console.error('Download failed:', error)
    } finally {
      setDownloading(null)
    }
  }

  const handleDelete = async (docId) => {
    if (!window.confirm('Delete this document?')) return

    try {
      setDeleting(docId)
      await documentService.delete(docId)
      if (onDelete) onDelete(docId)
    } catch (error) {
      console.error('Delete failed:', error)
    } finally {
      setDeleting(null)
    }
  }

  if (!documents.length) {
    return (
      <div className="text-center py-8 bg-slate-50 rounded-lg border border-slate-200">
        <p className="text-slate-500 text-sm">No documents uploaded yet</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {documents.map((doc) => {
        const statusConfig = {
          verified: { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50', label: 'Verified' },
          rejected: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-50', label: 'Rejected' },
          pending: { icon: Clock, color: 'text-yellow-600', bg: 'bg-yellow-50', label: 'Pending' },
        }
        const status = statusConfig[doc.verification_status] || statusConfig.pending
        const StatusIcon = status.icon

        return (
          <div key={doc.id} className={`flex items-center justify-between p-3 rounded-lg border ${status.bg} border-opacity-50`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <StatusIcon className={`w-4 h-4 flex-shrink-0 ${status.color}`} />
                <p className="font-medium text-sm text-slate-900 truncate">{doc.file_name}</p>
              </div>
              <p className="text-xs text-slate-500">
                {doc.document_type} • {formatDate(doc.uploaded_at)} • {(doc.file_size / 1024).toFixed(0)}KB
              </p>
              {doc.verification_notes && (
                <p className="text-xs text-slate-600 mt-1 italic">Note: {doc.verification_notes}</p>
              )}
            </div>

            <div className="flex items-center gap-2 ml-3 flex-shrink-0">
              <button
                onClick={() => handleDownload(doc)}
                disabled={downloading === doc.id}
                className="p-2 hover:bg-white/50 rounded transition disabled:opacity-50"
                title="Download"
              >
                <Download className="w-4 h-4 text-slate-600" />
              </button>
              {canVerify && doc.verification_status === 'pending' && (
                <>
                  <button
                    onClick={() => onVerify(doc.id, true)}
                    className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition"
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => onVerify(doc.id, false)}
                    className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition"
                  >
                    ✗
                  </button>
                </>
              )}
              <button
                onClick={() => handleDelete(doc.id)}
                disabled={deleting === doc.id}
                className="p-2 hover:bg-red-50 rounded transition disabled:opacity-50"
                title="Delete"
              >
                <Trash2 className="w-4 h-4 text-red-600" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
