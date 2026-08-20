import React from 'react'
import HRJobs from './HRJobs'
import { date, ModuleTable, status, useTable } from './hrShared'

export default function Recruitment() {
  const candidates = useTable('hr_candidates')

  return (
    <div className="space-y-8">
      <HRJobs />
      <ModuleTable
        title="Applicants"
        subtitle="Candidate profiles and recruitment pipeline"
        rows={candidates.rows}
        loading={candidates.loading}
        error={candidates.error}
        searchKeys={['full_name', 'email', 'current_company', 'application_status']}
        columns={[
          { key: 'full_name', label: 'Candidate', render: (r) => <div><div className="font-medium text-slate-900">{r.full_name}</div><div className="text-xs text-slate-400">{r.email || r.phone || '-'}</div></div> },
          { key: 'current_company', label: 'Current Company' },
          { key: 'years_experience', label: 'Experience', render: (r) => `${r.years_experience || 0} yrs` },
          { key: 'application_status', label: 'Status', render: (r) => status(r.application_status, ['shortlisted', 'interview', 'offer', 'hired']) },
          { key: 'screening_score', label: 'Screening', render: (r) => r.screening_score ?? '-' },
          { key: 'created_at', label: 'Applied', render: (r) => date(r.created_at) },
        ]}
      />
    </div>
  )
}
