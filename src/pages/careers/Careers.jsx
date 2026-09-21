import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Briefcase, Building2, CalendarDays, FileText, Loader2, MapPin, Search } from 'lucide-react'
import CareersShell from './CareersShell'
import { careerService } from '../../services/careerService'
import { ErrorState } from '../../components/PageStates'

function formatDeadline(deadline) {
  if (!deadline) return null
  const d = new Date(deadline)
  const today = new Date()
  const diff = Math.ceil((d - today) / (1000 * 60 * 60 * 24))
  if (diff < 0) return 'Closed'
  if (diff === 0) return 'Closes today'
  if (diff === 1) return 'Closes tomorrow'
  return `Closes ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

export default function Careers() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [department, setDepartment] = useState('all')

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const data = await careerService.listPublishedJobs()
        if (active) setJobs(data || [])
      } catch (e) {
        if (active) setError(e?.message || 'Unable to load open roles.')
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [])

  const departments = useMemo(() => [...new Set(jobs.map((j) => j.department).filter(Boolean))], [jobs])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return jobs.filter((j) => {
      if (department !== 'all' && j.department !== department) return false
      if (!q) return true
      return [j.job_title, j.department, j.location, j.qualifications, j.description].some((v) => String(v || '').toLowerCase().includes(q))
    })
  }, [jobs, search, department])

  return (
    <CareersShell>
      <section className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Open Positions</h1>
        <p className="text-slate-500 mt-1 max-w-2xl">
          Explore career opportunities at Infinity Microfinance Bank. Submit your application online and track its progress from your candidate portal.
        </p>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roles, departments, skills…"
            className="w-full h-11 pl-9 pr-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] bg-white"
          />
        </div>
        <select value={department} onChange={(e) => setDepartment(e.target.value)} className="h-11 rounded-lg border border-slate-300 px-3 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#009944]">
          <option value="all">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {loading && <div className="flex items-center justify-center py-16 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading open roles…</div>}
      {!loading && error && <ErrorState message={error} />}
      {!loading && !error && filtered.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <Briefcase className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">No open roles match your search right now. Check back soon.</p>
        </div>
      )}

      <div className="space-y-4">
        {filtered.map((job) => (
          <Link key={job.id} to={`/careers/jobs/${job.public_token}`} className="block bg-white border border-slate-200 rounded-xl p-6 hover:border-[#009944]/50 hover:shadow-sm transition">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{job.job_title}</h3>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-slate-500">
                  <span className="inline-flex items-center gap-1.5"><Building2 className="w-4 h-4" /> {job.department || 'General'}</span>
                  {job.location && <span className="inline-flex items-center gap-1.5"><MapPin className="w-4 h-4" /> {job.location}</span>}
                  <span className="inline-flex items-center gap-1.5"><FileText className="w-4 h-4" /> {job.employment_type || 'full_time'}</span>
                  {job.openings > 1 && <span className="inline-flex items-center gap-1.5"><Briefcase className="w-4 h-4" /> {job.openings} openings</span>}
                </div>
              </div>
              {job.application_deadline && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  <CalendarDays className="w-3.5 h-3.5" /> {formatDeadline(job.application_deadline)}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-500 mt-3 line-clamp-2">{job.description || 'View this role to learn more and apply.'}</p>
            <span className="inline-block mt-4 text-sm font-medium text-[#009944]">Apply now →</span>
          </Link>
        ))}
      </div>
    </CareersShell>
  )
}