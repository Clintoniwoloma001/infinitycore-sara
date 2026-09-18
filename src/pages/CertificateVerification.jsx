import React, { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, Loader2, ShieldCheck, XCircle } from 'lucide-react'
import { useParams } from 'react-router-dom'
import TrainingCertificate from '../components/training/TrainingCertificate'
import { downloadBlob, trainingCertificateToPdf } from '../lib/trainingCertificatePdf'
import { trainingService } from '../services/trainingService'
import { recordTrainingDownload } from '../services/trainingService'
import { formatTrainingType } from '../services/trainingService'
import { formatDate } from '../lib/utils'

export default function CertificateVerification() {
  const { certificateNumber } = useParams()
  const [certificate, setCertificate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const previewRef = useRef(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    trainingService.verifyCertificate(decodeURIComponent(certificateNumber || ''))
      .then((data) => { if (active) setCertificate(data?.valid ? data : null) })
      .catch((e) => { if (active) setError(e?.message || 'Certificate verification is unavailable.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [certificateNumber])

  const download = async () => {
    if (!previewRef.current || !certificate) return
    setBusy(true); setError('')
    try {
      const blob = await trainingCertificateToPdf(previewRef.current, `${certificate.certificate_number}.pdf`)
      downloadBlob(blob, `${certificate.certificate_number}.pdf`)
      await recordTrainingDownload(certificate)
    } catch (e) {
      setError(e?.message || 'Certificate PDF could not be generated.')
    } finally { setBusy(false) }
  }

  return <div className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12"><div className="max-w-6xl mx-auto"><div className="flex items-center justify-between gap-4 mb-8"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#009944]">Infinity Bank</p><h1 className="text-2xl font-semibold text-slate-900 mt-1">Certificate verification</h1><p className="text-sm text-slate-500 mt-1">Public verification confirms the certificate number and validity without exposing employee account data.</p></div><ShieldCheck className="w-10 h-10 text-[#009944]" /></div>{loading && <div className="bg-white border border-slate-200 rounded-xl p-10 flex items-center justify-center gap-3 text-sm text-slate-500"><Loader2 className="w-5 h-5 animate-spin text-[#009944]" />Checking certificate...</div>}{!loading && error && <div className="bg-white border border-rose-200 rounded-xl p-8 text-center"><XCircle className="w-10 h-10 text-rose-500 mx-auto" /><h2 className="font-semibold text-slate-900 mt-3">Verification unavailable</h2><p className="text-sm text-slate-500 mt-1">{error}</p></div>}{!loading && !error && !certificate && <div className="bg-white border border-amber-200 rounded-xl p-8 text-center"><XCircle className="w-10 h-10 text-amber-500 mx-auto" /><h2 className="font-semibold text-slate-900 mt-3">Certificate not valid</h2><p className="text-sm text-slate-500 mt-1">No valid Infinity Bank certificate matches this number.</p></div>}{!loading && !error && certificate && <><div className="bg-white border border-emerald-200 rounded-xl p-5 mb-5"><div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"><div className="flex items-center gap-3"><CheckCircle2 className="w-8 h-8 text-emerald-600" /><div><p className="text-sm font-semibold text-emerald-800">Certificate valid</p><p className="text-xs text-slate-500 mt-1">{certificate.certificate_number} · Issued {formatDate(certificate.issued_at)}</p></div></div><button disabled={busy} onClick={download} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60"><Download className="w-4 h-4" /> Download PDF</button></div><div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5"><Meta label="Issued to" value={certificate.employee_name} /><Meta label="Training" value={certificate.training_title} /><Meta label="Type" value={formatTrainingType(certificate.training_type)} /></div></div><div className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-100 p-4"><TrainingCertificate ref={previewRef} certificate={certificate} /></div></>}</div></div>
}

function Meta({ label, value }) { return <div className="rounded-lg bg-slate-50 border border-slate-100 p-3"><p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p><p className="text-sm font-medium text-slate-700 mt-1 break-words">{value || '—'}</p></div> }
