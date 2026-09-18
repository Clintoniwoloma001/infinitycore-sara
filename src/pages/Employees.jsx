import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Archive, ChevronRight, Loader2, Trash2, UserPlus, UserX } from 'lucide-react'
import { date, ModuleTable, status, useTable } from './hrShared'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../supabaseClient'
import { employeeService } from '../services/employeeService'
import AddEmployeeModal from '../components/AddEmployeeModal'
import TerminationModal from '../components/TerminationModal'
import ArchiveModal from '../components/ArchiveModal'
import DeleteEmployeeModal from '../components/DeleteEmployeeModal'

export default function Employees() {
  const { rows, loading, error, reload } = useTable('employees')
  const { hasPermission, isAdmin, isHR, canTerminate, canArchive, canDelete, user } = useAuth()
  const [showAdd, setShowAdd] = useState(false)
  const [terminating, setTerminating] = useState(null)
  const [archiving, setArchiving] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [restoring, setRestoring] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  // user_ids whose linked profile is a super_admin — those employees can
  // never be deleted (server-enforced; hidden here for UX).
  const [protectedUserIds, setProtectedUserIds] = useState([])

  const canAdd = isAdmin || isHR || hasPermission('hr.employee.update')

  // The terminate/archive/delete actions are shown ONLY to super_admin and
  // hr_manager (UX). The backend RPC still independently re-verifies
  // the authenticated user's role — a hidden button is never the gate.
  const canRunLifecycle = canTerminate || canArchive || canDelete

  // Resolve which employees are protected from deletion (linked to a
  // super_admin login) so the Delete button is hidden for them.
  useEffect(() => {
    if (!canDelete) { setProtectedUserIds([]); return }
    const ids = [...new Set((rows || []).map((r) => r.user_id).filter(Boolean))]
    if (!ids.length) { setProtectedUserIds([]); return }
    supabase
      .from('profiles')
      .select('id')
      .in('id', ids)
      .eq('role', 'super_admin')
      .then(({ data }) => setProtectedUserIds((data || []).map((p) => p.id)))
      .catch(() => setProtectedUserIds([]))
  }, [canDelete, rows])

  const isProtectedEmployee = (employee) =>
    !!employee?.user_id &&
    (protectedUserIds.includes(employee.user_id) || employee.user_id === user?.id)

  const confirmTerminate = async (employee, { effectiveDate, reason, notes, rehireEligible }) => {
    setActionError('')
    setBusy(true)
    setTerminating(employee)
    try {
      await employeeService.terminate(employee.id, { effectiveDate, reason, notes, rehireEligible })
      setTerminating(null)
      reload()
    } catch (e) {
      setActionError(e?.message || 'Unable to terminate employee')
      setTerminating(null)
    } finally {
      setBusy(false)
    }
  }

  const confirmArchive = async (employee, { reason }) => {
    setActionError('')
    setBusy(true)
    setArchiving(employee)
    try {
      await employeeService.archive(employee.id, reason, false)
      setArchiving(null)
      reload()
    } catch (e) {
      setActionError(e?.message || 'Unable to archive employee')
      setArchiving(null)
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async (employee) => {
    setActionError('')
    setBusy(true)
    try {
      await employeeService.deleteEmployee(employee.id)
      setDeleting(null)
      reload()
    } catch (e) {
      setActionError(e?.message || 'Unable to delete employee')
      setDeleting(null)
    } finally {
      setBusy(false)
    }
  }

  const confirmRestore = async (employee) => {
    setActionError('')
    setBusy(true)
    setRestoring(employee)
    try {
      await employeeService.archive(employee.id, '', true)
      setRestoring(null)
      reload()
    } catch (e) {
      setActionError(e?.message || 'Unable to restore employee')
      setRestoring(null)
    } finally {
      setBusy(false)
    }
  }

  const visibleRows = showArchived ? rows : (rows || []).filter((r) => !r.is_archived)

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Employees</h2>
          <p className="text-sm text-slate-500 mt-1">Employee directory, department assignment, branch, and employment status</p>
        </div>
        <div className="flex items-center gap-2">
          {canRunLifecycle && (
            <button
              onClick={() => setShowArchived((v) => !v)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium ${
                showArchived ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Archive className="w-4 h-4" /> {showArchived ? 'Hide archived' : 'Archived'}
            </button>
          )}
          {canAdd && (
            <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <UserPlus className="w-4 h-4" /> Add Employee
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{actionError}</div>
      )}

      <ModuleTable
        title=""
        subtitle=""
        rows={visibleRows}
        loading={loading}
        error={error}
        searchKeys={['full_name', 'email', 'department', 'position', 'branch', 'employee_code', 'employee_number', 'staff_id']}
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
          { key: 'employee_code', label: 'Work ID', render: (r) => r.employee_code || r.employee_number || r.staff_id || '-' },
          { key: 'department', label: 'Department' },
          { key: 'position', label: 'Position' },
          { key: 'branch', label: 'Branch', render: (r) => r.branch || '-' },
          { key: 'employment_status', label: 'Status', render: (r) => status(r.employment_status) },
          { key: 'hire_date', label: 'Date Joined', render: (r) => date(r.hire_date || r.created_at) },
          ...(canRunLifecycle ? [{
            key: 'actions',
            label: '',
            render: (r) => (
              <div className="flex justify-end items-center gap-1.5">
                {r.is_archived ? (
                  <button
                    onClick={() => confirmRestore(r)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
                    title="Restore employee from archive"
                  >
                    <Archive className="w-3.5 h-3.5" /> Restore
                  </button>
                ) : (
                  <>
                    {canTerminate && r.employment_status !== 'terminated' && (
                      <button
                        onClick={() => setTerminating(r)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-600 border border-rose-200 hover:bg-rose-50"
                        title="Terminate employee (ends employment, preserves history)"
                      >
                        {terminating?.id === r.id && busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserX className="w-3.5 h-3.5" />} Terminate Employee
                      </button>
                    )}
                    {r.employment_status === 'terminated' && (
                      <span className="text-xs text-slate-400">Terminated</span>
                    )}
                    {canArchive && r.employment_status !== 'terminated' && (
                      <button
                        onClick={() => setArchiving(r)}
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-slate-500 border border-slate-200 hover:bg-slate-50"
                        title="Archive employee (hide from active views, preserve history)"
                      >
                        <Archive className="w-3.5 h-3.5" /> Archive
                      </button>
                    )}
                    {canDelete && !isProtectedEmployee(r) && (
                      <button
                        onClick={() => setDeleting(r)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-600 border border-rose-200 hover:bg-rose-50 disabled:opacity-50"
                        title="Delete employee (removes from payroll and the platform, preserves history)"
                      >
                        {deleting?.id === r.id && busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            ),
          }] : []),
        ]}
      />

      {showAdd && <AddEmployeeModal onClose={() => setShowAdd(false)} onCreated={(empId) => { setShowAdd(false); reload() }} />}

      {terminating && canTerminate && (
        <TerminationModal
          employee={terminating}
          busy={busy}
          error=""
          onClose={() => setTerminating(null)}
          onConfirm={(opts) => confirmTerminate(terminating, opts)}
        />
      )}

      {archiving && canArchive && (
        <ArchiveModal
          employee={archiving}
          busy={busy}
          error=""
          onClose={() => setArchiving(null)}
          onConfirm={(opts) => confirmArchive(archiving, opts)}
        />
      )}

      {deleting && canDelete && (
        <DeleteEmployeeModal
          employee={deleting}
          busy={busy}
          error={actionError}
          onClose={() => setDeleting(null)}
          onConfirm={(emp) => confirmDelete(emp)}
        />
      )}
    </div>
  )
}