import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarCheck, ClipboardCheck, ChevronRight, User, Mail, Phone, Briefcase, Star } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { logAction } from '../services/supabaseService'
import { useAuth } from '../hooks/useAuth'
import HRJobs from './HRJobs'
import { date, status, useTable } from './hrShared'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

const PIPELINE_TABS = [
  { key: 'all', label: 'All' },
  { key: 'received', label: 'Received' },
  { key: 'screening', label: 'Screening' },
  { key: 'shortlisted', label: 'Shortlisted' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
  { key: 'hired', label: 'Hired' },
  { key: 'rejected', label: 'Rejected' },
]

export default function Recruitment() {
  const navigate = useNavigate()
  const { name: userName } = useAuth()
  const [candidates, setCandidates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [actionCandidate, setActionCandidate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { data, error } = await supabase.from('hr_candidates').select('*').order('created_at', { ascending: false })
      if (error) throw error
      setCandidates(data || [])
    } catch (e) {
      setError(e?.message || 'Failed to load candidates')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = candidates.filter((c) => {
    const tabOk = tab === 'all' || c.application_status === tab
    const searchOk = !search || [c.full_name, c.email, c.current_company].some((v) => (v || '').toLowerCase().includes(search.toLowerCase()))
    return tabOk && searchOk
  })

  const updateStatus = async (candidateId, newStatus) => {
    setBusy(true)
    try {
      await supabase.from('hr_candidates').update({ application_status: newStatus }).eq('id', candidateId)
      await logAction({ action: 'CANDIDATE_STATUS_CHANGED', entityType: 'Candidate', entityId: candidateId, details: `Status → ${newStatus}`, userName })
      setSuccess(`Candidate moved to ${newStatus}.`)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to update status')
    } finally {
      setBusy(false)
    }
  }

  const createAssessment = async (candidate) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.from('hr_assessments').insert([{
        candidate_id: candidate.id,
        assessment_type: 'technical',
        test_name: `Assessment - ${candidate.full_name}`,
        status: 'pending',
        pass_score: 70,
        total_score: 100,
      }]).select().single()
      if (error) throw error
      await supabase.from('hr_candidates').update({ application_status: 'screening' }).eq('id', candidate.id)
      await logAction({ action: 'ASSESSMENT_CREATED', entityType: 'Assessment', entityId: data.id, details: `Assessment for ${candidate.full_name}`, userName })
      setSuccess(`Assessment created for ${candidate.full_name}.`)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to create assessment')
    } finally {
      setBusy(false)
    }
  }

  const stats = {
    total: candidates.length,
    received: candidates.filter((c) => c.application_status === 'received').length,
    screening: candidates.filter((c) => c.application_status === 'screening').length,
    shortlisted: candidates.filter((c) => c.application_status === 'shortlisted').length,
    interview: candidates.filter((c) => c.application_status === 'interview').length,
    hired: candidates.filter((c) => c.application_status === 'hired').length,
  }

  return (
    <div className="space-y-8">
      <HRJobs />

      <div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
          <div>
            <h2 className="text-2xl font-semibold text-slate-900">Applicants</h2>
            <p className="text-sm text-slate-500 mt-1">Candidate pipeline — from application to hire</p>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search candidates…"
            className="w-full sm:w-64 h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
          />
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-6">
          {[
            { label: 'Total', value: stats.total, color: 'text-slate-900' },
            { label: 'Received', value: stats.received, color: 'text-slate-600' },
            { label: 'Screening', value: stats.screening, color: 'text-blue-600' },
            { label: 'Shortlisted', value: stats.shortlisted, color: 'text-amber-600' },
            { label: 'Interview', value: stats.interview, color: 'text-violet-600' },
            { label: 'Hired', value: stats.hired, color: 'text-emerald-600' },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-lg border border-slate-200 p-3">
              <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-xs text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Pipeline tabs */}
        <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
          {PIPELINE_TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.key ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {error && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>}
        {success && <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm p-3">{success}</div>}

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-slate-400">No candidates match this filter.</div>
        ) : (
          <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-left">
                <tr>
                  <th className="px-6 py-3 font-medium">Candidate</th>
                  <th className="px-6 py-3 font-medium">Experience</th>
                  <th className="px-6 py-3 font-medium">Screening</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Applied</th>
                  <th className="px-6 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 group">
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-900">{c.full_name}</div>
                      <div className="text-xs text-slate-400">{c.email || c.phone || '-'}</div>
                      {c.current_company && <div className="text-xs text-slate-400">{c.current_company}</div>}
                    </td>
                    <td className="px-6 py-3 text-slate-600">{c.years_experience || 0} yrs</td>
                    <td className="px-6 py-3">
                      {c.screening_score != null ? (
                        <span className="inline-flex items-center gap-1">
                          <Star className="w-3.5 h-3.5 text-amber-500" />
                          {c.screening_score}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3">{status(c.application_status, ['shortlisted', 'interview', 'offer', 'hired'])}</td>
                    <td className="px-6 py-3 text-slate-500">{date(c.created_at)}</td>
                    <td className="px-6 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        {c.application_status === 'received' && (
                          <button onClick={() => updateStatus(c.id, 'screening')} className="text-xs px-2.5 py-1.5 rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100">Screen</button>
                        )}
                        {c.application_status === 'screening' && (
                          <>
                            <button onClick={() => createAssessment(c)} disabled={busy} className="text-xs px-2.5 py-1.5 rounded-md bg-violet-50 text-violet-700 hover:bg-violet-100 inline-flex items-center gap-1">
                              <ClipboardCheck className="w-3 h-3" /> Assess
                            </button>
                            <button onClick={() => updateStatus(c.id, 'shortlisted')} className="text-xs px-2.5 py-1.5 rounded-md bg-amber-50 text-amber-700 hover:bg-amber-100">Shortlist</button>
                          </>
                        )}
                        {c.application_status === 'shortlisted' && (
                          <button onClick={() => navigate('/interviews')} className="text-xs px-2.5 py-1.5 rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100 inline-flex items-center gap-1">
                            <CalendarCheck className="w-3 h-3" /> Interview
                          </button>
                        )}
                        {c.application_status === 'interview' && (
                          <button onClick={() => updateStatus(c.id, 'offer')} className="text-xs px-2.5 py-1.5 rounded-md bg-cyan-50 text-cyan-700 hover:bg-cyan-100">Offer</button>
                        )}
                        {c.application_status === 'offer' && (
                          <button onClick={() => updateStatus(c.id, 'hired')} className="text-xs px-2.5 py-1.5 rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100">Hire</button>
                        )}
                        {['received', 'screening', 'shortlisted'].includes(c.application_status) && (
                          <button onClick={() => updateStatus(c.id, 'rejected')} className="text-xs px-2.5 py-1.5 rounded-md bg-rose-50 text-rose-700 hover:bg-rose-100">Reject</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
