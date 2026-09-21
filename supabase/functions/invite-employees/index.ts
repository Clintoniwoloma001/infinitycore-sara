// Supabase Edge Function: invite-employees
//
// Employee account invitations are generated here so service-role credentials
// never reach the browser. Profile/employee linking is delegated to a
// SECURITY DEFINER RPC invoked with the HR caller JWT; this preserves the
// existing profile role-change trigger and RBAC checks.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAuthRedirectUrl } from '../_shared/appUrl.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const INVITE_EXPIRY_DAYS = 7

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function text(value) {
  return String(value || '').trim()
}

function normalizeEmail(value) {
  return text(value).toLowerCase()
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value))
}

function expiryDate() {
  return new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

function employeeResult(emp, result, extra = {}) {
  const code = extra.code || result
  const message = extra.message || extra.error || null
  return {
    employee_id: emp?.id || null,
    employee_name: emp?.full_name || null,
    email: emp?.email || null,
    department: emp?.department || null,
    branch: emp?.branch || null,
    area: emp?.area || null,
    result,
    success: ['SUCCESS', 'RESENT'].includes(result),
    code,
    message,
    ...extra,
  }
}

function structuredFailure(code, message, emp = null, result = 'FAILED', extra = {}) {
  return employeeResult(emp || { id: null, full_name: null, email: null }, result, {
    code,
    message,
    ...extra,
  })
}

async function audit(admin, { action, entityType, entityId, actorName, details, severity = 'warning' }) {
  const { error } = await admin.from('audit_logs').insert({
    action,
    entity_type: entityType,
    entity_id: entityId,
    user_name: actorName,
    details,
    severity,
  })
  if (error) console.warn(`Audit ${action} failed:`, error.message)
}

async function revokeOpenInvitations(admin, employeeId) {
  await admin
    .from('employee_account_invites')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('employee_id', employeeId)
    .in('status', ['pending', 'sent'])
}

async function recordInvite(admin, { employeeId, email, role, result, error, invitedBy, authUserId, status, expiresAt, resentCount = 0 }) {
  const inviteStatus = status || (['SUCCESS', 'RESENT'].includes(result) ? 'sent' : result === 'ALREADY_EXISTS' ? 'activated' : 'failed')
  const { data, error: insertError } = await admin
    .from('employee_account_invites')
    .insert({
      employee_id: employeeId,
      invited_email: email || '',
      intended_role: role,
      result,
      error: error || null,
      auth_user_id: authUserId || null,
      invited_by: invitedBy,
      status: inviteStatus,
      expires_at: expiresAt || null,
      last_sent_at: inviteStatus === 'sent' ? new Date().toISOString() : null,
      resent_count: resentCount,
    })
    .select('id')
    .maybeSingle()
  if (insertError) console.warn('Invitation record failed:', insertError.message)
  return data?.id || null
}

async function latestResendCount(admin, employeeId) {
  const { data } = await admin
    .from('employee_account_invites')
    .select('resent_count')
    .eq('employee_id', employeeId)
    .order('invited_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return Number(data?.resent_count || 0) + 1
}

async function getMatchingAuthUser(admin, normalizedEmail) {
  try {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    if (error) throw error
    const match = (data?.users || []).find((user) => normalizeEmail(user.email || '') === normalizedEmail)
    return match || null
  } catch (e) {
    console.warn('Unable to resolve auth users by email:', e?.message || e)
    return null
  }
}

async function reconcileAuthIdentity(admin, employee, email, actorName) {
  const authUser = await getMatchingAuthUser(admin, normalizeEmail(email))
  if (!authUser) return { ok: true, action: 'create', authUserId: null }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, email, employee_id, status, full_name, phone, department, branch, role')
    .eq('id', authUser.id)
    .maybeSingle()

  const { data: linkedEmployee } = await admin
    .from('employees')
    .select('id, full_name, email')
    .eq('user_id', authUser.id)
    .maybeSingle()

  if ((profile && profile.employee_id && profile.employee_id !== employee.id) || (linkedEmployee && linkedEmployee.id !== employee.id)) {
    return {
      ok: false,
      reason: 'This email already belongs to a different employee account.',
      authUserId: authUser.id,
    }
  }

  if (profile && normalizeEmail(profile.email || '') === normalizeEmail(email)) {
    await admin
      .from('employees')
      .update({ user_id: authUser.id, updated_at: new Date().toISOString() })
      .eq('id', employee.id)

    await admin
      .from('profiles')
      .update({
        employee_id: employee.id,
        full_name: employee.full_name || profile.full_name,
        phone: employee.phone || profile.phone,
        department: employee.department || profile.department,
        branch: employee.branch || profile.branch,
        employee_number: employee.employee_number || profile.employee_number,
        designation: employee.position || profile.designation,
        status: profile.status === 'active' ? 'active' : 'pending',
      })
      .eq('id', authUser.id)

    await audit(admin, {
      action: 'USER_IDENTITY_RECONCILED',
      entityType: 'Employee',
      entityId: employee.id,
      actorName: actorName || authUser.email,
      details: `Reconciled orphaned auth identity ${authUser.id} to employee ${employee.full_name} (${email}) and linked the employee profile.`,
      severity: 'warning',
    })

    return { ok: true, action: 'reconciled', authUserId: authUser.id }
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(authUser.id)
  if (deleteError) throw deleteError

  await audit(admin, {
    action: 'ORPHAN_AUTH_IDENTITY_REMOVED',
    entityType: 'Employee',
    entityId: employee.id,
    actorName: actorName || authUser.email,
    details: `Removed orphaned auth identity ${authUser.id} for ${employee.full_name} (${email}) before re-creating the correct employee account.`,
    severity: 'warning',
  })

  return { ok: true, action: 'deleted', authUserId: null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({ error: 'env_missing' }, 500)

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  const { data: profile } = await userClient
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()
  const actorRole = profile?.role || 'customer'
  if (!['super_admin', 'admin', 'head_of_human_resources'].includes(actorRole)) {
    return json({ error: 'forbidden', message: 'Not authorized to invite employees' }, 403)
  }

  const body = await req.json().catch(() => ({}))
  const employeeIds = body?.employee_ids
  const intendedRole = text(body?.intended_role) || 'staff'
  const reason = text(body?.reason)
  const resend = body?.resend === true
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) return json({ error: 'employee_ids_required' }, 400)

  if (intendedRole === 'super_admin' && actorRole !== 'super_admin') {
    return json({ error: 'forbidden', message: 'Only super_admin can assign the super_admin role' }, 403)
  }
  if (['admin', 'area_manager', 'head_of_business'].includes(intendedRole) && !['super_admin', 'admin'].includes(actorRole)) {
    return json({ error: 'forbidden', message: 'Not authorized to assign this role' }, 403)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const redirectTo = getAuthRedirectUrl()
  const results = []

  for (const employeeId of employeeIds) {
    let employee = null
    let createdAuthUserId = null
    try {
      const { data, error: employeeError } = await admin
        .from('employees')
        .select('*')
        .eq('id', employeeId)
        .single()
      if (employeeError) {
        throw new Error(`Selected employee could not be found: ${employeeError.message}`)
      }
      employee = data

      const email = normalizeEmail(employee.email)
      if (!validEmail(email)) {
        const structured = structuredFailure('EMPLOYEE_EMAIL_MISSING', 'Selected employee does not have an email address.', employee, 'INVALID_EMAIL')
        results.push(structured)
        await recordInvite(admin, { employeeId, email: employee?.email || null, role: intendedRole, result: 'INVALID_EMAIL', error: 'Selected employee does not have an email address.', invitedBy: user.id })
        continue
      }

      if (employee.user_id) {
        const { data: linkedProfile, error: linkedProfileError } = await admin
          .from('profiles')
          .select('id, email, status, employee_id, full_name')
          .eq('id', employee.user_id)
          .maybeSingle()

        if (!linkedProfile) {
          await admin.from('employees').update({ user_id: null, updated_at: new Date().toISOString() }).eq('id', employee.id)
          await audit(admin, {
            action: 'USER_IDENTITY_RECONCILED',
            entityType: 'Employee',
            entityId: employee.id,
            actorName: profile?.full_name || user.email,
            details: `Cleared stale employee.user_id link for ${employee.full_name} (${email}) before creating a valid account.`,
            severity: 'warning',
          })
        } else if (normalizeEmail(linkedProfile.email || '') === email && linkedProfile.employee_id === employee.id) {
          const structured = structuredFailure('USER_ALREADY_EXISTS', 'This employee already has an active InfinityCore account.', employee, 'ALREADY_EXISTS', {
            auth_user_id: employee.user_id,
            account_status: linkedProfile.status || 'active',
          })
          results.push(structured)
          await recordInvite(admin, { employeeId, email, role: intendedRole, result: 'ALREADY_EXISTS', status: linkedProfile.status === 'active' ? 'activated' : 'pending', invitedBy: user.id, authUserId: employee.user_id })
          continue
        }
      }

      if (resend) {
        if (!employee.user_id) {
          const authUser = await getMatchingAuthUser(admin, email)
          if (authUser) {
            const reconciliation = await reconcileAuthIdentity(admin, employee, email, profile?.full_name || user.email)
            if (!reconciliation.ok) {
              const structured = structuredFailure('USER_ALREADY_EXISTS', reconciliation.reason, employee, 'FAILED', { auth_user_id: authUser.id, code: 'USER_ALREADY_EXISTS' })
              results.push(structured)
              await recordInvite(admin, { employeeId, email, role: intendedRole, result: 'FAILED', error: reconciliation.reason, invitedBy: user.id, authUserId: authUser.id })
              continue
            }
            if (reconciliation.authUserId) {
              createdAuthUserId = reconciliation.authUserId
            }
          }
        }

        if (!employee.user_id && !createdAuthUserId) {
          const structured = structuredFailure('EMPLOYEE_ACCOUNT_NOT_LINKED', 'This employee does not have a linked InfinityCore account yet.', employee, 'FAILED', { code: 'EMPLOYEE_ACCOUNT_NOT_LINKED' })
          results.push(structured)
          continue
        }

        const targetUserId = createdAuthUserId || employee.user_id
        const { data: linkedProfile, error: linkedProfileError } = await admin
          .from('profiles')
          .select('id, email, status, full_name')
          .eq('id', targetUserId)
          .maybeSingle()
        if (linkedProfileError || !linkedProfile || normalizeEmail(linkedProfile.email || '') !== email) {
          const structured = structuredFailure('EMPLOYEE_EMAIL_MISMATCH', 'The employee account is not linked to the selected email address.', employee, 'FAILED', { code: 'EMPLOYEE_EMAIL_MISMATCH' })
          results.push(structured)
          await audit(admin, {
            action: 'ACCOUNT_ACTIVATION_FAILURE',
            entityType: 'Employee',
            entityId: employee.id,
            actorName: profile?.full_name || user.email,
            details: `Cannot resend invitation: ${email} is not linked to the employee auth account`,
            severity: 'critical',
          })
          continue
        }

        const resetClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } })
        const { error: resetError } = await resetClient.auth.resetPasswordForEmail(email, { redirectTo })
        if (resetError) {
          const structured = structuredFailure('INVITE_RESEND_FAILED', resetError.message, employee, 'FAILED', { code: 'INVITE_RESEND_FAILED' })
          results.push(structured)
          await recordInvite(admin, { employeeId, email, role: intendedRole, result: 'FAILED', error: resetError.message, invitedBy: user.id, authUserId: targetUserId })
          continue
        }

        await revokeOpenInvitations(admin, employee.id)
        const expiresAt = expiryDate()
        const resentCount = await latestResendCount(admin, employee.id)
        await recordInvite(admin, { employeeId, email, role: intendedRole, result: 'RESENT', invitedBy: user.id, authUserId: targetUserId, status: 'sent', expiresAt, resentCount })
        await audit(admin, {
          action: 'EMPLOYEE_ACCOUNT_INVITATION_RESENT',
          entityType: 'Employee',
          entityId: employee.id,
          actorName: profile?.full_name || user.email,
          details: `InfinityCore activation invitation resent to ${email}. ${reason}`.trim(),
        })
        results.push(employeeResult(employee, 'RESENT', { auth_user_id: targetUserId, expires_at: expiresAt, code: 'INVITE_RESENT', message: 'Invitation resent to the employee email.' }))
        continue
      }

      const existingAuthUser = await getMatchingAuthUser(admin, email)
      if (existingAuthUser) {
        const reconciliation = await reconcileAuthIdentity(admin, employee, email, profile?.full_name || user.email)
        if (!reconciliation.ok) {
          const structured = structuredFailure('USER_ALREADY_EXISTS', reconciliation.reason, employee, 'FAILED', { auth_user_id: existingAuthUser.id, code: 'USER_ALREADY_EXISTS' })
          results.push(structured)
          await recordInvite(admin, { employeeId, email, role: intendedRole, result: 'FAILED', error: reconciliation.reason, invitedBy: user.id, authUserId: existingAuthUser.id })
          continue
        }

        if (reconciliation.authUserId) {
          createdAuthUserId = reconciliation.authUserId
          const { data: linked, error: linkError } = await userClient.rpc('provision_employee_account', {
            p_employee_id: employee.id,
            p_auth_user_id: createdAuthUserId,
            p_role: intendedRole,
            p_user_type: 'staff',
            p_reason: reason || 'Reconciled employee account invitation',
          })
          if (linkError) throw linkError

          const resetClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } })
          const { error: resetError } = await resetClient.auth.resetPasswordForEmail(email, { redirectTo })
          if (resetError) throw resetError

          await revokeOpenInvitations(admin, employee.id)
          const expiresAt = expiryDate()
          const invitationId = await recordInvite(admin, { employeeId: employee.id, email, role: intendedRole, result: 'SUCCESS', invitedBy: user.id, authUserId: createdAuthUserId, status: 'sent', expiresAt })
          await audit(admin, {
            action: 'USER_INVITATION_CREATED',
            entityType: 'Employee',
            entityId: employee.id,
            actorName: profile?.full_name || user.email,
            details: `Reconciled and invited employee ${employee.full_name} (${email}) to InfinityCore.`,
          })

          results.push(employeeResult(employee, 'SUCCESS', {
            auth_user_id: createdAuthUserId,
            invitation_id: invitationId,
            expires_at: expiresAt,
            department: linked?.department,
            branch: linked?.branch,
            area: linked?.area,
            code: 'INVITE_SENT',
            message: 'Existing InfinityCore identity reconciled and invitation sent successfully.',
          }))
          continue
        }
      }

      const { data: authData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: employee.full_name || '', employee_id: employee.id },
        redirectTo,
      })
      if (inviteError || !authData?.user?.id) {
        throw inviteError || new Error('Supabase did not return the invited auth user.')
      }
      createdAuthUserId = authData.user.id

      const { data: linked, error: linkError } = await userClient.rpc('provision_employee_account', {
        p_employee_id: employee.id,
        p_auth_user_id: createdAuthUserId,
        p_role: intendedRole,
        p_user_type: 'staff',
        p_reason: reason || 'Employee account invitation',
      })
      if (linkError) throw linkError

      await revokeOpenInvitations(admin, employee.id)
      const expiresAt = expiryDate()
      const invitationId = await recordInvite(admin, {
        employeeId: employee.id,
        email,
        role: intendedRole,
        result: 'SUCCESS',
        invitedBy: user.id,
        authUserId: createdAuthUserId,
        status: 'sent',
        expiresAt,
      })
      await audit(admin, {
        action: 'EMPLOYEE_ACCOUNT_INVITATION_CREATED',
        entityType: 'Employee',
        entityId: employee.id,
        actorName: profile?.full_name || user.email,
        details: `InfinityCore account created and linked for ${employee.full_name} (${email})`,
      })
      await audit(admin, {
        action: 'EMPLOYEE_ACCOUNT_INVITATION_SENT',
        entityType: 'Employee',
        entityId: employee.id,
        actorName: profile?.full_name || user.email,
        details: `InfinityCore activation invitation sent to ${email}; expires ${expiresAt}`,
      })
      results.push(employeeResult(employee, 'SUCCESS', {
        auth_user_id: createdAuthUserId,
        invitation_id: invitationId,
        expires_at: expiresAt,
        department: linked?.department,
        branch: linked?.branch,
        area: linked?.area,
        code: 'INVITE_SENT',
        message: 'Invitation sent successfully.',
      }))
    } catch (e) {
      const message = String(e?.message || e)
      if (createdAuthUserId) {
        const { error: cleanupError } = await admin.auth.admin.deleteUser(createdAuthUserId)
        if (cleanupError) console.warn('Failed to clean up incomplete auth user:', cleanupError.message)
      }
      results.push(structuredFailure('INVITE_FAILED', message, employee || { id: employeeId }, 'FAILED', {
        error: message,
      }))
      await recordInvite(admin, { employeeId, email: employee?.email || null, role: intendedRole, result: 'FAILED', error: message, invitedBy: user.id, authUserId: createdAuthUserId })
      await audit(admin, {
        action: 'ACCOUNT_ACTIVATION_FAILURE',
        entityType: 'Employee',
        entityId: employeeId,
        actorName: profile?.full_name || user.email,
        details: `Employee account invitation failed: ${message}`,
        severity: 'critical',
      })
    }
  }

  return json({ ok: true, redirect_to: redirectTo, results })
})
