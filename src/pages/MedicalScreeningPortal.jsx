import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Send, Stethoscope, Upload, XCircle, FileText } from 'lucide-react'
import Logo from '../components/Logo'
import SignaturePad from '../components/SignaturePad'
import { medicalScreeningService, MEDICAL_OUTCOME_LABELS } from '../services/medicalScreeningService'
import { LoadingState } from '../components/PageStates'
import { screeningTypeLabel, formatMedDate } from '../components/medical/medicalUi'

// Public, unauthenticated Hospital / Medical Provider portal. Reached by
// scanning the QR on the Medical Screening Card. No sign-in required: access
// is granted by the one-time token embedded in the QR, validated server-side.
//
// The examination is broken into structured sections that mirror what a
// medical officer records during a pre-employment / periodic screening. The
// final fitness outcome is ALWAYS a human, medical-officer decision — AI is
// never used to determine fitness.

const STEPS = [
  { id: 1, title: 'Overview', short: 'Overview' },
  { id: 2, title: 'Medical History', short: 'History' },
  { id: 3, title: 'General Examination', short: 'Exam' },
  { id: 4, title: 'Vision & Hearing', short: 'Vision' },
  { id: 5, title: 'Laboratory & Radiology', short: 'Lab' },
  { id: 6, title: 'Fitness Assessment', short: 'Fitness' },
  { id: 7, title: 'Officer & Submit', short: 'Submit' },
]

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-slate-50'
const textCls = 'w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-slate-50'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

function Field({ label, children, required }) {
  return (
    <div>
      <label className={labelCls}>{label}{required && <span className="text-rose-500"> *</span>}</label>
      {children}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-semibold text-slate-800 mb-4">{title}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>
    </div>
  )
}

