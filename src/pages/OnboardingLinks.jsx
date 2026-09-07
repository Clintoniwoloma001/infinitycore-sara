import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Archive, ArchiveRestore, Briefcase, CheckCircle2, Clock, Copy, Eye,
  Link2, Loader2, Plus, RefreshCw, Search, Trash2, User, X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { EmptyState, ErrorState, LoadingState } from '../components/PageStates'
import OnboardingReviewCenter from '../components/review/OnboardingReviewCenter'
import { status, date } from './hrShared'
import { onboardingService, DEFAULT_EXPIRY_DAYS } from '../services/onboardingService'
import { guarantorVerificationService } from '../services/guarantorVerificationService'
import { payrollService } from '../services/payrollService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

async function copyText(text) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  }
}

// ---- Status helpers ----

const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'review', label: 'Review' },
  { id: 'completed', label: 'Completed' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'revoked', label: 'Revoked' },
  { id: 'expired', label: 'Expired' },
  { id: 'archived', label: 'Archived' },
]

function getProgressLabel(link) {
  if (link.is_archived) return 'Archived'
  const s = link.status
  if (s === 'REVOKED') return 'Revoked'
  if (s === 'EXPIRED') return 'Expired'
  if (['PENDING', 'OPENED', 'IN_PROGRESS'].includes(s)) return 'Awaiting candidate'
  if (s === 'SUBMITTED' && link.submission) {
    const os = link.submission.onboarding_status
    if (os === 'completed') return 'Completed'
    if (os === 'approved') return 'Approved'
    if (os === 'rejected') return 'Rejected'
    if (os === 'correction_requested') return 'Correction requested'
    if (os === 'guarantor_submitted') return 'Guarantor submitted'
    if (os === 'pending_guarantor') return 'Guarantor pending'
    if (os === 'under_review') return 'HR review pending'
    return 'HR review pending'
  }
  if (s === 'SUBMITTED') return 'Awaiting HR review'
  return '—'
}

function progressBadge(link) {
  const label = getProgressLabel(link)
  const cls = {
    'Completed': 'bg-emerald-50 text-emerald-700 border-emerald-200',
    'Approved': 'bg-emerald-50 text-emerald-700 border-emerald-200',
    'Rejected': 'bg-rose-50 text-rose-700 border-rose-200',
    'Revoked': 'bg-slate-100 text-slate-500 border-slate-200',
    'Expired': 'bg-slate-100 text-slate-500 border-slate-200',
    'Archived': 'bg-slate-100 text-slate-400 border-slate-200',
    'Correction requested': 'bg-amber-50 text-amber-700 border-amber-200',
    'Guarantor pending': 'bg-amber-50 text-amber-700 border-amber-200',
    'Guarantor submitted': 'bg-blue-50 text-blue-700 border-blue-200',
    'HR review pending': 'bg-blue-50 text-blue-700 border-blue-200',
    'Awaiting candidate': 'bg-amber-50 text-amber-700 border-amber-200',
    'Awaiting HR review': 'bg-blue-50 text-blue-700 border-blue-200',
  }
  return { label, cls: cls[label] || 'bg-slate-50 text-slate-600 border-slate-200' }
}

function linkTabFilter(link) {
  if (link.is_archived) return 'archived'
  const s = link.status
  if (s === 'REVOKED') return 'revoked'
  if (s === 'EXPIRED') return 'expired'
  if (['PENDING', 'OPENED', 'IN_PROGRESS'].includes(s)) return 'active'
  if (s === 'SUBMITTED' && link.submission) {
    const os = link.submission.onboarding_status
    if (os === 'completed' || os === 'approved') return 'completed'
    if (os === 'rejected') return 'rejected'
    return 'review'
  }
  if (s === 'SUBMITTED') return 'review'
  return 'active'
}

