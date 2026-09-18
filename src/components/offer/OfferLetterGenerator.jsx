import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Download, FileText, Loader2, Plus, Printer, UserPlus, Users, X } from 'lucide-react'
import SignaturePad from '../SignaturePad'
import { employeeService } from '../../services/employeeService'
import { recruitmentService } from '../../services/recruitmentService'
import { payrollProfileService } from '../../services/payrollProfileService'
import { getOfferEnvironment, offerPayloadFromForm, offerService } from '../../services/offerService'
import { employmentLetterService } from '../../services/employmentLetterService'
import { renderOfferLetterHtml } from '../../lib/offerLetterDocument'
import { downloadBlob, offerLetterHtmlToPdf, openOfferPreview } from '../../lib/offerLetterPdf'
import { computeRemuneration, emptyRemuneration, remunerationFromLegacy, remunerationFromPayroll, PAY_COMPONENTS, COA_COMPONENTS, BENEFIT_COMPONENTS, SOCIAL_COMPONENTS } from '../../lib/remuneration'
import { defaultSalaryConfig } from '../../config/offerLetterDefaults'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-white'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'
const SOURCES = [
  { value: 'candidate', label: 'Candidate' },
  { value: 'employee', label: 'From employee list' },
  { value: 'manual', label: 'Manual entry' },
]

function blankRemuneration() {
  return emptyRemuneration(defaultSalaryConfig(0))
}

function blankForm(environment = null, template = null) {
  const salary = template?.salary_config && Object.keys(template.salary_config).length
    ? emptyRemuneration(template.salary_config)
    : blankRemuneration()
  const today = new Date().toISOString().slice(0, 10)
  const validity = Number(template?.validity_days || 7)
  const deadline = new Date(`${today}T00:00:00`)
  deadline.setDate(deadline.getDate() + validity)
  return {
    candidateName: '', email: '', phone: '', candidate_address: '', area: '', work_id: '', employment_status: '',
    position: '', department: '', branch: '', company: environment?.companyInfo?.name || 'Infinity Microfinance Bank Ltd',
    employment_type: 'full_time', offer_date: today, start_date: '', probation_months: 3,
    reporting_manager: '', working_hours: '', leave_entitlement: environment?.workHours?.leave_annual_days ? `${environment.workHours.leave_annual_days} working days` : '',
    benefits: '', conditions: '', other_terms: '', acceptance_deadline: deadline.toISOString().slice(0, 10),
    template_id: template?.id || '', remuneration: salary,
  }
}

function formFromOffer(offer, person, template, environment) {
  const snapshot = offer?.salary_structure?.document || {}
  const rem = offer?.remuneration && Object.keys(offer.remuneration).length
    ? offer.remuneration
    : remunerationFromLegacy(offer)
  return {
    ...blankForm(environment, template),
    candidateName: person?.full_name || offer?.candidate_name || '',
    email: person?.email || snapshot.email || offer?.email || '',
    phone: person?.phone || snapshot.phone || offer?.phone || '',
    candidate_address: offer?.candidate_address || snapshot.candidate_address || person?.address || person?.residential_address || '',
    area: snapshot.area || offer?.area || '',
    work_id: snapshot.work_id || offer?.work_id || offer?.employee_code || '',
    employment_status: snapshot.employment_status || offer?.employment_status || '',
    position: offer?.position || '', department: offer?.department || '', branch: offer?.branch || '',
    company: offer?.company_name || environment?.companyInfo?.name || 'Infinity Microfinance Bank Ltd',
    employment_type: offer?.employment_type || 'full_time',
    offer_date: snapshot.offer_date || offer?.offer_date || offer?.issue_date || offer?.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    start_date: offer?.start_date || '', probation_months: offer?.probation_months ?? 3,
    reporting_manager: offer?.reporting_manager || '', working_hours: offer?.working_hours || '',
    leave_entitlement: offer?.leave_entitlement || '', benefits: offer?.benefits || '',
    conditions: offer?.conditions || '', other_terms: offer?.other_terms || '',
    acceptance_deadline: offer?.acceptance_deadline || '', template_id: offer?.template_id || template?.id || '',
    remuneration: rem,
  }
}

