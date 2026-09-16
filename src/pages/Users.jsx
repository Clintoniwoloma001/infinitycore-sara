import React, { useEffect, useState, useCallback } from 'react'
import { supabase } from '../supabaseClient'
import { logAction } from '../services/supabaseService'
import { useAuth } from '../hooks/useAuth'
import { ROLE_METADATA, ROLES, assignableRoles } from '../constants/roles'
import { userProvisioningService } from '../services/userProvisioningService'
import { Shield, UserPlus, CheckCircle2, XCircle, Loader2, Search, UserCog, Power, PowerOff, Mail, Phone, Building2, Calendar, Eye, X, MailPlus, Send, UserCheck, Clock, Layers } from 'lucide-react'

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
        p_department: assignment.department || null,
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
                      <button onClick={() => approveUser(u, { role: 'staff', department: u.department, branch: u.branch })} disabled={busyId === u.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-600 text-xs font-medium hover:bg-emerald-50 disabled:opacity-50">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                      </button>
                      <button onClick={() => rejectUser(u, 'Not specified')} disabled={busyId === u.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-rose-300 text-rose-600 text-xs font-medium hover:bg-rose-50 disabled:opacity-50">
                        <XCircle className="w-3.5 h-3.5" /> Reject
                      </button>
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
  const myRoles = assignableRoles(actorRole)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

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
          department: form.department || null,
          branch: form.branch || null,
          userType: form.user_type || 'staff',
        },
      })
      if (error) throw error
      if (data?.error === 'duplicate') { setError(data.message || 'User already exists'); return }
      if (data?.error) { setError(data.message || data.error); return }
      showToast(`User ${form.email} created successfully`)
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
  const [assignment, setAssignment] = useState({ role: 'staff', department: '', branch: '', user_type: 'staff' })
  const [rejectReason, setRejectReason] = useState('')
  const [mode, setMode] = useState('approve')
  const myRoles = assignableRoles(actorRole)
  const set = (k) => (e) => setAssignment((a) => ({ ...a, [k]: e.target.value }))

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
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Department</label><input className={inputCls} value={assignment.department} onChange={set('department')} placeholder="IT, Finance..." /></div>
              <div><label className={labelCls}>Branch</label><input className={inputCls} value={assignment.branch} onChange={set('branch')} placeholder="HQ, Lagos..." /></div>
            </div>
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
  const [selected, setSelected] = useState({})
  const [role, setRole] = useState('staff')
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)
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
    (e.department || '').toLowerCase().includes(q)
  )

  const allSelected = filtered.length > 0 && filtered.every((e) => selected[e.id])
  const selectedList = employees.filter((e) => selected[e.id])
  const count = selectedList.length

  const toggle = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }))
  const toggleAll = () => {
    const next = { ...selected }
    filtered.forEach((e) => { if (allSelected) delete next[e.id]; else next[e.id] = true })
    setSelected(next)
  }

  const send = async () => {
    if (count === 0) return
    setSending(true)
    setError('')
    setResults(null)
    try {
      const res = await userProvisioningService.inviteEmployees(selectedList, { role, reason })
      const list = res?.results || []
      setResults({ list, summary: userProvisioningService.summarizeResults(list) })
      setSelected({})
      const ok = list.filter((r) => r.result === 'SUCCESS').length
      showToast(ok ? `${ok} invitation(s) sent` : 'Invitations processed — check results below')
      if (ok) onProvisioned()
    } catch (e) {
      setError(e?.message || `Invitation request failed. Confirm the invite-employees Edge Function is deployed (HTTP ${e?.context?.status || e?.status || 'unknown'}).`)
    } finally {
      setSending(false)
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
            Select employees from the staff record (active, with an email, and no linked InfinityCore account — so invites are never duplicated).
            Account creation happens server-side; each employee then receives a setup invitation.
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
              <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
                {results.list.map((r, i) => {
                  const meta = userProvisioningService.resultMeta(r.result)
                  return (
                    <div key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="text-slate-700">{r.employee_name || r.id || r.email || '—'}</span>
                      <span className={`text-xs font-medium ${meta.color}`}>{meta.label}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Search + select all */}
          {!results && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input className={`${inputCls} pl-9`} placeholder="Search employees..." value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {filtered.length > 0 && (
                <button onClick={toggleAll} className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
                  <UserCheck className="w-4 h-4" /> {allSelected ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>
          )}

          {/* Employee list */}
          {!results && (loading ? (
            <div className="flex justify-center py-10"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 text-slate-400 text-sm">No eligible employees found (all staff may already have accounts, or the employee list is empty).</div>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100 bg-white">
              {filtered.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-4 py-3">
                  <input type="checkbox" checked={!!selected[e.id]} onChange={() => toggle(e.id)} className="w-4 h-4 accent-[#009944]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900 truncate">{e.full_name || '—'}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {e.email || 'no email'} {e.department ? `• ${e.department}` : ''} {e.employee_number || e.staff_id || e.employee_code ? `• ${e.employee_number || e.staff_id || e.employee_code}` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* Assignment + send */}
          {!results && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end border-t border-slate-100 pt-4">
              <div className="sm:w-44">
                <label className={labelCls}>Default Role</label>
                <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
                  {myRoles.map((r) => <option key={r} value={r}>{ROLE_METADATA[r]?.label || r}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className={labelCls}>Reason (optional, recorded in audit)</label>
                <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Phase 2 onboarding — new joiners" />
              </div>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={send} disabled={sending || count === 0} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50">
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send Invitations ({count})
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
