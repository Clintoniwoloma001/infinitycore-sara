import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, FileText,
  Loader2, Send, Trash2, Upload, XCircle, Camera, PenTool, IdCard, Home, User,
} from 'lucide-react'
import Logo from '../components/Logo'
import SignaturePad from '../components/SignaturePad'
import CameraCapture from '../components/CameraCapture'
import { guarantorVerificationService } from '../services/guarantorVerificationService'
import { LoadingState } from '../components/PageStates'

const STEPS = [
  { id: 1, title: 'Identity', short: 'Identity', icon: User },
  { id: 2, title: 'Documents', short: 'Documents', icon: FileText },
  { id: 3, title: 'Selfie', short: 'Selfie', icon: Camera },
  { id: 4, title: 'Signature', short: 'Signature', icon: PenTool },
  { id: 5, title: 'Review & Submit', short: 'Review', icon: CheckCircle2 },
]

const DOC_TYPES = [
  { key: 'passport', label: 'Passport Photograph', required: true },
  { key: 'id_card', label: 'Valid Means of Identification', required: true },
  { key: 'work_id', label: 'Work ID', required: false },
  { key: 'utility_bill', label: 'Utility Bill', required: false },
]

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

function Field({ label, children, required }) {
  return (
    <div>
      <label className={labelCls}>{label}{required && <span className="text-rose-500"> *</span>}</label>
      {children}
    </div>
  )
}

function Notice({ children, type = 'info' }) {
  const colors = {
    info: 'bg-blue-50 border-blue-200 text-blue-900',
    warning: 'bg-amber-50 border-amber-200 text-amber-900',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  }
  return (
    <div className={`rounded-lg border p-4 text-sm flex items-start gap-2 ${colors[type]}`}>
      <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  )
}

