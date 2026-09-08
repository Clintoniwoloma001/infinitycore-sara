import React, { useEffect, useState, useMemo } from 'react'
import { Loader2, X, Check, Ban, UserCheck, UserX, Clock, Mail, Calendar, Shield, Building2, Key, ChevronRight, ChevronLeft } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { userApprovalService } from '../services/userApprovalService'
import { StatusBadge } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'
import { ROLES, ROLE_METADATA, assignableRoles } from '../constants/roles'
import { PERMISSIONS } from '../constants/permissions'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: 'amber' },
  active: { label: 'Active', color: 'emerald' },
  suspended: { label: 'Suspended', color: 'rose' },
  rejected: { label: 'Rejected', color: 'rose' },
}

// All available modules for access profile configuration
const ALL_MODULES = [
  { key: 'dashboard', label: 'Home / Dashboard' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'my-work', label: 'My Work' },
  { key: 'leave-requests', label: 'Leave' },
  { key: 'employees', label: 'Employee' },
  { key: 'recruitment', label: 'Recruitment' },
  { key: 'interviews', label: 'Interviews' },
  { key: 'assessments', label: 'Assessments' },
  { key: 'reports', label: 'Reports' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'customers', label: 'Customers' },
  { key: 'loans', label: 'Loans' },
  { key: 'bankone-imports', label: 'BankOne' },
  { key: 'reconciliation', label: 'Reconciliation' },
  { key: 'users', label: 'User Management' },
  { key: 'settings', label: 'Settings' },
  { key: 'work-management', label: 'Work Management' },
]

// Default basic user access modules
const BASIC_USER_MODULES = ['dashboard', 'attendance', 'my-work']

