// -----------------------------------------------------------------------------
// Canonical offer-letter document renderer.
//
// This is deliberately a document renderer, not a dashboard card.  The same
// self-contained A4 HTML is used for HR preview, candidate viewing, stored
// body_content, employee files, and PDF generation.
// -----------------------------------------------------------------------------

import { computeRemuneration, formatMoney, remunerationFromLegacy } from './remuneration'
import {
  DEFAULT_COMPANY,
  DEFAULT_LETTER,
  DEFAULT_OPENING,
  DEFAULT_SECTIONS,
  DEFAULT_SIGNATORIES,
} from '../config/offerLetterDefaults'

const GREEN = {
  deep: '#005f2b',
  mid: '#007a4a',
  rule: '#007a4a',
  tint: '#eef6f0',
  tintStrong: '#d9ecdf',
  orange: '#f58220',
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textToHtml(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`)
    .join('')
}

// This is the existing InfinityCore logo asset expressed as inline SVG so it
// survives a private-file download and a client-side PDF conversion.
export function brandLogoSvg(size = 64) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Infinity Microfinance Bank logo">
    <defs><linearGradient id="infinity-mfb-logo-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#00a85a"/><stop offset="100%" stop-color="#007a4a"/></linearGradient></defs>
    <g transform="rotate(45 50 50)"><rect x="21" y="19" width="58" height="58" rx="15" fill="#f58220"/></g>
    <g transform="rotate(45 50 50)"><rect x="24" y="24" width="52" height="52" rx="13" fill="url(#infinity-mfb-logo-gradient)"/></g>
    <text x="50" y="51" text-anchor="middle" dominant-baseline="central" font-size="30" font-weight="700" fill="#ffffff" font-family="ui-sans-serif, system-ui, sans-serif">∞</text>
    <g transform="rotate(45 63 50)"><rect x="60" y="47" width="6" height="6" fill="#f58220"/></g>
  </svg>`
}

function fmtDate(value, locale = DEFAULT_LETTER.date_format) {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return parsed.toLocaleDateString(locale || 'en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
}

function fmtTime(value) {
  if (!value) return ''
  const match = String(value).match(/^(\d{1,2}):(\d{2})/)
  if (!match) return String(value)
  const hour = Number(match[1])
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'}`
}

function workingDayLabel(day) {
  const map = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }
  return map[String(day || '').toLowerCase().slice(0, 3)] || day
}

function employmentTypeLabel(type) {
  return String(type || '').replace(/_/g, ' ')
}

const PLACEHOLDER_KEYS = [
  'candidate_name', 'position', 'department', 'branch', 'area', 'employment_type',
  'start_date', 'probation_months', 'reporting_manager', 'working_hours', 'working_days',
  'leave_entitlement', 'acceptance_deadline', 'offer_number', 'conditions', 'other_terms',
  'company_name', 'company_address', 'annual_salary', 'monthly_salary', 'mid_month_salary',
  'end_month_salary', 'benefits', 'resumption_time', 'lunch_break', 'hr_signatory',
  'hr_title', 'md_signatory', 'md_title', 'employee_id', 'email', 'phone',
]

export function resolvePlaceholders(text, values = {}) {
  if (!text) return ''
  let result = String(text)
  PLACEHOLDER_KEYS.forEach((key) => {
    result = result.split(`{{${key}}}`).join(String(values[key] ?? ''))
  })
  return result
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function nonEmptyObject(value) {
  return value && typeof value === 'object' && Object.keys(value).length > 0
}

export function buildLetterContext({
  offer,
  candidate = null,
  template = null,
  workHours = null,
  currency = null,
  companyInfo = null,
  signatories = null,
  sections = null,
  dateFormat = null,
}) {
  const snapshot = offer?.salary_structure?.document || offer?.document_snapshot || {}
  const person = { ...snapshot, ...(candidate || {}) }
  const company = {
    ...DEFAULT_COMPANY,
    ...(template?.company_info || {}),
    ...(snapshot.company_info || {}),
    ...(companyInfo || {}),
  }
  const sigs = {
    ...DEFAULT_SIGNATORIES,
    ...(template?.signatories || {}),
    ...(snapshot.signatories || {}),
    ...(signatories || {}),
  }
  const cur = {
    symbol: currency?.currency_symbol || DEFAULT_LETTER.currency_symbol,
    position: currency?.currency_position || DEFAULT_LETTER.currency_position,
    decimals: currency?.currency_decimal_places ?? DEFAULT_LETTER.currency_decimals,
    code: currency?.currency_code || DEFAULT_LETTER.currency,
  }
  const storedRemuneration = offer?.remuneration
  const remInput = nonEmptyObject(storedRemuneration) ? storedRemuneration : remunerationFromLegacy(offer)
  const rem = computeRemuneration(remInput)
  const money = (value) => formatMoney(value, cur)
  const wh = workHours || snapshot.work_hours || {}
  const days = Array.isArray(wh.working_days) && wh.working_days.length
    ? wh.working_days.map(workingDayLabel).join(' - ')
    : (wh.working_days || '')
  const breakMinutes = Number(wh.break_duration_minutes ?? wh.break_minutes ?? 0)
  const lunch = breakMinutes > 0
    ? breakMinutes >= 60
      ? `${breakMinutes / 60} hour${breakMinutes === 60 ? '' : 's'}`
      : `${breakMinutes} minutes`
    : ''
  const dateLocale = dateFormat || template?.date_format || DEFAULT_LETTER.date_format
  const candidateName = person.full_name || offer?.candidate_name || ''
  const annualSalary = rem.totals.annual_gross

  const values = {
    candidate_name: candidateName,
    position: offer?.position || '',
    department: offer?.department || '',
    branch: offer?.branch || '',
    area: offer?.area || person.area || '',
    employment_type: employmentTypeLabel(offer?.employment_type),
    start_date: fmtDate(offer?.start_date, dateLocale),
    probation_months: offer?.probation_months != null ? String(offer.probation_months) : '',
    reporting_manager: offer?.reporting_manager || '',
    working_hours: [fmtTime(wh.start_time), fmtTime(wh.end_time)].filter(Boolean).join(' - '),
    working_days: days,
    leave_entitlement: offer?.leave_entitlement || (wh.leave_annual_days ? `${wh.leave_annual_days} working days` : ''),
    acceptance_deadline: fmtDate(offer?.acceptance_deadline, dateLocale),
    offer_number: offer?.offer_number || '',
    conditions: offer?.conditions || '',
    other_terms: offer?.other_terms || '',
    benefits: offer?.benefits || '',
    company_name: company.name,
    company_address: company.address || '',
    annual_salary: money(annualSalary),
    monthly_salary: money(rem.totals.monthly_gross),
    mid_month_salary: money(rem.totals.mid_month),
    end_month_salary: money(rem.totals.month_end),
    resumption_time: fmtTime(wh.start_time),
    lunch_break: lunch,
    hr_signatory: sigs.hr_name || '',
    hr_title: sigs.hr_title || '',
    md_signatory: sigs.md_name || '',
    md_title: sigs.md_title || '',
    employee_id: offer?.work_id || offer?.employee_code || person.work_id || person.employee_code || '',
    email: offer?.email || person.email || '',
    phone: offer?.phone || person.phone || '',
  }

  return {
    company,
    sigs,
    cur,
    rem,
    values,
    money,
    dateLocale,
    snapshot,
    sections: sections || template?.sections || null,
  }
}

function summaryRows(ctx, offer) {
  const { values, dateLocale } = ctx
  const rows = []
  const add = (label, value) => { if (hasValue(value)) rows.push([label, value]) }
  add('Full Name', values.candidate_name)
  add('Employee / Work ID', values.employee_id)
  add('Email', values.email)
  add('Phone', values.phone)
  add('Position', values.position)
  add('Department', values.department)
  add('Branch', values.branch)
  add('Area', values.area)
  add('Reporting Manager', values.reporting_manager)
  add('Employment Type', values.employment_type)
  add('Employment Status', offer?.employment_status || ctx.snapshot.employment_status || '')
  add('Start Date', fmtDate(offer?.start_date, dateLocale))
  add('Probation Period', offer?.probation_months ? `${offer.probation_months} month${Number(offer.probation_months) === 1 ? '' : 's'}` : '')
  add('Working Hours', values.working_hours)
  add('Working Days', values.working_days)
  add('Leave Entitlement', values.leave_entitlement)
  add('Acceptance Deadline', fmtDate(offer?.acceptance_deadline, dateLocale))
  return rows
}

function remunerationRows(rem, money) {
  return rem.rows.map((row) => {
    if (row.tone === 'group') return `<tr class="rem-group"><td colspan="2">${escapeHtml(row.label)}</td></tr>`
    const note = row.note ? `<span class="rem-note">&nbsp;(${escapeHtml(row.note)})</span>` : ''
    const klass = row.tone === 'grandtotal' ? 'rem-grand' : row.tone === 'total' ? 'rem-total' : ''
    return `<tr class="${klass}"><td>${escapeHtml(row.label)}${note}</td><td class="value">${money(row.value)}</td></tr>`
  }).join('')
}

function safeSignature(value) {
  return typeof value === 'string' && /^data:image\//.test(value)
    ? `<img src="${value}" alt="Electronic signature" class="signature-image" />`
    : ''
}

function signatureArea(ctx) {
  const { company, sigs, values } = ctx
  const hrSignature = safeSignature(sigs.signature_data)
  const mdSignature = safeSignature(sigs.md_signature_data)
  return `<div class="acceptance-block">
    <p class="acceptance-statement">&quot;I accept the offer of employment on the terms and conditions stated above.&quot;</p>
    <table class="signature-table"><tbody><tr>
      <td class="signature-cell employer-cell">
        <div class="signature-label">For and on behalf of</div>
        <div class="signature-company">${escapeHtml(company.name)}</div>
        ${hrSignature}<div class="signature-line"></div>
        <div class="signature-name">${escapeHtml(sigs.hr_name || '')}</div>
        <div class="signature-title">${escapeHtml(sigs.hr_title || 'Human Resources Manager')}</div>
        ${mdSignature ? `${mdSignature}<div class="signature-line"></div>` : '<div class="secondary-signature-space"></div>'}
        <div class="signature-name">${escapeHtml(sigs.md_name || '')}</div>
        <div class="signature-title">${escapeHtml(sigs.md_title || '')}</div>
      </td>
      <td class="signature-cell candidate-cell">
        <div class="signature-label">Candidate Acceptance</div>
        <div class="signature-company">${escapeHtml(values.candidate_name)}</div>
        <div class="candidate-signature-space"></div><div class="signature-line"></div>
        <div class="signature-name">Candidate Signature</div>
        <div class="signature-title">Name: ${escapeHtml(values.candidate_name)}</div>
        <div class="signature-title">Date: ______________________________</div>
      </td>
    </tr></tbody></table>
  </div>`
}

export function renderOfferLetterHtml({
  offer,
  candidate = null,
  template = null,
  workHours = null,
  currency = null,
  signingOfficer = null,
  signatureData = null,
  sections = null,
  companyInfo = null,
  signatories = null,
  dateFormat = null,
}) {
  const mergedSignatories = {
    ...(signatories || {}),
    ...(signingOfficer ? { hr_name: signingOfficer } : {}),
    ...(signatureData ? { signature_data: signatureData } : {}),
  }
  const ctx = buildLetterContext({ offer, candidate, template, workHours, currency, companyInfo, signatories: mergedSignatories, sections, dateFormat })
  const { company, sigs, values, rem, money, dateLocale } = ctx
  const effectiveSections = (sections && sections.length)
    ? sections
    : (template?.sections && template.sections.length ? template.sections : DEFAULT_SECTIONS)
  const renderedSections = effectiveSections.map((section) => {
    const body = textToHtml(resolvePlaceholders(section.body || '', values))
    const remuneration = /remuneration/i.test(section.title || '')
      ? `<div class="remuneration-wrap"><table class="remuneration"><thead><tr><th>Description</th><th>Payment Basis / Value</th></tr></thead><tbody>${remunerationRows(rem, money)}</tbody></table></div><p class="remuneration-note">Amounts are stated per annum unless otherwise indicated. Statutory deductions and contributions are applied in line with applicable law and the Bank's approved payroll policy.</p>`
      : ''
    return `<section class="document-section ${/remuneration/i.test(section.title || '') ? 'remuneration-section' : ''} ${/acceptance/i.test(section.title || '') ? 'acceptance-section' : ''}"><h3><span>${escapeHtml(section.number || '')}</span> ${escapeHtml(section.title || '')}</h3>${body}${remuneration}</section>`
  }).join('')
  const openingText = resolvePlaceholders(template?.opening_paragraph || template?.opening || DEFAULT_OPENING, values)
  const summary = summaryRows(ctx, offer)
  const address = offer?.candidate_address || ctx.snapshot.candidate_address || candidate?.address || ''
  const headerLines = [
    company.address,
    company.rc_number ? `RC No: ${company.rc_number}` : '',
    [company.email, company.phone].filter(Boolean).join(' | '),
    company.website,
  ].filter(Boolean)
  const offerDate = offer?.offer_date || offer?.issue_date || offer?.issued_at || offer?.created_at || new Date().toISOString()
  const confidentiality = company.confidentiality_notice || 'Private and confidential - intended solely for the addressee.'

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(company.name)} - Offer of Employment - ${escapeHtml(values.candidate_name)}</title><style>
    * { box-sizing: border-box; }
    @page { size: A4 portrait; margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { color: #161a17; font-family: Georgia, 'Times New Roman', serif; font-size: 11.3px; line-height: 1.42; }
    .document { width: 180mm; margin: 0 auto; padding: 14mm 0 17mm; }
    p, h1, h2, h3 { margin: 0; }
    .letterhead { border-bottom: 2px solid ${GREEN.rule}; padding-bottom: 8px; margin-bottom: 12px; }
    .letterhead-table, .summary, .remuneration, .signature-table { width: 100%; border-collapse: collapse; }
    .letterhead-table { table-layout: fixed; }
    .logo-cell { width: 59px; vertical-align: middle; }
    .brand-cell { width: 50%; vertical-align: middle; padding-left: 9px; padding-right: 9px; }
    .brand-name { color: ${GREEN.deep}; font-size: 12.5px; font-weight: 700; letter-spacing: .1px; white-space: nowrap; }
    .brand-sub { color: #69756e; font: 8px Arial, Helvetica, sans-serif; letter-spacing: 1.7px; margin-top: 2px; text-transform: uppercase; }
    .brand-line { background: ${GREEN.orange}; height: 2px; margin-top: 5px; width: 42px; }
    .office { color: #4c5951; font-size: 8.4px; left: 8px; line-height: 1.42; padding-left: 14px; position: relative; text-align: right; vertical-align: middle; width: 36%; }
    .office strong { color: #243b2d; display: inline-block; padding-left: 12px; }
    .fine-rule { border-bottom: .5px solid #cdd4cf; margin-top: 4px; }
    .metadata { display: flex; justify-content: space-between; gap: 20px; margin: 3px 0 12px; color: #3c473f; font-size: 10.3px; }
    .addressee { margin: 3px 0 9px; }
    .candidate-name { font-size: 12px; font-weight: 700; letter-spacing: .25px; text-transform: uppercase; }
    .candidate-address { color: #3c473f; font-size: 10.5px; line-height: 1.4; white-space: pre-line; }
    .salutation { margin: 8px 0 9px; }
    .document-title { margin: 10px 0 13px; text-align: center; }
    .document-title h1 { border-bottom: 1.3px solid ${GREEN.orange}; color: ${GREEN.deep}; display: inline-block; font: 700 13px Georgia, 'Times New Roman', serif; letter-spacing: 2.6px; padding: 0 12px 4px; text-transform: uppercase; }
    .opening p { margin-bottom: 7px; text-align: justify; }
    .summary-wrap { margin: 10px 0 5px; page-break-inside: avoid; break-inside: avoid; }
    .summary { font-size: 10.2px; }
    .summary th, .summary td { border: .65px solid #b8c2bc; padding: 3.7px 7px; text-align: left; vertical-align: top; }
    .summary th { background: ${GREEN.tint}; color: #1f3a2b; font: 700 9.2px Arial, Helvetica, sans-serif; letter-spacing: .25px; text-transform: uppercase; width: 29%; }
    .summary td { color: #232b26; }
    .document-section { margin: 8px 0; page-break-inside: avoid; break-inside: avoid; }
    .document-section h3 { border-bottom: .6px solid ${GREEN.tintStrong}; color: ${GREEN.deep}; font: 700 10.8px Arial, Helvetica, sans-serif; letter-spacing: .55px; margin-bottom: 3px; padding-bottom: 2px; page-break-after: avoid; break-after: avoid; }
    .document-section h3 span { color: ${GREEN.mid}; margin-right: 4px; }
    .document-section p { margin: 3px 0; text-align: justify; }
    .remuneration-wrap { margin: 8px 0 5px; page-break-inside: auto; }
    .remuneration { font-size: 9.7px; }
    .remuneration thead { display: table-header-group; }
    .remuneration tr { page-break-inside: avoid; break-inside: avoid; }
    .remuneration th, .remuneration td { border: .65px solid #b8c2bc; padding: 3.6px 7px; vertical-align: middle; }
    .remuneration th { background: #f4f7f5; color: #34463b; font: 700 8.7px Arial, Helvetica, sans-serif; letter-spacing: .5px; text-align: left; text-transform: uppercase; }
    .remuneration th:last-child { text-align: right; width: 31%; }
    .remuneration td.value { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
    .remuneration .rem-group td { background: ${GREEN.mid}; color: #fff; font: 700 8.9px Arial, Helvetica, sans-serif; letter-spacing: .8px; text-transform: uppercase; }
    .remuneration .rem-total td { background: ${GREEN.tintStrong}; color: ${GREEN.deep}; font-weight: 700; }
    .remuneration .rem-grand td { background: ${GREEN.deep}; color: #fff; font-weight: 700; }
    .rem-note { color: #768078; display: inline; font: italic 8px Georgia, 'Times New Roman', serif; margin-left: 2px; }
    .remuneration-note { color: #657168; font-size: 8.5px; }
    .acceptance-section { page-break-inside: avoid; break-inside: avoid; }
    .acceptance-block { margin-top: 13px; page-break-inside: avoid; break-inside: avoid; }
    .acceptance-statement { color: #1f3a2b; font-size: 10.8px; font-style: italic; margin-bottom: 8px; text-align: center; }
    .signature-table td { padding: 5px 8px; vertical-align: top; width: 50%; }
    .signature-table .candidate-cell { border-left: .6px solid #cdd4cf; }
    .signature-label { color: #77827b; font: 8.2px Arial, Helvetica, sans-serif; letter-spacing: 1px; text-transform: uppercase; }
    .signature-company { color: ${GREEN.deep}; font-size: 10.5px; font-weight: 700; margin: 1px 0 10px; }
    .signature-image { display: block; max-height: 31px; max-width: 125px; object-fit: contain; }
    .signature-line { border-bottom: 1px solid #333b35; margin: 13px 0 2px; width: 86%; }
    .secondary-signature-space { height: 18px; }
    .candidate-signature-space { height: 31px; }
    .signature-name { color: #161a17; font-size: 10px; font-weight: 700; }
    .signature-title { color: #55605a; font-size: 8.7px; }
    .document-footer { border-top: .6px solid #cdd4cf; color: #77787a; font-size: 7.5px; line-height: 1.35; margin-top: 15px; padding-top: 5px; text-align: center; }
    @media print { .document { margin: 0 auto; } }
  </style></head><body><main class="document" data-offer-number="${escapeHtml(values.offer_number)}">
    <header class="letterhead"><table class="letterhead-table"><tbody><tr>
      <td class="logo-cell">${brandLogoSvg(50)}</td>
      <td class="brand-cell"><div class="brand-name">${escapeHtml(company.name)}&nbsp;</div>${company.tagline ? `<div class="brand-sub">${escapeHtml(company.tagline)}</div>` : ''}<div class="brand-line"></div></td>
      <td class="office">${headerLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}<p><strong>${escapeHtml(sigs.department || 'Human Resources Department')}</strong></p></td>
    </tr></tbody></table><div class="fine-rule"></div></header>
    <div class="metadata"><p>Date: <strong>${escapeHtml(fmtDate(offerDate, dateLocale))}</strong></p><p>Reference: <strong>${escapeHtml(values.offer_number)}</strong></p></div>
    <section class="addressee"><p class="candidate-name">${escapeHtml(values.candidate_name)}</p>${address ? `<p class="candidate-address">${escapeHtml(address)}</p>` : ''}</section>
    <p class="salutation">Dear <strong>${escapeHtml(values.candidate_name.split(/\s+/)[0] || 'Candidate')}</strong>,</p>
    <div class="document-title"><h1>Offer of Employment</h1></div>
    <div class="opening">${textToHtml(openingText)}</div>
    ${summary.length ? `<div class="summary-wrap"><table class="summary"><tbody>${summary.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${renderedSections}
    ${signatureArea(ctx)}
    <footer class="document-footer">${escapeHtml([company.name, company.address, company.phone, company.email].filter(Boolean).join(' | '))}${company.website ? `<br />${escapeHtml(company.website)}` : ''}<br />${escapeHtml(confidentiality)}</footer>
  </main></body></html>`
}

export default {
  renderOfferLetterHtml,
  buildLetterContext,
  resolvePlaceholders,
  brandLogoSvg,
  escapeHtml,
}