export default function GuarantorVerificationForm() {
  const { token } = useParams()
  const [details, setDetails] = useState(null)
  const [status, setStatus] = useState('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(null)

  // Form state
  const [form, setForm] = useState({})
  const [documents, setDocuments] = useState([])
  const [selfie, setSelfie] = useState(null)
  const [signature, setSignature] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [fileError, setFileError] = useState('')

  // Correction state
  const [corrections, setCorrections] = useState([])
  const [correctionValues, setCorrectionValues] = useState({})

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  useEffect(() => {
    let active = true
    const load = async () => {
      setStatus('loading')
      try {
        const data = await guarantorVerificationService.getDetails(token)
        if (!active) return
        setDetails(data)
        setForm({
          phone: data.phone || '',
          residential_address: data.residential_address || '',
          occupation: data.occupation || '',
          employer: data.employer || '',
          bvn: data.bvn || '',
          nin: data.nin || '',
        })
        setSelfie(data.selfie_data || null)
        setSignature(data.signature_data || null)
        // Parse existing documents
        if (data.documents && Array.isArray(data.documents)) {
          setDocuments(data.documents.map((d) => ({ ...d, label: d.file_name })))
        }
        // Parse corrections
        if (data.corrections && Array.isArray(data.corrections)) {
          setCorrections(data.corrections)
          const cVals = {}
          data.corrections.forEach((c) => { cVals[c.id] = c.corrected_value || '' })
          setCorrectionValues(cVals)
        }
        // If corrections are pending, start at correction mode
        if (data.status === 'correction_requested') {
          setStatus('corrections')
        } else if (data.status === 'submitted') {
          setStatus('submitted')
        } else {
          setStatus('ready')
        }
      } catch (e) {
        if (!active) return
        setErrorMsg(e?.message || 'Unable to open this verification link.')
        setStatus('error')
      }
    }
    load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const uploadDoc = async (file, docType) => {
    setFileError('')
    if (file.size > 10 * 1024 * 1024) { setFileError('File exceeds the 10MB limit.'); return }
    setUploading(true)
    try {
      const meta = await guarantorVerificationService.uploadDocument({ token, file, documentType: docType })
      setDocuments((d) => [...d.filter((doc) => doc.document_type !== docType), { ...meta, label: file.name, document_type: docType }])
    } catch (e) {
      setFileError(e?.message || 'Upload failed — try again.')
    } finally {
      setUploading(false)
    }
  }

  const removeDoc = (docType) => {
    setDocuments((d) => d.filter((doc) => doc.document_type !== docType))
  }

  const checklist = useMemo(() => ({
    identity: !!(form.phone && form.residential_address && form.occupation && form.employer && form.bvn && form.nin),
    documents: DOC_TYPES.filter((d) => d.required).every((d) => documents.some((doc) => doc.document_type === d.key)),
    selfie: !!selfie,
    signature: !!signature,
  }), [form, documents, selfie, signature])

  const allComplete = Object.values(checklist).every(Boolean)

  const doSubmit = async () => {
    setErrorMsg('')
    if (!allComplete) { setErrorMsg('Please complete all required items before submitting.'); return }
    const payload = {
      ...form,
      selfie_data: selfie,
      signature_data: signature,
      signature_date: new Date().toISOString().split('T')[0],
      documents,
    }
    setSubmitting(true)
    try {
      const result = await guarantorVerificationService.submit(token, payload)
      setDone(result)
    } catch (e) {
      setErrorMsg(e?.message || 'Submission failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const doSubmitCorrections = async () => {
    setErrorMsg('')
    const pendingCorrections = corrections.filter((c) => c.status === 'pending')
    if (pendingCorrections.length === 0) { setErrorMsg('No corrections to submit.'); return }
    const payload = pendingCorrections.map((c) => ({
      correction_id: c.id,
      corrected_value: correctionValues[c.id] || '',
    }))
    setSubmitting(true)
    try {
      const result = await guarantorVerificationService.submitCorrection(token, payload)
      setDone({ ok: true, message: 'Corrections submitted successfully.' })
    } catch (e) {
      setErrorMsg(e?.message || 'Correction submission failed.')
    } finally {
      setSubmitting(false)
    }
  }

  // --- Render helpers ---

  const stepContent = useMemo(() => {
    if (step === 1) return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Full Name" >
          <input className={`${inputCls} bg-slate-50`} value={details?.guarantor_name || ''} readOnly />
        </Field>
        <Field label="Email">
          <input className={`${inputCls} bg-slate-50`} value={details?.guarantor_email || ''} readOnly />
        </Field>
        <Field label="Relationship to Employee">
          <input className={`${inputCls} bg-slate-50`} value={details?.guarantor_relationship || ''} readOnly />
        </Field>
        <Field label="Phone Number" required>
          <input className={inputCls} value={form.phone || ''} onChange={set('phone')} placeholder="0801 234 5678" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Residential Address" required>
            <input className={inputCls} value={form.residential_address || ''} onChange={set('residential_address')} placeholder="House number, street, city, state" />
          </Field>
        </div>
        <Field label="Occupation" required>
          <input className={inputCls} value={form.occupation || ''} onChange={set('occupation')} placeholder="e.g. Accountant" />
        </Field>
        <Field label="Employer / Business" required>
          <input className={inputCls} value={form.employer || ''} onChange={set('employer')} placeholder="e.g. ABC Company Ltd" />
        </Field>
        <Field label="BVN" required>
          <input className={inputCls} value={form.bvn || ''} onChange={set('bvn')} placeholder="11-digit Bank Verification Number" maxLength={11} />
        </Field>
        <Field label="NIN" required>
          <input className={inputCls} value={form.nin || ''} onChange={set('nin')} placeholder="11-digit National ID Number" maxLength={11} />
        </Field>
      </div>
    )
    if (step === 2) return (
      <div className="space-y-4">
        {DOC_TYPES.map((dt) => {
          const doc = documents.find((d) => d.document_type === dt.key)
          return (
            <div key={dt.key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-slate-200 p-4">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${doc ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                  {doc ? <CheckCircle2 className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-800">{dt.label}{dt.required && <span className="text-rose-500"> *</span>}</p>
                  {doc ? <p className="text-xs text-slate-400 mt-0.5">{doc.file_name || doc.label}</p> : <p className="text-xs text-slate-400 mt-0.5">Not uploaded</p>}
                </div>
              </div>
              <div className="flex gap-2">
                {doc ? (
                  <button type="button" onClick={() => removeDoc(dt.key)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-rose-300 text-rose-600 text-xs hover:bg-rose-50">
                    <Trash2 className="w-3.5 h-3.5" /> Remove
                  </button>
                ) : null}
                <label className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${doc ? 'border border-slate-300 text-slate-600 hover:bg-slate-50' : 'bg-[#009944] text-white hover:bg-[#007a36]'}`}>
                  <Upload className="w-3.5 h-3.5" /> {doc ? 'Replace' : 'Upload'}
                  <input type="file" className="hidden" accept="image/*,.pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadDoc(f, dt.key) }} disabled={uploading} />
                </label>
              </div>
            </div>
          )
        })}
        {fileError && <p className="text-sm text-rose-600"><AlertTriangle className="inline w-4 h-4" /> {fileError}</p>}
        {uploading && <p className="text-sm text-slate-500 flex items-center gap-1"><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</p>}
      </div>
    )
    if (step === 3) return (
      <div className="space-y-4">
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-900">
          <p className="font-medium">Identity Verification — Selfie Capture</p>
          <p className="mt-1 text-blue-700">Position your face inside the frame and capture a clear photo. This is a photo capture, not biometric liveness verification.</p>
        </div>
        {selfie ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="w-5 h-5" /> <span className="font-medium">Selfie captured</span>
            </div>
            <img src={selfie} alt="Selfie" className="w-full max-w-xs rounded-lg border border-slate-300 mx-auto" />
            <button type="button" onClick={() => setSelfie(null)} className="mx-auto block text-sm text-[#009944] hover:underline">Retake selfie</button>
          </div>
        ) : (
          <CameraCapture onCapture={(dataUrl) => setSelfie(dataUrl)} />
        )}
      </div>
    )
    if (step === 4) return (
      <div className="space-y-4">
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-900">
          <p className="font-medium">Electronic Signature</p>
          <p className="mt-1 text-blue-700">Sign using your mouse, touchscreen, or stylus in the box below.</p>
        </div>
        {signature ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="w-5 h-5" /> <span className="font-medium">Signature captured</span>
            </div>
            <img src={signature} alt="Signature" className="w-full max-w-md rounded-lg border border-slate-300" />
            <button type="button" onClick={() => setSignature(null)} className="text-sm text-[#009944] hover:underline">Re-sign</button>
          </div>
        ) : (
          <SignaturePad onChange={(dataUrl) => setSignature(dataUrl)} />
        )}
      </div>
    )
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-slate-800">Completion Checklist</h3>
        {[
          { label: 'Identity Information', done: checklist.identity },
          { label: 'Required Documents', done: checklist.documents },
          { label: 'Selfie Captured', done: checklist.selfie },
          { label: 'Signature Captured', done: checklist.signature },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
            {item.done ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            ) : (
              <XCircle className="w-5 h-5 text-rose-400" />
            )}
            <span className={`text-sm ${item.done ? 'text-slate-700' : 'text-rose-500'}`}>{item.label}</span>
          </div>
        ))}
        {!allComplete && <Notice type="warning">Please complete all required items before submitting. Use the step navigation above to go back and fill in any missing information.</Notice>}
      </div>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, details, form, documents, selfie, signature, fileError, uploading, checklist])

  // --- Render ---

  if (status === 'loading') return <Shell><LoadingState label="Opening your verification link…" /></Shell>

  if (status === 'error') return (
    <Shell>
      <div className="text-center py-16">
        <XCircle className="w-12 h-12 text-rose-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Link unavailable</h2>
        <p className="text-sm text-slate-500 mt-2">{errorMsg}</p>
      </div>
    </Shell>
  )

  if (status === 'submitted') return (
    <Shell>
      <div className="text-center py-16">
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Already submitted</h2>
        <p className="text-sm text-slate-500 mt-2">Your verification has been submitted and is pending HR review. Contact HR if you need to make changes.</p>
      </div>
    </Shell>
  )

  if (done) return (
    <Shell>
      <div className="text-center py-16">
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Verification Submitted</h2>
        <p className="text-sm text-slate-500 mt-2">Your guarantor verification has been submitted successfully. HR will review your information.</p>
      </div>
    </Shell>
  )

  // --- Correction mode ---
  if (status === 'corrections') {
    const pendingCorrections = corrections.filter((c) => c.status === 'pending')
    return (
      <Shell>
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-slate-900">Corrections Required</h2>
          <p className="text-sm text-slate-500 mt-1">HR has requested corrections to the following fields. Please provide the corrected information.</p>
        </div>
        {pendingCorrections.length === 0 ? (
          <div className="text-center py-12">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
            <p className="text-sm text-slate-600">All corrections have been submitted. HR will review them shortly.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {pendingCorrections.map((c) => (
              <div key={c.id} className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-medium text-amber-900">{c.field_label || c.field_name}</span>
                </div>
                <div className="text-sm text-slate-600 mb-3">
                  <p className="text-xs text-slate-400">Previously submitted:</p>
                  <p className="mt-0.5 font-mono text-xs bg-white rounded px-2 py-1 border border-slate-200">{c.previous_value || '(empty)'}</p>
                </div>
                <div className="text-sm text-slate-600 mb-3">
                  <p className="text-xs text-slate-400">HR comment:</p>
                  <p className="mt-0.5 text-sm text-amber-800">{c.hr_comment || 'No comment provided.'}</p>
                </div>
                <Field label="Corrected Information" required>
                  <input className={inputCls} value={correctionValues[c.id] || ''} onChange={(e) => setCorrectionValues((v) => ({ ...v, [c.id]: e.target.value }))} />
                </Field>
              </div>
            ))}
            {errorMsg && <Notice type="warning">{errorMsg}</Notice>}
            <button type="button" onClick={doSubmitCorrections} disabled={submitting} className="w-full inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {submitting ? 'Submitting…' : 'Submit Corrections'}
            </button>
          </div>
        )}
      </Shell>
    )
  }

  // --- Normal form mode ---
  return (
    <Shell>
      {details && (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p className="font-medium">Guarantor Verification for {details.employee_name || 'Employee'}</p>
          <p className="text-emerald-700 mt-0.5">Position: {details.position || 'N/A'}</p>
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-6 border-b border-slate-200">
        {STEPS.map((s) => {
          const Icon = s.icon
          return (
            <button key={s.id} onClick={() => setStep(s.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border flex items-center gap-1.5 ${step === s.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
              <Icon className="w-3.5 h-3.5" /> {s.short}
            </button>
          )
        })}
      </div>
      <div className="min-h-[300px]">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">{STEPS.find((s) => s.id === step)?.title}</h2>
        {stepContent}
      </div>
      {errorMsg && <div className="mt-4"><Notice type="warning">{errorMsg}</Notice></div>}
      <div className="mt-8 flex items-center justify-between">
        <button type="button" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 disabled:opacity-40 hover:bg-slate-50">
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        {step < STEPS.length ? (
          <button type="button" onClick={() => setStep(step + 1)} className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            Continue <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button type="button" onClick={doSubmit} disabled={submitting || !allComplete} className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {submitting ? 'Submitting…' : 'Submit Verification'}
          </button>
        )}
      </div>
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-[#0a0b0d] text-white">
        <div className="max-w-3xl mx-auto px-4 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={36} variant="light" />
            <div>
              <div className="font-semibold">Guarantor Verification</div>
              <div className="text-xs text-white/50">InfinityCore Human Resources</div>
            </div>
          </div>
          <Check className="text-[#009944]" />
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl border border-slate-200 p-6 sm:p-8 shadow-sm">{children}</div>
      </main>
    </div>
  )
}
