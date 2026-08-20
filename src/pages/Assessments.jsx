import React from 'react'
import { date, ModuleTable, status, useTable } from './hrShared'

export default function Assessments() {
  const { rows, loading, error } = useTable('hr_assessments')

  return (
    <ModuleTable
      title="Assessments"
      subtitle="Candidate tests, scores, and pass or fail decisions"
      rows={rows}
      loading={loading}
      error={error}
      searchKeys={['assessment_type', 'test_name', 'status']}
      columns={[
        { key: 'test_name', label: 'Assessment', render: (r) => <div><div className="font-medium text-slate-900">{r.test_name || r.assessment_type || 'Assessment'}</div><div className="text-xs text-slate-400">{r.assessment_type || '-'}</div></div> },
        { key: 'candidate_id', label: 'Candidate ID', render: (r) => <span className="font-mono text-xs">{r.candidate_id || '-'}</span> },
        { key: 'status', label: 'Status', render: (r) => status(r.status) },
        { key: 'score', label: 'Score', render: (r) => r.score != null ? `${r.score}/${r.total_score || 100}` : '-' },
        { key: 'pass_score', label: 'Result', render: (r) => r.score == null ? '-' : status(Number(r.score) >= Number(r.pass_score || 0) ? 'passed' : 'failed', ['passed']) },
        { key: 'completed_at', label: 'Completed', render: (r) => date(r.completed_at || r.created_at) },
      ]}
    />
  )
}
