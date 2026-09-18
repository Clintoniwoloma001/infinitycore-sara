let html2pdfPromise

async function loadHtml2Pdf() {
  html2pdfPromise ||= import('html2pdf.js').then((module) => module.default || module)
  return html2pdfPromise
}

function waitForFrame(frame) {
  return new Promise((resolve) => {
    const finish = () => setTimeout(resolve, 80)
    if (frame.contentDocument?.readyState === 'complete') finish()
    else frame.addEventListener('load', finish, { once: true })
  })
}

export async function offerLetterHtmlToPdf(html, filename = 'offer-letter.pdf') {
  if (typeof document === 'undefined') throw new Error('PDF generation is only available in a browser.')
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;visibility:hidden;'
  document.body.appendChild(frame)
  try {
    frame.srcdoc = html
    await waitForFrame(frame)
    const source = frame.contentDocument?.querySelector('.document') || frame.contentDocument?.body
    if (!source) throw new Error('Offer document could not be prepared for PDF generation.')

    const options = {
      margin: [0, 0, 12, 0],
      filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
      pagebreak: {
        mode: ['css', 'legacy'],
        avoid: ['.summary-wrap', '.document-section', '.acceptance-block', '.signature-table', 'tr'],
      },
    }

    const html2pdf = await loadHtml2Pdf()
    const worker = html2pdf().set(options).from(source).toPdf()
    const pdf = await worker.get('pdf')
    const pages = pdf.internal.getNumberOfPages()
    for (let page = 1; page <= pages; page += 1) {
      pdf.setPage(page)
      pdf.setFont('times', 'normal')
      pdf.setFontSize(7.5)
      pdf.setTextColor(110, 120, 114)
      pdf.text(`Private & Confidential  |  Page ${page} of ${pages}`, 15, 290)
    }
    return await worker.output('blob')
  } finally {
    frame.remove()
  }
}

export function downloadBlob(blob, filename) {
  if (!blob) throw new Error('No file was generated.')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function openOfferPreview(html, { print = false, title = 'Offer Letter' } = {}) {
  const popup = window.open('', '_blank', 'noopener,noreferrer')
  if (!popup) throw new Error('Allow pop-ups to preview the offer letter.')
  popup.document.write(html)
  popup.document.close()
  popup.document.title = title
  if (print) setTimeout(() => popup.print(), 350)
  return popup
}

export default { offerLetterHtmlToPdf, downloadBlob, openOfferPreview }
