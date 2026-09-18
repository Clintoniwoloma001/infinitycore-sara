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

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value))
}

function expiryDate() {
  return new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

function employeeResult(emp, result, extra = {}) {
  return {
    employee_id: emp?.id,
    employee_name: emp?.full_name || null,
    email: emp?.email || null,
    department: emp?.department || null,
    branch: emp?.branch || null,
    area: emp?.area || null,
    result,
    ...extra,
  }
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
  if (!['super_admin', 'admin', 'hr_manager'].includes(actorRole)) {
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
      if (employeeError) throw employeeError
      employee = data

      const email = text(employee.email)
      if (!validEmail(email)) {
        results.push(employeeResult(employee, 'INVALID_EMAIL', { error: 'This employee does not have a valid email address. Update the employee record before creating the user account.' }))
        await recordInvite(admin, { employeeId, email: null, role: intendedRole, result: 'INVALID_EMAIL', error: 'No valid email on employee record', invitedBy: user.id })
        continue
      }

      if (resend) {
        if (!employee.user_id) {
          results.push(employeeResult(employee, 'FAILED', { error: 'employee_account_not_linked' }))
          continue
        }

        const { data: linkedProfile, error: linkedProfileError } = await admin
          .from('profiles')
          .select('id, email, status, full_name')
          .eq('id', employee.user_id)
          .maybeSingle()
        if (linkedProfileError || !linkedProfile || text(linkedProfile.email).toLowerCase() !== email.toLowerCase()) {
          results.push(employeeResult(employee, 'FAILED', { error: 'employee_email_account_mismatch' }))
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
          results.push(employeeResult(employee, 'FAILED', { error: resetError.message }))
          await recordInvite(admin, { employeeId, email, role: intendedRole, result: 'FAILED', error: resetError.message, invitedBy: user.id, authUserId: employee.user_id })
          continue
        }

        await revokeOpenInvitations(admin, employee.id)
        const expiresAt = expiryDate()
        const resentCount = await latestResendCount(admin, employee.id)
        await recordInvite(admin, { employeeId, email, role: intendedRole, result: 'RESENT', invitedBy: user.id, authUserId: employee.user_id, status: 'sent', expiresAt, resentCount })
        await audit(admin, {
          action: 'EMPLOYEE_ACCOUNT_INVITATION_RESENT',
          entityType: 'Employee',
          entityId: employee.id,
          actorName: profile?.full_name || user.email,
          details: `InfinityCore activation invitation resent to ${email}. ${reason}`.trim(),
        })
        results.push(employeeResult(employee, 'RESENT', { auth_user_id: employee.user_id, expires_at: expiresAt }))
        continue
      }

      if (employee.user_id) {
        const { data: linkedProfile } = await admin.from('profiles').select('id, email, status').eq('id', employee.user_id).maybeSingle()
        results.push(employeeResult(employee, 'ALREADY_EXISTS', { auth_user_id: employee.user_id, account_status: linkedProfile?.status || 'active' }))
        await recordInvite(admin, { employeeId, email, role: intendedRole, result: 'ALREADY_EXISTS', status: linkedProfile?.status === 'active' ? 'activated' : 'pending', invitedBy: user.id, authUserId: employee.user_id })
        continue
      }

      // Handle an existing profile by exact normalized email instead of
      // creating a second auth.users identity.
      const { data: existingProfile } = await admin
        .from('profiles')
        .select('id, email, status, employee_id')
        .ilike('email', email)
        .maybeSingle()

      if (existingProfile) {
        const { data: linkData, error: linkError } = await userClient.rpc('provision_employee_account', {
          p_employee_id: employee.id,
          p_auth_user_id: existingProfile.id,
          p_role: intendedRole,
          p_user_type: 'staff',
          p_reason: reason || 'Existing auth account linked to employee',
        })
        if (linkError) throw linkError
        const existingPending = existingProfile.status !== 'active'
        if (existingPending) {
          const resetClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } })
          const { error: resetError } = await resetClient.auth.resetPasswordForEmail(email, { redirectTo })
          if (resetError) throw resetError
          await revokeOpenInvitations(admin, employee.id)
          const expiresAt = expiryDate()
          await recordInvite(admin, { employeeId: employee.id, email, role: intendedRole, result: 'RESENT', invitedBy: user.id, authUserId: existingProfile.id, status: 'sent', expiresAt, resentCount: await latestResendCount(admin, employee.id) })
          results.push(employeeResult(employee, 'RESENT', { auth_user_id: existingProfile.id, expires_at: expiresAt, department: linkData?.department, branch: linkData?.branch }))
        } else {
          await recordInvite(admin, { employeeId: employee.id, email, role: intendedRole, result: 'ALREADY_EXISTS', status: 'activated', invitedBy: user.id, authUserId: existingProfile.id })
          results.push(employeeResult(employee, 'ALREADY_EXISTS', { auth_user_id: existingProfile.id, account_status: existingProfile.status }))
        }
        continue
      }

      const { data: authData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: employee.full_name || '' },
        redirectTo,
      })
      if (inviteError || !authData?.user?.id) throw inviteError || new Error('Supabase did not return the invited auth user')
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
      }))
    } catch (e) {
      const message = String(e?.message || e)
      if (createdAuthUserId) {
        const { error: cleanupError } = await admin.auth.admin.deleteUser(createdAuthUserId)
        if (cleanupError) console.warn('Failed to clean up incomplete auth user:', cleanupError.message)
      }
      results.push(employeeResult(employee || { id: employeeId }, 'FAILED', { error: message }))
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
