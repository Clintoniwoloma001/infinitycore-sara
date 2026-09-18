import React, { useEffect, useState } from 'react'
import { X, Loader2, CheckCircle2, Copy, Download, Printer, Plus, RefreshCcw, UserPlus } from 'lucide-react'
import { QRCodeCanvas } from 'qrcode.react'
import medicalScreeningService, {
  MEDICAL_SCREENING_TYPES,
  buildMedicalScreeningUrl,
} from '../../services/medicalScreeningService'
import { recruitmentService } from '../../services/recruitmentService'
import { employeeService } from '../../services/employeeService'
import { formatMedDate } from './medicalUi'
import MedicalCardPrint from './MedicalCardPrint'

const DEFAULT_MEDICAL_EXPIRY_DAYS = 90

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

// Generate + share a medical screening / hospital referral card for a
// candidate or employee. After generation the modal switches to a "card"
// view showing the branded card + QR code, with copy / print / PNG actions.
//
// When `allowPick` is true (no subject pre-supplied — e.g. opened from the
// Medical Screening Center) the HR user chooses the subject first: an
// existing candidate, an employee, or a manual entry. Fields auto-populate
// from the selection but stay editable.
export default function MedicalCardModal({ open, onClose, subjectType = 'candidate', subject = {}, photoUrl = null, onCreated, allowPick = false }) {
  const [form, setForm] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null) // { ...referral, url, rawToken }
  const [providers, setProviders] = useState([])
  const [copied, setCopied] = useState(false)

  // Local (mutable) subject so `allowPick` mode can change it in place.
  const [effSubjectType, setEffSubjectType] = useState(subjectType)
  const [effSubject, setEffSubject] = useState(subject)
  const [pickSource, setPickSource] = useState('candidate')
  const [pickId, setPickId] = useState('')
  const [candidates, setCandidates] = useState([])
  const [employees, setEmployees] = useState([])

  const subjectName = effSubject?.full_name || effSubject?.name || ''

  useEffect(() => {
    if (!open) return
    setResult(null)
    setError('')
    setCopied(false)
    setEffSubjectType(subjectType)
    setEffSubject(subject)
    setPickSource(subjectType === 'employee' ? 'employee' : 'candidate')
    setPickId('')
    setForm({
      screening_type: 'pre_employment',
      other_screening_type: '',
      hospital_id: '',
      hospital_name: '',
      expiry_date: new Date(Date.now() + DEFAULT_MEDICAL_EXPIRY_DAYS * 86400000).toISOString().slice(0, 10),
      notes: '',
      position: subject?.position || '',
      department: subject?.department || '',
      branch: subject?.branch || '',
    })
    medicalScreeningService.listHospitalProviders().then(setProviders).catch(() => setProviders([]))
    if (allowPick) {
      recruitmentService.listApplications({}).then((c) => setCandidates(c || [])).catch(() => setCandidates([]))
      employeeService.list().then((e) => setEmployees(e || [])).catch(() => setEmployees([]))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subject])

  const applyPick = (source, id) => {
    setPickSource(source)
    setPickId(id)
    if (source === 'candidate') {
      const c = candidates.find((x) => x.id === id)
      if (!c) return
      setEffSubjectType('candidate')
      setEffSubject({ id: c.id, full_name: c.full_name, position: c.applied_role || c.hr_jobs?.job_title || '', department: c.department || c.hr_jobs?.department || '', branch: c.branch || '' })
      setForm((f) => ({ ...f, position: c.applied_role || c.hr_jobs?.job_title || '', department: c.department || c.hr_jobs?.department || '', branch: c.branch || '' }))
    } else if (source === 'employee') {
      const e = employees.find((x) => x.id === id)
      if (!e) return
      setEffSubjectType('employee')
      setEffSubject({ id: e.id, full_name: e.full_name, position: e.position || '', department: e.department || '', branch: e.branch || '' })
      setForm((f) => ({ ...f, position: e.position || '', department: e.department || '', branch: e.branch || '' }))
    } else {
      setEffSubjectType('manual')
      setEffSubject({ id: null, full_name: '', position: form.position || '', department: form.department || '', branch: form.branch || '' })
    }
  }

  const create = async () => {
    if (!subjectName.trim()) { setError('Subject name is required. Select a candidate/employee or enter a name.'); return }
    setBusy(true)
    setError('')
    try {
      const provider = providers.find((p) => p.id === form.hospital_id)
      const res = await medicalScreeningService.createReferral({
        candidateId: effSubjectType === 'candidate' ? effSubject?.id : null,
        employeeId: effSubjectType === 'employee' ? effSubject?.id : null,
        subjectName: subjectName.trim(),
        subjectPosition: form.position || null,
        subjectDepartment: form.department || null,
        subjectBranch: form.branch || null,
        screeningType: form.screening_type,
        otherScreeningType: form.screening_type === 'other' ? form.other_screening_type : '',
        hospitalId: form.hospital_id || null,
        hospitalName: form.hospital_name || provider?.name || null,
        expiresAt: form.expiry_date || null,
        notes: form.notes || null,
        status: 'issued',
      })
      setResult(res)
      onCreated?.(res)
    } catch (e) {
      setError(e?.message || 'Failed to create the medical screening referral.')
    } finally {
      setBusy(false)
    }
  }

  const copyLink = async () => {
    if (!result?.url) return
    await copyText(result.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const downloadPNG = () => {
    const canvas = document.getElementById('medical-card-qr-canvas')
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `${result?.reference || 'medical-card'}-qr.png`
    a.click()
  }

  const printCard = () => {
    const printable = document.getElementById('medical-card-print-area')
    if (!printable) return
    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(`<!doctype html><html><head><title>${result?.reference || 'Medical Screening Card'}</title><style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; }
      @media print { body { padding: 0; } }
    </style></head><body>${printable.innerHTML}</body></html>`)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 350)
  }

  if (!open) return null

  const subjectLabel = effSubjectType === 'candidate'
    ? <><span className="text-slate-400">Candidate </span>{subjectName}</>
    : effSubjectType === 'employee'
      ? <><span className="text-slate-400">Employee </span>{subjectName}</>
      : <><span className="text-slate-400">Subject </span>{subjectName || '(manual entry)'}</>

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto p-6 shadow-xl">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-slate-900">
            {result ? 'Medical Screening Card' : 'Generate Medical Screening Card'}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-sm text-slate-500 mb-5">{result ? `Referral ${result.reference} issued successfully` : subjectLabel}</p>

        {error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">{error}</div>}

        {result ? (
          <>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 mb-4 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Referral <span className="font-semibold">{result.reference}</span> created.
                The QR code on the card opens a secure, single-submission portal for the hospital.
                It expires {formatMedDate(result.expires_at)}.
              </span>
            </div>

            {/* Hidden print source (QR renders via canvas so it survives Print) */}
            <div className="hidden">
              <div id="medical-card-print-area">
                <MedicalCardPrint referral={result} qrUrl={buildMedicalScreeningUrl(result.rawToken)} photoUrl={photoUrl} />
              </div>
              <QRCodeCanvas id="medical-card-qr-canvas" value={buildMedicalScreeningUrl(result.rawToken)} size={512} level="M" />
            </div>

            {/* Share options */}
            <div className="mb-5">
              <p className="text-sm font-medium text-slate-700 mb-2">Share this card</p>
              <div className="flex items-center gap-2 mb-4">
                <input readOnly value={result.url} className={inputCls} />
                <button onClick={copyLink} className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] whitespace-nowrap">
                  <Copy className="w-4 h-4" /> {copied ? 'Copied!' : 'Copy link'}
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <button onClick={printCard} className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-100">
                  <Printer className="w-4 h-4" /> Print Card
                </button>
                <button onClick={downloadPNG} className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-100">
                  <Download className="w-4 h-4" /> QR PNG
                </button>
                <button
                  onClick={() => setResult(null)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:col-span-1 col-span-2"
                >
                  <RefreshCcw className="w-4 h-4" /> New Referral
                </button>
              </div>
            </div>

            {/* Card preview */}
            <MedicalCardPrint referral={result} qrUrl={buildMedicalScreeningUrl(result.rawToken)} photoUrl={photoUrl} />
          </>
        ) : (
          <>
            {allowPick && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 mb-5">
                <p className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-1.5"><UserPlus className="w-4 h-4 text-[#009944]" /> Who is this screening for?</p>
                <p className="text-xs text-slate-400 mb-3">Choose an existing candidate or employee, or enter the details manually.</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {[['candidate', 'Candidate'], ['employee', 'Employee'], ['manual', 'Manual entry']].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => applyPick(key, '')}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${pickSource === key ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {pickSource !== 'manual' && (
                  <select className={inputCls} value={pickId || ''} onChange={(e) => applyPick(pickSource, e.target.value)}>
                    <option value="">Select {pickSource}…</option>
                    {pickSource === 'candidate'
                      ? candidates.map((c) => <option key={c.id} value={c.id}>{c.full_name} — {c.applied_role || c.hr_jobs?.job_title || ''}</option>)
                      : employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} — {e.position || ''} · {e.department || ''}</option>)}
                  </select>
                )}
              </div>
            )}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Full Name</label>
                  {pickSource === 'manual'
                    ? <input className={inputCls} value={effSubject?.full_name || ''} onChange={(e) => setEffSubject((s) => ({ ...s, full_name: e.target.value }))} placeholder="Candidate / employee full name" />
                    : <input className={inputCls} value={subjectName} readOnly />}
                </div>
                <div>
                  <label className={labelCls}>Screening Type</label>
                  <select className={inputCls} value={form.screening_type || ''} onChange={(e) => setForm((f) => ({ ...f, screening_type: e.target.value }))}>
                    {MEDICAL_SCREENING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>

              {form.screening_type === 'other' && (
                <div>
                  <label className={labelCls}>Specify Screening Type</label>
                  <input className={inputCls} value={form.other_screening_type || ''} onChange={(e) => setForm((f) => ({ ...f, other_screening_type: e.target.value }))} placeholder="Describe the screening type" />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Position</label>
                  <input className={inputCls} value={form.position || ''} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} placeholder="Job title / role" />
                </div>
                <div>
                  <label className={labelCls}>Department</label>
                  <input className={inputCls} value={form.department || ''} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} placeholder="Department" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Hospital / Provider</label>
                  <select className={inputCls} value={form.hospital_id || ''} onChange={(e) => setForm((f) => ({ ...f, hospital_id: e.target.value, hospital_name: providers.find((p) => p.id === e.target.value)?.name || f.hospital_name || '' }))}>
                    <option value="">Select a registered provider…</option>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.address ? ` — ${p.address}` : ''}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Or type a hospital name</label>
                  <input className={inputCls} value={form.hospital_name || ''} onChange={(e) => setForm((f) => ({ ...f, hospital_name: e.target.value }))} placeholder="e.g. General Hospital Lagos" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Valid Until</label>
                  <input type="date" className={inputCls} value={form.expiry_date || ''} onChange={(e) => setForm((f) => ({ ...f, expiry_date: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Branch</label>
                  <input className={inputCls} value={form.branch || ''} onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))} placeholder="Branch" />
                </div>
              </div>

              <div>
                <label className={labelCls}>Notes for the Medical Officer</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={form.notes || ''} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Specific instructions, e.g. employer's requirements or pre-existing conditions to investigate…" />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-5">
              <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={create} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Generate Card
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
