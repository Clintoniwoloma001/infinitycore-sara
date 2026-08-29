import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react'
import Logo from '../components/Logo'
import SignaturePad from '../components/SignaturePad'
import { onboardingService } from '../services/onboardingService'
import { LoadingState } from '../components/PageStates'

const STEPS = [
  { id: 1, title: 'Personal', short: 'Personal' },
  { id: 2, title: 'Marital & Family', short: 'Family' },
  { id: 3, title: 'Contact', short: 'Contact' },
  { id: 4, title: 'Next of Kin', short: 'Next of Kin' },
  { id: 5, title: 'Beneficiary', short: 'Beneficiary' },
  { id: 6, title: 'Education', short: 'Education' },
  { id: 7, title: 'Work History', short: 'Work' },
  { id: 8, title: 'Guarantor', short: 'Guarantor' },
  { id: 9, title: 'Fidelity Bond', short: 'Bond' },
  { id: 10, title: 'Documents & Signature', short: 'Sign' },
]

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

function Field({ label, children }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  )
}

function ListEditor({ label, columns, rows, setRows, placeholder }) {
  const [draft, setDraft] = useState({})
  const fields = columns.map((c) => c.key)
  const canAdd = fields.every((f) => (draft[f] || '').trim() !== '')
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <div className="space-y-2 mb-2">
        {rows.length === 0 && <p className="text-sm text-slate-400">{placeholder}</p>}
        {rows.map((row, idx) => (
          <div key={idx} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {columns.map((col) => (
                <div key={col.key} className="text-sm">
                  <span className="text-xs text-slate-400">{col.label}:</span>{' '}
                  <span className="text-slate-700">{row[col.key] || '-'}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setRows(rows.filter((_, i) => i !== idx))} className="text-rose-500 hover:text-rose-700"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {columns.map((col) => (
          <div key={col.key}>
            <input
              value={draft[col.key] || ''}
              onChange={(e) => setDraft({ ...draft, [col.key]: e.target.value })}
              placeholder={placeholder?.replace('{label}', col.label) || col.label}
              className={inputCls}
            />
          </div>
        ))}
      </div>
      <button type="button" onClick={() => { setRows([...rows, draft]); setDraft({}) }} disabled={!canAdd} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[#009944] disabled:opacity-40">
        <Plus className="w-4 h-4" /> Add {label}
      </button>
    </div>
  )
}

function Notice({ children }) {
  return (
    <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm p-4 flex items-start gap-2">
      <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-600" />
      <div>{children}</div>
    </div>
  )
}

export default function OnboardingForm() {
  const { token } = useParams()
  const [link, setLink] = useState(null)
  const [status, setStatus] = useState('loading') // loading | ready | used | error
  const [errorMsg, setErrorMsg] = useState('')
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(null)
  const progressRef = useRef(0)

  const [form, setForm] = useState({})
  const [education, setEducation] = useState([])
  const [workHistory, setWorkHistory] = useState([])
  const [documents, setDocuments] = useState([])
  const [declaration, setDeclaration] = useState(false)
  const [signature, setSignature] = useState(null)
  const [fileError, setFileError] = useState('')

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  useEffect(() => {
    let active = true
    const load = async () => {
      setStatus('loading')
      try {
        const details = await onboardingService.getDetails(token)
        if (!details) throw new Error('This onboarding link could not be found.')
        if (details.status === 'EXPIRED') throw new Error('This onboarding link has expired. Please contact your HR office for a new one.')
        if (details.status === 'REVOKED') throw new Error('This onboarding link has been revoked. Please contact your HR office.')
        if (details.status === 'SUBMITTED') { if (active) setStatus('used'); return }
        if (!active) return
        setLink(details)
        setForm((f) => ({
          ...f,
          surname: details.candidate_name?.split(' ').slice(1).join(' ') || '',
          first_name: details.candidate_name?.split(' ')[0] || '',
          email: details.candidate_email || '',
          phone: details.candidate_phone || '',
          position: details.position || '',
          department: details.department || '',
          branch: details.branch || '',
          employment_type: details.employment_type || '',
        }))
        setStatus('ready')
      } catch (e) {
        if (!active) return
        setErrorMsg(e?.message || 'Unable to open this onboarding link.')
        setStatus('error')
      }
    }
    load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (status !== 'ready' || !token) return
    const stepNumber = Math.floor(step / 3)
    if (stepNumber > progressRef.current) {
      progressRef.current = stepNumber
      onboardingService.markProgress(token).catch(() => {})
    }
  }, [step, status, token])

  const addDoc = async (files) => {
    setFileError('')
    for (const file of Array.from(files || [])) {
      if (file.size > 10 * 1024 * 1024) { setFileError('One of the selected files exceeds the 10MB limit.'); continue }
      try {
        const meta = await onboardingService.uploadDocument({ token, file, category: 'onboarding' })
        setDocuments((d) => [...d, { ...meta, label: file.name }])
      } catch (e) {
        setFileError(e?.message || 'Upload failed — try again.')
      }
    }
  }

  const doSubmit = async () => {
    setErrorMsg('')
    if (!declaration) { setErrorMsg('Please accept the declaration before submitting.'); return }
    if (!signature) { setErrorMsg('Please sign before submitting.'); return }
    const payload = {
      ...form,
      education,
      work_history: workHistory,
      documents,
      declaration_accepted: declaration,
      declaration_signature: signature,
      number_of_children: form.number_of_children || '0',
    }
    setSubmitting(true)
    try {
      const result = await onboardingService.submit(token, payload)
      setDone(result)
    } catch (e) {
      setErrorMsg(e?.message || 'Submission failed. Please contact HR.')
    } finally {
      setSubmitting(false)
    }
  }

  const content = useMemo(() => {
    if (!link) return null
    if (step === 1) return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Surname *"><input className={inputCls} value={form.surname || ''} onChange={set('surname')} /></Field>
        <Field label="First Name *"><input className={inputCls} value={form.first_name || ''} onChange={set('first_name')} /></Field>
        <Field label="Email Address"><input className={inputCls} value={form.email || ''} onChange={set('email')} type="email" /></Field>
        <Field label="Phone Number"><input className={inputCls} value={form.phone || ''} onChange={set('phone')} /></Field>
        <Field label="Date of Birth"><input className={inputCls} value={form.date_of_birth || ''} onChange={set('date_of_birth')} type="date" /></Field>
        <Field label="Sex">
          <select className={inputCls} value={form.sex || ''} onChange={set('sex')}>
            <option value="">Select...</option>
            <option>Male</option><option>Female</option>
          </select>
        </Field>
        <Field label="State of Origin"><input className={inputCls} value={form.state_of_origin || ''} onChange={set('state_of_origin')} /></Field>
        <Field label="LGA"><input className={inputCls} value={form.lga || ''} onChange={set('lga')} /></Field>
        <Field label="Town / City"><input className={inputCls} value={form.town || ''} onChange={set('town')} /></Field>
        <Field label="Residential Address"><input className={inputCls} value={form.residential_address || ''} onChange={set('residential_address')} /></Field>
        <Field label="Religion"><input className={inputCls} value={form.religion || ''} onChange={set('religion')} /></Field>
        <Field label="Denomination"><input className={inputCls} value={form.denomination || ''} onChange={set('denomination')} /></Field>
        <Field label="Nationality"><input className={inputCls} value={form.nationality || ''} onChange={set('nationality')} /></Field>
      </div>
    )
    if (step === 2) return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Marital Status">
          <select className={inputCls} value={form.marital_status || ''} onChange={set('marital_status')}>
            <option value="">Select...</option>
            <option>Single</option><option>Married</option><option>Divorced</option><option>Widowed</option>
          </select>
        </Field>
        <Field label="Living with spouse?">
          <select className={inputCls} value={form.living_with_spouse || ''} onChange={set('living_with_spouse')}>
            <option value="">Select...</option><option value="true">Yes</option><option value="false">No</option>
          </select>
        </Field>
        <Field label="Spouse Name"><input className={inputCls} value={form.spouse_name || ''} onChange={set('spouse_name')} /></Field>
        <Field label="Spouse Occupation"><input className={inputCls} value={form.spouse_occupation || ''} onChange={set('spouse_occupation')} /></Field>
        <Field label="Spouse Age"><input className={inputCls} value={form.spouse_age || ''} onChange={set('spouse_age')} type="number" /></Field>
        <Field label="Spouse Business Address"><input className={inputCls} value={form.spouse_business_address || ''} onChange={set('spouse_business_address')} /></Field>
        <Field label="Spouse Email"><input className={inputCls} value={form.spouse_email || ''} onChange={set('spouse_email')} type="email" /></Field>
        <Field label="Spouse Phone"><input className={inputCls} value={form.spouse_phone || ''} onChange={set('spouse_phone')} /></Field>
        <Field label="Number of Children"><input className={inputCls} value={form.number_of_children || ''} onChange={set('number_of_children')} type="number" min="0" /></Field>
        <Field label="Children Age Range"><input className={inputCls} value={form.children_age_range || ''} onChange={set('children_age_range')} placeholder="e.g. 2-5, 6-12" /></Field>
      </div>
    )
    if (step === 3) return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Emergency Contact Name"><input className={inputCls} value={form.emergency_contact_name || ''} onChange={set('emergency_contact_name')} /></Field>
        <Field label="Emergency Contact Phone"><input className={inputCls} value={form.emergency_contact_phone || ''} onChange={set('emergency_contact_phone')} /></Field>
        <div className="sm:col-span-2 rounded-lg border border-[#009944]/30 bg-emerald-50 p-4 text-sm text-emerald-900">
          Employment details below are pre-filled from your offer. Contact HR if anything is wrong.
        </div>
        <Field label="Department"><input className={inputCls} value={form.department || ''} readOnly /></Field>
        <Field label="Position"><input className={inputCls} value={form.position || ''} readOnly /></Field>
        <Field label="Employment Type"><input className={inputCls} value={form.employment_type || ''} readOnly /></Field>
        <Field label="Branch"><input className={inputCls} value={form.branch || ''} readOnly /></Field>
      </div>
    )
    if (step === 4) return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Next of Kin Name"><input className={inputCls} value={form.next_of_kin_name || ''} onChange={set('next_of_kin_name')} /></Field>
        <Field label="Relationship"><input className={inputCls} value={form.next_of_kin_relationship || ''} onChange={set('next_of_kin_relationship')} /></Field>
        <div className="sm:col-span-2"><Field label="Address"><input className={inputCls} value={form.next_of_kin_address || ''} onChange={set('next_of_kin_address')} /></Field></div>
        <Field label="Phone"><input className={inputCls} value={form.next_of_kin_phone || ''} onChange={set('next_of_kin_phone')} /></Field>
      </div>
    )
    if (step === 5) return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Beneficiary Name"><input className={inputCls} value={form.beneficiary_name || ''} onChange={set('beneficiary_name')} /></Field>
        <Field label="Relationship"><input className={inputCls} value={form.beneficiary_relationship || ''} onChange={set('beneficiary_relationship')} /></Field>
        <div className="sm:col-span-2"><Field label="Address"><input className={inputCls} value={form.beneficiary_address || ''} onChange={set('beneficiary_address')} /></Field></div>
        <Field label="Phone"><input className={inputCls} value={form.beneficiary_phone || ''} onChange={set('beneficiary_phone')} /></Field>
      </div>
    )
    if (step === 6) return (
      <ListEditor
        label="Education History"
        placeholder="Enter {label}"
        rows={education}
        setRows={setEducation}
        columns={[
          { key: 'institution', label: 'Institution' },
          { key: 'education_level', label: 'Level (primary/secondary/tertiary)' },
          { key: 'from_year', label: 'From Year' },
          { key: 'to_year', label: 'To Year' },
          { key: 'field_of_study', label: 'Field of Study' },
          { key: 'class_degree', label: 'Class / Degree' },
        ]}
      />
    )
    if (step === 7) return (
      <ListEditor
        label="Work History"
        placeholder="Enter {label}"
        rows={workHistory}
        setRows={setWorkHistory}
        columns={[
          { key: 'company_name', label: 'Company' },
          { key: 'position', label: 'Position' },
          { key: 'duties', label: 'Duties' },
          { key: 'start_date', label: 'Start (YYYY-MM-DD)' },
          { key: 'end_date', label: 'End (YYYY-MM-DD)' },
          { key: 'salary', label: 'Salary' },
          { key: 'supervisor_name', label: 'Supervisor' },
          { key: 'supervisor_phone', label: 'Supervisor Phone' },
          { key: 'reason_for_leaving', label: 'Reason for Leaving' },
        ]}
      />
    )
    if (step === 8) return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Guarantor Full Name"><input className={inputCls} value={form.guarantor_full_name || ''} onChange={set('guarantor_full_name')} /></Field>
        <Field label="Relationship to Employee"><input className={inputCls} value={form.guarantor_relationship || ''} onChange={set('guarantor_relationship')} /></Field>
        <Field label="Profession"><input className={inputCls} value={form.guarantor_profession || ''} onChange={set('guarantor_profession')} /></Field>
        <Field label="Designation"><input className={inputCls} value={form.guarantor_designation || ''} onChange={set('guarantor_designation')} /></Field>
        <Field label="Phone"><input className={inputCls} value={form.guarantor_phone || ''} onChange={set('guarantor_phone')} /></Field>
        <Field label="Email"><input className={inputCls} value={form.guarantor_email || ''} onChange={set('guarantor_email')} type="email" /></Field>
        <Field label="BVN"><input className={inputCls} value={form.guarantor_bvn || ''} onChange={set('guarantor_bvn')} /></Field>
        <Field label="NIN"><input className={inputCls} value={form.guarantor_nin || ''} onChange={set('guarantor_nin')} /></Field>
        <div className="sm:col-span-2"><Field label="Business Address"><input className={inputCls} value={form.guarantor_business_address || ''} onChange={set('guarantor_business_address')} /></Field></div>
        <div className="sm:col-span-2"><Field label="Residential Address"><input className={inputCls} value={form.guarantor_residential_address || ''} onChange={set('guarantor_residential_address')} /></Field></div>
        <div className="sm:col-span-2 sm:grid sm:grid-cols-2 gap-4">
          <Field label="Guarantor Signature Date"><input className={inputCls} value={form.guarantor_date || ''} onChange={set('guarantor_date')} type="date" /></Field>
          <Field label="Guarantor Signature (data URL)"><input className={inputCls} value={form.guarantor_signature || ''} onChange={set('guarantor_signature')} placeholder="Paste signature data URL if obtained separately" /></Field>
        </div>
      </div>
    )
    if (step === 9) return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Surety Name"><input className={inputCls} value={form.fidelity_surety_name || ''} onChange={set('fidelity_surety_name')} /></Field>
        <Field label="Relationship"><input className={inputCls} value={form.fidelity_relationship || ''} onChange={set('fidelity_relationship')} /></Field>
        <Field label="Occupation"><input className={inputCls} value={form.fidelity_occupation || ''} onChange={set('fidelity_occupation')} /></Field>
        <Field label="Phone"><input className={inputCls} value={form.fidelity_phone || ''} onChange={set('fidelity_phone')} /></Field>
        <Field label="Email"><input className={inputCls} value={form.fidelity_email || ''} onChange={set('fidelity_email')} type="email" /></Field>
        <Field label="BVN"><input className={inputCls} value={form.fidelity_bvn || ''} onChange={set('fidelity_bvn')} /></Field>
        <Field label="NIN"><input className={inputCls} value={form.fidelity_nin || ''} onChange={set('fidelity_nin')} /></Field>
        <div className="sm:col-span-2"><Field label="Address"><input className={inputCls} value={form.fidelity_address || ''} onChange={set('fidelity_address')} /></Field></div>
        <Field label="Signature Date"><input className={inputCls} value={form.fidelity_date || ''} onChange={set('fidelity_date')} type="date" /></Field>
        <Field label="Signature (data URL)"><input className={inputCls} value={form.fidelity_signature || ''} onChange={set('fidelity_signature')} placeholder="Paste signature data URL if obtained separately" /></Field>
      </div>
    )
    return (
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-5 h-5 text-[#009944]" />
            <h3 className="text-sm font-semibold text-slate-800">Uploaded documents</h3>
          </div>
          <input type="file" multiple onChange={(e) => addDoc(e.target.files)} className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-[#009944] file:text-white hover:file:bg-[#007a36]" />
          {fileError && <p className="text-sm text-rose-600 mt-2"><AlertTriangle className="inline w-4 h-4" /> {fileError}</p>}
          {documents.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {documents.map((d, i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-slate-600">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" /> {d.label}
                  <button type="button" onClick={() => setDocuments(documents.filter((_, idx) => idx !== i))} className="text-rose-500 ml-auto"><Trash2 className="w-4 h-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          <p className="font-medium text-slate-800 mb-1">Declaration</p>
          <p>I hereby declare that the information provided in this onboarding form is true and complete to the best of my knowledge. I consent to the verification of guarantors, referees, and provided documents, and to the processing of the personal data herein for employment purposes.</p>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={declaration} onChange={(e) => setDeclaration(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[#009944]" />
          <span>I accept the declaration above.</span>
        </label>
        <div>
          <label className={labelCls}>Your signature (draw below)</label>
          <SignaturePad onChange={setSignature} />
        </div>
      </div>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, link, form, education, workHistory, documents, declaration, signature, fileError])

  if (status === 'loading') return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center"><LoadingState label="Opening your onboarding link..." /></div>
  )

  if (status === 'used') return (
    <Shell>
      <div className="text-center py-16">
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Already submitted</h2>
        <p className="text-sm text-slate-500 mt-2">This onboarding link has already been used. Contact your HR office if you believe this is a mistake.</p>
      </div>
    </Shell>
  )

  if (status === 'error') return (
    <Shell>
      <div className="text-center py-16">
        <XCircle className="w-12 h-12 text-rose-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Link unavailable</h2>
        <p className="text-sm text-slate-500 mt-2">{errorMsg}</p>
      </div>
    </Shell>
  )

  if (done) return (
    <Shell>
      <div className="text-center py-16">
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-900">Onboarding submitted</h2>
        <p className="text-sm text-slate-500 mt-2">
          {done.created ? 'Your recruitment profile has been created.' : 'Your existing profile has been updated.'} HR will review your information and contact you.
        </p>
        {done.warnings?.length > 0 && (
          <Notice><p>Some items need attention:</p><ul className="list-disc pl-4 mt-1">{done.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Notice>
        )}
      </div>
    </Shell>
  )

  return (
    <Shell>
      {link && (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p className="font-medium">{link.position ? `Position: ${link.position}` : 'Employee onboarding'}{link.department ? ` — ${link.department}` : ''}</p>
          <p className="text-emerald-700 mt-0.5">Complete all steps below. Fields in <span className="font-medium">*</span> are required.</p>
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-6 border-b border-slate-200">
        {STEPS.map((s) => (
          <button key={s.id} onClick={() => setStep(s.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${step === s.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
            {s.id}. {s.short}
          </button>
        ))}
      </div>
      <div className="min-h-[420px]">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">{STEPS.find((s) => s.id === step)?.title}</h2>
        {content}
      </div>
      {errorMsg && <div className="mt-4"><Notice>{errorMsg}</Notice></div>}
      <div className="mt-8 flex items-center justify-between">
        <button type="button" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 disabled:opacity-40 hover:bg-slate-50">
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        {step < STEPS.length ? (
          <button type="button" onClick={() => setStep(step + 1)} className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            Continue <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button type="button" onClick={doSubmit} disabled={submitting} className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {submitting ? 'Submitting...' : 'Submit Onboarding'}
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
              <div className="font-semibold">Employee Onboarding</div>
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