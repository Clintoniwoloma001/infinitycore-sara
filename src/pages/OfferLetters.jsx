import React, { useEffect, useState } from 'react'
import { Archive, Copy, Download, FileEdit, FileText, Link2, Loader2, Plus, Send, X } from 'lucide-react'
import { date, ModuleTable } from './hrShared'
import { ErrorState } from '../components/PageStates'
import { StatusBadge, formatCurrency } from '../lib/utils'
import { offerService, getOfferEnvironment } from '../services/offerService'
import { documentService } from '../services/documentService'
import { careerService } from '../services/careerService'
import { onboardingService, DEFAULT_EXPIRY_DAYS } from '../services/onboardingService'
import { useAuth } from '../hooks/useAuth'
import { downloadBlob, offerLetterHtmlToPdf, openOfferPreview } from '../lib/offerLetterPdf'
import { renderOfferLetterHtml } from '../lib/offerLetterDocument'
import OfferLetterGenerator from '../components/offer/OfferLetterGenerator'
import OfferLetterTemplateEditor from '../components/offer/OfferLetterTemplateEditor'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const OFFER_STATUS_COLOR = { draft: 'amber', issued: 'blue', accepted: 'emerald', declined: 'rose', withdrawn: 'slate' }
const OFFER_STATUSES = ['draft', 'issued', 'accepted', 'declined', 'withdrawn']