export default function Users() {
  const { name: userName, role: actorRole } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('pending')
  const [reviewUser, setReviewUser] = useState(null)
  const [wizard, setWizard] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState({ kind: '', text: '' })

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await userApprovalService.listUsers()
      setUsers(data)
    } catch (e) {
      setError(e?.message || 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Summary counts
  const summary = useMemo(() => ({
    pending: users.filter((u) => u.status === 'pending').length,
    active: users.filter((u) => u.status === 'active').length,
    suspended: users.filter((u) => u.status === 'suspended').length,
    total: users.length,
  }), [users])

  // Filter by tab
  const filtered = useMemo(() => {
    if (activeTab === 'all') return users
    return users.filter((u) => (u.status || 'pending') === activeTab)
  }, [users, activeTab])

  const openReview = (user) => {
    setReviewUser(user)
    setNotice({ kind: '', text: '' })
  }

  const startApproval = (user) => {
    setWizard({ step: 1, user, role: 'customer', department: '', modules: [...BASIC_USER_MODULES] })
    setReviewUser(null)
  }

  const handleApprove = async () => {
    const { user, role, department, modules } = wizard
    setBusy(true)
    setNotice({ kind: '', text: '' })
    try {
      await userApprovalService.approveUser({
        userId: user.id,
        role,
        department: department || null,
        modules,
      })
      setNotice({ kind: 'ok', text: `${user.email || user.full_name || 'User'} has been approved and activated.` })
      setWizard(null)
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Approval failed' })
    } finally {
      setBusy(false)
    }
  }

  const handleReject = async (user, reason) => {
    setBusy(true)
    setNotice({ kind: '', text: '' })
    try {
      await userApprovalService.rejectUser({ userId: user.id, reason })
      setNotice({ kind: 'ok', text: `${user.email || 'User'} has been rejected.` })
      setReviewUser(null)
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Rejection failed' })
    } finally {
      setBusy(false)
    }
  }

  const handleSuspend = async (user, reason) => {
    setBusy(true)
    setNotice({ kind: '', text: '' })
    try {
      await userApprovalService.suspendUser({ userId: user.id, reason })
      setNotice({ kind: 'ok', text: `${user.email || 'User'} has been suspended.` })
      setReviewUser(null)
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Suspension failed' })
    } finally {
      setBusy(false)
    }
  }

  const handleActivate = async (user) => {
    setBusy(true)
    setNotice({ kind: '', text: '' })
    try {
      await userApprovalService.activateUser(user.id)
      setNotice({ kind: 'ok', text: `${user.email || 'User'} has been activated.` })
      setReviewUser(null)
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e?.message || 'Activation failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">User Management</h2>
        <p className="text-sm text-slate-500 mt-1">Every new signup starts as a pending customer. Approve, assign roles, departments, and module access here. All actions are enforced and audited server-side.</p>
      </div>

      {notice.text && (
        <div className={`mb-5 rounded-lg border p-4 text-sm ${notice.kind === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}>
          {notice.text}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Pending', value: summary.pending, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' },
          { label: 'Active', value: summary.active, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200' },
          { label: 'Suspended', value: summary.suspended, color: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-200' },
          { label: 'Total Users', value: summary.total, color: 'text-slate-900', bg: 'bg-slate-50', border: 'border-slate-200' },
        ].map((s) => (
          <div key={s.label} className={`rounded-xl border ${s.border} ${s.bg} p-4`}>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Status Tabs */}
      <div className="flex gap-2 mb-5 overflow-x-auto pb-1">
        {[
          { key: 'pending', label: 'Pending Approval' },
          { key: 'active', label: 'Active' },
          { key: 'suspended', label: 'Suspended' },
          { key: 'rejected', label: 'Rejected' },
          { key: 'all', label: 'All Users' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition ${activeTab === t.key ? 'bg-[#009944] text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <ErrorState message={error} />}
      {loading && <LoadingState label="Loading users..." />}
      {!loading && !error && filtered.length === 0 && <EmptyState title="No users found" description="There are no users matching this filter." />}

      {/* Users Table */}
      {!loading && !error && filtered.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-left">
                <tr>
                  <th className="px-6 py-3 font-medium whitespace-nowrap">Name</th>
                  <th className="px-6 py-3 font-medium whitespace-nowrap">Email</th>
                  <th className="px-6 py-3 font-medium whitespace-nowrap">Signup Date</th>
                  <th className="px-6 py-3 font-medium whitespace-nowrap">Role</th>
                  <th className="px-6 py-3 font-medium whitespace-nowrap">Status</th>
                  <th className="px-6 py-3 font-medium whitespace-nowrap">Department</th>
                  <th className="px-6 py-3 font-medium whitespace-nowrap text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((u) => {
                  const sc = STATUS_CONFIG[u.status || 'pending'] || STATUS_CONFIG.pending
                  return (
                    <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-3 font-medium text-slate-800">{u.full_name || '—'}</td>
                      <td className="px-6 py-3 text-slate-600">{u.email || '—'}</td>
                      <td className="px-6 py-3 text-slate-500 text-xs">{u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</td>
                      <td className="px-6 py-3">
                        <StatusBadge label={ROLE_METADATA[u.role]?.label || u.role || 'Customer'} color={ROLE_METADATA[u.role]?.color ? 'blue' : 'slate'} />
                      </td>
                      <td className="px-6 py-3"><StatusBadge label={sc.label} color={sc.color} /></td>
                      <td className="px-6 py-3 text-slate-600">{u.department || '—'}</td>
                      <td className="px-6 py-3 text-right">
                        <button
                          onClick={() => openReview(u)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36] transition-colors"
                        >
                          Review
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Review Modal */}
      {reviewUser && (
        <ReviewModal
          user={reviewUser}
          onClose={() => setReviewUser(null)}
          onApprove={startApproval}
          onReject={handleReject}
          onSuspend={handleSuspend}
          onActivate={handleActivate}
          actorRole={actorRole}
          busy={busy}
        />
      )}

      {/* Approval Wizard */}
      {wizard && (
        <ApprovalWizard
          wizard={wizard}
          setWizard={setWizard}
          onComplete={handleApprove}
          onCancel={() => setWizard(null)}
          busy={busy}
          actorRole={actorRole}
        />
      )}
    </div>
  )
}

// ============================================================
// REVIEW MODAL — User Account Review
// ============================================================
function ReviewModal({ user, onClose, onApprove, onReject, onSuspend, onActivate, actorRole, busy }) {
  const [rejectMode, setRejectMode] = useState(false)
  const [suspendMode, setSuspendMode] = useState(false)
  const [reason, setReason] = useState('')
  const [audit, setAudit] = useState([])
  const [loadingAudit, setLoadingAudit] = useState(true)

  useEffect(() => {
    const loadAudit = async () => {
      try {
        const data = await userApprovalService.getAuditTrail(user.id)
        setAudit(data)
      } catch { setAudit([]) }
      finally { setLoadingAudit(false) }
    }
    loadAudit()
  }, [user.id])

  const sc = STATUS_CONFIG[user.status || 'pending'] || STATUS_CONFIG.pending
  const canApprove = user.status === 'pending'
  const canSuspend = user.status === 'active'
  const canActivate = user.status === 'suspended' || user.status === 'rejected'

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">User Account Review</h3>
            <p className="text-sm text-slate-500">{user.email || user.id}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6 space-y-5">
          {/* Personal Information */}
          <div>
            <h4 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2"><Shield className="w-4 h-4 text-slate-400" /> Personal Information</h4>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <InfoRow label="Full Name" value={user.full_name || '—'} />
              <InfoRow label="Email" value={user.email || '—'} />
              <InfoRow label="Phone" value={user.phone || '—'} />
              <InfoRow label="Signup Date" value={user.created_at ? new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'} />
              <InfoRow label="Current Role" value={ROLE_METADATA[user.role]?.label || user.role || 'Customer'} />
              <InfoRow label="Current Status" value={<StatusBadge label={sc.label} color={sc.color} />} />
              <InfoRow label="Department" value={user.department || '—'} />
              <InfoRow label="Approved By" value={user.approved_by ? 'Yes' : 'No'} />
            </div>
            {user.rejected_reason && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                <span className="font-medium">Rejection/Suspension Reason: </span>{user.rejected_reason}
              </div>
            )}
          </div>

          {/* Audit Trail */}
          <div>
            <h4 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2"><Clock className="w-4 h-4 text-slate-400" /> Account History</h4>
            {loadingAudit ? <p className="text-sm text-slate-400">Loading...</p> : audit.length === 0 ? (
              <p className="text-sm text-slate-400">No account actions recorded yet.</p>
            ) : (
              <div className="space-y-2">
                {audit.map((a) => (
                  <div key={a.id} className="flex items-start gap-3 text-xs border-l-2 border-slate-200 pl-3 py-1">
                    <div>
                      <span className="font-medium text-slate-700">{a.action.replace(/_/g, ' ')}</span>
                      <span className="text-slate-400 ml-2">{new Date(a.created_at).toLocaleString()}</span>
                      {a.reason && <p className="text-slate-500 mt-0.5">Reason: {a.reason}</p>}
                      {a.approver_name && <p className="text-slate-400">By: {a.approver_name}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Rejection/Suspension form */}
          {(rejectMode || suspendMode) && (
            <div className="rounded-lg border border-slate-200 p-4 space-y-3">
              <label className={labelCls}>{rejectMode ? 'Rejection Reason' : 'Suspension Reason'}</label>
              <textarea
                className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={rejectMode ? 'e.g. Invalid registration details' : 'e.g. Policy violation'}
              />
              <div className="flex justify-end gap-2">
                <button onClick={() => { setRejectMode(false); setSuspendMode(false); setReason('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button
                  onClick={() => { rejectMode ? onReject(user, reason) : onSuspend(user, reason) }}
                  disabled={busy || !reason}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {rejectMode ? 'Reject User' : 'Suspend User'}
                </button>
              </div>
            </div>
          )}

          {/* Actions */}
          {!rejectMode && !suspendMode && (
            <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
              {canApprove && (
                <button
                  onClick={() => onApprove(user)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
                >
                  <UserCheck className="w-4 h-4" /> Approve User
                </button>
              )}
              {canApprove && (
                <button
                  onClick={() => setRejectMode(true)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-rose-300 text-rose-700 text-sm font-medium hover:bg-rose-50 disabled:opacity-50"
                >
                  <UserX className="w-4 h-4" /> Reject User
                </button>
              )}
              {canSuspend && (
                <button
                  onClick={() => setSuspendMode(true)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-300 text-amber-700 text-sm font-medium hover:bg-amber-50 disabled:opacity-50"
                >
                  <Ban className="w-4 h-4" /> Suspend
                </button>
              )}
              {canActivate && (
                <button
                  onClick={() => onActivate(user)}
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                  <UserCheck className="w-4 h-4" /> Activate
                </button>
              )}
              <button onClick={onClose} className="ml-auto px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="font-medium text-slate-800 mt-0.5">{value}</div>
    </div>
  )
}

// ============================================================
// APPROVAL WIZARD — Role → Department → Access Profile
// ============================================================
function ApprovalWizard({ wizard, setWizard, onComplete, onCancel, busy, actorRole }) {
  const { step, user, role, department, modules } = wizard
  const [departments, setDepartments] = useState([])
  const myAssignableRoles = assignableRoles(actorRole)

  useEffect(() => {
    const loadDepts = async () => {
      try {
        const { data } = await supabase
          .from('employees')
          .select('department')
          .not('department', 'is', null)
          .neq('department', '')
        const depts = [...new Set((data || []).map((d) => d.department))]
        setDepartments(depts)
      } catch { setDepartments([]) }
    }
    loadDepts()
  }, [])

  const updateWizard = (updates) => setWizard({ ...wizard, ...updates })

  const toggleModule = (key) => {
    const next = modules.includes(key) ? modules.filter((m) => m !== key) : [...modules, key]
    updateWizard({ modules: next })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Approve User</h3>
            <p className="text-sm text-slate-500">{user.email}</p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-slate-100">
          {[
            { n: 1, label: 'Role', icon: Shield },
            { n: 2, label: 'Department', icon: Building2 },
            { n: 3, label: 'Access', icon: Key },
          ].map((s) => {
            const Icon = s.icon
            return (
              <React.Fragment key={s.n}>
                <div className={`flex items-center gap-1.5 text-sm ${step >= s.n ? 'text-[#009944] font-medium' : 'text-slate-400'}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs ${step >= s.n ? 'bg-[#009944] text-white' : 'bg-slate-100 text-slate-400'}`}>
                    {step > s.n ? <Check className="w-4 h-4" /> : s.n}
                  </div>
                  {s.label}
                </div>
                {s.n < 3 && <div className={`flex-1 h-px ${step > s.n ? 'bg-[#009944]' : 'bg-slate-200'}`} />}
              </React.Fragment>
            )
          })}
        </div>

        <div className="p-6">
          {/* Step 1 — Role */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500 mb-2">Select the role for this user. Only roles you are authorized to assign are shown. This is enforced server-side.</p>
              {myAssignableRoles.length === 0 ? (
                <p className="text-sm text-rose-600">You are not authorized to assign roles. Contact a higher-level administrator.</p>
              ) : (
                <div className="space-y-2">
                  {myAssignableRoles.map((r) => (
                    <button
                      key={r}
                      onClick={() => updateWizard({ role: r })}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-left transition ${role === r ? 'border-[#009944] bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`}
                    >
                      <div>
                        <div className="font-medium text-slate-800">{ROLE_METADATA[r]?.label || r}</div>
                        <div className="text-xs text-slate-500">{ROLE_METADATA[r]?.description || ''}</div>
                      </div>
                      {role === r && <Check className="w-5 h-5 text-[#009944]" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 2 — Department */}
          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500 mb-2">Assign the user to a department. You can also type a new department name.</p>
              <input
                list="dept-list"
                className={inputCls}
                value={department}
                onChange={(e) => updateWizard({ department: e.target.value })}
                placeholder="Select or type department"
              />
              <datalist id="dept-list">
                {departments.map((d) => <option key={d} value={d} />)}
              </datalist>
              <p className="text-xs text-slate-400">Leave blank if no department assignment is needed.</p>
            </div>
          )}

          {/* Step 3 — Access Profile */}
          {step === 3 && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500 mb-2">Select which modules this user can access. Basic users get Home, Attendance, and My Work by default.</p>
              <div className="grid grid-cols-2 gap-2">
                {ALL_MODULES.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => toggleModule(m.key)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm text-left transition ${modules.includes(m.key) ? 'border-[#009944] bg-emerald-50 text-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                  >
                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${modules.includes(m.key) ? 'bg-[#009944] border-[#009944]' : 'border-slate-300'}`}>
                      {modules.includes(m.key) && <Check className="w-3 h-3 text-white" />}
                    </div>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => step > 1 ? updateWizard({ step: step - 1 }) : onCancel()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
            >
              <ChevronLeft className="w-4 h-4" /> {step > 1 ? 'Back' : 'Cancel'}
            </button>
            {step < 3 ? (
              <button
                onClick={() => updateWizard({ step: step + 1 })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={onComplete}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Approve & Activate
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
