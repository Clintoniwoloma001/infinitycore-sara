import React, { useRef, useState } from 'react'
import { Camera, CheckCircle2, ImageIcon, Loader2, Trash2, Upload, X } from 'lucide-react'
import { documentService } from '../services/documentService'

// ProfilePhotoModal — two SEPARATE images:
//   1. Profile Picture  — the platform avatar (user-managed, editable).
//   2. ID Card Photo    — the onboarding passport (immutable once set).
// Changing the profile picture NEVER touches the ID card photo, and vice
// versa. If no onboarding passport exists, the user may attach one here;
// it is stored as document_type 'passport' so the card picks it up.

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

function PhotoSlot({ title, hint, src, initials, onFile, onRemove, canRemove }) {
  const fileInput = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const handle = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { setErr('Image exceeds the 8MB limit.'); return }
    if (!file.type.startsWith('image/')) { setErr('Please select an image file.'); return }
    setBusy(true)
    setErr('')
    try {
      await onFile(file)
    } catch (ex) {
      setErr(ex?.message || 'Upload failed. Please try again.')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
      <div className="mt-3 flex items-center gap-3">
        <div className="w-20 h-24 shrink-0 rounded-lg border border-slate-200 bg-white overflow-hidden flex items-center justify-center">
          {src ? (
            <img src={src} alt={title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-slate-100 to-emerald-50 flex items-center justify-center">
              <span className="text-lg font-bold text-[#009944]">{initials || <ImageIcon className="w-5 h-5 text-slate-300" />}</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60"
            style={{ minHeight: 40 }}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {busy ? 'Uploading...' : src ? 'Replace' : 'Upload'}
          </button>
          {src && canRemove && (
            <button
              type="button"
              onClick={() => onRemove?.()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 text-rose-600 text-sm font-medium hover:bg-rose-50"
              style={{ minHeight: 40 }}
            >
              <Trash2 className="w-4 h-4" /> {title === 'Profile Picture' ? 'Remove' : 'Remove photo'}
            </button>
          )}
        </div>
      </div>
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={handle} />
      {err && <p className="text-xs text-rose-600 mt-2">{err}</p>}
    </div>
  )
}

export default function ProfilePhotoModal({ employee, photoUrl, onClose, onSaved }) {
  const [err, setErr] = useState('')
  const [profileSrc, setProfileSrc] = useState(null)
  const [passportDoc, setPassportDoc] = useState(null)
  const employeeId = employee?.id

  // Do not attempt any upload without a resolvable employee record. This is the
  // top of the "c.id" failure chain: a missing employee must never reach storage.
  const missingEmployee = !employeeId
  const blockedMsg = missingEmployee
    ? 'Employee record could not be resolved. Photos are disabled — refresh the page and try again.'
    : ''

  React.useEffect(() => {
    let active = true
    const load = async () => {
      if (!employeeId) return
      try {
        const docList = await documentService.list('employee', employeeId).catch(() => [])
        if (!active) return
        const pp = docList.find((d) => /passport/i.test(d.document_type))
        if (pp?.file_path) {
          const url = await documentService.getSignedUrl(pp.file_path).catch(() => null)
          if (active && url) setPassportDoc({ ...pp, url })
        }
        const pic = docList.find((d) => d.document_type === 'profile_picture')
        if (pic?.file_path) {
          const url = await documentService.getSignedUrl(pic.file_path).catch(() => null)
          if (active && url) setProfileSrc(url)
        }
      } catch {
        // ignore
      }
    }
    load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId])

  const initials = (employee?.full_name || 'U')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join('') || 'U'

  // ----- profile picture (platform) -----
  const uploadProfile = async (file) => {
    if (!employeeId) throw new Error(blockedMsg)
    const res = await documentService.uploadProfilePicture(file, employeeId)
    if (!res?.file_path) throw new Error('Upload succeeded but the file record is missing. Please retry.')
    const url = await documentService.getSignedUrl(res.file_path)
    if (!url) throw new Error('Could not generate the photo link. Please retry.')
    setProfileSrc(url)
    await onSaved?.()
  }

  const removeProfile = async () => {
    if (!employeeId) throw new Error(blockedMsg)
    const docList = await documentService.list('employee', employeeId)
    const pic = docList.find((d) => d.document_type === 'profile_picture')
    if (pic) await documentService.delete(pic.id)
    setProfileSrc(null)
    await onSaved?.()
  }

  // ----- ID card photo (onboarding passport / attach when missing) -----
  const attachPassport = async (file) => {
    if (!employeeId) throw new Error(blockedMsg)
    const res = await documentService.upload(file, 'employee', employeeId, 'passport')
    if (!res?.file_path) throw new Error('Upload succeeded but the file record is missing. Please retry.')
    const url = await documentService.getSignedUrl(res.file_path)
    if (!url) throw new Error('Could not generate the photo link. Please retry.')
    setPassportDoc({ ...res, url })
    await onSaved?.()
  }

  const removePassport = async () => {
    if (passportDoc?.id) await documentService.delete(passportDoc.id)
    setPassportDoc(null)
    await onSaved?.()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-900">Photos</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        {(err || missingEmployee) && (
          <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">
            {missingEmployee ? blockedMsg : err}
          </div>
        )}

        <div className="space-y-4">
          <PhotoSlot
            title="Profile Picture"
            hint="Your platform avatar. Completely separate from the ID card."
            src={profileSrc}
            initials={initials}
            onFile={uploadProfile}
            onRemove={removeProfile}
            canRemove={!!profileSrc}
          />

          <PhotoSlot
            title="ID Card Photo"
            hint={
              passportDoc
                ? 'Set during onboarding (passport). Changing your profile picture will not change this.'
                : 'No ID card photo on file yet. Attach an image here — it becomes the official card photo.'
            }
            src={passportDoc?.url || photoUrl}
            initials={initials}
            onFile={attachPassport}
            onRemove={removePassport}
            canRemove={!!passportDoc}
          />

          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-start gap-2">
            <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-[#009944]" />
            <span>Your Staff ID card always uses the onboarding passport photo. Profile picture changes never affect the card.</span>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-700">
            <Camera className="w-4 h-4" /> Done
          </button>
        </div>
      </div>
    </div>
  )
}