export default function MedicalScreeningPortal() {
  const { token } = useParams()
  const [status, setStatus] = useState('loading')
  const [details, setDetails] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [step, setStep] = useState(1)
  const [started, setStarted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(null)
  const [uploading, setUploading] = useState(false)

  // Medical record form state
  const [form, setForm] = useState({
    general_examination: {}, vision: {}, hearing: {},
    laboratory: {}, radiology: {}, medical_history: {}, fitness_assessment: {},
    medical_officer_name: '', medical_officer_title: '', license_number: '',
    screening_date: new Date().toISOString().split('T')[0],
    outcome: '', outcome_notes: '', restrictions: '',
  })
  const [signature, setSignature] = useState(null)
  const [documents, setDocuments] = useState([])
  const [fileError, setFileError] = useState('')

  const setSection = (key) => (e) => setForm((f) => ({ ...f, [key]: { ...(f[key] || {}), [e.target.name]: e.target.value } }))
  const setTop = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  useEffect(() => {
    let active = true
    const load = async () => {
      setStatus('loading')
      try {
        const data = await medicalScreeningService.getDetails(token)
        if (!active) return
        setDetails(data)
        if (data?.already_submitted) {
          setStatus('submitted')
        } else {
          setStatus('ready')
          setStarted(!['issued', 'qr_opened'].includes(data.status))
        }
      } catch (e) {
        if (!active) return
        setErrorMsg(e?.message || 'Unable to open this referral. Please contact Human Resources.')
        setStatus('error')
      }
    }
    load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const begin = async () => {
    // Opening the referral already moved it to "qr_opened" server-side;
    // record "screening_started" so HR sees the In Progress state immediately.
    // The token is already proven valid here, so a failed begin only means the
    // tracking RPC is unavailable — never block the hospital from working.
    try {
      await medicalScreeningService.begin(token)
    } catch (e) {
      console.warn('begin_medical_screening unavailable:', e?.message || e)
    }
    setStarted(true)
  }

  const uploadDoc = async (file) => {
    setFileError('')
    if (file.size > 10 * 1024 * 1024) { setFileError('File exceeds the 10MB limit.'); return }
    setUploading(true)
    try {
      const meta = await medicalScreeningService.uploadDocument({ token, file })
      setDocuments((d) => [...d, { ...meta, label: file.name }])
    } catch (e) {
      setFileError(e?.message || 'Upload failed — try again.')
    } finally {
      setUploading(false)
    }
  }

  const requiredComplete = form.medical_officer_name.trim() && signature && form.outcome && form.screening_date
  const outcomeOptions = Object.entries(MEDICAL_OUTCOME_LABELS)

  const doSubmit = async () => {
    setErrorMsg('')
    if (!requiredComplete) {
      setErrorMsg('The medical officer must enter their name, capture their signature, select a fitness outcome, and set the screening date before submitting.')
      return
    }
    setSubmitting(true)
    try {
      const officer = [form.medical_officer_name.trim(), form.medical_officer_title.trim(), form.license_number.trim()]
        .filter(Boolean)
        .join(' · ')
      const payload = {
        medical_officer: officer,
        outcome: form.outcome,
        signature_data: signature,
        screening_date: form.screening_date,
        hospital_name: details?.hospital_name || '',
        outcome_notes: form.outcome_notes || '',
        results: {
          medical_history: form.medical_history,
          general_examination: form.general_examination,
          vision: form.vision,
          hearing: form.hearing,
          laboratory: form.laboratory,
          radiology: form.radiology,
          fitness_assessment: { ...form.fitness_assessment, restrictions: form.restrictions || '' },
        },
        documents: documents.map((d) => ({
          document_type: d.document_type || 'other',
          file_name: d.file_name,
          file_path: d.file_path,
          file_size: d.file_size,
          mime_type: d.mime_type,
        })),
      }
      const result = await medicalScreeningService.submit(token, payload)
      setDone(result)
    } catch (e) {
      setErrorMsg(e?.message || 'Submission failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // ---------- Render ----------

  if (status === 'loading') return <Shell><LoadingState label="Opening the medical screening portal…" /></Shell>

  if (status === 'error') return (
    <Shell>
      <div className="text-center py-16">
        <XCircle className="w-12 h-12 text-rose-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Referral unavailable</h2>
        <p className="text-sm text-slate-500 mt-2">{errorMsg}</p>
      </div>
    </Shell>
  )

  if (status === 'submitted') return (
    <Shell>
      <div className="text-center py-16">
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Already submitted</h2>
        <p className="text-sm text-slate-500 mt-2">This screening has already been submitted and is with InfinityCore Human Resources for review.</p>
      </div>
    </Shell>
  )

  if (done) return (
    <Shell>
      <div className="text-center py-16">
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Screening submitted successfully</h2>
        <p className="text-sm text-slate-500 mt-2">
          The medical screening result for <span className="font-medium text-slate-700">{details?.subject_name}</span> ({details?.reference})
          has been transmitted to InfinityCore Human Resources. This QR code can no longer be used to submit another result.
        </p>
      </div>
    </Shell>
  )

  // ---- Landing ----
  if (!started) return (
    <Shell>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-slate-900">Medical Screening Referral</h2>
        <p className="text-sm text-slate-500 mt-1">This is an authorized InfinityCore hospital screening referral. Confirm the details below before proceeding.</p>
      </div>

      <div className="rounded-xl border border-slate-200 overflow-hidden mb-6">
        <div className="bg-slate-50 px-4 py-2.5 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-800">Referral Details</span>
          <span className="font-mono text-sm font-bold text-[#009944]">{details?.reference}</span>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Candidate / Employee"><input readOnly className={inputCls} value={details?.subject_name || ''} /></Field>
          <Field label="Screening Type"><input readOnly className={inputCls} value={screeningTypeLabel(details?.screening_type, details?.other_screening_type)} /></Field>
          <Field label="Position"><input readOnly className={inputCls} value={details?.subject_position || '—'} /></Field>
          <Field label="Department"><input readOnly className={inputCls} value={details?.subject_department || '—'} /></Field>
          <Field label="Assigned Hospital"><input readOnly className={inputCls} value={details?.hospital_name || '—'} /></Field>
          <Field label="Valid Until"><input readOnly className={inputCls} value={formatMedDate(details?.expires_at)} /></Field>
        </div>
      </div>

      {details?.lab_tests?.length > 0 && (
        <div className="mb-6">
          <p className="text-sm font-medium text-slate-700 mb-2">Required Investigations</p>
          <div className="flex flex-wrap gap-2">
            {details.lab_tests.map((t) => (
              <span key={t} className="px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-700">{t}</span>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-900 mb-6">
        <p className="font-medium">Before you begin</p>
        <ul className="mt-2 list-disc list-inside space-y-1 text-blue-700">
          <li>Verify the subject's identity against their photo and the name above.</li>
          <li>Carry out only the investigations required by the employer (listed above) plus any you deem clinically necessary.</li>
          <li>The fitness outcome is the responsibility of the qualified medical officer; it is never decided automatically.</li>
        </ul>
      </div>

      <button onClick={begin} className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-[#009944] text-white text-sm font-semibold hover:bg-[#007a36]">
        <Stethoscope className="w-4 h-4" /> Begin Medical Screening
      </button>
    </Shell>
  )

  // ---- Stepper / Form ----
  return (
    <Shell>
      {/* Step indicator */}
      <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-1">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && <span className={`w-1 h-1 rounded-full flex-shrink-0 ${i < step ? 'bg-[#009944]' : 'bg-slate-300'}`} />}
            <button
              type="button"
              onClick={() => setStep(Math.min(s.id, Math.max(step - 1, 1)))}
              className={`text-[10px] px-2 py-1 rounded font-medium whitespace-nowrap ${s.id === step ? 'bg-[#009944] text-white' : s.id < step ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-400'}`}
            >
              {s.short}
            </button>
          </React.Fragment>
        ))}
      </div>

      <div className="min-h-[300px]">
        <h2 className="text-lg font-semibold text-slate-900 mb-1">{STEPS.find((s) => s.id === step)?.title}</h2>
        <p className="text-xs text-slate-400 mb-4">{details?.subject_name} · {details?.reference}</p>

        {/* STEP 1 — Overview */}
        {step === 1 && (
          <div className="space-y-4">
            <Section title="Medical Officer Confirmation">
              <Field label="Full Name" required>
                <input className={inputCls} value={form.medical_officer_name} onChange={setTop('medical_officer_name')} placeholder="Dr. Jane Smith" />
              </Field>
              <Field label="Title / Qualification">
                <input className={inputCls} value={form.medical_officer_title} onChange={setTop('medical_officer_title')} placeholder="Consultant Physician" />
              </Field>
              <Field label="License Number">
                <input className={inputCls} value={form.license_number} onChange={setTop('license_number')} placeholder="MDCN / GMC number" />
              </Field>
              <Field label="Screening Date" required>
                <input type="date" className={inputCls} value={form.screening_date} onChange={setTop('screening_date')} />
              </Field>
            </Section>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm text-slate-600">
              Proceed through each section and record your findings. Sections may be left partially complete where a test wasn't performed.
            </div>
          </div>
        )}

        {/* STEP 2 — Medical History */}
        {step === 2 && (
          <Section title="Medical History">
            <Field label="Known Conditions / Medications">
              <input name="known_conditions" className={inputCls} onChange={setSection('medical_history')} placeholder="e.g. hypertension, asthma" />
            </Field>
            <Field label="Surgeries">
              <input name="surgeries" className={inputCls} onChange={setSection('medical_history')} placeholder="None / details" />
            </Field>
            <Field label="Allergies">
              <input name="allergies" className={inputCls} onChange={setSection('medical_history')} placeholder="None / details" />
            </Field>
            <Field label="Family History">
              <input name="family_history" className={inputCls} onChange={setSection('medical_history')} placeholder="Relevant hereditary conditions" />
            </Field>
            <Field label="Lifestyle / Smoking / Alcohol">
              <input name="lifestyle" className={inputCls} onChange={setSection('medical_history')} placeholder="Notes" />
            </Field>
            <Field label="Additional Notes">
              <input name="notes" className={inputCls} onChange={setSection('medical_history')} placeholder="Any other relevant history" />
            </Field>
          </Section>
        )}

        {/* STEP 3 — General Examination */}
        {step === 3 && (
          <Section title="General Examination">
            <Field label="Height (cm)">
              <input name="height" type="number" className={inputCls} onChange={setSection('general_examination')} placeholder="170" />
            </Field>
            <Field label="Weight (kg)">
              <input name="weight" type="number" className={inputCls} onChange={setSection('general_examination')} placeholder="70" />
            </Field>
            <Field label="BMI">
              <input name="bmi" type="number" step="0.1" className={inputCls} onChange={setSection('general_examination')} placeholder="24.2" />
            </Field>
            <Field label="Blood Pressure (mmHg)">
              <input name="blood_pressure" className={inputCls} onChange={setSection('general_examination')} placeholder="120/80" />
            </Field>
            <Field label="Pulse (bpm)">
              <input name="pulse" type="number" className={inputCls} onChange={setSection('general_examination')} placeholder="72" />
            </Field>
            <Field label="Temperature (°C)">
              <input name="temperature" type="number" step="0.1" className={inputCls} onChange={setSection('general_examination')} placeholder="36.5" />
            </Field>
            <Field label="Respiratory Rate (breaths/min)">
              <input name="respiratory_rate" type="number" className={inputCls} onChange={setSection('general_examination')} placeholder="16" />
            </Field>
            <Field label="General System Review">
              <input name="system_review" className={inputCls} onChange={setSection('general_examination')} placeholder="Normal / findings" />
            </Field>
          </Section>
        )}

        {/* STEP 4 — Vision & Hearing */}
        {step === 4 && (
          <>
            <Section title="Vision">
              <Field label="Right Eye">
                <input name="right_eye" className={inputCls} onChange={setSection('vision')} placeholder="6/6" />
              </Field>
              <Field label="Left Eye">
                <input name="left_eye" className={inputCls} onChange={setSection('vision')} placeholder="6/6" />
              </Field>
              <Field label="Colour Vision">
                <input name="colour_vision" className={inputCls} onChange={setSection('vision')} placeholder="Normal / defective" />
              </Field>
              <Field label="Corrective Lenses Required?">
                <input name="corrective_lenses" className={inputCls} onChange={setSection('vision')} placeholder="No / Yes (specify)" />
              </Field>
            </Section>
            <Section title="Hearing">
              <Field label="Right Ear">
                <input name="right_ear" className={inputCls} onChange={setSection('hearing')} placeholder="Normal / impaired" />
              </Field>
              <Field label="Left Ear">
                <input name="left_ear" className={inputCls} onChange={setSection('hearing')} placeholder="Normal / impaired" />
              </Field>
              <Field label="Hearing Aid Required?">
                <input name="hearing_aid" className={inputCls} onChange={setSection('hearing')} placeholder="No / Yes (specify)" />
              </Field>
              <Field label="Notes">
                <input name="notes" className={inputCls} onChange={setSection('hearing')} placeholder="Additional notes" />
              </Field>
            </Section>
          </>
        )}

        {/* STEP 5 — Laboratory & Radiology */}
        {step === 5 && (
          <>
            <Section title="Laboratory">
              <Field label="Urinalysis">
                <input name="urinalysis" className={inputCls} onChange={setSection('laboratory')} placeholder="Normal / findings" />
              </Field>
              <Field label="Full Blood Count">
                <input name="full_blood_count" className={inputCls} onChange={setSection('laboratory')} placeholder="Normal / findings" />
              </Field>
              <Field label="Blood Glucose">
                <input name="blood_glucose" className={inputCls} onChange={setSection('laboratory')} placeholder="Normal / mmol/L" />
              </Field>
              <Field label="Malaria Screening">
                <input name="malaria_screening" className={inputCls} onChange={setSection('laboratory')} placeholder="Negative / positive" />
              </Field>
              <Field label="Hepatitis Screening">
                <input name="hepatitis" className={inputCls} onChange={setSection('laboratory')} placeholder="Negative / positive" />
              </Field>
              <Field label="Additional Laboratory Tests">
                <input name="other" className={inputCls} onChange={setSection('laboratory')} placeholder="Results of any other tests performed" />
              </Field>
            </Section>
            <Section title="Radiology">
              <Field label="Chest X-ray">
                <input name="chest_xray" className={inputCls} onChange={setSection('radiology')} placeholder="Normal / findings" />
              </Field>
              <Field label="Other Imaging">
                <input name="other" className={inputCls} onChange={setSection('radiology')} placeholder="None / findings" />
              </Field>
            </Section>
          </>
        )}

        {/* STEP 6 — Fitness Assessment */}
        {step === 6 && (
          <div className="space-y-4">
            <Section title="Fitness Assessment">
              <div className="sm:col-span-2">
                <Field label="Final Outcome" required>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {outcomeOptions.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, outcome: value }))}
                        className={`px-3 py-2.5 rounded-lg border text-left text-sm font-medium transition-colors ${form.outcome === value ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </Field>
                <div className="mt-4">
                  <Field label="Outcome Notes">
                    <textarea className={textCls} rows={2} value={form.outcome_notes || ''} onChange={setTop('outcome_notes')} placeholder="Brief justification for the outcome" />
                  </Field>
                </div>
                <div className="mt-4">
                  <Field label="Restrictions / Accommodations">
                    <textarea className={textCls} rows={2} value={form.restrictions || ''} onChange={setTop('restrictions')} placeholder="e.g. no heavy lifting, display-screen adjustments" />
                  </Field>
                </div>
              </div>
            </Section>
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
              <p className="font-medium">Important</p>
              <p className="mt-1">The fitness outcome is your independent clinical decision as a qualified medical officer — it is never generated or influenced automatically. Record it accurately.</p>
            </div>
          </div>
        )}

        {/* STEP 7 — Officer signature + documents */}
        {step === 7 && (
          <div className="space-y-4">
            <Section title="Electronic Signature of Medical Officer">
              <div className="sm:col-span-2">
                <p className="text-sm text-slate-600 mb-3">Sign using your mouse, touchscreen, or stylus.</p>
                {signature ? (
                  <div>
                    <div className="flex items-center gap-2 text-sm text-emerald-700 mb-2">
                      <CheckCircle2 className="w-4 h-4" /> <span className="font-medium">Signature captured</span>
                    </div>
                    <img src={signature} alt="Signature" className="w-full max-w-md rounded-lg border border-slate-300" />
                    <button type="button" onClick={() => setSignature(null)} className="mt-2 text-sm text-[#009944] hover:underline">Re-sign</button>
                  </div>
                ) : (
                  <SignaturePad onChange={(dataUrl) => setSignature(dataUrl)} />
                )}
              </div>
            </Section>

            <Section title="Supporting Documents">
              <div className="sm:col-span-2">
                <label className={labelCls}>Lab results, imaging reports, dictation notes…</label>
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 cursor-pointer hover:bg-slate-50">
                    <Upload className="w-4 h-4" /> {uploading ? 'Uploading…' : 'Upload document'}
                    <input type="file" className="hidden" onChange={(e) => { if (e.target.files?.[0]) uploadDoc(e.target.files[0]); e.target.value = '' }} />
                  </label>
                </div>
                {fileError && <p className="text-sm text-rose-600 mt-2">{fileError}</p>}
                {documents.length > 0 && (
                  <div className="mt-3 border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {documents.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700">
                        <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                        <span className="truncate">{d.label}</span>
                        <button type="button" onClick={() => setDocuments((arr) => arr.filter((_, j) => j !== i))} className="ml-auto text-xs text-rose-500 hover:underline">Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Section>
          </div>
        )}
      </div>

      {errorMsg && <div className="mt-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">{errorMsg}</div>}

      <div className="mt-8 flex items-center justify-between">
        <button type="button" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 disabled:opacity-40 hover:bg-slate-50">
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        {step < STEPS.length ? (
          <button type="button" onClick={() => setStep(step + 1)} className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            Continue <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button type="button" onClick={doSubmit} disabled={submitting || !requiredComplete} className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {submitting ? 'Submitting…' : 'Submit Screening'}
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
              <div className="font-semibold">Medical Screening Portal</div>
              <div className="text-xs text-white/50">InfinityCore Human Resources · Authorized Medical Providers</div>
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
