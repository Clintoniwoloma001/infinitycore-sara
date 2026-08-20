import React, { useState } from 'react'
import { Upload, AlertCircle, CheckCircle2, FileText, Loader } from 'lucide-react'
import { documentService } from '../services/documentService'

/**
 * DocumentUpload Component - Handles file uploads with validation
 * Used in various workflows: customer KYC, loan applications, HR CVs, etc.
 */
export default function DocumentUpload({ entityType, entityId, documentType, onSuccess, onError, accept = '.pdf,.doc,.docx,.jpg,.jpeg,.png' }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const handleUpload = async (file) => {
    setError(null)
    setUploading(true)

    try {
      // Validate file type
      const validTypes = accept.split(',')
      const fileExt = '.' + file.name.split('.').pop().toLowerCase()
      if (!validTypes.includes(fileExt)) {
        throw new Error(`Invalid file type. Accepted: ${accept}`)
      }

      const doc = await documentService.upload(file, entityType, entityId, documentType)
      setUploading(false)

      if (onSuccess) onSuccess(doc)
    } catch (err) {
      const errorMsg = err.message || 'Upload failed'
      setError(errorMsg)
      setUploading(false)
      if (onError) onError(err)
    }
  }

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleUpload(e.dataTransfer.files[0])
    }
  }

  const handleChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleUpload(e.target.files[0])
    }
  }

  return (
    <div
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      className={`relative border-2 border-dashed rounded-lg p-6 text-center transition ${
        dragActive
          ? 'border-blue-500 bg-blue-50'
          : error
            ? 'border-red-300 bg-red-50'
            : 'border-slate-300 bg-slate-50'
      }`}
    >
      <input
        type="file"
        onChange={handleChange}
        accept={accept}
        disabled={uploading}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />

      {uploading ? (
        <div className="flex flex-col items-center">
          <Loader className="w-8 h-8 text-blue-600 animate-spin mb-2" />
          <p className="text-sm text-slate-600 font-medium">Uploading...</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center">
          <AlertCircle className="w-8 h-8 text-red-600 mb-2" />
          <p className="text-sm text-red-600 font-medium mb-1">Upload failed</p>
          <p className="text-xs text-red-500">{error}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <Upload className="w-8 h-8 text-slate-400 mb-2" />
          <p className="text-sm font-medium text-slate-700">Drag and drop your file</p>
          <p className="text-xs text-slate-500 mt-1">or click to browse</p>
          <p className="text-xs text-slate-400 mt-2">Accepted: {accept}</p>
        </div>
      )}
    </div>
  )
}
