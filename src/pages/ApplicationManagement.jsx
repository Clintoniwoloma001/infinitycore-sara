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

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [apps, jobList] = await Promise.all([
        recruitmentService.listApplications({ jobId: jobFilter || undefined }),
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Applications</h1>
          <p className="text-sm text-slate-500 mt-1">Review and manage the recruitment pipeline across all open roles.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="">All statuses</option>
            {Object.keys(STAT).map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')} ({counts[s] || 0})</option>)}
          </select>
          <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} className="h-10 rounded-lg border border-slate-300 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#009944]">
            <option value="">All jobs</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_title}</option>)}
          </select>
        </div>
      </div>

      {error && <ErrorState message={error} />}

      <ModuleTable
        title=""
        subtitle=""
        rows={rows}
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
          { key: 'screening_score', label: 'Screen', render: (r) => r.screening_score != null ? <span className="font-medium">{Number(r.screening_score).toFixed(1)}</span> : '—' },
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