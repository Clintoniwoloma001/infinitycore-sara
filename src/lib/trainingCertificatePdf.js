let html2pdfPromise

async function loadHtml2Pdf() {
  html2pdfPromise ||= import('html2pdf.js').then((module) => module.default || module)
  return html2pdfPromise
}

export async function trainingCertificateToPdf(element, filename = 'infinity-bank-training-certificate.pdf') {
  if (!element) throw new Error('Certificate preview is not available.')
  const html2pdf = await loadHtml2Pdf()
  const worker = html2pdf().set({
    margin: 0,
    filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape', compress: true },
    pagebreak: { mode: ['css', 'legacy'], avoid: ['.training-certificate'] },
  }).from(element).toPdf()
  return worker.output('blob')
}

export function downloadBlob(blob, filename) {
  if (!blob) throw new Error('No PDF was generated.')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
