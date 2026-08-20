import React from 'react'
import { date, ModuleTable, status, useTable } from './hrShared'

export default function Interviews() {
  const { rows, loading, error } = useTable('hr_interviews', 'scheduled_date')

  return (
    <ModuleTable
      title="Interviews"
      subtitle="Scheduled interviews, interviewer assignments, status, and outcomes"
      rows={rows}
      loading={loading}
      error={error}
      searchKeys={['interview_type', 'status', 'feedback']}
      columns={[
        { key: 'candidate_id', label: 'Candidate ID', render: (r) => <span className="font-mono text-xs">{r.candidate_id || '-'}</span> },
        { key: 'interview_type', label: 'Type', render: (r) => String(r.interview_type || '-').replace(/_/g, ' ') },
        { key: 'interviewer_id', label: 'Interviewer', render: (r) => <span className="font-mono text-xs">{r.interviewer_id || '-'}</span> },
        { key: 'scheduled_date', label: 'Date/Time', render: (r) => date(r.scheduled_date) },
        { key: 'status', label: 'Status', render: (r) => status(r.status) },
        { key: 'rating', label: 'Outcome', render: (r) => r.rating ? `${r.rating}/5` : r.feedback || '-' },
      ]}
    />
  )
}
