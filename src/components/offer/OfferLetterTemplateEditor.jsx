import React, { useEffect, useState } from 'react'
import { GripVertical, Loader2, Plus, Save, Trash2, X } from 'lucide-react'
import SignaturePad from '../SignaturePad'
import { defaultSalaryConfig, defaultTemplate } from '../../config/offerLetterDefaults'
import { offerService } from '../../services/offerService'

const inputCls = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-xs font-medium text-slate-600 mb-1'

function cloneTemplate(template) {
  const base = template || defaultTemplate()
  return {
    ...base,
    company_info: { ...(base.company_info || {}) },
    signatories: { ...(base.signatories || {}) },
    sections: Array.isArray(base.sections) ? base.sections.map((section) => ({ ...section })) : [],
    salary_config: base.salary_config || defaultSalaryConfig(),
  }
}

export default function OfferLetterTemplateEditor({ open, template = null, onClose, onSaved, onPreview }) {
  const [form, setForm] = useState(() => cloneTemplate(template))
  const [salaryText, setSalaryText] = useState(() => JSON.stringify(template?.salary_config || defaultSalaryConfig(), null, 2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const next = cloneTemplate(template)
    setForm(next)
    setSalaryText(JSON.stringify(next.salary_config || defaultSalaryConfig(), null, 2))
    setError('')
  }, [open, template])

  if (!open) return null

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))
  const updateNested = (group, key, value) => setForm((current) => ({ ...current, [group]: { ...(current[group] || {}), [key]: value } }))
  const updateSection = (index, key, value) => setForm((current) => ({
    ...current,
    sections: current.sections.map((section, sectionIndex) => sectionIndex === index ? { ...section, [key]: value } : section),
  }))
  const removeSection = (index) => setForm((current) => ({ ...current, sections: current.sections.filter((_, sectionIndex) => sectionIndex !== index) }))
  const addSection = () => setForm((current) => ({
    ...current,
    sections: [...current.sections, { number: `${current.sections.length + 1}.0`, title: 'NEW SECTION', body: '' }],
  }))

  const save = async () => {
    setError('')
    let salaryConfig
    try { salaryConfig = JSON.parse(salaryText || '{}') } catch { setError('Salary configuration must be valid JSON.'); return }
    if (!form.name.trim()) { setError('Template name is required.'); return }
    setBusy(true)
    try {
      const saved = await offerService.saveTemplate({ ...form, salary_config: salaryConfig })
      onSaved?.(saved)
    } catch (e) {
      setError(e?.message || 'Template could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const preview = () => {
    try {
      onPreview?.({ ...form, salary_config: JSON.parse(salaryText || '{}') })
    } catch {
      setError('Salary configuration must be valid JSON before previewing.')
    }
  }

  return <div className="fixed inset-0 z-[60] bg-slate-950/50 p-4 flex items-center justify-center">
    <div className="bg-white w-full max-w-5xl max-h-[94vh] overflow-y-auto rounded-xl shadow-2xl">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{form.id ? 'Edit offer-letter template' : 'Create offer-letter template'}</h2>
          <p className="text-xs text-slate-500 mt-1">Configure the letterhead, wording, remuneration defaults, and signature block used by HR.</p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
      </div>

      {error && <div className="mx-6 mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      <div className="p-6 space-y-6">
        <section>
          <SectionHeading title="Template identity" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Template name"><input className={inputCls} value={form.name || ''} onChange={(e) => update('name', e.target.value)} placeholder="Standard Staff Offer" /></Field>
            <Field label="Template type"><select className={inputCls} value={form.template_type || 'standard'} onChange={(e) => update('template_type', e.target.value)}><option value="standard">Standard Staff</option><option value="executive">Management</option><option value="contract">Contract Staff</option><option value="intern">Graduate Trainee</option></select></Field>
            <Field label="Reference prefix"><input className={inputCls} value={form.reference_prefix || 'OFR'} onChange={(e) => update('reference_prefix', e.target.value.toUpperCase())} /></Field>
            <Field label="Offer validity (days)"><input type="number" min="1" className={inputCls} value={form.validity_days ?? 7} onChange={(e) => update('validity_days', e.target.value)} /></Field>
            <Field label="Date format"><select className={inputCls} value={form.date_format || 'en-GB'} onChange={(e) => update('date_format', e.target.value)}><option value="en-GB">DD Month YYYY</option><option value="en-US">Month DD, YYYY</option></select></Field>
            <Field label="Email subject"><input className={inputCls} value={form.subject || ''} onChange={(e) => update('subject', e.target.value)} placeholder="Offer of Employment - {{company_name}}" /></Field>
          </div>
        </section>

        <section>
          <SectionHeading title="Company information" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Company name"><input className={inputCls} value={form.company_info?.name || ''} onChange={(e) => updateNested('company_info', 'name', e.target.value)} /></Field>
            <Field label="Short name"><input className={inputCls} value={form.company_info?.short_name || ''} onChange={(e) => updateNested('company_info', 'short_name', e.target.value)} /></Field>
            <Field label="Registered / office address"><textarea rows="2" className={inputCls} value={form.company_info?.address || ''} onChange={(e) => updateNested('company_info', 'address', e.target.value)} /></Field>
            <Field label="RC number"><input className={inputCls} value={form.company_info?.rc_number || ''} onChange={(e) => updateNested('company_info', 'rc_number', e.target.value)} /></Field>
            <Field label="HR email"><input type="email" className={inputCls} value={form.company_info?.email || ''} onChange={(e) => updateNested('company_info', 'email', e.target.value)} /></Field>
            <Field label="Phone / website"><input className={inputCls} value={form.company_info?.phone || ''} onChange={(e) => updateNested('company_info', 'phone', e.target.value)} placeholder="Phone" /><input className={`${inputCls} mt-2`} value={form.company_info?.website || ''} onChange={(e) => updateNested('company_info', 'website', e.target.value)} placeholder="Website" /></Field>
            <Field label="Letterhead tagline"><input className={inputCls} value={form.company_info?.tagline || ''} onChange={(e) => updateNested('company_info', 'tagline', e.target.value)} /></Field>
            <Field label="Footer confidentiality notice"><textarea rows="2" className={inputCls} value={form.company_info?.confidentiality_notice || ''} onChange={(e) => updateNested('company_info', 'confidentiality_notice', e.target.value)} /></Field>
          </div>
          <p className="text-xs text-slate-400 mt-2">The existing InfinityCore Infinity MFB logo is used automatically. Company details remain blank until HR supplies approved values.</p>
        </section>

        <section>
          <SectionHeading title="Letter wording" />
          <Field label="Opening paragraph"><textarea rows="4" className={inputCls} value={form.opening || ''} onChange={(e) => update('opening', e.target.value)} placeholder="Use placeholders such as {{candidate_name}}, {{position}}, and {{start_date}}." /></Field>
          <div className="mt-3"><Field label="Legacy body fallback (optional)"><textarea rows="3" className={`${inputCls} font-mono text-xs`} value={form.body || ''} onChange={(e) => update('body', e.target.value)} placeholder="Used only by older records that do not have structured sections." /></Field></div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-2"><SectionHeading title="Numbered document sections" /><button onClick={addSection} className="inline-flex items-center gap-1 text-xs font-medium text-[#009944] hover:underline"><Plus className="w-3.5 h-3.5" /> Add section</button></div>
          <div className="space-y-3">
            {form.sections.map((section, index) => <div key={`${section.number}-${index}`} className="border border-slate-200 rounded-lg p-3">
              <div className="flex items-start gap-2"><GripVertical className="w-4 h-4 text-slate-300 mt-2" /><div className="grid grid-cols-[70px_1fr_auto] gap-2 flex-1"><input className={inputCls} value={section.number || ''} onChange={(e) => updateSection(index, 'number', e.target.value)} /><input className={inputCls} value={section.title || ''} onChange={(e) => updateSection(index, 'title', e.target.value)} /><button onClick={() => removeSection(index)} className="p-2 text-slate-300 hover:text-rose-600" title="Remove section"><Trash2 className="w-4 h-4" /></button></div></div>
              <textarea rows="3" className={`${inputCls} mt-2 ml-6 w-[calc(100%-1.5rem)]`} value={section.body || ''} onChange={(e) => updateSection(index, 'body', e.target.value)} placeholder="Editable HR-approved wording. Use {{placeholders}} for offer values." />
            </div>)}
          </div>
        </section>

        <section>
          <SectionHeading title="Remuneration defaults" />
          <p className="text-xs text-slate-500 mb-2">Use annual amounts for the schedule. Payroll employee packages are monthly and are annualised by the shared calculation utility.</p>
          <textarea rows="11" className={`${inputCls} font-mono text-xs`} value={salaryText} onChange={(e) => setSalaryText(e.target.value)} />
        </section>

        <section>
          <SectionHeading title="Signature settings" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="HR signatory name"><input className={inputCls} value={form.signatories?.hr_name || ''} onChange={(e) => updateNested('signatories', 'hr_name', e.target.value)} /></Field>
            <Field label="HR signatory title"><input className={inputCls} value={form.signatories?.hr_title || ''} onChange={(e) => updateNested('signatories', 'hr_title', e.target.value)} /></Field>
            <Field label="Managing Director / authorised signatory"><input className={inputCls} value={form.signatories?.md_name || ''} onChange={(e) => updateNested('signatories', 'md_name', e.target.value)} /></Field>
            <Field label="MD signatory title"><input className={inputCls} value={form.signatories?.md_title || ''} onChange={(e) => updateNested('signatories', 'md_title', e.target.value)} /></Field>
          </div>
          <div className="mt-3 max-w-md"><label className={labelCls}>HR signature image</label>{form.signatories?.signature_data ? <><img src={form.signatories.signature_data} alt="Configured HR signature" className="max-h-20 border border-slate-200 bg-white" /><button className="text-xs text-[#009944] mt-2 hover:underline" onClick={() => updateNested('signatories', 'signature_data', null)}>Clear signature</button></> : <SignaturePad height={100} onChange={(value) => updateNested('signatories', 'signature_data', value)} />}</div>
        </section>
      </div>

      <div className="sticky bottom-0 bg-white border-t border-slate-200 px-6 py-4 flex flex-wrap justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
        <button onClick={preview} className="px-4 py-2 rounded-lg border border-[#009944] text-sm text-[#009944] hover:bg-emerald-50">Preview template</button>
        <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60"><>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}</> {busy ? 'Saving...' : 'Save template'}</button>
      </div>
    </div>
  </div>
}

function SectionHeading({ title }) {
  return <h3 className="text-sm font-semibold text-slate-900 border-b border-slate-200 pb-2 mb-3">{title}</h3>
}

function Field({ label, children }) {
  return <div><label className={labelCls}>{label}</label>{children}</div>
}
