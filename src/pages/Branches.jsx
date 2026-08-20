import React from 'react'
import { ModuleTable, status, useTable } from './hrShared'

export default function Branches() {
  const { rows, loading, error } = useTable('branches', 'created_at')

  return (
    <ModuleTable
      title="Branches"
      subtitle="Branch directory, manager assignment, location, and operational status"
      rows={rows}
      loading={loading}
      error={error}
      searchKeys={['branch_name', 'name', 'branch_code', 'manager_name', 'location', 'status']}
      columns={[
        { key: 'branch_name', label: 'Branch', render: (r) => <div><div className="font-medium text-slate-900">{r.branch_name || r.name}</div><div className="text-xs text-slate-400">{r.branch_code || '-'}</div></div> },
        { key: 'manager_name', label: 'Manager', render: (r) => r.manager_name || r.manager || '-' },
        { key: 'location', label: 'Location' },
        { key: 'status', label: 'Status', render: (r) => status(r.status || 'active') },
      ]}
    />
  )
}
