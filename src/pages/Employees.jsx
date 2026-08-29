import React from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { date, ModuleTable, status, useTable } from './hrShared'

export default function Employees() {
  const { rows, loading, error } = useTable('employees')

  return (
    <ModuleTable
      title="Employees"
      subtitle="Employee directory, department assignment, branch, and employment status"
      rows={rows}
      loading={loading}
      error={error}
      searchKeys={['full_name', 'email', 'department', 'position', 'branch']}
      columns={[
        { key: 'full_name', label: 'Employee', render: (r) => (
          <Link to={`/employees/${r.id}`} className="group flex items-center gap-2">
            <div>
              <div className="font-medium text-slate-900 group-hover:text-[#009944]">{r.full_name}</div>
              <div className="text-xs text-slate-400">{r.email || r.phone || '-'}</div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-[#009944]" />
          </Link>
        ) },
        { key: 'department', label: 'Department' },
        { key: 'position', label: 'Position' },
        { key: 'branch', label: 'Branch', render: (r) => r.branch || r.branch_name || '-' },
        { key: 'employment_status', label: 'Status', render: (r) => status(r.employment_status) },
        { key: 'hire_date', label: 'Date Joined', render: (r) => date(r.hire_date || r.created_at) },
      ]}
    />
  )
}