function personForRender(source, employee, candidate, form) {
  if (source === 'employee') return employee || { full_name: form.candidateName, email: form.email, phone: form.phone, address: form.candidate_address }
  if (source === 'candidate') return candidate || { full_name: form.candidateName, email: form.email, phone: form.phone, address: form.candidate_address }
  return { full_name: form.candidateName, email: form.email, phone: form.phone, address: form.candidate_address }
}

export function buildOfferLetterHtml(args) {
  return renderOfferLetterHtml(args)
}

export default function OfferLetterGenerator({ open, onClose, onSaved, initialOffer = null }) {
  const [source, setSource] = useState(initialOffer?.candidate_id ? 'candidate' : 'candidate')
  const [pickId, setPickId] = useState(initialOffer?.candidate_id || '')
  const [candidates, setCandidates] = useState([])
  const [employees, setEmployees] = useState([])
  const [templates, setTemplates] = useState([])
  const [environment, setEnvironment] = useState(null)
  const [form, setForm] = useState(blankForm())
  const [signature, setSignature] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)
  const [previewHtml, setPreviewHtml] = useState('')

  const template = useMemo(() => templates.find((item) => item.id === form.template_id) || templates.find((item) => item.is_default && !item.archived) || templates[0] || null, [templates, form.template_id])
  const chosenCandidate = useMemo(() => candidates.find((item) => item.id === pickId) || null, [candidates, pickId])
  const chosenEmployee = useMemo(() => employees.find((item) => item.id === pickId) || null, [employees, pickId])
  const calculated = useMemo(() => computeRemuneration(form.remuneration || {}), [form.remuneration])

  useEffect(() => {
    if (!open) return
    let active = true
    setBusy('load')
    setError('')
    setDone(null)
    setPreviewHtml('')
    Promise.all([
      recruitmentService.listApplications({}).catch(() => []),
      employeeService.list().catch(() => []),
      offerService.listActiveTemplates().catch(() => []),
      getOfferEnvironment(initialOffer?.branch || '').catch(() => null),
    ]).then(([candidateRows, employeeRows, templateRows, env]) => {
      if (!active) return
      const selectedTemplate = templateRows.find((item) => item.id === initialOffer?.template_id)
        || templateRows.find((item) => item.is_default && !item.archived)
        || templateRows[0]
        || null
      const person = candidateRows.find((item) => item.id === initialOffer?.candidate_id) || employeeRows.find((item) => item.id === initialOffer?.employee_id) || null
      setCandidates(candidateRows || [])
      setEmployees(employeeRows || [])
      setTemplates(templateRows || [])
      setEnvironment(env)
      setSource(initialOffer?.employee_id && !initialOffer?.candidate_id ? 'employee' : 'candidate')
      setPickId(initialOffer?.candidate_id || initialOffer?.employee_id || '')
      setForm(initialOffer ? formFromOffer(initialOffer, person, selectedTemplate, env) : blankForm(env, selectedTemplate))
      setSignature(selectedTemplate?.signatories?.signature_data || null)
    }).catch((e) => setError(e?.message || 'Offer data could not be loaded.')).finally(() => active && setBusy(''))
    return () => { active = false }
  }, [open, initialOffer])

  const setField = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const setRemField = (group, key) => (event) => setForm((current) => ({ ...current, remuneration: { ...(current.remuneration || {}), [group]: { ...(current.remuneration?.[group] || {}), [key]: event.target.value } } }))
  const setRemRootField = (key) => (event) => setForm((current) => ({ ...current, remuneration: { ...(current.remuneration || {}), [key]: event.target.value } }))
  const setSalaryField = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value, remuneration: { ...(current.remuneration || {}), [key]: event.target.value } }))

  const changeSource = (value) => {
    setSource(value)
    setPickId('')
    setForm(blankForm(environment, template))
    setSignature(template?.signatories?.signature_data || null)
    setError('')
  }

  const applyPick = async (id) => {
    setPickId(id)
    if (!id) return
    if (source === 'candidate') {
      const candidate = candidates.find((item) => item.id === id)
      if (!candidate) return
      setForm((current) => ({
        ...current,
        candidateName: candidate.full_name || '', email: candidate.email || '', phone: candidate.phone || '',
        candidate_address: candidate.address || candidate.residential_address || '',
        position: candidate.applied_role || candidate.hr_jobs?.job_title || current.position,
        department: candidate.department || candidate.hr_jobs?.department || current.department,
        branch: candidate.branch || current.branch,
        employment_type: candidate.hr_jobs?.employment_type || current.employment_type,
        start_date: current.start_date || new Date().toISOString().slice(0, 10),
      }))
      return
    }
    if (source === 'employee') {
      const employee = employees.find((item) => item.id === id)
      if (!employee) return
      const packages = await payrollProfileService.listPackages(id).catch(() => [])
      const payrollRemuneration = remunerationFromPayroll(employee, packages)
      setForm((current) => ({
        ...current,
        candidateName: employee.full_name || '', email: employee.email || '', phone: employee.phone || '',
        candidate_address: employee.residential_address || employee.address || '',
        work_id: employee.employee_code || employee.employee_number || employee.staff_id || '',
        employment_status: employee.employment_status || '',
        position: employee.position || current.position, department: employee.department || current.department,
        branch: employee.branch || employee.branch_name || current.branch, employment_type: employee.employment_type || current.employment_type,
        start_date: employee.hire_date || employee.start_date || current.start_date,
        monthly_salary: employee.salary || '', annual_salary: payrollRemuneration.annual_salary || '',
        remuneration: payrollRemuneration,
      }))
    }
  }

  const updateTemplate = (templateId) => {
    const selected = templates.find((item) => item.id === templateId)
    setForm((current) => ({ ...current, template_id: templateId, company: selected?.company_info?.name || current.company, remuneration: selected?.salary_config && !current.remuneration?.pay?.basic ? emptyRemuneration(selected.salary_config) : current.remuneration }))
    setSignature(selected?.signatories?.signature_data || null)
  }

  const addCustomComponent = () => setForm((current) => ({ ...current, remuneration: { ...(current.remuneration || {}), custom: [...(current.remuneration?.custom || []), { id: `custom-${Date.now()}`, label: 'Other allowance', group: 'pay', amount: '', basis: 'annual', cashable: true, include_in_guaranteed: true, include_in_cost: true }] } }))
  const updateCustomComponent = (index, key, value) => setForm((current) => ({ ...current, remuneration: { ...(current.remuneration || {}), custom: (current.remuneration?.custom || []).map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item) } }))
  const removeCustomComponent = (index) => setForm((current) => ({ ...current, remuneration: { ...(current.remuneration || {}), custom: (current.remuneration?.custom || []).filter((_, itemIndex) => itemIndex !== index) } }))

  const buildDocument = (offerOverride = null) => {
    const payload = offerPayloadFromForm(template, {
      ...form,
      candidate_name: form.candidateName,
      company_name: form.company,
      signature_data: signature,
      company_info: template?.company_info || environment?.companyInfo,
      signatories: { ...(template?.signatories || {}), ...(signature ? { signature_data: signature } : {}) },
    }, environment)
    const offer = {
      ...payload,
      ...(offerOverride || {}),
      candidate_name: form.candidateName,
      company_name: form.company,
      offer_date: form.offer_date,
      candidate_address: form.candidate_address,
      email: form.email,
      phone: form.phone,
      area: form.area,
      employment_status: form.employment_status,
      remuneration: payload.remuneration,
      salary_structure: payload.salary_structure,
      offer_number: offerOverride?.offer_number || 'PREVIEW',
    }
    return {
      offer,
      html: renderOfferLetterHtml({
        offer,
        candidate: personForRender(source, chosenEmployee, chosenCandidate, form),
        template,
        workHours: environment?.workHours,
        currency: environment?.currency,
        signatureData: signature,
        dateFormat: template?.date_format,
      }),
    }
  }

  const validate = () => {
    if (source !== 'manual' && !pickId) return `Select a ${source}.`
    if (!form.candidateName.trim()) return 'Enter the candidate name or choose a recipient.'
    if (!form.position.trim()) return 'Set the position / job title.'
    if (calculated.totals.annual_gross <= 0) return 'Enter a salary or at least one remuneration component.'
    return ''
  }

  const preview = () => {
    const validation = validate()
    if (validation) { setError(validation); return }
    setError('')
    setPreviewHtml(buildDocument().html)
  }

  const download = async (html, reference) => {
    setBusy('pdf')
    try {
      const blob = await offerLetterHtmlToPdf(html, `${reference || 'offer-letter'}.pdf`)
      downloadBlob(blob, `${reference || 'offer-letter'}.pdf`)
      return blob
    } catch (e) {
      setError(e?.message || 'The offer PDF could not be generated.')
      throw e
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    const validation = validate()
    if (validation) { setError(validation); return }
    setError('')
    setBusy('save')
    try {
      const { offer: draftOffer } = buildDocument()
      let savedOffer = null
      let offerId = null
      let token = null
      let version = 1

      if (source === 'candidate') {
        const payload = offerPayloadFromForm(template, {
          ...form, candidate_name: form.candidateName, company_name: form.company,
          signatories: { ...(template?.signatories || {}), ...(signature ? { signature_data: signature } : {}) },
        }, environment)
        const result = initialOffer
          ? await offerService.modifyOffer(initialOffer.id, payload)
          : await offerService.createOffer(chosenCandidate.id, chosenCandidate.job_id || null, payload)
        offerId = result?.offer_id || initialOffer?.id
        token = result?.token || null
        if (!offerId) throw new Error('The database did not return an offer reference.')
        savedOffer = await offerService.getOffer(offerId)
        if (!savedOffer) throw new Error('The generated offer could not be reloaded.')
        version = savedOffer.version || result?.new_version || 1
        const rendered = renderOfferLetterHtml({ offer: savedOffer, candidate: chosenCandidate, template, workHours: environment?.workHours, currency: environment?.currency, signatureData: signature, dateFormat: template?.date_format })
        await offerService.updateDraftDocument(offerId, rendered)
        savedOffer = { ...savedOffer, body_content: rendered }
        const pdf = await offerLetterHtmlToPdf(rendered, `${savedOffer.offer_number}-v${version}.pdf`)
        const document = await offerService.attachOfferPdf(offerId, pdf, `${savedOffer.offer_number}-v${version}.pdf`)
        savedOffer = { ...savedOffer, document_id: document?.id || null, digital_file_name: document?.file_name || null }
        if (token) {
          try {
            const previous = JSON.parse(localStorage.getItem('offer-tokens') || '{}')
            localStorage.setItem('offer-tokens', JSON.stringify({ ...previous, [offerId]: token }))
          } catch { /* local link cache is best effort */ }
        }
        onSaved?.({ offer: savedOffer, offerId, token })
        setDone({ offer: savedOffer, html: rendered, version, pdf, saved: 'candidate' })
      } else if (source === 'employee') {
        const reference = await offerService.allocateOfferReference(template?.reference_prefix || 'OFR').catch(() => `OFR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-EMP`)
        const { offer: offerForDocument, html } = buildDocument({ offer_number: reference })
        const pdf = await offerLetterHtmlToPdf(html, `${offerForDocument.offer_number}.pdf`)
        const pdfFile = new File([pdf], `${offerForDocument.offer_number}.pdf`, { type: 'application/pdf' })
        const letter = await employmentLetterService.issueOfferLetter(chosenEmployee, { ...offerForDocument, body_content: html }, { html, pdfFile, fileName: pdfFile.name, hrName: template?.signatories?.hr_name || 'Human Resources' })
        onSaved?.({ employeeLetter: letter })
        setDone({ offer: offerForDocument, html, version: letter.version, pdf, saved: 'employee' })
      } else {
        const { offer: offerForDocument, html } = buildDocument()
        const pdf = await offerLetterHtmlToPdf(html, 'offer-letter-preview.pdf')
        onSaved?.({ manual: true })
        setDone({ offer: offerForDocument, html, version: 1, pdf, saved: 'manual' })
      }
    } catch (e) {
      setError(e?.message || 'Could not generate and save the offer letter.')
    } finally {
      setBusy('')
    }
  }

  if (!open) return null
  if (busy === 'load') return <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"><div className="bg-white rounded-xl px-6 py-5 text-sm text-slate-600 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-[#009944]" /> Loading offer settings...</div></div>

  const componentGroups = [
    { key: 'pay', title: 'Base pay and allowances', components: PAY_COMPONENTS },
    { key: 'coa', title: 'COA / other allowances', components: COA_COMPONENTS },
    { key: 'benefit', title: 'Other benefits', components: BENEFIT_COMPONENTS },
    { key: 'social', title: 'Social costs - not cashable', components: SOCIAL_COMPONENTS },
  ]

  return <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
    <div className="bg-white rounded-xl w-full max-w-5xl max-h-[94vh] overflow-y-auto shadow-xl">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div><h3 className="text-lg font-semibold text-slate-900">{initialOffer ? `Generate new offer version - ${initialOffer.offer_number || ''}` : 'Generate Offer Letter'}</h3><p className="text-sm text-slate-500 mt-1">A4 bank letterhead, structured terms, payroll-linked remuneration, and a saved PDF artifact.</p></div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
      </div>

      {error && <div className="mx-6 mt-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">{error}</div>}

      {done ? <div className="p-6">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5" /><span>Offer letter <strong>{done.offer?.offer_number || ''}</strong>, version {done.version}, was generated as a professional PDF. {done.saved === 'candidate' ? 'The PDF is attached to the candidate offer record.' : done.saved === 'employee' ? 'The PDF is attached to the employee digital file.' : 'This manual letter is available for download.'}</span></div>
        <div className="mt-5 h-[58vh] border border-slate-200 bg-slate-100"><iframe title="Offer letter preview" srcDoc={done.html} className="w-full h-full bg-white" sandbox="allow-same-origin" /></div>
        <div className="flex flex-wrap justify-end gap-2 mt-4"><button onClick={() => openOfferPreview(done.html, { title: done.offer?.offer_number || 'Offer letter' })} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"><FileText className="w-4 h-4" /> Open preview</button><button onClick={() => downloadBlob(done.pdf, `${done.offer?.offer_number || 'offer-letter'}-v${done.version}.pdf`)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]"><Download className="w-4 h-4" /> Download PDF</button><button onClick={() => setDone(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Configure again</button></div>
      </div> : <div className="p-6 space-y-6">
        <section className="border border-slate-200 rounded-lg p-4"><p className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1.5"><Users className="w-4 h-4 text-[#009944]" /> Recipient</p><div className="flex flex-wrap gap-2 mb-3">{SOURCES.map((item) => <button key={item.value} type="button" onClick={() => changeSource(item.value)} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium ${source === item.value ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>{item.value === 'candidate' && <UserPlus className="w-3.5 h-3.5" />}{item.label}</button>)}</div>{source !== 'manual' && <select className={inputCls} value={pickId} onChange={(e) => applyPick(e.target.value)}><option value="">Select {source}...</option>{source === 'candidate' ? candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.full_name} - {candidate.applied_role || candidate.hr_jobs?.job_title || ''}</option>) : employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.full_name} - {employee.position || ''}</option>)}</select>}</section>

        <section><div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><Field label="Template"><select className={inputCls} value={form.template_id} onChange={(e) => updateTemplate(e.target.value)}><option value="">Select template...</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}{item.is_default ? ' (default)' : ''}</option>)}</select></Field><Field label="Offer date"><input type="date" className={inputCls} value={form.offer_date || ''} onChange={setField('offer_date')} /></Field><Field label="Acceptance deadline"><input type="date" className={inputCls} value={form.acceptance_deadline || ''} onChange={setField('acceptance_deadline')} /></Field></div></section>

        <section><h4 className="text-sm font-semibold text-slate-900 border-b border-slate-200 pb-2 mb-3">Candidate and employment details</h4><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"><Field label="Full name *"><input className={inputCls} value={form.candidateName} onChange={setField('candidateName')} /></Field><Field label="Email"><input className={inputCls} value={form.email} onChange={setField('email')} /></Field><Field label="Phone"><input className={inputCls} value={form.phone} onChange={setField('phone')} /></Field><Field label="Address"><textarea rows="2" className={`${inputCls} h-auto py-2`} value={form.candidate_address} onChange={setField('candidate_address')} /></Field><Field label="Area / location"><input className={inputCls} value={form.area} onChange={setField('area')} /></Field><Field label="Employee / Work ID"><input className={inputCls} value={form.work_id} onChange={setField('work_id')} /></Field><Field label="Position *"><input className={inputCls} value={form.position} onChange={setField('position')} /></Field><Field label="Department"><input className={inputCls} value={form.department} onChange={setField('department')} /></Field><Field label="Branch"><input className={inputCls} value={form.branch} onChange={setField('branch')} /></Field><Field label="Company"><input className={inputCls} value={form.company} onChange={setField('company')} /></Field><Field label="Employment type"><select className={inputCls} value={form.employment_type} onChange={setField('employment_type')}>{['full_time', 'part_time', 'contract', 'intern'].map((type) => <option key={type} value={type}>{type.replace('_', ' ')}</option>)}</select></Field><Field label="Employment status"><input className={inputCls} value={form.employment_status} onChange={setField('employment_status')} placeholder="e.g. Proposed" /></Field><Field label="Start date"><input type="date" className={inputCls} value={form.start_date || ''} onChange={setField('start_date')} /></Field><Field label="Probation (months)"><input type="number" min="0" className={inputCls} value={form.probation_months} onChange={setField('probation_months')} /></Field><Field label="Reporting manager"><input className={inputCls} value={form.reporting_manager} onChange={setField('reporting_manager')} /></Field><Field label="Leave entitlement"><input className={inputCls} value={form.leave_entitlement} onChange={setField('leave_entitlement')} /></Field></div></section>

        <section><div className="flex items-center justify-between border-b border-slate-200 pb-2 mb-3"><div><h4 className="text-sm font-semibold text-slate-900">Remuneration schedule</h4><p className="text-xs text-slate-500 mt-1">Fixed payroll components are entered per annum. Employee packages are annualised from monthly payroll values.</p></div><div className="text-right"><p className="text-xs text-slate-400">Calculated gross</p><p className="text-sm font-semibold text-[#005f2b]">{formatMoney(calculated.totals.annual_gross)} / yr</p><p className="text-xs text-slate-500">{formatMoney(calculated.totals.monthly_gross)} / month</p></div></div><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4"><Field label="Annual gross (fallback)"><input type="number" className={inputCls} value={form.annual_salary || ''} onChange={setSalaryField('annual_salary')} /></Field><Field label="Monthly gross (fallback)"><input type="number" className={inputCls} value={form.monthly_salary || ''} onChange={setSalaryField('monthly_salary')} /></Field><Field label="Mid-month amount"><input type="number" className={inputCls} value={form.remuneration?.mid_month_salary || ''} onChange={setRemRootField('mid_month_salary')} /></Field><Field label="Month-end amount"><input type="number" className={inputCls} value={form.remuneration?.end_month_salary || ''} onChange={setRemRootField('end_month_salary')} /></Field></div><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{componentGroups.map((group) => <div key={group.key} className="border border-slate-200 rounded-lg p-3"><p className="text-xs font-semibold uppercase tracking-wide text-[#005f2b] mb-2">{group.title}</p><div className="space-y-2">{group.components.map((component) => <div key={component.key} className="grid grid-cols-[1fr_130px] items-center gap-2"><label className="text-xs text-slate-600">{component.label}<span className="block text-[10px] text-slate-400">per annum</span></label><input type="number" min="0" className={inputCls} value={form.remuneration?.[group.key]?.[component.key] || ''} onChange={setRemField(group.key, component.key)} /></div>)}</div></div>)}</div><div className="mt-4"><div className="flex items-center justify-between mb-2"><p className="text-xs font-semibold text-slate-700">Custom benefits and employer contributions</p><button onClick={addCustomComponent} className="inline-flex items-center gap-1 text-xs text-[#009944] hover:underline"><Plus className="w-3.5 h-3.5" /> Add component</button></div><div className="space-y-2">{(form.remuneration?.custom || []).map((item, index) => <div key={item.id || index} className="grid grid-cols-1 sm:grid-cols-[1.5fr_1fr_110px_110px_auto] gap-2 items-end border border-slate-100 p-2 rounded-lg"><Field label="Name"><input className={inputCls} value={item.label || ''} onChange={(e) => updateCustomComponent(index, 'label', e.target.value)} /></Field><Field label="Category"><select className={inputCls} value={item.group || 'pay'} onChange={(e) => updateCustomComponent(index, 'group', e.target.value)}><option value="pay">Pay</option><option value="coa">COA</option><option value="benefit">Benefit</option><option value="social">Social cost</option></select></Field><Field label="Basis"><select className={inputCls} value={item.basis || 'annual'} onChange={(e) => updateCustomComponent(index, 'basis', e.target.value)}><option value="annual">Annual</option><option value="monthly">Monthly</option><option value="percentage">Percent</option></select></Field><Field label={item.basis === 'percentage' ? 'Rate %' : 'Amount'}><input type="number" className={inputCls} value={item.basis === 'percentage' ? (item.rate || '') : (item.amount || '')} onChange={(e) => updateCustomComponent(index, item.basis === 'percentage' ? 'rate' : 'amount', e.target.value)} /></Field><button onClick={() => removeCustomComponent(index)} className="h-10 px-2 text-slate-300 hover:text-rose-600" title="Remove"><X className="w-4 h-4" /></button></div>)}</div></div></section>

        <section className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Field label="Benefits / narrative"><textarea rows="3" className={`${inputCls} h-auto py-2`} value={form.benefits} onChange={setField('benefits')} placeholder="HMO, leave allowance, annual bonus..." /></Field><Field label="Conditions / other terms"><textarea rows="3" className={`${inputCls} h-auto py-2`} value={form.conditions} onChange={setField('conditions')} /></Field></section>

        <section className="border border-slate-200 rounded-lg p-4"><p className="text-sm font-semibold text-slate-700 mb-1">Signing officer</p><p className="text-xs text-slate-400 mb-3">The saved template signature is used by default; this session can capture a new HR signature.</p>{signature ? <div><img src={signature} alt="HR signature" className="max-h-20 border border-slate-200 bg-white" /><button onClick={() => setSignature(null)} className="text-xs text-[#009944] mt-2 hover:underline">Re-sign</button></div> : <SignaturePad onChange={setSignature} height={110} />}</section>

        <div className="flex flex-wrap justify-end gap-2 pt-2"><button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button><button onClick={preview} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50"><Printer className="w-4 h-4" /> Preview</button><button onClick={save} disabled={busy === 'save' || busy === 'pdf'} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">{busy === 'save' || busy === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Generate and save PDF</button></div>
      </div>}

      {previewHtml && <div className="fixed inset-0 z-[70] bg-slate-950/70 p-4 flex items-center justify-center"><div className="bg-white w-full max-w-5xl h-[94vh] rounded-xl shadow-2xl flex flex-col"><div className="flex items-center justify-between px-4 py-3 border-b border-slate-200"><p className="text-sm font-semibold text-slate-900">Offer letter preview</p><div className="flex items-center gap-2"><button onClick={() => openOfferPreview(previewHtml, { print: true })} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs text-slate-700"><Printer className="w-3.5 h-3.5" /> Print</button><button onClick={() => download(previewHtml, 'offer-letter-preview')} disabled={busy === 'pdf'} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#009944] text-white text-xs"><Download className="w-3.5 h-3.5" /> Download PDF</button><button onClick={() => setPreviewHtml('')} className="p-1 text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button></div></div><iframe title="Offer letter preview" srcDoc={previewHtml} className="flex-1 w-full bg-slate-100" sandbox="allow-same-origin" /></div></div>}
    </div>
  </div>
}

function Field({ label, children }) { return <div><label className={labelCls}>{label}</label>{children}</div> }

function formatMoney(value) {
  return `₦${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
