import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Loader2, Trash2, UserPlus } from 'lucide-react'
import { date, ModuleTable, status, useTable } from './hrShared'
import { useAuth } from '../hooks/useAuth'
import { employeeService } from '../services/employeeService'
import AddEmployeeModal from '../components/AddEmployeeModal'

export default function Employees() {
  const { rows, loading, error, reload } = useTable('employees')
  const { hasPermission, isAdmin, isHR } = useAuth()
  const [showAdd, setShowAdd] = useState(false)
  const [terminating, setTerminating] = useState(null)
  const [actionError, setActionError] = useState('')
  const canAdd = isAdmin || isHR || hasPermission('hr.employee.update')
  const canDelete = isAdmin || isHR

  const terminate = async (employee) => {
    const label = employee.employee_code || employee.employee_number || employee.staff_id || 'no code'
    if (!confirm(`Terminate ${employee.full_name} (${label})?\n\nThis sets the employment status to "terminated". The record and its history are kept.`)) return
    setActionError('')
    setTerminating(employee.id)
    try {
      await employeeService.terminate(employee.id)
      reload()
    } catch (e) {
      setActionError(e?.message || 'Unable to terminate employee')
    } finally {
      setTerminating(null)
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Employees</h2>
          <p className="text-sm text-slate-500 mt-1">Employee directory, department assignment, branch, and employment status</p>
        </div>
        {canAdd && (
          <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <UserPlus className="w-4 h-4" /> Add Employee
          </button>
        )}
      </div>

      {actionError && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{actionError}</div>
      )}

      <ModuleTable
        title=""
        subtitle=""
        rows={rows}
        loading={loading}
        error={error}
        searchKeys={['full_name', 'email', 'department', 'position', 'branch', 'employee_code']}
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
          { key: 'employee_code', label: 'Work ID', render: (r) => r.employee_code || '-' },
          { key: 'department', label: 'Department' },
          { key: 'position', label: 'Position' },
          { key: 'branch', label: 'Branch', render: (r) => r.branch || '-' },
          { key: 'employment_status', label: 'Status', render: (r) => status(r.employment_status) },
          { key: 'hire_date', label: 'Date Joined', render: (r) => date(r.hire_date || r.created_at) },
          ...(canDelete ? [{
            key: 'actions',
            label: '',
            render: (r) => (
              <div className="flex justify-end">
                {r.employment_status === 'terminated'
                  ? <span className="text-xs text-slate-400">Terminated</span>
                  : (
                    <button
                      onClick={() => terminate(r)}
                      disabled={terminating === r.id}
                      className="p-2 rounded-lg hover:bg-rose-50 text-rose-500 disabled:opacity-50"
                      title="Terminate employee"
                    >
                      {terminating === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  )}
              </div>
            ),
          }] : []),
        ]}
      />

      {showAdd && <AddEmployeeModal onClose={() => setShowAdd(false)} onCreated={(empId) => { setShowAdd(false); reload() }} />}
    </div>
  )
}