export default function OfferLetters() {
  const { user } = useAuth()
  const [offers, setOffers] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [busy, setBusy] = useState('')
  const [generator, setGenerator] = useState(null)
  const [editor, setEditor] = useState(null)
  const [previewHtml, setPreviewHtml] = useState('')
  const [sharing, setSharing] = useState(null)
  const [copied, setCopied] = useState('')
  const [tokens, setTokens] = useState(() => {
    try { return JSON.parse(localStorage.getItem('offer-tokens') || '{}') } catch { return {} }
  })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [offerRows, templateRows] = await Promise.all([
        offerService.listOffers(statusFilter ? { status: statusFilter } : {}),
        offerService.listTemplates(),
      ])
      setOffers(offerRows || [])
      setTemplates(templateRows || [])
    } catch (e) {
      setError(e?.message || 'Offers could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [statusFilter])

  const issue = async (offer) => {
    setBusy(`issue-${offer.id}`)
    setMessage('')
    try {
      await offerService.issueOffer(offer.id)
      setMessage(`${offer.offer_number || 'Offer'} issued.`)
      await load()
    } catch (e) { setMessage(e?.message || 'Offer could not be issued.') } finally { setBusy('') }
  }

  const send = async (offer) => {
    setBusy(`send-${offer.id}`)
    setMessage('')
    try {
      await offerService.sendOffer(offer.id, offer.hr_candidates?.email || null, offer.document_id || null)
      setMessage(`${offer.offer_number || 'Offer'} marked as sent.`)
      await load()
    } catch (e) { setMessage(e?.message || 'Offer could not be sent.') } finally { setBusy('') }
  }

  const withdraw = async (offer) => {
    if (!window.confirm(`Withdraw ${offer.offer_number || 'this offer'}? Its candidate link will stop working.`)) return
    setBusy(`withdraw-${offer.id}`)
    try { await offerService.withdrawOffer(offer.id); await load() } catch (e) { setMessage(e?.message || 'Offer could not be withdrawn.') } finally { setBusy('') }
  }

  const copyText = async (value, key) => {
    try { await navigator.clipboard.writeText(value) } catch {
      const area = document.createElement('textarea')
      area.value = value
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(key)
    setTimeout(() => setCopied(''), 1500)
  }

  const share = (offer) => {
    const token = tokens[offer.id]
    if (!token) {
      setMessage('This offer has no saved candidate link. Generate a new version to create a shareable token.')
      return
    }
    setSharing({ offer, url: careerService.buildOfferUrl(token) })
  }

  const generateOnboarding = async (offer) => {
    setBusy(`onboarding-${offer.id}`)
    try {
      const result = await offerService.createOnboardingLink(offer.id, DEFAULT_EXPIRY_DAYS)
      const link = result?.url
        ? result
        : await onboardingService.createLink({
            candidateName: offer.candidate_name, candidateEmail: offer.hr_candidates?.email || '', position: offer.position,
            department: offer.department, branch: offer.branch, employmentType: offer.employment_type,
            expiresInDays: DEFAULT_EXPIRY_DAYS, createdBy: user?.id, candidateId: offer.candidate_id, jobId: offer.job_id,
          })
      setSharing({ offer: null, url: link.url, label: 'Onboarding link' })
    } catch (e) { setMessage(e?.message || 'Could not generate an onboarding link.') } finally { setBusy('') }
  }

  const preview = (offer) => {
    if (!offer.body_content) { setMessage('This offer has no stored document content. Generate a new version to create it.'); return }
    setPreviewHtml(offer.body_content)
  }

  const downloadOffer = async (offer) => {
    setBusy(`download-${offer.id}`)
    try {
      if (offer.document_id) {
        const doc = await documentService.getById(offer.document_id)
        const url = doc?.file_path ? await documentService.getSignedUrl(doc.file_path) : null
        if (url) {
          const response = await fetch(url)
          if (!response.ok) throw new Error('The stored offer file could not be downloaded.')
          downloadBlob(await response.blob(), doc.file_name || `${offer.offer_number || 'offer-letter'}-v${offer.version || 1}.pdf`)
          return
        }
      }
      if (offer.body_content) {
        const blob = await offerLetterHtmlToPdf(offer.body_content, `${offer.offer_number || 'offer-letter'}-v${offer.version || 1}.pdf`)
        downloadBlob(blob, `${offer.offer_number || 'offer-letter'}-v${offer.version || 1}.pdf`)
      }
    } catch (e) { setMessage(e?.message || 'Offer PDF could not be downloaded.') } finally { setBusy('') }
  }

  const previewTemplate = async (template) => {
    try {
      const environment = await getOfferEnvironment()
      const html = renderOfferLetterHtml({
        offer: {
          candidate_name: 'Sample Candidate', position: 'Relationship Officer',
          department: 'Operations', employment_type: 'full_time', start_date: new Date().toISOString().slice(0, 10),
          probation_months: 3, acceptance_deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          offer_number: 'PREVIEW', annual_salary: 0, monthly_salary: 0,
          remuneration: template.salary_config || {}, salary_structure: { document: { email: 'candidate@example.com', phone: '+234 800 000 0000' } },
        },
        candidate: { full_name: 'Sample Candidate', email: 'candidate@example.com', phone: '+234 800 000 0000' },
        template, workHours: environment.workHours, currency: environment.currency,
      })
      setPreviewHtml(html)
    } catch (e) { setMessage(e?.message || 'Template preview could not be generated.') }
  }

  const onSaved = async (result = {}) => {
    if (result.offerId && result.token) {
      const next = { ...tokens, [result.offerId]: result.token }
      setTokens(next)
      localStorage.setItem('offer-tokens', JSON.stringify(next))
    }
    setGenerator(null)
    await load()
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-2xl font-semibold text-slate-900">Offer Letters</h1><p className="text-sm text-slate-500 mt-1">Generate bank-grade, versioned employment offers from configurable HR templates.</p></div>
      <div className="flex items-center gap-2"><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${inputCls} w-40`}><option value="">All statuses</option>{OFFER_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select><button onClick={() => setGenerator({ offer: null })} className="inline-flex items-center gap-2 rounded-lg bg-[#009944] text-white px-4 py-2.5 text-sm font-medium hover:bg-[#007a36]"><Plus className="w-4 h-4" /> Generate Offer Letter</button></div>
    </div>

    {error && <ErrorState message={error} />}
    {message && <div className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700">{message}</div>}

    <ModuleTable title="Generated offers" subtitle="Historical versions remain available after a new version is generated." rows={offers} loading={loading} error={error} searchKeys={['candidate_name', 'position', 'offer_number', 'status']} columns={[
      { key: 'candidate', label: 'Candidate', render: (row) => <div><div className="font-medium text-slate-900">{row.candidate_name || row.hr_candidates?.full_name || '-'}</div><div className="text-xs text-slate-400">{row.offer_number || 'No reference'} · v{row.version || 1}</div></div> },
      { key: 'position', label: 'Position', render: (row) => row.position || '-' },
      { key: 'monthly_salary', label: 'Monthly gross', render: (row) => row.monthly_salary != null ? formatCurrency(row.monthly_salary) : '-' },
      { key: 'status', label: 'Status', render: (row) => <StatusBadge label={row.status} color={OFFER_STATUS_COLOR[row.status] || 'slate'} /> },
      { key: 'issued', label: 'Issued', render: (row) => date(row.issued_at || row.created_at) },
      { key: 'actions', label: 'Actions', render: (row) => <div className="flex justify-end flex-wrap gap-1.5">
        <button onClick={() => preview(row)} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><FileText className="w-3.5 h-3.5" /> Preview</button>
        <button onClick={() => downloadOffer(row)} disabled={busy === `download-${row.id}`} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-50 disabled:opacity-50">{busy === `download-${row.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} PDF</button>
        {row.status === 'draft' && <><button onClick={() => issue(row)} disabled={!!busy} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-emerald-300 text-emerald-700 text-xs hover:bg-emerald-50 disabled:opacity-50">{busy === `issue-${row.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Issue</button><button onClick={() => setGenerator({ offer: row })} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><FileEdit className="w-3.5 h-3.5" /> Edit</button></>}
        {(row.status === 'issued' || row.status === 'accepted') && <><button onClick={() => share(row)} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-blue-300 text-blue-700 text-xs hover:bg-blue-50"><Link2 className="w-3.5 h-3.5" /> Share</button>{tokens[row.id] && <button onClick={() => copyText(careerService.buildOfferUrl(tokens[row.id]), row.id)} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><Copy className="w-3.5 h-3.5" /> {copied === row.id ? 'Copied' : 'Copy link'}</button>}<button onClick={() => generateOnboarding(row)} disabled={!!busy} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-emerald-300 text-emerald-700 text-xs hover:bg-emerald-50 disabled:opacity-50">{busy === `onboarding-${row.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Onboarding</button></>}
        {row.status === 'issued' && <><button onClick={() => send(row)} disabled={!!busy} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-blue-300 text-blue-700 text-xs hover:bg-blue-50 disabled:opacity-50">{busy === `send-${row.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send</button><button onClick={() => setGenerator({ offer: row })} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-50"><Copy className="w-3.5 h-3.5" /> New version</button></>}
        {['draft', 'issued'].includes(row.status) && <button onClick={() => withdraw(row)} disabled={!!busy} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-rose-200 text-rose-600 text-xs hover:bg-rose-50 disabled:opacity-50"><Archive className="w-3.5 h-3.5" /> Withdraw</button>}
      </div> },
    ]} />

    <section className="bg-white border border-slate-200 rounded-xl p-6"><div className="flex flex-wrap items-center justify-between gap-3 mb-4"><div><h2 className="text-base font-bold text-slate-900">Offer-letter templates</h2><p className="text-xs text-slate-500 mt-1">Manage structured wording, letterhead details, salary defaults, signatures, and numbered sections.</p></div><button onClick={() => setEditor({ template: null })} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><Plus className="w-4 h-4" /> Create template</button></div><div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">{templates.length === 0 && <p className="text-sm text-slate-400">No templates found. Create one to begin.</p>}{templates.map((template) => <div key={template.id} className={`rounded-lg border p-4 ${template.archived ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-slate-200 bg-white'}`}><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-medium text-slate-800">{template.name}</p><p className="text-xs text-slate-400 mt-1">{template.template_type || 'standard'} · {template.sections?.length || 0} sections</p></div><span className="text-[10px] uppercase tracking-wide text-slate-500">{template.archived ? 'archived' : template.is_default ? 'default' : template.active === false ? 'inactive' : 'active'}</span></div><div className="flex flex-wrap gap-1.5 mt-4"><button onClick={() => setEditor({ template })} className="text-xs px-2 py-1 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50">Edit</button><button onClick={() => previewTemplate(template)} className="text-xs px-2 py-1 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50">Preview</button>{!template.archived && <><button onClick={async () => { try { await offerService.duplicateTemplate(template.id); await load() } catch (e) { setMessage(e?.message || 'Template could not be duplicated.') } }} className="text-xs px-2 py-1 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50">Duplicate</button><button onClick={async () => { try { await offerService.setDefaultTemplate(template.id); await load() } catch (e) { setMessage(e?.message || 'Default template could not be changed.') } }} className="text-xs px-2 py-1 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50">Set default</button><button onClick={async () => { try { await offerService.archiveTemplate(template.id); await load() } catch (e) { setMessage(e?.message || 'Template could not be archived.') } }} className="text-xs px-2 py-1 rounded-md border border-amber-200 text-amber-700 hover:bg-amber-50">Archive</button></>}</div></div>)}</div></section>

    {generator && <OfferLetterGenerator open onClose={() => setGenerator(null)} initialOffer={generator.offer} onSaved={onSaved} />}
    {editor && <OfferLetterTemplateEditor open template={editor.template} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await load() }} onPreview={async (template) => { await previewTemplate(template) }} />}
    {previewHtml && <div className="fixed inset-0 z-[70] bg-slate-950/70 p-4 flex items-center justify-center"><div className="bg-white w-full max-w-5xl h-[94vh] rounded-xl shadow-2xl flex flex-col"><div className="flex items-center justify-between px-4 py-3 border-b border-slate-200"><p className="text-sm font-semibold text-slate-900">Offer letter preview</p><div className="flex items-center gap-2"><button onClick={() => openOfferPreview(previewHtml, { print: true })} className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs text-slate-700">Print</button><button onClick={async () => { setBusy('preview-pdf'); try { const blob = await offerLetterHtmlToPdf(previewHtml, 'offer-letter-preview.pdf'); downloadBlob(blob, 'offer-letter-preview.pdf') } catch (e) { setMessage(e?.message || 'Preview PDF could not be generated.') } finally { setBusy('') } }} disabled={busy === 'preview-pdf'} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#009944] text-white text-xs"><Download className="w-3.5 h-3.5" /> PDF</button><button onClick={() => setPreviewHtml('')} className="p-1 text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button></div></div><iframe title="Offer letter preview" srcDoc={previewHtml} className="flex-1 w-full bg-slate-100" sandbox="allow-same-origin" /></div></div>}
    {sharing && <div className="fixed inset-0 z-[75] bg-black/40 flex items-center justify-center p-4"><div className="bg-white rounded-xl w-full max-w-lg p-6"><div className="flex items-center justify-between mb-4"><h3 className="text-lg font-semibold text-slate-900">{sharing.label || `Share offer - ${sharing.offer?.candidate_name || ''}`}</h3><button onClick={() => setSharing(null)} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button></div><p className="text-sm text-slate-500 mb-4">This token-gated link is invalidated when the offer is superseded, withdrawn, or accepted.</p><div className="flex items-center gap-2"><input readOnly value={sharing.url} className={inputCls} /><button onClick={() => copyText(sharing.url, 'share')} className="px-3 py-2.5 rounded-lg bg-[#009944] text-white text-sm">{copied === 'share' ? 'Copied' : 'Copy'}</button></div></div></div>}
  </div>
}
