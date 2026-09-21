import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, BadgeCheck, CheckCircle2, FileText, Loader2, XCircle } from 'lucide-react'
import CareersShell from './CareersShell'
import { careerService } from '../../services/careerService'
import { formatCurrency, formatDate } from '../../lib/utils'
import { ErrorState } from '../../components/PageStates'

export default function OfferAcceptance() {
  const { token } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState(null) // accept | decline
  const [signature, setSignature] = useState('')
  const [comments, setComments] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState('')
  const [done, setDone] = useState(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const res = await careerService.getOffer(token)
        if (active) setData(res)
      } catch (e) {
        if (active) setError(e?.message || 'This offer could not be loaded.')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [token])

  const submit = async (decision) => {
    setActionError('')
    if (decision === 'accept' && signature.trim().length < 2) {
      setActionError('Please type your full name to sign your acceptance.')
      return
    }
    setSubmitting(true)
    try {
      const res = await careerService.respondToOffer(token, decision, decision === 'accept' ? signature.trim() : null, { comments: comments.trim() })
      setDone({ ...res, decision })
    } catch (e) {
      setActionError(e?.message || 'Your response could not be submitted. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <CareersShell compact><div className="flex items-center justify-center py-20 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading offer…</div></CareersShell>
  }
  if (error) {
    return (
      <CareersShell compact>
        <ErrorState message={error}>
          <Link to="/careers" className="inline-flex items-center gap-1.5 mt-4 text-sm font-medium text-[#009944] hover:underline">Back to jobs</Link>
        </ErrorState>
      </CareersShell>
    )
  }

  const { offer, candidate } = data

  if (done) {
    const accepted = done.decision === 'accept'
    return (
      <CareersShell compact>
        <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl p-8 text-center">
          {accepted ? <CheckCircle2 className="w-14 h-14 text-[#009944] mx-auto mb-4" /> : <XCircle className="w-14 h-14 text-rose-500 mx-auto mb-4" />}
          <h1 className="text-xl font-bold text-slate-900">{accepted ? 'Offer accepted — welcome to Infinity Microfinance Bank' : 'Offer declined'}</h1>
          <p className="text-sm text-slate-500 mt-2">
            {accepted
              ? 'Thank you. Your onboarding link has been generated — check your email for the next steps, or continue via your candidate portal.'
              : 'Thank you for letting us know. We wish you the very best in your career.'}
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            {accepted && candidate?.application_token_hash && (
              <Link to={`/careers/portal/${token}`} className="inline-flex items-center justify-center rounded-lg bg-[#009944] text-white px-5 py-2.5 text-sm font-medium hover:bg-[#00813a]">Open my candidate portal</Link>
            )}
            <Link to="/careers" className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">Browse roles</Link>
          </div>
        </div>
      </CareersShell>
    )
  }

  const bodyHtml = offer?.body_content || '<!doctype html><html><body><p>Offer letter follows.</p></body></html>'

  return (
    <CareersShell compact>
      <div className="max-w-2xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-2xl p-8 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <BadgeCheck className="w-5 h-5 text-[#009944]" />
              <h1 className="text-lg font-bold text-slate-900">Employment offer</h1>
            </div>
            <span className="text-xs text-slate-400">Offer no. {offer.offer_number || '—'} · v{offer.version || 1}</span>
          </div>

          <div className="border border-slate-200 bg-slate-100 min-h-[920px]">
            <iframe
              title="Infinity Microfinance Bank offer letter"
              srcDoc={bodyHtml}
              sandbox="allow-same-origin"
              className="w-full min-h-[920px] bg-white"
            />
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6 pt-5 border-t border-slate-100 text-sm">
            <div><dt className="text-xs text-slate-400 uppercase">Position</dt><dd className="font-medium text-slate-800 mt-0.5">{offer.position}</dd></div>
            <div><dt className="text-xs text-slate-400 uppercase">Start date</dt><dd className="font-medium text-slate-800 mt-0.5">{formatDate(offer.start_date)}</dd></div>
            <div><dt className="text-xs text-slate-400 uppercase">Annual salary</dt><dd className="font-medium text-slate-800 mt-0.5">{formatCurrency(offer.annual_salary)}</dd></div>
            <div><dt className="text-xs text-slate-400 uppercase">Monthly</dt><dd className="font-medium text-slate-800 mt-0.5">{formatCurrency(offer.monthly_salary)}</dd></div>
            {offer.probation_months > 0 && <div><dt className="text-xs text-slate-400 uppercase">Probation</dt><dd className="font-medium text-slate-800 mt-0.5">{offer.probation_months} month{offer.probation_months > 1 ? 's' : ''}</dd></div>}
            {offer.employment_type && <div><dt className="text-xs text-slate-400 uppercase">Type</dt><dd className="font-medium text-slate-800 mt-0.5 capitalize">{offer.employment_type.replace('_', ' ')}</dd></div>}
          </dl>

          {offer.acceptance_deadline && (
            <p className="mt-5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 inline-flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" /> Please respond by {formatDate(offer.acceptance_deadline)}.
            </p>
          )}
        </div>

        {mode === null && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button onClick={() => setMode('accept')} className="rounded-xl bg-[#009944] text-white p-5 text-left hover:bg-[#00813a] transition">
              <CheckCircle2 className="w-8 h-8 mb-2" />
              <p className="font-semibold">Accept offer</p>
              <p className="text-xs text-white/80 mt-1">Accept and continue to onboarding.</p>
            </button>
            <button onClick={() => setMode('decline')} className="rounded-xl border-2 border-slate-200 p-5 text-left text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 transition">
              <XCircle className="w-8 h-8 mb-2" />
              <p className="font-semibold">Decline offer</p>
              <p className="text-xs text-slate-400 mt-1">Politely decline this offer.</p>
            </button>
          </div>
        )}

        {mode === 'accept' && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6">
            <h2 className="text-sm font-semibold text-slate-900 mb-1">Accept the offer</h2>
            <p className="text-xs text-slate-500 mb-4">Type your full legal name as an electronic signature.</p>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Full name *</label>
            <input
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder={`${candidate?.full_name || 'Your full name'}`}
              className="w-full h-11 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
            />
            <label className="block text-sm font-medium text-slate-700 mb-1.5 mt-4">Comments (optional)</label>
            <textarea rows="3" value={comments} onChange={(e) => setComments(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" placeholder="Notes for the recruitment team…" />
            {actionError && <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mt-3">{actionError}</p>}
            <div className="flex gap-3 mt-4">
              <button onClick={() => submit('accept')} disabled={submitting} className="flex-1 rounded-lg bg-[#009944] text-white py-2.5 text-sm font-semibold hover:bg-[#00813a] disabled:opacity-60">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Accept & continue'}
              </button>
              <button onClick={() => setMode(null)} className="rounded-lg border border-slate-300 px-4 text-sm text-slate-600 hover:bg-slate-50">Back</button>
            </div>
          </div>
        )}

        {mode === 'decline' && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6">
            <h2 className="text-sm font-semibold text-slate-900 mb-1">Decline the offer</h2>
            <p className="text-xs text-slate-500 mb-4">Reason (optional) — this stays confidential within HR.</p>
            <textarea rows="3" value={comments} onChange={(e) => setComments(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" placeholder="Let us know why…" />
            {actionError && <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mt-3">{actionError}</p>}
            <div className="flex gap-3 mt-4">
              <button onClick={() => submit('decline')} disabled={submitting} className="flex-1 rounded-lg bg-rose-600 text-white py-2.5 text-sm font-semibold hover:bg-rose-700 disabled:opacity-60">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Confirm decline'}
              </button>
              <button onClick={() => setMode(null)} className="rounded-lg border border-slate-300 px-4 text-sm text-slate-600 hover:bg-slate-50">Back</button>
            </div>
          </div>
        )}
      </div>
    </CareersShell>
  )
}
