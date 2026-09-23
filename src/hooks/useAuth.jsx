import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { ROLES, ROLE_METADATA, ROLE_MODULES, ROLE_PERMISSIONS } from '../constants/roles'
import { canTerminateEmployee, canArchiveEmployee, canDeleteEmployee } from '../services/terminationAuthorization'
import { AUTH_REDIRECT_URL, SIGNUP_REDIRECT_URL } from '../config/siteUrl'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(false)
  const [profileError, setProfileError] = useState(null)
  const [viewingAsRole, setViewingAsRole] = useState(null)
  const [accessModules, setAccessModules] = useState([])
  const [permDoc, setPermDoc] = useState(null)

  const fetchPermissions = async (sessionUser) => {
    if (!sessionUser) {
      setPermDoc(null)
      return null
    }
    try {
      const { data, error } = await supabase.rpc('get_my_permissions')
      if (error) throw error
      setPermDoc(data || null)
      return data || null
    } catch {
      // The granular engine may not be deployed yet (or offline) —
      // fall back to the legacy role-permission matrix, never crash.
      setPermDoc(null)
      return null
    }
  }

  const fetchProfile = async (sessionUser) => {
    if (!sessionUser) {
      setProfile(null)
      setAccessModules([])
      await fetchPermissions(null)
      return null
    }
    await fetchPermissions(sessionUser)
    try {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', sessionUser.id).single()
      if (error) throw error
      setProfile(data)
      setProfileError(null)

      // Fetch per-user access modules
      try {
        const { data: access } = await supabase
          .from('user_access_profiles')
          .select('modules')
          .eq('user_id', sessionUser.id)
          .single()
        setAccessModules(access?.modules || [])
      } catch {
        setAccessModules([])
      }

      return data
    } catch (e) {
      console.error('Error fetching profile:', e)
      setProfile(null)
      setAccessModules([])
      setProfileError(
        e?.code === 'PGRST116'
          ? 'Your profile record could not be found. Please contact an administrator.'
          : (e?.message || 'Profile unavailable')
      )
      return null
    }
  }

  useEffect(() => {
    let mounted = true

    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!mounted) return
        if (session?.user) {
          setUser(session.user)
          await fetchProfile(session.user)
        }
      } catch (e) {
        if (mounted) setAuthError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    init()

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (mounted) {
        setUser(session?.user || null)
        if (session?.user) await fetchProfile(session.user)
        else setProfile(null)
      }
    })

    return () => {
      mounted = false
      sub?.subscription?.unsubscribe()
    }
  }, [])

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  const signUp = async (email, password) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: SIGNUP_REDIRECT_URL,
      },
    })
    if (error) throw error
    return data
  }

  const forgotPassword = async (email) => {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: AUTH_REDIRECT_URL,
    })
    if (error) throw error
    return data
  }

  const refreshProfile = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    setUser(session?.user || null)
    return fetchProfile(session?.user || null)
  }

  const refreshPermissions = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) return null
    return fetchPermissions(session.user)
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
    setProfileError(null)
    setViewingAsRole(null)
    setPermDoc(null)
  }

  const actualRole = profile?.role || ROLES.STAFF
  const effectiveRole = viewingAsRole || actualRole
  const canSwitchViews = actualRole === ROLES.SUPER_ADMIN
  const roleMetadata = ROLE_METADATA[effectiveRole] || ROLE_METADATA[ROLES.STAFF]
  const availableModules = ROLE_MODULES[effectiveRole] || []
  const userPermissions = ROLE_PERMISSIONS[effectiveRole] || []

  const hasPermission = (permissionKey) => {
    if (permDoc?.is_super_user) return true
    if (permDoc && permDoc.allowed) {
      if (permDoc.denied?.[permissionKey]) return false
      if (permDoc.allowed[permissionKey]) return true
    }
    return userPermissions.includes(permissionKey)
  }
  const hasAnyPermission = (permissions) => permissions.some((p) => hasPermission(p))
  const hasAllPermissions = (permissions) => permissions.every((p) => hasPermission(p))

  const permissions = {
    canReadCustomers: hasPermission('customers.read'),
    canCreateCustomers: hasPermission('customers.create'),
    canUpdateCustomers: hasPermission('customers.update'),
    canDeleteCustomers: hasPermission('customers.delete'),

    canReadLoans: hasPermission('loans.read'),
    canCreateLoans: hasPermission('loans.create'),
    canAssessLoans: hasPermission('loans.assess'),
    canApproveLow: hasPermission('loans.approve_low'),
    canApproveMedium: hasPermission('loans.approve_medium'),
    canApproveHigh: hasPermission('loans.approve_high'),
    canApproveLoan: hasPermission('loans.approve_low') || hasPermission('loans.approve_medium') || hasPermission('loans.approve_high'),
    canDisburse: hasPermission('loans.disburse'),

    canUploadDocuments: hasPermission('documents.upload'),
    canReadDocuments: hasPermission('documents.read'),
    canVerifyDocuments: hasPermission('documents.verify'),
    canDeleteDocuments: hasPermission('documents.delete'),

    canManageHR: hasPermission('hr.jobs.create') || hasPermission('hr.jobs.manage'),
    canScreenCandidates: hasPermission('hr.applications.screen'),
    canHire: hasPermission('hr.hire'),
    canReadPayroll: hasPermission('hr.payroll.read'),
    canReadOfferLetters: hasPermission('hr.offer_letters.read'),
    canReadBranches: hasPermission('branches.read'),
    canReadReports: hasPermission('reports.read'),
    canManageLeave: hasPermission('hr.leave.manage'),

    canCreateSupport: hasPermission('support.create'),
    canReadSupport: hasPermission('support.read'),
    canResolveSupport: hasPermission('support.resolve'),

    canManageUsers: hasPermission('admin.manage_users'),
    canViewAudit: hasPermission('admin.view_audit'),
    canManageConfig: hasPermission('admin.manage_config'),

    // Personnel termination / archive / delete authorization (STRICT).
    // Derived from the ACTUAL RBAC role — never the "viewing as" role,
    // never a client-supplied value. Server enforces the same rule.
    canTerminate: canTerminateEmployee(actualRole),
    canArchive: canArchiveEmployee(actualRole),
    canDelete: canDeleteEmployee(actualRole),
  }

  const value = {
    user,
    profile,
    loading,
    authError,
    profileError,
    signIn,
    signUp,
    forgotPassword,
    refreshProfile,
    refreshPermissions,
    signOut,

    actualRole,
    effectiveRole,
    role: effectiveRole,
    roleMetadata,

    viewingAsRole,
    setViewingAsRole,
    canSwitchViews,

    availableModules,
    accessModules,
    userPermissions,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    permissions,
    // Effective granular permission document (get_my_permissions).
    permDoc,
    permissionEpoch: permDoc?.epoch ?? null,
    deniedKeys: permDoc?.denied || {},
    allowedKeys: permDoc?.allowed || {},
    // Personnel lifecycle flags at the TOP level as well — several pages
    // destructure canTerminate/canArchive/canDelete straight off useAuth().
    canTerminate: canTerminateEmployee(actualRole),
    canArchive: canArchiveEmployee(actualRole),
    canDelete: canDeleteEmployee(actualRole),
    canApprove: hasPermission('loans.approve_low') || hasPermission('loans.approve_medium') || hasPermission('loans.approve_high') || hasPermission('loans.disburse'),

    name: profile?.full_name || user?.email || 'User',
    email: user?.email,
    isAdmin: actualRole === ROLES.ADMIN || actualRole === ROLES.SUPER_ADMIN,
    isManager: [ROLES.BRANCH_MANAGER, ROLES.AREA_MANAGER, ROLES.HEAD_OF_BUSINESS, ROLES.HEAD_OF_OPERATIONS, ROLES.HEAD_OF_E_BUSINESS, ROLES.FINANCIAL_CONTROLLER, ROLES.HEAD_OF_RISK_COMPLIANCE, ROLES.HEAD_OF_LEGAL, ROLES.HEAD_OF_AUDIT].includes(actualRole),
    isHR: [ROLES.HEAD_OF_HUMAN_RESOURCES, ROLES.HR_OFFICER].includes(actualRole),
    isCustomer: actualRole === ROLES.CUSTOMER,
    isStaff: actualRole === ROLES.STAFF,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