export default function OnboardingLinks() {
  const navigate = useNavigate()
  const { hasPermission, user } = useAuth()
  const canManage = hasPermission('hr.onboarding.manage')

  const [links, setLinks] = useState([])
  const [submissions, setSubmissions] = useState([])
  const [activeTab, setActiveTab] = useState('active')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toast, setToast] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdLink, setCreatedLink] = useState(null)
  const [copied, setCopied] = useState('')
  const [form, setForm] = useState({})
  const [reviewSubmission, setReviewSubmission] = useState(null)
  const [archiveTarget, setArchiveTarget] = useState(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [payrollTarget, setPayrollTarget] = useState(null)
  const [payrollPeriods, setPayrollPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [payrollBusy, setPayrollBusy] = useState(false)

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    setError('')
    try {
      const [linkData, subData] = await Promise.all([
        onboardingService.listLinks(),
        onboardingService.listSubmissions(),
      ])
      setLinks(linkData)
      setSubmissions(subData)
    } catch (e) {
      setError(e?.message || 'Unable to load onboarding links')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Join links with submissions
  const rows = useMemo(() => {
    const subMap = new Map()
    submissions.forEach((s) => { if (s.link_id) subMap.set(s.link_id, s) })
    return links.map((link) => ({ ...link, submission: subMap.get(link.id) || null }))
  }, [links, submissions])

  // Tab counts
  const tabCounts = useMemo(() => {
    const counts = { active: 0, review: 0, completed: 0, rejected: 0, revoked: 0, expired: 0, archived: 0 }
    rows.forEach((r) => { counts[linkTabFilter(r)]++ })
    return counts
  }, [rows])

  // Filtered rows
  const filteredRows = useMemo(() => {
    let filtered = rows.filter((r) => linkTabFilter(r) === activeTab)
    const q = search.trim().toLowerCase()
    if (q) {
      filtered = filtered.filter((r) =>
        r.candidate_name?.toLowerCase().includes(q) ||
        r.candidate_email?.toLowerCase().includes(q) ||
        r.candidate_phone?.toLowerCase().includes(q) ||
        r.position?.toLowerCase().includes(q) ||
        r.department?.toLowerCase().includes(q)
      )
    }
    return filtered
  }, [rows, activeTab, search])

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
        createdBy: user?.id,
      })
      setCreatedLink(link)
      setForm({})
      await load(false)
      showToast('Onboarding link created.')
    } catch (e) {
      setError(e?.message || 'Failed to create link')
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (id) => {
    try {
      await onboardingService.revokeLink(id)
      await load(false)
      showToast('Link revoked.')
    } catch (e) {
      setError(e?.message || 'Failed to revoke link')
    }
  }

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
        createdBy: user?.id,
      })
      setCreatedLink(fresh)
      setForm({})
      await onboardingService.revokeLink(link.id)
      await load(false)
      showToast('New link generated and old one revoked.')
    } catch (e) {
      setError(e?.message || 'Failed to regenerate link')
    }
  }

  const archive = async (link) => {
    setArchiveBusy(true)
    try {
      await onboardingService.archiveLink(link.id, user?.id)
      await load(false)
      setArchiveTarget(null)
      showToast('Link archived. History preserved.')
    } catch (e) {
      setError(e?.message || 'Failed to archive link')
    } finally {
      setArchiveBusy(false)
    }
  }

  const restore = async (link) => {
    try {
      await onboardingService.restoreLink(link.id)
      await load(false)
      showToast('Link restored from archive.')
    } catch (e) {
      setError(e?.message || 'Failed to restore link')
    }
  }

  const copyLink = async (url, id) => {
    await copyText(url)
    setCopied(id)
    setTimeout(() => setCopied(''), 1500)
  }

  const openPayroll = async (link) => {
    setPayrollTarget(link)
    setSelectedPeriod('')
    try {
      const periods = await payrollService.listPeriods()
      setPayrollPeriods(periods)
    } catch { setPayrollPeriods([]) }
  }

  const addToPayroll = async () => {
    if (!selectedPeriod || !payrollTarget?.submission?.employee_id) return
    setPayrollBusy(true)
    try {
      await guarantorVerificationService.addToPayroll(
        payrollTarget.submission.employee_id,
        selectedPeriod,
        payrollTarget.submission?.payload?.salary || null,
      )
      setPayrollTarget(null)
      showToast('Employee added to payroll.')
    } catch (e) {
      setError(e?.message || 'Failed to add to payroll')
    } finally {
      setPayrollBusy(false)
    }
  }

  // ---- Row actions renderer ----
  const renderActions = (link) => {
    const tab = linkTabFilter(link)
    const actions = []

    if (tab === 'active') {
      if (canManage) {
        actions.push(
          <button key="resend" onClick={() => resend(link)} title="Generate a fresh link and revoke this one"
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
            <RefreshCw className="w-3.5 h-3.5" /> Resend
          </button>
        )
        actions.push(
          <button key="revoke" onClick={() => revoke(link.id)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-rose-300 text-rose-600 text-xs hover:bg-rose-50">
            <Trash2 className="w-3.5 h-3.5" /> Revoke
          </button>
        )
      }
    } else if (tab === 'review') {
      if (link.submission) {
        actions.push(
          <button key="review" onClick={() => setReviewSubmission(link.submission)}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36]">
            <Eye className="w-3.5 h-3.5" /> Review
          </button>
        )
      }
      if (canManage) {
        actions.push(
          <button key="revoke-r" onClick={() => revoke(link.id)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-rose-300 text-rose-600 text-xs hover:bg-rose-50">
            <Trash2 className="w-3.5 h-3.5" /> Revoke
          </button>
        )
      }
    } else if (tab === 'completed') {
      if (link.submission?.employee_id) {
        actions.push(
          <button key="view-emp" onClick={() => navigate(`/employees/${link.submission.employee_id}`)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
            <User className="w-3.5 h-3.5" /> View Employee
          </button>
        )
      }
      if (link.submission) {
        actions.push(
          <button key="review-c" onClick={() => setReviewSubmission(link.submission)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
            <Eye className="w-3.5 h-3.5" /> Record
          </button>
        )
      }
      if (canManage && link.submission?.employee_id) {
        actions.push(
          <button key="payroll" onClick={() => openPayroll(link)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-violet-600 text-white text-xs font-medium hover:bg-violet-700">
            <Briefcase className="w-3.5 h-3.5" /> Payroll
          </button>
        )
      }
    } else if (tab === 'rejected') {
      if (link.submission) {
        actions.push(
          <button key="review-rj" onClick={() => setReviewSubmission(link.submission)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
            <Eye className="w-3.5 h-3.5" /> View
          </button>
        )
      }
    } else if (tab === 'revoked') {
      if (canManage) {
        actions.push(
          <button key="archive" onClick={() => setArchiveTarget(link)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
            <Archive className="w-3.5 h-3.5" /> Archive
          </button>
        )
      }
    } else if (tab === 'expired') {
      if (canManage) {
        actions.push(
          <button key="resend-e" onClick={() => resend(link)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
            <RefreshCw className="w-3.5 h-3.5" /> New Link
          </button>
        )
        actions.push(
          <button key="archive-e" onClick={() => setArchiveTarget(link)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
            <Archive className="w-3.5 h-3.5" /> Archive
          </button>
        )
      }
    } else if (tab === 'archived') {
      if (canManage) {
        actions.push(
          <button key="restore" onClick={() => restore(link)}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-emerald-300 text-emerald-600 text-xs hover:bg-emerald-50">
            <ArchiveRestore className="w-3.5 h-3.5" /> Restore
          </button>
        )
      }
    }

    return <div className="flex justify-end gap-1.5">{actions}</div>
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Onboarding Links</h2>
          <p className="text-sm text-slate-500 mt-1">Generate secure one-time links for new employees to complete their onboarding.</p>
        </div>
        {canManage && (
          <button onClick={() => { setShowCreate(true); setCreatedLink(null); setError(''); setForm((f) => ({ ...f, expires_in_days: DEFAULT_EXPIRY_DAYS })) }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <Plus className="w-4 h-4" /> New Link
          </button>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`mb-4 rounded-lg border px-4 py-3 text-sm flex items-center gap-2 ${toast.type === 'error' ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          <CheckCircle2 className="w-4 h-4" /> {toast.msg}
        </div>
      )}

      {error && <div className="mb-4"><ErrorState message={error} /></div>}

      {/* Status tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 border-b border-slate-200">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2 rounded-t-lg text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-[#009944] text-[#009944]'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.label}
            <span className={`ml-1.5 text-xs ${activeTab === tab.id ? 'text-[#009944]' : 'text-slate-400'}`}>
              ({tabCounts[tab.id] || 0})
            </span>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative w-full sm:w-80 mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidate, email, position…"
          className="w-full h-10 pl-9 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
        />
      </div>

      {/* Table */}
      {loading && <LoadingState label="Loading onboarding links..." />}
      {!loading && !error && filteredRows.length === 0 && (
        <EmptyState
          title={`No ${activeTab} onboarding links`}
          description={activeTab === 'active' ? 'Generate a one-time link for a new hire to begin onboarding.' : `There are no onboarding links in the ${activeTab} category.`}
        />
      )}
      {!loading && !error && filteredRows.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left">
              <tr>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Candidate</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap hidden md:table-cell">Email</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Position</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap hidden lg:table-cell">Department</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap hidden md:table-cell">Created</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap hidden md:table-cell">Expires</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Status</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap">Progress</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap hidden lg:table-cell">Last Activity</th>
                <th className="px-4 py-3 font-medium whitespace-nowrap text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRows.map((link) => {
                const pb = progressBadge(link)
                const lastActivity = link.submission?.submitted_at || link.submitted_at || link.opened_at || link.updated_at || link.created_at
                return (
                  <tr key={link.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{link.candidate_name}</div>
                      <div className="text-xs text-slate-400 md:hidden">{link.candidate_email || link.candidate_phone || '-'}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600 hidden md:table-cell">{link.candidate_email || link.candidate_phone || '-'}</td>
                    <td className="px-4 py-3 text-slate-600">{link.position || '-'}</td>
                    <td className="px-4 py-3 text-slate-600 hidden lg:table-cell">{link.department || '-'}</td>
                    <td className="px-4 py-3 text-slate-600 hidden md:table-cell">{date(link.created_at)}</td>
                    <td className="px-4 py-3 text-slate-600 hidden md:table-cell">{date(link.expiry)}</td>
                    <td className="px-4 py-3">{status(link.status, ['SUBMITTED'])}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${pb.cls}`}>
                        {pb.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600 hidden lg:table-cell">{date(lastActivity)}</td>
                    <td className="px-4 py-3">{renderActions(link)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Create link modal ---- */}
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

      {/* ---- Archive confirmation ---- */}
      {archiveTarget && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center gap-2 mb-3">
              <Archive className="w-5 h-5 text-slate-500" />
              <h4 className="text-base font-semibold text-slate-900">Archive this onboarding link?</h4>
            </div>
            <p className="text-sm text-slate-600 mb-1">This will remove the link from your active operational records but preserve the onboarding history and audit trail.</p>
            <p className="text-sm text-slate-500 mb-4">Candidate: <span className="font-medium text-slate-700">{archiveTarget.candidate_name}</span></p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setArchiveTarget(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button
                onClick={() => archive(archiveTarget)}
                disabled={archiveBusy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-700 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
              >
                {archiveBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />} Archive
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Payroll modal ---- */}
      {payrollTarget && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <h4 className="text-base font-semibold text-slate-900 mb-3">Add to Payroll</h4>
            <p className="text-sm text-slate-500 mb-3">Employee: <span className="font-medium text-slate-700">{payrollTarget.candidate_name}</span></p>
            <label className={labelCls}>Payroll Period</label>
            <select className={inputCls} value={selectedPeriod} onChange={(e) => setSelectedPeriod(e.target.value)}>
              <option value="">Select a period…</option>
              {payrollPeriods.map((p) => <option key={p.id} value={p.period_label}>{p.period_label} ({p.status})</option>)}
            </select>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setPayrollTarget(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button
                onClick={addToPayroll}
                disabled={payrollBusy || !selectedPeriod}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50"
              >
                {payrollBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Briefcase className="w-4 h-4" />} Add to Payroll
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Review Center ---- */}
      {reviewSubmission && (
        <OnboardingReviewCenter
          submission={reviewSubmission}
          onClose={() => setReviewSubmission(null)}
          onRefresh={() => load(false)}
        />
      )}
    </div>
  )
}
