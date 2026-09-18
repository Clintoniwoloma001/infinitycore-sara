import fs from 'node:fs'
import { chromium } from '@playwright/test'

const baseUrl = process.env.OFFER_PREVIEW_URL || 'http://127.0.0.1:4173/'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })

const result = await page.evaluate(async () => {
  const [{ renderOfferLetterHtml }, { DEFAULT_SECTIONS }, { offerLetterHtmlToPdf }] = await Promise.all([
    import('/src/lib/offerLetterDocument.js'),
    import('/src/config/offerLetterDefaults.js'),
    import('/src/lib/offerLetterPdf.js'),
  ])
  const html = renderOfferLetterHtml({
    offer: {
      candidate_name: 'Clinton Tamunosiki Iwoloma',
      position: 'Relationship Officer',
      company_name: 'Infinity Microfinance Bank Ltd',
      department: 'Operations',
      branch: 'Lagos Main Branch',
      employment_type: 'full_time',
      employment_status: 'Proposed',
      start_date: '2026-10-01',
      probation_months: 3,
      reporting_manager: 'Head, Branch Operations',
      acceptance_deadline: '2026-09-25',
      offer_date: '2026-09-18',
      offer_number: 'OFR-20260918-0001',
      candidate_address: '15 Sample Street\nLagos, Nigeria',
      remuneration: {
        pay: { basic: 4200000, housing: 900000, transport: 480000, medical: 180000, lunch: 120000 },
        coa: { coa: 150000 },
        benefit: { leave_allowance: 350000, thirteenth_month: 400000 },
        social: { pension: 336000, hmo: 180000, group_life: 60000 },
        config: { mid_month_ratio: 0.5 },
      },
      salary_structure: { document: { email: 'clinton@example.com', phone: '+234 800 000 0000', work_id: 'IMFB-0001' } },
    },
    candidate: { full_name: 'Clinton Tamunosiki Iwoloma', email: 'clinton@example.com', phone: '+234 800 000 0000' },
    template: {
      company_info: { name: 'Infinity Microfinance Bank Ltd', address: '', email: '', phone: '', website: '', tagline: '' },
      signatories: { hr_name: 'Human Resources Manager', hr_title: 'Human Resources Manager', md_name: 'Managing Director', md_title: 'Managing Director', department: 'Human Resources Department' },
      opening: 'With reference to your application and the subsequent interview(s) conducted with us, we are pleased to offer you employment with {{company_name}} on the terms and conditions set out below.',
      sections: DEFAULT_SECTIONS,
    },
    workHours: { start_time: '07:30', end_time: '17:00', break_duration_minutes: 60, working_days: ['mon', 'tue', 'wed', 'thu', 'fri'], leave_annual_days: 21 },
    currency: { currency_code: 'NGN', currency_symbol: '₦', currency_position: 'prefix', currency_decimal_places: 2 },
  })
  const pdf = await offerLetterHtmlToPdf(html, 'offer-letter-sample.pdf')
  return { html, bytes: Array.from(new Uint8Array(await pdf.arrayBuffer())), size: pdf.size }
})

const outputPdf = process.env.OFFER_PDF_OUTPUT || '/var/folders/hv/0v5v1t9n7vd0bwdbttx8ygw40000gn/T/opencode/offer-letter-sample.pdf'
const outputHtml = outputPdf.replace(/\.pdf$/i, '.html')
fs.writeFileSync(outputHtml, result.html, 'utf8')
fs.writeFileSync(outputPdf, Buffer.from(result.bytes))
console.log(JSON.stringify({ htmlBytes: Buffer.byteLength(result.html), pdfBytes: result.size, pdfPath: outputPdf }))
await browser.close()
