import React, { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { formatDate } from '../lib/utils'
import { Briefcase, Plus, Users, Search } from 'lucide-react'

/**
 * HR Jobs Page - Manage job postings and view applications
 * For HR managers to create, edit, and manage job postings
 */
export default function HRJobs() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [formData, setFormData] = useState({
    job_title: '',
    department: '',
    location: '',
    employment_type: 'full_time',
    experience_years: 0,
    salary_min: '',
    salary_max: '',
    description: '',
    requirements: '',
  })

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await supabase
          .from('hr_jobs')
          .select('*')
          .order('created_at', { ascending: false })
        setJobs(data || [])
      } catch (e) {
        console.error('Failed to load jobs:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      const { user } = await supabase.auth.getUser()
      const { data, error } = await supabase
        .from('hr_jobs')
        .insert([{ ...formData, created_by: user.id, status: 'draft' }])
        .select()

      if (error) throw error
      setJobs([data[0], ...jobs])
      setShowForm(false)
      setFormData({
        job_title: '',
        department: '',
        location: '',
        employment_type: 'full_time',
        experience_years: 0,
        salary_min: '',
        salary_max: '',
        description: '',
        requirements: '',
      })
    } catch (e) {
      console.error('Failed to create job:', e)
    }
  }

  const filteredJobs = jobs.filter((job) => {
    const matchesSearch = job.job_title.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesStatus = filterStatus === 'all' || job.status === filterStatus
    return matchesSearch && matchesStatus
  })

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin mx-auto" />
        <p className="text-slate-500 mt-3">Loading job postings...</p>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-slate-900">Job Postings</h2>
          <p className="text-slate-500 mt-1">Manage open positions and recruitment</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New Job
        </button>
      </div>

      {/* Search and Filter */}
      <div className="flex gap-4 mb-6 flex-wrap">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="w-5 h-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search jobs..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Status</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {/* Jobs Grid */}
      {filteredJobs.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          {filteredJobs.map((job) => (
            <div key={job.id} className="bg-white rounded-lg border border-slate-200 p-6 hover:shadow-md transition">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{job.job_title}</h3>
                  <p className="text-xs text-slate-500 mt-1">{job.department}</p>
                </div>
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold ${
                    job.status === 'published'
                      ? 'bg-green-100 text-green-700'
                      : job.status === 'closed'
                        ? 'bg-slate-100 text-slate-700'
                        : 'bg-yellow-100 text-yellow-700'
                  }`}
                >
                  {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                </span>
              </div>

              <p className="text-sm text-slate-600 mb-4 line-clamp-2">{job.description}</p>

              <div className="space-y-2 text-xs text-slate-600 mb-4">
                <div className="flex justify-between">
                  <span>Experience: {job.experience_years}+ years</span>
                  <span>{job.employment_type}</span>
                </div>
                {job.location && <div>📍 {job.location}</div>}
                {job.salary_min && job.salary_max && (
                  <div>💰 ₦{job.salary_min.toLocaleString()} - ₦{job.salary_max.toLocaleString()}</div>
                )}
              </div>

              <div className="flex gap-2 pt-4 border-t border-slate-100">
                <button className="flex-1 px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded transition">
                  View
                </button>
                <button className="flex-1 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 rounded transition">
                  Edit
                </button>
                <button className="flex-1 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 rounded transition">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 bg-slate-50 rounded-lg border border-slate-200">
          <Briefcase className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600">No jobs found</p>
        </div>
      )}

      {/* New Job Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
            <h3 className="text-xl font-bold text-slate-900 mb-6">Create New Job Posting</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="Job Title"
                  value={formData.job_title}
                  onChange={(e) => setFormData({ ...formData, job_title: e.target.value })}
                  className="col-span-2 px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
                <input
                  type="text"
                  placeholder="Department"
                  value={formData.department}
                  onChange={(e) => setFormData({ ...formData, department: e.target.value })}
                  className="px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="text"
                  placeholder="Location"
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  className="px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <select
                  value={formData.employment_type}
                  onChange={(e) => setFormData({ ...formData, employment_type: e.target.value })}
                  className="px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="full_time">Full Time</option>
                  <option value="part_time">Part Time</option>
                  <option value="contract">Contract</option>
                </select>
                <input
                  type="number"
                  placeholder="Years of Experience"
                  value={formData.experience_years}
                  onChange={(e) => setFormData({ ...formData, experience_years: parseInt(e.target.value) })}
                  className="px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <textarea
                placeholder="Job Description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={4}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <textarea
                placeholder="Requirements"
                value={formData.requirements}
                onChange={(e) => setFormData({ ...formData, requirements: e.target.value })}
                rows={3}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition"
                >
                  Create Job
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="flex-1 px-4 py-2 bg-slate-100 text-slate-900 rounded-lg font-medium hover:bg-slate-200 transition"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
