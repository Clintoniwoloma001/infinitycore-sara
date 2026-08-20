import React from 'react'
import { date, ModuleTable, money, status, useTable } from './hrShared'

export default function OfferLetters() {
  const { rows, loading, error } = useTable('offer_letters')

  return (
    <ModuleTable
      title="Offer Letters"
      subtitle="Candidate offers, position, salary, employment type, issue date, and approvals"
      rows={rows}
      loading={loading}
      error={error}
      searchKeys={['candidate_name', 'position', 'status', 'approval_status']}
      columns={[
        { key: 'candidate_name', label: 'Candidate', render: (r) => r.candidate_name || r.full_name || r.candidate_id || '-' },
        { key: 'position', label: 'Position' },
        { key: 'salary', label: 'Salary', render: (r) => money(r.salary) },
        { key: 'employment_type', label: 'Type', render: (r) => String(r.employment_type || '-').replace(/_/g, ' ') },
        { key: 'status', label: 'Status', render: (r) => status(r.status, ['issued', 'accepted']) },
        { key: 'issue_date', label: 'Issue Date', render: (r) => date(r.issue_date || r.created_at) },
        { key: 'approval_status', label: 'Approval', render: (r) => status(r.approval_status || 'pending', ['approved']) },
      ]}
    />
  )
}
