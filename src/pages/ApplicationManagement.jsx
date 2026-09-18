import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, Filter, Loader2 } from 'lucide-react'
import { ModuleTable, date } from './hrShared'
import { recruitmentService } from '../services/recruitmentService'
import { ErrorState } from '../components/PageStates'
import { StatusBadge } from '../lib/utils'

const STAT = {
  new: 'blue', received: 'slate', screening: 'blue', shortlisted: 'violet',
  assessment: 'violet', assessment_passed: 'teal', interview: 'cyan',
  interviewed: 'cyan', recommended: 'teal', offer: 'amber',
  offer_accepted: 'emerald', offer_declined: 'rose', guarantor: 'amber',
  onboarding: 'slate', hired: 'emerald', withdrawn: 'slate', rejected: 'rose',
}

export default function ApplicationManagement() {
  const [rows, setRows] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [jobFilter, setJobFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [category, setCategory] = useState('all')
  const [sortBy, setSortBy] = useState('newest')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [apps, jobList] = await Promise.all([
        recruitmentService.listApplications({ jobId: jobFilter || undefined, status: statusFilter || undefined }),
        recruitmentService.listJobs(),
      ])
      setRows(apps || [])
      setJobs(jobList || [])
    } catch (e) {
      setError(e?.message || 'Applications could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [jobFilter, statusFilter])

  const counts = useMemo(() => {
    const c = {}
    rows.forEach((r) => { c[r.application_status] = (c[r.application_status] || 0) + 1 })
    return c
  }, [rows])

  const displayRows = useMemo(() => rows.filter((row) => {
    if (category === 'best_match') return Number(row.match_score ?? row.screening_score ?? 0) >= 70
    if (category === 'talent_pool') return row.application_status === 'talent_pool'
    if (category === 'interview') return ['interview', 'interviewed', 'recommended'].includes(row.application_status)
    if (category === 'offer') return ['offer', 'offer_accepted', 'offer_declined'].includes(row.application_status)
    if (category === 'hired') return row.application_status === 'hired'
    if (category === 'blacklisted') return row.application_status === 'blacklisted'
    if (category === 'rejected') return row.application_status === 'rejected'
    if (category === 'assessment_pending') return row.application_status === 'assessment'
    if (category === 'assessment_completed') return ['assessment_passed', 'interview', 'interviewed', 'recommended', 'offer', 'hired'].includes(row.application_status)
    return true
  }).sort((a, b) => {
    if (sortBy === 'match') return Number(b.match_score ?? b.screening_score ?? -1) - Number(a.match_score ?? a.screening_score ?? -1)
    if (sortBy === 'assessment') return Number(b.assessment_score ?? -1) - Number(a.assessment_score ?? -1)
    if (sortBy === 'experience') return Number(b.years_experience || 0) - Number(a.years_experience || 0)
    if (sortBy === 'oldest') return new Date(a.created_at) - new Date(b.created_at)
    return new Date(b.created_at) - new Date(a.created_at)
  }), [category, rows, sortBy])

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Applications</h1>
          <p className="text-sm text-slate-500 mt-1">Review and manage the recruitment pipeline across all open roles.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="all">All candidates</option><option value="best_match">Best match</option><option value="talent_pool">Talent pool</option><option value="interview">Interview</option><option value="offer">Offer</option><option value="hired">Employed</option><option value="blacklisted">Blacklisted</option><option value="rejected">Rejected</option><option value="assessment_pending">Assessment pending</option><option value="assessment_completed">Assessment completed</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="">All statuses</option>
            {Object.keys(STAT).map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')} ({counts[s] || 0})</option>)}
          </select>
          <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="">All jobs</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_title}</option>)}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#009944]"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="match">Match score</option><option value="assessment">Assessment score</option><option value="experience">Experience</option></select>
        </div>
      </div>

      {error && <ErrorState message={error} />}

      <ModuleTable
        title=""
        subtitle=""
        rows={displayRows}
        loading={loading}
        error={error}
        searchKeys={['full_name', 'email', 'phone', 'applied_role', 'current_company']}
        columns={[
          {
            key: 'candidate', label: 'Candidate', render: (r) => (
              <div>
                <Link to={`/candidate/${r.id}`} className="font-medium text-slate-900 hover:text-[#009944]">{r.full_name}</Link>
                <div className="text-xs text-slate-400">{r.email || r.phone || '-'}</div>
              </div>
            ),
          },
          { key: 'role', label: 'Role', render: (r) => <div>{r.hr_jobs?.job_title || r.applied_role || '-'}<div className="text-xs text-slate-400">{r.hr_jobs?.department || r.department || ''}</div></div> },
          { key: 'source', label: 'Source', render: (r) => r.application_source || '-' },
          { key: 'application_status', label: 'Status', render: (r) => <StatusBadge label={r.application_status.replace(/_/g, ' ')} color={STAT[r.application_status] || 'slate'} /> },
          { key: 'screening_score', label: 'Match', render: (r) => (r.match_score ?? r.screening_score) != null ? <span className="font-medium">{Number(r.match_score ?? r.screening_score).toFixed(1)}%</span> : '—' },
          { key: 'assessment_score', label: 'Assessment', render: (r) => r.assessment_score != null ? `${Number(r.assessment_score).toFixed(1)}%` : '—' },
          { key: 'created_at', label: 'Applied', render: (r) => date(r.created_at) },
          {
            key: 'actions', label: '', render: (r) => (
              <Link to={`/candidate/${r.id}`} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 text-slate-600 text-xs hover:bg-slate-100">
                <Eye className="w-3.5 h-3.5" /> Open profile
              </Link>
            ),
          },
        ]}
      />
    </div>
  )
}
