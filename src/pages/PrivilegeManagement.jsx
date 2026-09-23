import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Check, ChevronDown, ChevronUp, Loader2, Lock, RefreshCw,
  Search, Shield, ShieldCheck, ShieldOff, Trash2, UserCog, KeyRound, X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { privilegeService } from '../services/privilegeService'
import { supabase } from '../supabaseClient'
import { ROLES, ROLE_METADATA } from '../constants/roles'

const inputCls = 'w-full h-11 rounded-xl border border-slate-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]/40 focus:border-[#009944] transition-all duration-200'
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1.5'
const btnPrimary = 'inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-[#009944] text-white text-sm font-semibold hover:bg-[#007a37] transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
const btnGhost = 'inline-flex items-center gap-2 h-10 px-4 rounded-xl border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

const ROLE_LIST = Object.entries(ROLES)

function roleLabel(role) {
  return ROLE_METADATA[role]?.label || role
}

function ReasonModal({ title, prompt, actionLabel, onConfirm, onClose, onAutoFill }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const valid = reason.trim().length >= 5

  const submit = async () => {
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm(reason.trim())
      onClose()
    } catch (e) {
      setError(e?.message || 'The change could not be saved')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            <p className="text-sm text-slate-500 mt-0.5">{prompt}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="px-6 py-4">
          <label className={labelCls}>Reason (mandatory, at least 5 characters — recorded in the audit log)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Why is this access being changed?"
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]/40 focus:border-[#009944]"
          />
          {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-200">
          <button onClick={onClose} className={btnGhost}>Cancel</button>
          <button onClick={submit} disabled={!valid || saving} className={btnPrimary}>
            {saving && <Loader2 size={15} className="animate-spin" />}
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModuleGroup({ module, perms, render }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 text-left"
      >
        <span className="text-sm font-semibold text-slate-800 capitalize">{module}</span>
        <span className="text-xs text-slate-500">{perms.length}</span>
        {open ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
      </button>
      {open && <div className="divide-y divide-slate-100">{perms.map(render)}</div>}
    </div>
  )
}

function PermRow({ perm, children, meta }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-[12px] font-mono font-semibold text-slate-800">{perm.permission_key}</code>
          {perm.sensitive && <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-[#b45309] bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5"><Lock size={10} /> Sensitive</span>}
        </div>
        <p className="text-xs text-slate-500 truncate">{perm.description}</p>
      </div>
      {children}
      {meta}
    </div>
  )
}

const TABS = [
  { id: 'roles', label: 'Role Privileges', icon: ShieldCheck },
  { id: 'users', label: 'User Privileges', icon: UserCog },
  { id: 'effective', label: 'Effective Access', icon: KeyRound },
  { id: 'fields', label: 'Field Visibility', icon: Shield },
  { id: 'delegation', label: 'Delegation', icon: Shield },
  { id: 'history', label: 'History', icon: RefreshCw },
]

export default function PrivilegeManagement() {
  const { role: myRole, refreshPermissions } = useAuth()
  const [tab, setTab] = useState('roles')
  const [catalog, setCatalog] = useState([])
  const [roleMap, setRoleMap] = useState({})
  const [authority, setAuthority] = useState(null)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // role tab
  const [selRole, setSelRole] = useState(ROLES.HEAD_OF_HUMAN_RESOURCES)
  // user tab
  const [userQuery, setUserQuery] = useState('')
  const [selUser, setSelUser] = useState(null)
  const [userMap, setUserMap] = useState([])
  // effective
  const [effUser, setEffUser] = useState(null)
  const [effDoc, setEffDoc] = useState(null)
  // fields
  const [fieldRules, setFieldRules] = useState([])
  const [sensitiveFields, setSensitiveFields] = useState([])
  // delegation
  const [delegations, setDelegations] = useState([])
  // history
  const [audit, setAudit] = useState([])
  const [auditTargetType, setAuditTargetType] = useState('')

  const [pending, setPending] = useState(null) // { title, prompt, actionLabel, onConfirm }
  const [search, setSearch] = useState('')

  const canManage = authority?.can_manage_privileges === true
  const isSuper = myRole === ROLES.SUPER_ADMIN

  const modules = useMemo(() => {
    const list = []
    for (const p of catalog || []) if (!list.includes(p.module)) list.push(p.module)
    return list.sort()
  }, [catalog])

  const loadCatalog = async () => {
    const [cat, rmap, auth] = await Promise.all([
      privilegeService.searchPermissions(),
      privilegeService.getRolePermissionMap(),
      privilegeService.getPrivilegeAuthority(),
    ])
    setCatalog(cat || [])
    setRoleMap(rmap || {})
    setAuthority(auth)
  }

  const loadUsers = async () => {
    const { data, error: err } = await supabase
      .from('profiles')
      .select('id, full_name, email, role')
      .order('full_name', { ascending: true })
    if (err) throw err
    return data || []
  }

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      await loadCatalog()
      setUsers(await loadUsers())
    } catch (e) {
      setError(e?.message || 'Failed to load privilege data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!canManage) return
    ;(async () => {
      try {
        const [fRules, sFields] = await Promise.all([
          supabase.from('permission_field_rules').select('*').order('granted_at', { ascending: false }),
          privilegeService.listSensitiveFields(),
        ])
        setFieldRules(fRules.data || [])
        setSensitiveFields(sFields || [])
      } catch { /* non-fatal */ }
    })()
  }, [canManage, tab])

  useEffect(() => {
    if (!canManage) return
    privilegeService.listDelegations().then(setDelegations).catch(() => {})
  }, [canManage, tab])

  useEffect(() => {
    if (!canManage) return
    privilegeService.getPermissionAudit({ limit: 200 }).then(setAudit).catch(() => {})
  }, [canManage, tab])

  const refreshAfterChange = async () => {
    await loadCatalog()
    setUserMap([])
    setSelUser(null)
    setEffDoc(null)
    if (tab === 'fields' && canManage) {
      const { data } = await supabase.from('permission_field_rules').select('*').order('granted_at', { ascending: false })
      setFieldRules(data || [])
    }
    if (tab === 'delegation') {
      setDelegations(await privilegeService.listDelegations().catch(() => []))
    }
    if (tab === 'history') {
      setAudit(await privilegeService.getPermissionAudit({ limit: 200 }).catch(() => []))
    }
    if (typeof refreshPermissions === 'function') refreshPermissions()
  }

  const filteredUsers = useMemo(() => {
    const q = (userQuery || '').trim().toLowerCase()
    if (!q) return users
    return users.filter((u) =>
      (u.full_name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.role || '').toLowerCase().includes(q)
    )
  }, [users, userQuery])

  const grouped = useMemo(() => {
    const q = (search || '').trim().toLowerCase()
    const map = {}
    for (const p of catalog || []) {
      if (q && !p.permission_key.toLowerCase().includes(q) && !(p.description || '').toLowerCase().includes(q)) continue
      ;(map[p.module] = map[p.module] || []).push(p)
    }
    return map
  }, [catalog, search])

  const roleGrants = useMemo(() => roleMap[selRole] || {}, [roleMap, selRole])

  const pickUser = async (id) => {
    setSelUser(id)
    if (!id) return setUserMap([])
    const umap = await privilegeService.getUserPermissionsMap(id).catch(() => [])
    setUserMap(umap || [])
  }

  const pickEffUser = async (id) => {
    setEffUser(id)
    if (!id) return setEffDoc(null)
    const doc = await privilegeService.getPermissionsStateForUser(id).catch(() => null)
    setEffDoc(doc)
  }

  const roleSetting = (permKey) => roleGrants[permKey] ? 'granted' : 'default'
  const userSetting = (permKey) => {
    const hit = userMap.find((u) => u.permission_key === permKey)
    return hit ? hit.effect : roleSetting(permKey)
  }

  const ugroup = useMemo(() => {
    const map = {}
    for (const u of userMap || []) map[u.permission_key] = u
    return map
  }, [userMap])

  if (loading) return <div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-[#009944]" size={28} /></div>

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck size={22} className="text-[#009944]" /> Access &amp; Privileges
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Centralized granular authorization — layered over the existing role-based access control.
            {authority?.effective?.epoch ? ` Release ${authority.effective.epoch}.` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!canManage && <span className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-full px-3 py-1.5 inline-flex items-center gap-1"><Lock size={12} /> Read-only</span>}
          <button onClick={load} className={btnGhost}><RefreshCw size={15} /> Refresh</button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 flex items-center gap-2">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-200 mb-5 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors ${
              tab === t.id ? 'border-[#009944] text-[#009944]' : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'roles' && (
        <div className="grid md:grid-cols-[260px_1fr] gap-5">
          <div>
            <label className={labelCls}>Role</label>
            <select value={selRole} onChange={(e) => setSelRole(e.target.value)} className={inputCls}>
              {ROLE_LIST.map(([key, val]) => (
                <option key={key} value={val}>{roleLabel(val)}</option>
              ))}
            </select>
            <div className="mt-3 text-xs text-slate-500 leading-relaxed">
              {isSuper ? (
                <>Super Admin always holds every permission — grants below only affect the effective doc for viewability.</>
              ) : (
                <>Grant or revoke permissions for the entire {roleLabel(selRole)} role. Changes take effect immediately and are audited with your reason.</>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search permissions…" className={inputCls} />
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1 bg-slate-100 rounded-full px-2 py-1"><ShieldCheck size={12} /> Granted</span>
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 border border-slate-200">● Inherited / not granted</span>
            </div>
            {modules.map((m) => (
              <ModuleGroup
                key={m}
                module={m}
                perms={grouped[m] || []}
                render={(perm) => {
                  const granted = roleGrants[perm.permission_key]
                  return (
                    <PermRow key={perm.permission_key} perm={perm} meta={false}>
                      {isSuper ? (
                        <span className="text-[11px] text-slate-400 bg-slate-100 rounded-full px-2 py-1">{granted ? 'Granted' : 'Implicit'}</span>
                      ) : (
                        <button
                          onClick={() => setPending({
                            title: granted ? 'Revoke role permission' : 'Grant role permission',
                            prompt: `${granted ? 'Revoke' : 'Grant'} ${perm.permission_key} ${granted ? 'from' : 'to'} the ${roleLabel(selRole)} role?`,
                            actionLabel: granted ? 'Revoke' : 'Grant',
                            onConfirm: async (reason) => {
                              if (granted) {
                                await privilegeService.revokeRolePermission({ roleName: selRole, permissionKey: perm.permission_key, reason })
                              } else {
                                await privilegeService.grantRolePermission({ roleName: selRole, permissionKey: perm.permission_key, reason })
                              }
                              await refreshAfterChange()
                            },
                          })}
                          className={`h-7 px-3 rounded-full text-[11px] font-semibold inline-flex items-center gap-1 transition-colors disabled:opacity-40 ${
                            granted ? 'bg-[#009944] text-white hover:bg-[#007a37]' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                          disabled={!canManage}
                        >
                          {granted ? <Check size={12} /> : <ChevronDown size={12} />}
                          {granted ? 'Granted — click to revoke' : 'Click to grant'}
                        </button>
                      )}
                    </PermRow>
                  )
                }}
              />
            ))}
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div className="grid md:grid-cols-[260px_1fr] gap-5">
          <div>
            <label className={labelCls}>Find user</label>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-3 text-slate-400" />
              <input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Name, email or role…" className={`${inputCls} pl-9`} />
            </div>
            <div className="mt-3 max-h-[520px] overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
              {filteredUsers.map((u) => (
                <button
                  key={u.id}
                  onClick={() => pickUser(u.id)}
                  className={`w-full text-left px-3 py-2.5 hover:bg-slate-50 ${selUser === u.id ? 'bg-slate-50' : ''}`}
                >
                  <p className="text-sm font-semibold text-slate-800 truncate">{u.full_name || u.email}</p>
                  <p className="text-[11px] text-slate-500 truncate">{roleLabel(u.role)}{u.email ? ` · ${u.email}` : ''}</p>
                </button>
              ))}
              {!filteredUsers.length && <p className="px-3 py-4 text-xs text-slate-500">No matching accounts</p>}
            </div>
          </div>
          <div className="space-y-4">
            {!selUser ? (
              <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center text-sm text-slate-500">
                Select a user to view or override their permissions. Overrides are additive — "Deny" beats the role baseline, "Allow" restores it.
              </div>
            ) : (
              <>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search permissions…" className={inputCls} />
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 rounded-full px-2 py-1"><ShieldCheck size={12} /> Allow</span>
                  <span className="inline-flex items-center gap-1 bg-rose-100 text-rose-700 rounded-full px-2 py-1"><ShieldOff size={12} /> Deny</span>
                  <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 border border-slate-200">● Inherited from role</span>
                </div>
                {modules.map((m) => (
                  <ModuleGroup
                    key={m}
                    module={m}
                    perms={grouped[m] || []}
                    render={(perm) => {
                      const setting = userSetting(perm.permission_key)
                      return (
                        <PermRow key={perm.permission_key} perm={perm} meta={false}>
                          <div className="flex items-center gap-1.5">
                            {['default', 'allow', 'deny'].map((s) => (
                              <button
                                key={s}
                                onClick={() => {
                                  const current = ugroup[perm.permission_key]
                                  const next = s
                                  setPending({
                                    title: 'Update user permission',
                                    prompt: `${next === 'allow' ? 'Allow' : next === 'deny' ? 'Deny' : 'Reset (clear override) for'} ${perm.permission_key} for ${filteredUsers.find((u) => u.id === selUser)?.full_name || selUser}?`,
                                    actionLabel: 'Save',
                                    onConfirm: async (reason) => {
                                      if (next === 'default' && current) {
                                        await privilegeService.clearUserPermission({ userId: selUser, permissionKey: perm.permission_key, reason })
                                      } else if (next !== 'default') {
                                        await privilegeService.setUserPermission({ userId: selUser, permissionKey: perm.permission_key, effect: next, reason })
                                      }
                                      await refreshAfterChange()
                                    },
                                  })
                                }}
                                disabled={!canManage || myRole === ROLES.SUPER_ADMIN && setting === 'default'}
                                className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold border transition-colors disabled:opacity-40 ${
                                  setting === s
                                    ? s === 'deny' ? 'bg-rose-600 text-white border-rose-600'
                                      : s === 'allow' ? 'bg-emerald-600 text-white border-emerald-600'
                                      : 'bg-slate-800 text-white border-slate-800'
                                    : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                                }`}
                              >
                                {s === 'default' ? 'Default' : s}
                              </button>
                            ))}
                          </div>
                        </PermRow>
                      )
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'effective' && (
        <div className="grid md:grid-cols-[260px_1fr] gap-5">
          <div>
            <label className={labelCls}>User</label>
            <select value={effUser || ''} onChange={(e) => pickEffUser(e.target.value || null)} className={inputCls}>
              <option value="">— Select user —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name || u.email} · {roleLabel(u.role)}</option>
              ))}
            </select>
            {effDoc && (
              <div className="mt-4 rounded-xl border border-slate-200 divide-y divide-slate-100 text-sm">
                <div className="flex items-center justify-between px-4 py-3"><span className="text-slate-500">Role</span><span className="font-semibold text-slate-800">{roleLabel(effDoc.role)}</span></div>
                <div className="flex items-center justify-between px-4 py-3"><span className="text-slate-500">Release (epoch)</span><span className="font-semibold text-slate-800">{effDoc.epoch}</span></div>
                <div className="flex items-center justify-between px-4 py-3"><span className="text-slate-500">Allows rate</span><span className="font-semibold text-slate-800">{Object.keys(effDoc.allowed || {}).length}</span></div>
                <div className="flex items-center justify-between px-4 py-3"><span className="text-slate-500">Denies</span><span className="font-semibold text-rose-600">{Object.keys(effDoc.denied || {}).length}</span></div>
                <div className="px-4 py-3"><span className="text-slate-500">Modules</span><div className="flex flex-wrap gap-1.5 mt-2">{effDoc.modules?.map((m) => <span key={m} className="text-[11px] capitalize bg-slate-100 rounded-full px-2 py-1 text-slate-700">{m}</span>)}</div></div>
              </div>
            )}
          </div>
          <div className="space-y-4">
            {!effDoc ? (
              <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center text-sm text-slate-500">
                Pick a user to see the exact access decision engine output — derived from role baseline, user overrides (allow/deny), and field visibility.
              </div>
            ) : (
              <>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the effective allow-list…" className={inputCls} />
                <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
                  {(Object.entries(effDoc.allowed || {}))
                    .filter(([k]) => !search || k.toLowerCase().includes(search.toLowerCase()))
                    .slice(0, 400)
                    .map(([k, detail]) => (
                      <div key={k} className="flex items-center justify-between px-4 py-2">
                        <code className="text-[12px] font-mono text-slate-800">{k}</code>
                        <span className="text-[11px] text-slate-400 capitalize">{detail?.source} · {detail?.effect || 'allow'}</span>
                      </div>
                    ))}
                  {(Object.keys(effDoc.denied || {})).length > 0 && (
                    <>
                      <p className="px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-rose-600 bg-rose-50">Denied</p>
                      {Object.entries(effDoc.denied).map(([k, detail]) => (
                        <div key={k} className="flex items-center justify-between px-4 py-2">
                          <code className="text-[12px] font-mono text-rose-700 line-through">{k}</code>
                          <span className="text-[11px] text-slate-400 capitalize">{detail?.source}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {!search && !Object.keys(effDoc.allowed || {}).length && <p className="px-4 py-6 text-center text-xs text-slate-500">No permissions. This account inherits a restricted baseline.</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'fields' && (
        <FieldRulesTab
          canManage={canManage}
          fieldRules={fieldRules}
          setPending={setPending}
          refreshAfterChange={refreshAfterChange}
          setFieldRules={setFieldRules}
          users={users}
        />
      )}

      {tab === 'delegation' && (
        <DelegationTab
          isSuper={isSuper}
          canManage={canManage}
          delegations={delegations}
          setPending={setPending}
          refreshAfterChange={refreshAfterChange}
          modules={modules}
          users={users}
        />
      )}

      {tab === 'history' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <select value={auditTargetType} onChange={(e) => {
              setAuditTargetType(e.target.value)
              privilegeService.getPermissionAudit({ limit: 200, targetType: e.target.value || null }).then(setAudit).catch(() => {})
            }} className={`${inputCls} max-w-[260px]`}>
              <option value="">All targets</option>
              <option value="role">Roles</option>
              <option value="user">Users</option>
              <option value="field">Field rules</option>
              <option value="delegation">Delegations</option>
            </select>
            <span className="text-xs text-slate-500">{audit.length} events</span>
          </div>
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">Target</th>
                  <th className="px-4 py-2.5">Permission</th>
                  <th className="px-4 py-2.5">Actor</th>
                  <th className="px-4 py-2.5">Reason</th>
                  <th className="px-4 py-2.5">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {audit.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5"><span className="text-[11px] font-bold text-slate-700 bg-slate-100 rounded-full px-2 py-1">{a.action}</span></td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">{a.target_name || a.target_key || a.target_type}</td>
                    <td className="px-4 py-2.5 text-xs font-mono text-slate-700">{a.permission_key || '—'}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">{a.actor_name || a.actor_role || 'system'}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500 max-w-[260px] truncate">{a.reason}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{a.created_at ? new Date(a.created_at).toLocaleString() : ''}</td>
                  </tr>
                ))}
                {!audit.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-slate-500">No audit events recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pending && (
        <ReasonModal
          title={pending.title}
          prompt={pending.prompt}
          actionLabel={pending.actionLabel}
          onConfirm={pending.onConfirm}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  )
}

function FieldRulesTab({ canManage, fieldRules, setPending, refreshAfterChange, setFieldRules, users }) {
  const [targetType, setTargetType] = useState('role')
  const [targetRole, setTargetRole] = useState(ROLES.HR_OFFICER)
  const [targetUser, setTargetUser] = useState('')
  const [field, setField] = useState('employees.bank_account')
  const [effect, setEffect] = useState('hide')
  const ruleTargetKey = targetType === 'role' ? targetRole : (targetUser || null)
  const [sensitiveFields, setSensitiveFields] = useState([])
  const [loadingFields, setLoadingFields] = useState(true)

  useEffect(() => {
    privilegeService.listSensitiveFields().then(setSensitiveFields).finally(() => setLoadingFields(false))
  }, [])

  return (
    <div className="grid lg:grid-cols-[300px_1fr] gap-5">
      <div className="rounded-xl border border-slate-200 p-4 space-y-4 self-start">
        <h3 className="text-sm font-semibold text-slate-900">New field rule</h3>
        <div>
          <label className={labelCls}>Apply to</label>
          <div className="grid grid-cols-2 gap-2">
            {['role', 'user'].map((t) => (
              <button key={t} onClick={() => setTargetType(t)} className={`h-10 rounded-xl text-sm font-semibold border transition-colors ${targetType === t ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-600 border-slate-300'}`}>{t === 'role' ? 'A role' : 'A user'}</button>
            ))}
          </div>
        </div>
        {targetType === 'role' ? (
          <div>
            <label className={labelCls}>Role</label>
            <select value={targetRole} onChange={(e) => setTargetRole(e.target.value)} className={inputCls}>
              {Object.values(ROLES).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          </div>
        ) : (
          <div>
            <label className={labelCls}>User</label>
            <select value={targetUser} onChange={(e) => setTargetUser(e.target.value)} className={inputCls}>
              <option value="">— Select user —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls}>Sensitive field</label>
          <select value={field} onChange={(e) => setField(e.target.value)} className={inputCls}>
            {sensitiveFields.map((f) => <option key={`${f.table}.${f.column}`} value={`${f.table}.${f.column}`}>{f.label} ({f.table}.{f.column})</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Effect</label>
          <select value={effect} onChange={(e) => setEffect(e.target.value)} className={inputCls}>
            <option value="hide">Hide the column</option>
            <option value="show">Force-show the column</option>
          </select>
        </div>
        <button
          disabled={!canManage || (targetType === 'user' && !targetUser)}
          className={`${btnPrimary} w-full justify-center`}
          onClick={() => {
            const [table, column] = field.split('.')
            setPending({
              title: 'Create field rule',
              prompt: `${effect === 'hide' ? 'Hide' : 'Show'} ${field} for ${targetType === 'role' ? `role ${roleLabel(targetRole)}` : `the selected user`}?`,
              actionLabel: 'Create rule',
              onConfirm: async (reason) => {
                await privilegeService.setFieldRule({ targetType, targetKey: ruleTargetKey, tableName: table, columnName: column, effect, reason })
                const { data } = await supabase.from('permission_field_rules').select('*').order('granted_at', { ascending: false })
                setFieldRules(data || [])
                await refreshAfterChange()
              },
            })
          }}
        >
          Add rule
        </button>
      </div>
      <div className="space-y-3">
        {fieldRules.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center text-sm text-slate-500">No field rules yet. Rules control column-level visibility (e.g. bank accounts on the payroll master).</div>}
        {fieldRules.map((r) => (
          <div key={r.id} className="rounded-xl border border-slate-200 px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <code className="text-[12px] font-mono font-semibold text-slate-800">{r.table_name}.{r.column_name}</code>
                <span className={`text-[10px] font-bold uppercase rounded-full px-2 py-0.5 ${r.effect === 'hide' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>{r.effect}</span>
                <span className="text-[11px] text-slate-400">{r.target_type}</span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{r.granted_reason}</p>
            </div>
            <button
              disabled={!canManage}
              className={btnGhost}
              onClick={() => setPending({
                title: 'Remove field rule',
                prompt: `Stop ${r.effect === 'hide' ? 'hiding' : 'showing'} ${r.table_name}.${r.column_name} for ${r.target_type} ${r.target_key}?`,
                actionLabel: 'Remove',
                onConfirm: async (reason) => {
                  await privilegeService.clearFieldRule({ targetType: r.target_type, targetKey: r.target_key, tableName: r.table_name, columnName: r.column_name, reason })
                  setFieldRules((prev) => prev.filter((x) => x.id !== r.id))
                  await refreshAfterChange()
                },
              })}
            >
              <Trash2 size={14} /> Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function DelegationTab({ isSuper, canManage, delegations, setPending, refreshAfterChange, modules, users }) {
  const [gtype, setGtype] = useState('role')
  const [grole, setGrole] = useState(ROLES.HEAD_OF_HUMAN_RESOURCES)
  const [guser, setGuser] = useState('')
  const [gmodule, setGmodule] = useState('hr')
  const [gscope, setGscope] = useState('global')

  return (
    <div className="grid lg:grid-cols-[300px_1fr] gap-5">
      <div className="rounded-xl border border-slate-200 p-4 space-y-4 self-start">
        <h3 className="text-sm font-semibold text-slate-900">Grant management authority</h3>
        <p className="text-xs text-slate-500 leading-relaxed">
          Delegation defines WHICH modules a privilege manager may administer. A manager can only change permissions they hold themselves and only within the modules + scope ceiling delegated to them.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {['role', 'user'].map((t) => (
            <button key={t} onClick={() => setGtype(t)} className={`h-10 rounded-xl text-sm font-semibold border transition-colors ${gtype === t ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-600 border-slate-300'}`}>{t === 'role' ? 'A role' : 'A user'}</button>
          ))}
        </div>
        {gtype === 'role' ? (
          <select value={grole} onChange={(e) => setGrole(e.target.value)} className={inputCls}>
            {Object.values(ROLES).filter((r) => r !== ROLES.SUPER_ADMIN).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        ) : (
          <select value={guser} onChange={(e) => setGuser(e.target.value)} className={inputCls}>
            <option value="">— Select user —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
          </select>
        )}
        <div>
          <label className={labelCls}>Module</label>
          <select value={gmodule} onChange={(e) => setGmodule(e.target.value)} className={inputCls}>
            <option value="*">* (all modules)</option>
            {modules.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Max scope</label>
          <select value={gscope} onChange={(e) => setGscope(e.target.value)} className={inputCls}>
            <option value="global">Global</option>
            <option value="branch">Branch</option>
            <option value="department">Department</option>
            <option value="self">Self only</option>
          </select>
        </div>
        <button
          disabled={!isSuper || (gtype === 'user' && !guser)}
          className={`${btnPrimary} w-full justify-center`}
          onClick={() => {
            const granteeKey = gtype === 'role' ? grole : guser
            setPending({
              title: 'Grant delegation',
              prompt: `Delegate module "${gmodule}" (max scope ${gscope}) to ${gtype} ${granteeKey}?`,
              actionLabel: 'Delegate',
              onConfirm: async (reason) => {
                await privilegeService.setDelegation({ granteeType: gtype, granteeKey, module: gmodule, maxScope: gscope, reason })
                await refreshAfterChange()
              },
            })
          }}
        >
          Delegate module
        </button>
      </div>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">Delegations ({delegations.length})</p>
        {delegations.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center text-sm text-slate-500">No delegations configured yet.</div>}
        {delegations.map((d) => (
          <div key={`${d.grantee_type}.${d.grantee_key}.${d.module}`} className="rounded-xl border border-slate-200 px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-800">{d.grantee_name || d.grantee_key}</span>
                <span className="text-[10px] text-slate-400 capitalize bg-slate-100 rounded-full px-2 py-0.5">{d.grantee_type}</span>
                <code className="text-[11px] font-mono text-[#009944] bg-emerald-50 rounded-full px-2 py-0.5">{d.module}</code>
                <span className="text-[10px] font-bold uppercase text-slate-500">{d.max_scope}</span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5 truncate">{d.granted_reason}</p>
            </div>
            {isSuper && (
              <button
                className={btnGhost}
                onClick={() => setPending({
                  title: 'Revoke delegation',
                  prompt: `Remove ${d.module} delegation from ${d.grantee_key}?`,
                  actionLabel: 'Revoke',
                  onConfirm: async (reason) => {
                    await privilegeService.revokeDelegation({ granteeType: d.grantee_type, granteeKey: d.grantee_key, module: d.module, reason })
                    await refreshAfterChange()
                  },
                })}
              >
                <Trash2 size={14} /> Revoke
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}