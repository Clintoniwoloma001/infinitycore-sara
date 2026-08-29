import React, { useEffect, useState } from 'react'
import { Copy, Link2, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import { status, date } from './hrShared'
import { onboardingService, DEFAULT_EXPIRY_DAYS } from '../services/onboardingService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

export default function OnboardingLinks() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('hr.onboarding.manage')

  const [links, setLinks] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingSubs, setLoadingSubs] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdLink, setCreatedLink] = useState(null)
  const [copied, setCopied] = useState('')
  const [form, setForm] = useState({})

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    setError('')
    try {
      const data = await onboardingService.listLinks()
      setLinks(data)
    } catch (e) {
      setError(e?.message || 'Unable to load onboarding links')
    } finally {
      setLoading(false)
    }
  }

  const loadSubs = async () => {
    try {
      const data = await onboardingService.listSubmissions()
      setSubmissions(data)
    } catch {
      setSubmissions([])
    } finally {
      setLoadingSubs(false)
    }
  }

  useEffect(() => {
    load()
    loadSubs()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const create = async () => {
    setError('')
    setCreating(true)
    try {
      const link = await onboardingService.createLink({
        candidateName: form.candidate_name,
        candidateEmail: form.candidate_email,
        candidatePhone: form.candidate_phone,
        position: form.position,
        department: form.department,
        branch: form.branch,
        employmentType: form.employment_type,
        expiresInDays: form.expires_in_days == null ? DEFAULT_EXPIRY_DAYS : form.expires_in_days,
      })
      setCreatedLink(link)
      setForm({})
      await load(false)
    } catch (e) {
      setError(e?.message || 'Failed to create link')
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (id) => {
    await onboardingService.revokeLink(id)
    await load(false)
  }

  // A raw token only exists in the candidate's browser after creation, so
  // "Resend" regenerates a brand-new link for the same person and revokes
  // the old one. We never store raw tokens — only their hash.
  const resend = async (link) => {
    setError('')
    setCreatedLink(null)
    setForm({
      candidate_name: link.candidate_name,
      candidate_email: link.candidate_email,
      candidate_phone: link.candidate_phone,
      position: link.position,
      department: link.department,
      branch: link.branch,
      employment_type: link.employment_type,
      expires_in_days: DEFAULT_EXPIRY_DAYS,
    })
    setShowCreate(true)
    try {
      const fresh = await onboardingService.createLink({
        candidateName: link.candidate_name,
        candidateEmail: link.candidate_email,
        candidatePhone: link.candidate_phone,
        position: link.position,
        department: link.department,
        branch: link.branch,
        employmentType: link.employment_type,
        expiresInDays: DEFAULT_EXPIRY_DAYS,
      })
      setCreatedLink(fresh)
      setForm({})
      await onboardingService.revokeLink(link.id)
      await load(false)
    } catch (e) {
      setError(e?.message || 'Failed to regenerate link')
    }
  }

  const copyLink = async (url, id) => {
    await copyText(url)
    setCopied(id)
    setTimeout(() => setCopied(''), 1500)
  }

  const stats = {
    total: links.length,
    submitted: links.filter((l) => l.status === 'submitted').length,
    opened: links.filter((l) => ['opened', 'in_progress'].includes(l.status)).length,
    pending: links.filter((l) => l.status === 'pending').length,
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Onboarding Links</h2>
          <p className="text-sm text-slate-500 mt-1">Generate secure one-time links for new employees to complete their profile.</p>
        </div>
        {canManage && (
          <button onClick={() => { setShowCreate(true); setCreatedLink(null); setError(''); setForm((f) => ({ ...f, expires_in_days: DEFAULT_EXPIRY_DAYS })) }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> New Link
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total', value: stats.total, color: 'text-slate-900' },
          { label: 'Pending', value: stats.pending, color: 'text-amber-600' },
          { label: 'In Progress', value: stats.opened, color: 'text-blue-600' },
          { label: 'Submitted', value: stats.submitted, color: 'text-[#009944]' },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-lg border border-slate-200 p-4">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {error && <ErrorState message={error} />}
      {loading && <LoadingState label="Loading onboarding links..." />}
      {!loading && !error && links.length === 0 && <EmptyState title="No onboarding links yet" description="Generate a one-time link for a new hire to begin onboarding." />}
      {!loading && !error && links.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto mb-10">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Candidate</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Position</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Expires</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Status</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {links.map((link) => (
                <tr key={link.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3">
                    <div className="font-medium text-slate-900">{link.candidate_name}</div>
                    <div className="text-xs text-slate-400">{link.candidate_email || link.candidate_phone || '-'}</div>
                  </td>
                  <td className="px-6 py-3 text-slate-600">{link.position || '-'}{link.department ? ` · ${link.department}` : ''}</td>
                  <td className="px-6 py-3 text-slate-600">{date(link.expiry)}</td>
                  <td className="px-6 py-3">{status(link.status, ['submitted', 'active'])}</td>
                  <td className="px-6 py-3">
                    <div className="flex justify-end gap-2">
                      {link.status !== 'revoked' && link.status !== 'submitted' && (
                        <>
                          {canManage && (
                            <button
                              onClick={() => resend(link)}
                              title="Generate a fresh link for this candidate and revoke the old one"
                              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100"
                            >
                              <RefreshCw className="w-3.5 h-3.5" /> Resend
                            </button>
                          )}
                          {canManage && (
                            <button onClick={() => revoke(link.id)} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-rose-300 text-rose-600 text-xs hover:bg-rose-50">
                              <Trash2 className="w-3.5 h-3.5" /> Revoke
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="text-lg font-semibold text-slate-900 mb-3">Submissions</h3>
      {loadingSubs && <LoadingState label="Loading submissions..." />}
      {!loadingSubs && submissions.length === 0 && <EmptyState title="No submissions yet" description="Submitted onboarding forms will appear here for review." />}
      {!loadingSubs && submissions.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Candidate</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Position</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Submitted</th>
                <th className="px-6 py-3 font-medium whitespace-nowrap">Declaration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {submissions.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3">
                    <div className="font-medium text-slate-900">{s.candidate_name}</div>
                    <div className="text-xs text-slate-400">{s.email || s.phone || '-'}</div>
                  </td>
                  <td className="px-6 py-3 text-slate-600">{s.position || '-'} {s.department ? `· ${s.department}` : ''}</td>
                  <td className="px-6 py-3 text-slate-600">{date(s.submitted_at)}</td>
                  <td className="px-6 py-3">{String(s.declaration_accepted) === 'true' || s.declaration_accepted === true ? status('accepted', ['accepted']) : status('declined')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">{createdLink ? 'Link generated' : 'New Onboarding Link'}</h3>
              <button onClick={() => { setShowCreate(false); setError('') }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            {createdLink ? (
              <div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 mb-4">
                  <p className="flex items-center gap-1.5 font-medium"><Link2 className="w-4 h-4" /> Copy this link and send it to the candidate.</p>
                  <p className="mt-1 text-emerald-700">It is only shown once and expires {date(createdLink.expiry)}.</p>
                </div>
                <div className="flex items-center gap-2">
                  <input readOnly value={createdLink.url} className={inputCls} />
                  <button onClick={() => copyLink(createdLink.url, 'new')} className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] whitespace-nowrap">
                    <Copy className="w-4 h-4" /> {copied === 'new' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <button onClick={() => { setShowCreate(false); setCreatedLink(null) }} className="mt-4 text-sm font-medium text-[#009944] hover:underline">Done</button>
              </div>
            ) : (
              <div className="space-y-4">
                {error && <ErrorState message={error} />}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2"><label className={labelCls}>Candidate Name *</label><input className={inputCls} value={form.candidate_name || ''} onChange={set('candidate_name')} /></div>
                  <div><label className={labelCls}>Email</label><input className={inputCls} value={form.candidate_email || ''} onChange={set('candidate_email')} type="email" /></div>
                  <div><label className={labelCls}>Phone</label><input className={inputCls} value={form.candidate_phone || ''} onChange={set('candidate_phone')} /></div>
                  <div><label className={labelCls}>Position</label><input className={inputCls} value={form.position || ''} onChange={set('position')} /></div>
                  <div><label className={labelCls}>Department</label><input className={inputCls} value={form.department || ''} onChange={set('department')} /></div>
                  <div><label className={labelCls}>Branch</label><input className={inputCls} value={form.branch || ''} onChange={set('branch')} /></div>
                  <div>
                    <label className={labelCls}>Employment Type</label>
                    <select className={inputCls} value={form.employment_type || ''} onChange={set('employment_type')}>
                      <option value="">Full-time</option>
                      <option value="full_time">Full-time</option>
                      <option value="part_time">Part-time</option>
                      <option value="contract">Contract</option>
                      <option value="intern">Intern</option>
                    </select>
                  </div>
                  <div><label className={labelCls}>Expires in (days)</label><input className={inputCls} value={form.expires_in_days ?? ''} onChange={set('expires_in_days')} type="number" min="1" step="1" placeholder={`Default ${DEFAULT_EXPIRY_DAYS}`} /></div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                  <button onClick={create} disabled={creating} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                    {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Generate link
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}