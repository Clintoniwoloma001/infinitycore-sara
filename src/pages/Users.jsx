import React, { useEffect, useState, useCallback } from 'react'
import { supabase } from '../supabaseClient'
import { logAction } from '../services/supabaseService'
import { useAuth } from '../hooks/useAuth'
import { ROLE_METADATA, ROLES, assignableRoles } from '../constants/roles'
import { cleanDepartmentValue, filterDepartmentOptions } from '../constants/departments'
import { userProvisioningService } from '../services/userProvisioningService'
import { Shield, UserPlus, CheckCircle2, XCircle, Loader2, Search, UserCog, Power, PowerOff, Mail, Phone, Building2, Calendar, Eye, X, MailPlus, Send, UserCheck, Clock, Layers, Trash2 } from 'lucide-react'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const STATUS_BADGE = {
  pending: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', label: 'Pending' },
  active: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', label: 'Active' },
  inactive: { bg: 'bg-slate-100', text: 'text-slate-500', border: 'border-slate-200', label: 'Inactive' },
  rejected: { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-200', label: 'Rejected' },
}

function StatusBadge({ status }) {
  const cfg = STATUS_BADGE[status] || STATUS_BADGE.pending
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.bg} ${cfg.text} ${cfg.border}`}>{cfg.label}</span>
}

const TABS = [
  { id: 'all', label: 'All Users' },
  { id: 'pending', label: 'Pending Approval' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'rejected', label: 'Rejected' },
]

export default function Users() {
  const { user: currentUser, profile: currentProfile, name: userName, role: actorRole } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [err, setErr] = useState(null)
  const [success, setSuccess] = useState(null)
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showProvision, setShowProvision] = useState(false)
  const [reviewUser, setReviewUser] = useState(null)
  const [creating, setCreating] = useState(false)
  const [provisionStats, setProvisionStats] = useState({ eligibleWithoutAccounts: 0, alreadyLinked: 0, invited: 0, pendingApproval: 0 })
  const myAssignableRoles = assignableRoles(actorRole)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [usersRes, statsRes] = await Promise.all([
        supabase.from('profiles').select('*').order('created_at', { ascending: false }),
        userProvisioningService.getAccountSummary().catch(() => null),
      ])
      const { data, error } = usersRes
      if (error) throw error
      setUsers(data || [])
      if (statsRes) setProvisionStats(statsRes)
    } catch (e) {
      setErr(e?.message || 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const showToast = (msg, type = 'success') => {
    if (type === 'success') setSuccess(msg)
    else setErr(msg)
    setTimeout(() => { setSuccess(null); setErr(null) }, 4000)
  }

  const filtered = users.filter((u) => {
    const matchTab = tab === 'all' || u.status === tab || (tab === 'pending' && (!u.status || u.status === 'pending'))
    const matchSearch = !search || (u.email || '').toLowerCase().includes(search.toLowerCase()) || (u.full_name || '').toLowerCase().includes(search.toLowerCase())
    return matchTab && matchSearch
  })

  const counts = {
    all: users.length,
    pending: users.filter((u) => !u.status || u.status === 'pending').length,
    active: users.filter((u) => u.status === 'active').length,
    inactive: users.filter((u) => u.status === 'inactive').length,
    rejected: users.filter((u) => u.status === 'rejected').length,
  }

  const approveUser = async (u, assignment) => {
    setBusyId(u.id)
    setErr(null)
    try {
      const { data, error } = await supabase.rpc('approve_user', {
        p_user_id: u.id,
        p_role: assignment.role || 'staff',
        p_department: cleanDepartmentValue(assignment.department) || null,
        p_branch: assignment.branch || null,
        p_user_type: assignment.user_type || 'staff',
      })
      if (error) throw error
      await logAction({ action: 'USER_APPROVED', entityType: 'User', entityId: u.id, details: `${u.email} approved as ${assignment.role}`, userName, severity: 'warning' })
      showToast(`${u.email} approved successfully`)
      setReviewUser(null)
      load()
    } catch (e) {
      setErr(e?.message || 'Failed to approve user')
    } finally {
      setBusyId(null)
    }
  }

  const rejectUser = async (u, reason) => {
    setBusyId(u.id)
    setErr(null)
    try {
      const { error } = await supabase.rpc('reject_user', { p_user_id: u.id, p_reason: reason || 'Not specified' })
      if (error) throw error
      showToast(`${u.email} rejected`, 'success')
      setReviewUser(null)
      load()
    } catch (e) {
      setErr(e?.message || 'Failed to reject user')
    } finally {
      setBusyId(null)
    }
  }

  const deleteInvite = async (u) => {
    const confirmed = window.confirm(
      `Delete the pending invitation for ${u.email || u.full_name || u.id}?\n\n` +
      'This permanently removes the Supabase Auth account and its profile. ' +
      'The employee record is NOT deleted and stays available for a clean re-invitation.'
    )
    if (!confirmed) return
    setBusyId(u.id)
    setErr(null)
    try {
      const { data, error } = await supabase.rpc('delete_pending_invite', { p_user_id: u.id })
      if (error) throw error
      if (!data?.ok) throw new Error(data?.message || 'Failed to delete invitation')
      await logAction({ action: 'USER_INVITE_DELETED', entityType: 'User', entityId: u.id, details: `${u.email} pending invitation deleted. Employee record retained for re-invitation.`, userName, severity: 'warning' })
      showToast(`Invitation for ${u.email} deleted. The employee can be re-invited from scratch.`)
      load()
    } catch (e) {
      setErr(e?.message || 'Failed to delete invitation')
    } finally {
      setBusyId(null)
    }
  }

  const reInvite = async (u) => {
    setBusyId(u.id)
    setErr(null)
    try {
      const res = await userProvisioningService.resendInvitationForProfile(u, { role: u.role || 'staff', reason: 'Re-invite from User Management' })
      const result = res?.results?.[0]
      if (result?.result !== 'RESENT') throw new Error(result?.message || result?.error || 'Failed to resend the invitation')
      await logAction({ action: 'USER_INVITE_RESENT', entityType: 'User', entityId: u.id, details: `${u.email} activation invitation resent.`, userName, severity: 'warning' })
      showToast(`Invitation resent to ${u.email}.`)
      load()
    } catch (e) {
      setErr(e?.message || 'Failed to resend the invitation')
    } finally {
      setBusyId(null)
    }
  }

  const deactivateUser = async (u) => {
    setBusyId(u.id)
    setErr(null)
    try {
      const { error } = await supabase.rpc('deactivate_user', { p_user_id: u.id })
      if (error) throw error
      showToast(`${u.email} deactivated`)
      load()
    } catch (e) {
      setErr(e?.message || 'Failed to deactivate user')
    } finally {
      setBusyId(null)
    }
  }

  const reactivateUser = async (u) => {
    setBusyId(u.id)
    setErr(null)
    try {
      const { error } = await supabase.rpc('reactivate_user', { p_user_id: u.id })
      if (error) throw error
      showToast(`${u.email} reactivated`)
      load()
    } catch (e) {
      setErr(e?.message || 'Failed to reactivate user')
    } finally {
      setBusyId(null)
    }
  }

  const changeRole = async (u, role) => {
    setBusyId(u.id)
    setErr(null)
    try {
      const { error } = await supabase.from('profiles').update({ role }).eq('id', u.id)
      if (error) throw error
      await logAction({ action: 'USER_ROLE_CHANGED', entityType: 'User', entityId: u.id, details: `${u.email} → ${role}`, userName, severity: 'critical' })
      showToast(`Role changed to ${ROLE_METADATA[role]?.label || role}`)
      load()
    } catch (e) {
      setErr(e?.message || 'Not authorized')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">User Management</h2>
          <p className="text-sm text-slate-500 mt-1">Approve registrations, assign roles, and manage user access.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowProvision(true)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[#009944] text-[#009944] text-sm font-medium hover:bg-[#009944]/5">
            <MailPlus className="w-4 h-4" /> Create Users from Employees
          </button>
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
            <UserPlus className="w-4 h-4" /> Create User
          </button>
        </div>
      </div>

      {/* Provisioning summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400 uppercase"><Layers className="w-3.5 h-3.5" /> Employees without accounts</div>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{provisionStats.eligibleWithoutAccounts || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400 uppercase"><Mail className="w-3.5 h-3.5" /> Invited</div>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{provisionStats.invited || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400 uppercase"><Clock className="w-3.5 h-3.5" /> Pending approval</div>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{provisionStats.pendingApproval || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400 uppercase"><UserCheck className="w-3.5 h-3.5" /> Invites to resend</div>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{provisionStats.alreadyLinked || 0}</p>
        </div>
      </div>

      {err && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{err}</div>}
      {success && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm p-3">{success}</div>}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${tab === t.id ? 'bg-[#009944] text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
            {t.label} <span className={`ml-1 text-xs ${tab === t.id ? 'text-emerald-100' : 'text-slate-400'}`}>({counts[t.id] || 0})</span>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input className={`${inputCls} pl-9`} placeholder="Search by name or email..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400 text-sm">No users found.</div>
      ) : (
        <div className="grid gap-3">
          {filtered.map((u) => {
            const isSuperAdmin = u.role === 'super_admin'
            const canManage = !isSuperAdmin || actorRole === 'super_admin'
            const isPending = !u.status || u.status === 'pending'
            const roleOptions = myAssignableRoles.includes(u.role) || myAssignableRoles.length === 0 ? myAssignableRoles : [...myAssignableRoles, u.role]

            return (
              <div key={u.id} className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                {/* User info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900">{u.full_name || u.email || u.id}</span>
                    {isSuperAdmin && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200">
                        <Shield className="w-3 h-3" /> Super Admin
                      </span>
                    )}
                    <StatusBadge status={u.status || 'pending'} />
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-slate-400 flex-wrap">
                    {u.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {u.email}</span>}
                    {u.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {u.phone}</span>}
                    {u.department && <span className="flex items-center gap-1"><Building2 className="w-3 h-3" /> {u.department}</span>}
                    {u.branch && <span>· {u.branch}</span>}
                    {u.created_at && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {new Date(u.created_at).toLocaleDateString()}</span>}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-wrap">
                  {isSuperAdmin && actorRole !== 'super_admin' && (
                    <span className="text-xs text-purple-600 font-medium">Protected Account</span>
                  )}

                  {isPending && canManage && (
                    <>
                      <button onClick={() => setReviewUser(u)} disabled={busyId === u.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36] disabled:opacity-50">
                        <Eye className="w-3.5 h-3.5" /> Review
                      </button>
                      <button onClick={() => approveUser(u, { role: 'staff', department: cleanDepartmentValue(u.department), branch: u.branch })} disabled={busyId === u.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-600 text-xs font-medium hover:bg-emerald-50 disabled:opacity-50">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button onClick={() => rejectUser(u, 'Not specified')} disabled={busyId === u.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-rose-300 text-rose-600 text-xs font-medium hover:bg-rose-50 disabled:opacity-50">
                        <XCircle className="w-3.5 h-3.5" /> Reject
                      </button>
                      {['super_admin', 'admin', 'head_of_human_resources'].includes(actorRole) && (
                        <button onClick={() => reInvite(u)} disabled={busyId === u.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-medium hover:bg-slate-50 disabled:opacity-50">
                          <Send className="w-3.5 h-3.5" /> Re-invite
                        </button>
                      )}
                      {actorRole === 'super_admin' && (
                        <button onClick={() => deleteInvite(u)} disabled={busyId === u.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-medium hover:bg-rose-50 hover:text-rose-600 hover:border-rose-300 disabled:opacity-50">
                          <Trash2 className="w-3.5 h-3.5" /> Delete Invite
                        </button>
                      )}
                    </>
                  )}

                  {!isPending && canManage && !isSuperAdmin && (
                    <>
                      <select value={u.role || 'customer'} disabled={busyId === u.id} onChange={(e) => changeRole(u, e.target.value)}
                        className="h-8 rounded-md border border-slate-300 px-2 text-xs disabled:opacity-50">
                        {!roleOptions.includes(u.role) && <option value={u.role}>{ROLE_METADATA[u.role]?.label || u.role} (current)</option>}
                        {roleOptions.map((r) => <option key={r} value={r}>{ROLE_METADATA[r]?.label || r}</option>)}
                      </select>
                      {u.status === 'active' && (
                        <button onClick={() => deactivateUser(u)} disabled={busyId === u.id}
                          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs hover:bg-slate-50 disabled:opacity-50">
                          <PowerOff className="w-3.5 h-3.5" /> Deactivate
                        </button>
                      )}
                      {u.status === 'inactive' && (
                        <button onClick={() => reactivateUser(u)} disabled={busyId === u.id}
                          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-emerald-300 text-emerald-600 text-xs hover:bg-emerald-50 disabled:opacity-50">
                          <Power className="w-3.5 h-3.5" /> Reactivate
                        </button>
                      )}
                    </>
                  )}

                  {isSuperAdmin && actorRole === 'super_admin' && (
                    <select value={u.role || 'super_admin'} disabled={busyId === u.id} onChange={(e) => changeRole(u, e.target.value)}
                      className="h-8 rounded-md border border-slate-300 px-2 text-xs disabled:opacity-50">
                      {Object.values(ROLES).map((r) => <option key={r} value={r}>{ROLE_METADATA[r]?.label || r}</option>)}
                    </select>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Create User Modal */}
      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load() }} actorRole={actorRole} showToast={showToast} />}

      {/* Create Users from Employees Modal */}
      {showProvision && <EmployeeProvisioningModal onClose={() => setShowProvision(false)} onProvisioned={() => load()} actorRole={actorRole} showToast={showToast} />}

      {/* Review User Modal */}
      {reviewUser && <ReviewUserModal user={reviewUser} onClose={() => setReviewUser(null)} onApprove={approveUser} onReject={rejectUser} busyId={busyId} actorRole={actorRole} />}
    </div>
  )
}

// ============================================================
// CREATE USER MODAL
// ============================================================
function CreateUserModal({ onClose, onCreated, actorRole, showToast }) {
  const [form, setForm] = useState({ role: 'staff', user_type: 'staff' })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [employees, setEmployees] = useState([])
  const myRoles = assignableRoles(actorRole)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  useEffect(() => {
    let active = true
    supabase
      .from('employees')
      .select('id, full_name, email, employee_number, department, branch')
      .is('user_id', null)
      .not('email', 'is', null)
      .order('full_name', { ascending: true })
      .limit(200)
      .then(({ data, error }) => {
        if (active && !error) setEmployees(data || [])
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const linkEmployee = (employeeId) => {
    const emp = employees.find((e) => e.id === employeeId)
    setForm((f) => ({
      ...f,
      employeeId: employeeId || null,
      full_name: emp ? emp.full_name : f.full_name,
      email: emp ? emp.email : f.email,
      department: emp ? emp.department || f.department : f.department,
      branch: emp ? emp.branch || f.branch : f.branch,
    }))
  }

  const create = async () => {
    if (!form.email) { setError('Email is required.'); return }
    if (!form.full_name) { setError('Full name is required.'); return }
    setError('')
    setCreating(true)
    try {
      const { data, error } = await supabase.functions.invoke('create-user', {
        body: {
          email: form.email,
          fullName: form.full_name,
          phone: form.phone || null,
          role: form.role || 'staff',
          department: cleanDepartmentValue(form.department) || null,
          branch: form.branch || null,
          userType: form.user_type || 'staff',
          employeeId: form.employeeId || null,
        },
      })
      if (error) throw error
      if (data?.error === 'duplicate') { setError(data.message || 'User already exists'); return }
      if (data?.error) { setError(data.message || data.error); return }
      showToast(`Invitation sent successfully to ${form.email}.`)
      onCreated()
    } catch (e) {
      setError(e?.message || 'Failed to create user. Edge function may not be deployed.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-slate-900">Create User</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        {error && <p className="text-sm text-rose-600 mb-3">{error}</p>}
        <div className="space-y-4">
          <div>
            <label className={labelCls}>Link to employee (optional)</label>
            <select className={inputCls} value={form.employeeId || ''} onChange={(e) => linkEmployee(e.target.value)} disabled={creating}>
              <option value="">— None (standalone account) —</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.full_name}{e.employee_number ? ` (${e.employee_number})` : ''} — {e.email}</option>
              ))}
            </select>
            <p className="text-xs text-slate-400 mt-1">When chosen, the account email must match the employee email — the employee record stays authoritative.</p>
          </div>
          <div><label className={labelCls}>Full Name *</label><input className={inputCls} value={form.full_name || ''} onChange={set('full_name')} placeholder="John Doe" disabled={creating} /></div>
          <div><label className={labelCls}>Email *</label><input className={inputCls} value={form.email || ''} onChange={set('email')} placeholder="john@company.com" disabled={creating} /></div>
          <div><label className={labelCls}>Phone</label><input className={inputCls} value={form.phone || ''} onChange={set('phone')} placeholder="+1234567890" disabled={creating} /></div>
          <div>
            <label className={labelCls}>Role</label>
            <select className={inputCls} value={form.role || 'staff'} onChange={set('role')} disabled={creating}>
              {myRoles.map((r) => <option key={r} value={r}>{ROLE_METADATA[r]?.label || r}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>Department</label><input className={inputCls} value={form.department || ''} onChange={set('department')} placeholder="IT, Finance..." disabled={creating} /></div>
            <div><label className={labelCls}>Branch</label><input className={inputCls} value={form.branch || ''} onChange={set('branch')} placeholder="HQ, Lagos..." disabled={creating} /></div>
          </div>
          <div>
            <label className={labelCls}>User Type</label>
            <select className={inputCls} value={form.user_type || 'staff'} onChange={set('user_type')} disabled={creating}>
              <option value="staff">Staff</option>
              <option value="contractor">Contractor</option>
              <option value="intern">Intern</option>
              <option value="customer">Customer</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={create} disabled={creating} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Create User
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// REVIEW USER MODAL
// ============================================================
function ReviewUserModal({ user, onClose, onApprove, onReject, busyId, actorRole }) {
  const [assignment, setAssignment] = useState({ role: 'staff', department: user?.department || '', branch: user?.branch || '', user_type: 'staff' })
  const [rejectReason, setRejectReason] = useState('')
  const [mode, setMode] = useState('approve')
  const [options, setOptions] = useState({ departments: [], branches: [] })
  const [optionsError, setOptionsError] = useState('')
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [matchedEmployee, setMatchedEmployee] = useState(null)
  const myRoles = assignableRoles(actorRole)
  const set = (k) => (e) => setAssignment((a) => ({ ...a, [k]: e.target.value }))

  useEffect(() => {
    let mounted = true
    const load = async () => {
      setOptionsLoading(true)
      try {
        const [opts, employee] = await Promise.all([
          userProvisioningService.getDepartmentBranchOptions().catch(() => null),
          userProvisioningService.findEmployeeForProfile(user).catch(() => null),
        ])
        if (!mounted) return
        if (opts) setOptions(opts)
        if (employee) {
          setMatchedEmployee(employee)
          // MD/CEO, Chairman, Director… are ROLES, never departments. A role-like
          // value carried on the employee/profile record is dropped so approval
          // can never write a title back into the department column.
          const department = cleanDepartmentValue((employee.department && employee.department.trim()) || user?.department || '')
          const branch = (employee.resolved_branch && employee.resolved_branch.trim()) || user?.branch || ''
          setAssignment((a) => ({ ...a, department, branch }))
        }
      } catch (e) {
        if (mounted) setOptionsError(e?.message || 'Could not load registration options')
      } finally {
        if (mounted) setOptionsLoading(false)
      }
    }
    load()
    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Guarantee the current value is selectable even when the source lists are
  // missing it (messy/legacy data) — never silently drop HR's chosen value.
  // Role-like titles (MD/CEO, Chairman, Director…) are excluded here too: they
  // are not departments and must not appear as a selectable option.
  const selectedDepartment = cleanDepartmentValue(assignment.department)
  const deptOptions = filterDepartmentOptions(
    options.departments.includes(selectedDepartment)
      ? options.departments
      : [...new Set([selectedDepartment, ...options.departments].filter(Boolean))]
  )
  const branchOptions = options.branches.includes(assignment.branch)
    ? options.branches
    : [...new Set([assignment.branch, ...options.branches].filter(Boolean))]

  // If the option lookup itself failed entirely, fall back to free text so
  // approval is never blocked. Normal path uses dropdowns.
  const useInputFallback = Boolean(optionsError) || (optionsLoading === false && deptOptions.length === 0)

  const DepartmentField = useInputFallback
    ? <input className={inputCls} value={selectedDepartment} onChange={set('department')} placeholder="IT, Finance..." />
    : (
      <select className={inputCls} value={selectedDepartment} onChange={set('department')} disabled={optionsLoading}>
        <option value="">Select department…</option>
        {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    )

  const BranchField = useInputFallback
    ? <input className={inputCls} value={assignment.branch} onChange={set('branch')} placeholder="HQ, Lagos..." />
    : (
      <select className={inputCls} value={assignment.branch} onChange={set('branch')} disabled={optionsLoading}>
        <option value="">Select branch…</option>
        {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
    )

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-slate-900">Review Registration</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        {/* User Info */}
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 mb-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-xs font-semibold text-slate-400 uppercase">Name</p><p className="text-slate-800 font-medium">{user.full_name || '-'}</p></div>
            <div><p className="text-xs font-semibold text-slate-400 uppercase">Email</p><p className="text-slate-800">{user.email || '-'}</p></div>
            <div><p className="text-xs font-semibold text-slate-400 uppercase">Phone</p><p className="text-slate-800">{user.phone || '-'}</p></div>
            <div><p className="text-xs font-semibold text-slate-400 uppercase">Registered</p><p className="text-slate-800">{user.created_at ? new Date(user.created_at).toLocaleDateString() : '-'}</p></div>
            {(user.employee_number || user.designation || user.department || user.branch) && (
              <div className="col-span-2 mt-1 rounded-lg bg-white border border-slate-200 p-3">
                <p className="text-xs font-semibold text-slate-400 uppercase">Employee Record</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-1.5">
                  {user.employee_number && <div><p className="text-xs font-semibold text-slate-400 uppercase">Employee No.</p><p className="text-slate-800">{user.employee_number}</p></div>}
                  {user.designation && <div><p className="text-xs font-semibold text-slate-400 uppercase">Designation</p><p className="text-slate-800">{user.designation}</p></div>}
                  {user.department && <div><p className="text-xs font-semibold text-slate-400 uppercase">Department</p><p className="text-slate-800">{user.department}</p></div>}
                  {user.branch && <div><p className="text-xs font-semibold text-slate-400 uppercase">Branch</p><p className="text-slate-800">{user.branch}</p></div>}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Toggle: Approve / Reject */}
        <div className="flex gap-2 mb-4">
          <button onClick={() => setMode('approve')} className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium ${mode === 'approve' ? 'bg-emerald-50 text-emerald-700 border border-emerald-300' : 'border border-slate-200 text-slate-500'}`}>
            <CheckCircle2 className="w-4 h-4 inline mr-1" /> Approve & Activate
          </button>
          <button onClick={() => setMode('reject')} className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium ${mode === 'reject' ? 'bg-rose-50 text-rose-700 border border-rose-300' : 'border border-slate-200 text-slate-500'}`}>
            <XCircle className="w-4 h-4 inline mr-1" /> Reject
          </button>
        </div>

        {mode === 'approve' ? (
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Assign Role</label>
              <select className={inputCls} value={assignment.role} onChange={set('role')}>
                {myRoles.map((r) => <option key={r} value={r}>{ROLE_METADATA[r]?.label || r}</option>)}
              </select>
            </div>
            {matchedEmployee && (
              <p className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs px-3 py-2">
                Pre-filled from employee record: <strong>{matchedEmployee.full_name}</strong>
                {matchedEmployee.employee_number || matchedEmployee.staff_id ? ` · ${matchedEmployee.employee_number || matchedEmployee.staff_id}` : ''}. You can still override either value.
              </p>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Department</label>
                {DepartmentField}
              </div>
              <div>
                <label className={labelCls}>Branch</label>
                {BranchField}
              </div>
            </div>
            {optionsError && <p className="text-xs text-amber-600">Could not load department/branch lists — free text fallback used.</p>}
            <div>
              <label className={labelCls}>User Type</label>
              <select className={inputCls} value={assignment.user_type} onChange={set('user_type')}>
                <option value="staff">Staff</option>
                <option value="contractor">Contractor</option>
                <option value="intern">Intern</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={() => onApprove(user, assignment)} disabled={busyId === user.id}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busyId === user.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve & Activate
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div><label className={labelCls}>Reason for Rejection</label><textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Provide a reason..." /></div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={() => onReject(user, rejectReason)} disabled={busyId === user.id}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-60">
                {busyId === user.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />} Confirm Rejection
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// EMPLOYEE PROVISIONING MODAL — single/bulk "Create Users from
// Employees". Reads eligible employees (no user_id, has email),
// sends through the `invite-employees` Edge Function which does the
// server-side linking with the service-role key.
// ============================================================
function EmployeeProvisioningModal({ onClose, onProvisioned, actorRole, showToast }) {
  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState([])
  const [role, setRole] = useState('staff')
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)
  const [resending, setResending] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState('')
  const myRoles = assignableRoles(actorRole)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setEmployees(await userProvisioningService.getEligibleEmployees())
    } catch (e) {
      setError(e?.message || 'Failed to load employees. The employees table may not be readable.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const q = search.trim().toLowerCase()
  const filtered = employees.filter((e) =>
    !q ||
    (e.full_name || '').toLowerCase().includes(q) ||
    (e.email || '').toLowerCase().includes(q) ||
    (e.department || '').toLowerCase().includes(q) ||
    (e.resolved_branch || e.branch || '').toLowerCase().includes(q)
  )

  const selectedEmployees = employees.filter((employee) => selectedEmployeeIds.includes(employee.id))
  const selectedEmployee = selectedEmployees.length === 1 ? selectedEmployees[0] : null
  const selectedCount = selectedEmployees.length
  const hasValidEmail = (employee) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(employee?.email || '').trim())

  const toggleEmployee = (employeeId) => {
    setSelectedEmployeeIds((ids) => ids.includes(employeeId)
      ? ids.filter((id) => id !== employeeId)
      : [...ids, employeeId])
    setResults(null)
    setError('')
  }

  const toggleAllFiltered = () => {
    const validIds = filtered.filter(hasValidEmail).map((employee) => employee.id)
    const allSelected = validIds.length > 0 && validIds.every((id) => selectedEmployeeIds.includes(id))
    setSelectedEmployeeIds((ids) => allSelected
      ? ids.filter((id) => !validIds.includes(id))
      : [...new Set([...ids, ...validIds])])
    setResults(null)
    setError('')
  }

  const send = async () => {
    if (!selectedCount) return
    setSending(true)
    setError('')
    setResults(null)
    try {
      const res = await userProvisioningService.inviteEmployees(selectedEmployees, { role, reason })
      const list = res?.results || []
      setResults({ list, summary: userProvisioningService.summarizeResults(list) })
      const ok = list.filter((r) => ['SUCCESS', 'RESENT'].includes(r.result)).length
      const firstMessage = list.find((r) => r?.message)?.message || list.find((r) => r?.error)?.error || null
      showToast(ok ? `${ok} InfinityCore invitation${ok === 1 ? '' : 's'} sent successfully.` : (firstMessage || 'Invitation processed — check the result below'))
      if (ok) onProvisioned()
    } catch (e) {
      setError(e?.message || `Invitation request failed. Confirm the invite-employees Edge Function is deployed (HTTP ${e?.context?.status || e?.status || 'unknown'}).`)
    } finally {
      setSending(false)
    }
  }

  const resend = async () => {
    if (!selectedEmployee) return
    setResending(true)
    setError('')
    try {
      const res = await userProvisioningService.resendInvitation(selectedEmployee, { role, reason })
      const list = res?.results || []
      setResults({ list, summary: userProvisioningService.summarizeResults(list) })
      if (list.some((result) => result.result === 'RESENT')) {
        showToast(`Invitation resent successfully to ${selectedEmployee.email}.`)
        onProvisioned()
      }
    } catch (e) {
      setError(e?.message || 'Unable to resend the invitation.')
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2"><MailPlus className="w-5 h-5 text-[#009944]" /> Create Users from Employees</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-500">
            Select one or more employees from the staff record. Their HR information is the source of truth and is copied to each linked InfinityCore profile server-side.
            The invitation is sent only to the email stored on that employee record.
          </p>

          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>}

          {results && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 mb-3"><Send className="w-4 h-4 text-[#009944]" /> Invitation results</div>
              <div className="flex flex-wrap gap-2 mb-3 text-xs">
                {Object.entries(results.summary).filter(([, n]) => n > 0).map(([k, n]) => {
                  const meta = userProvisioningService.resultMeta(k)
                  return <span key={k} className={`inline-flex items-center gap-1 px-2 py-1 rounded-full font-medium ${meta.color}`}>{meta.label} • {n}</span>
                })}
              </div>
              {results.list.some((result) => ['SUCCESS', 'RESENT'].includes(result.result)) && (
                <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 mb-3">
                  <p><strong>Invitation status:</strong> Sent</p>
                  <p><strong>Employees selected:</strong> {selectedCount}</p>
                  <p><strong>Account:</strong> Pending activation</p>
                  {results.list.find((result) => result.expires_at)?.expires_at && <p><strong>Expires:</strong> {new Date(results.list.find((result) => result.expires_at).expires_at).toLocaleString()}</p>}
                </div>
              )}
              <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
                {results.list.map((r, i) => {
                  const meta = userProvisioningService.resultMeta(r.result || r.code || 'FAILED')
                  const detailMessage = r.message || r.error || (['SUCCESS', 'RESENT'].includes(r.result) ? 'Invitation sent.' : 'Invitation failed.')
                  return (
                    <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="text-slate-700 truncate">{r.employee_name || r.email || r.id || 'Employee record'}</p>
                        {r.email && <p className="text-xs text-slate-400 truncate">{r.email}</p>}
                        {(r.code || r.message || r.error) && (
                          <p className="mt-1 text-[11px] text-slate-500">
                            {r.code ? `Code: ${r.code}` : 'Reason:'} {detailMessage}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-xs font-medium ${meta.color}`}>{meta.label}</span>
                        {['SUCCESS', 'RESENT'].includes(r.result) && selectedEmployee && (
                          <button onClick={resend} disabled={resending} className="text-xs text-[#009944] hover:underline disabled:opacity-50">
                            {resending ? 'Sending…' : 'Resend'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Search */}
          {!results && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input className={`${inputCls} pl-9`} placeholder="Search employees..." value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <button type="button" onClick={toggleAllFiltered} disabled={!filtered.some(hasValidEmail)} className="shrink-0 px-3 h-10 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                {filtered.filter(hasValidEmail).length > 0 && filtered.filter(hasValidEmail).every((employee) => selectedEmployeeIds.includes(employee.id)) ? 'Clear filtered' : 'Select filtered'}
              </button>
            </div>
          )}

          {/* Employee list */}
          {!results && (loading ? (
            <div className="flex justify-center py-10"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">No eligible employees found (all staff may already have accounts, or the employee list is empty).</div>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100 bg-white">
              {filtered.map((e) => {
                const selected = selectedEmployeeIds.includes(e.id)
                const validEmail = hasValidEmail(e)
                return <button key={e.id} type="button" disabled={!validEmail} onClick={() => toggleEmployee(e.id)} className={`w-full text-left flex items-center gap-3 px-4 py-3 transition disabled:cursor-not-allowed disabled:opacity-55 ${selected ? 'bg-emerald-50 ring-1 ring-inset ring-[#009944]' : 'hover:bg-slate-50'}`}>
                  <span className={`w-4 h-4 rounded border-2 shrink-0 ${selected ? 'border-[#009944] bg-[#009944] shadow-[inset_0_0_0_3px_white]' : 'border-slate-300'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 truncate">{e.full_name || '—'}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {e.email || 'No email on record'} {e.department ? `• ${e.department}` : ''} {e.resolved_branch || e.branch ? `• ${e.resolved_branch || e.branch}` : ''}
                    </p>
                  </div>
                  {selected && <CheckCircle2 className="w-4 h-4 text-[#009944] shrink-0" />}
                </button>
              })}
            </div>
          ))}

          {/* Selected employee source-of-truth record and account configuration */}
          {!results && (
            <div className="border-t border-slate-100 pt-4 space-y-4">
              {!selectedCount ? (
                <p className="text-sm text-slate-400 text-center py-2">Select an employee to review their account details.</p>
              ) : !selectedEmployee ? (
                <p className="text-sm text-slate-500 text-center py-2">{selectedCount} employees selected. Each account will use its employee record and email address.</p>
              ) : (
                <>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 mb-2">Employee Information</h4>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Name</p><p className="text-slate-800 font-medium">{selectedEmployee.full_name || '—'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Email</p><p className="text-slate-800 break-all">{selectedEmployee.email || 'No valid email'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Phone</p><p className="text-slate-800">{selectedEmployee.phone || '—'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Employee ID</p><p className="text-slate-800 break-all">{selectedEmployee.id || '—'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Employee Code</p><p className="text-slate-800">{selectedEmployee.employee_number || selectedEmployee.staff_id || selectedEmployee.employee_code || '—'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Department</p><p className="text-slate-800">{selectedEmployee.department || 'Not recorded'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Branch</p><p className="text-slate-800">{selectedEmployee.resolved_branch || selectedEmployee.branch || 'Not recorded'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Area</p><p className="text-slate-800">{selectedEmployee.resolved_area || selectedEmployee.area || 'Not recorded'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Designation</p><p className="text-slate-800">{selectedEmployee.position || selectedEmployee.designation || selectedEmployee.designation_title || '—'}</p></div>
                      <div><p className="text-xs text-slate-400 uppercase font-semibold">Employment</p><p className="text-slate-800">{selectedEmployee.employment_type || '—'}{selectedEmployee.employment_status ? ` • ${selectedEmployee.employment_status}` : ''}</p></div>
                      {(selectedEmployee.manager_name || selectedEmployee.supervisor_name || selectedEmployee.reporting_manager) && <div><p className="text-xs text-slate-400 uppercase font-semibold">Manager / Supervisor</p><p className="text-slate-800">{selectedEmployee.manager_name || selectedEmployee.supervisor_name || selectedEmployee.reporting_manager}{selectedEmployee.supervisor_title ? ` • ${selectedEmployee.supervisor_title}` : ''}</p></div>}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-3 text-xs">
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 px-2 py-1"><CheckCircle2 className="w-3.5 h-3.5" /> Employee found</span>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${selectedEmployee.email ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}><Mail className="w-3.5 h-3.5" /> {selectedEmployee.email ? 'Email available' : 'Email required'}</span>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${selectedEmployee.department ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}><Building2 className="w-3.5 h-3.5" /> {selectedEmployee.department ? 'Department detected' : 'Department not recorded'}</span>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${selectedEmployee.resolved_branch || selectedEmployee.branch ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}><Building2 className="w-3.5 h-3.5" /> {selectedEmployee.resolved_branch || selectedEmployee.branch ? 'Branch detected' : 'Branch not recorded'}</span>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold text-slate-900 mb-2">Account Configuration</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="sm:col-span-2"><label className={labelCls}>Email</label><input className={`${inputCls} bg-slate-50`} value={selectedEmployee.email || 'No valid email'} readOnly /></div>
                      <div><label className={labelCls}>Role</label><select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)} disabled={sending || resending}>{myRoles.map((r) => <option key={r} value={r}>{ROLE_METADATA[r]?.label || r}</option>)}</select></div>
                      <div><label className={labelCls}>User Type</label><input className={`${inputCls} bg-slate-50`} value="Staff" readOnly /></div>
                      <div><label className={labelCls}>Department</label><input className={`${inputCls} bg-slate-50`} value={selectedEmployee.department || 'Not recorded'} readOnly /></div>
                      <div><label className={labelCls}>Branch</label><input className={`${inputCls} bg-slate-50`} value={selectedEmployee.resolved_branch || selectedEmployee.branch || 'Not recorded'} readOnly /></div>
                    </div>
                  </div>

                  <div>
                    <label className={labelCls}>Reason (optional, recorded in audit)</label>
                    <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. New employee account activation" disabled={sending || resending} />
                  </div>
                </>
              )}
              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
                <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={send} disabled={sending || !selectedCount} className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send {selectedCount || ''} InfinityCore Invitation{selectedCount === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
