// Supabase Edge Function: invite-employees
//
// Bulk-invites employees to InfinityCore via Supabase Auth.
// Only authenticated super_admin/admin/hr_manager can call this.
// Each employee's result is recorded in employee_account_invites
// (SUCCESS / ALREADY_EXISTS / INVALID_EMAIL / FAILED).
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
// (all auto-provided by Supabase runtime)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')

  if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({ error: 'env_missing' }, 500)

  // Authenticate caller and check role
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

  const body = await req.json()
  const { employee_ids, intended_role, reason } = body || {}

  if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
    return json({ error: 'employee_ids_required' }, 400)
  }

  // Use admin client for auth operations and privileged writes
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const results = []

  for (const empId of employee_ids) {
    try {
      // Fetch employee record
      const { data: emp } = await admin
        .from('employees')
        .select('id, full_name, email, staff_id, user_id')
        .eq('id', empId)
        .single()

      if (!emp) {
        results.push({ employee_id: empId, result: 'FAILED', error: 'employee_not_found' })
        await recordInvite(admin, empId, null, intended_role || 'staff', 'FAILED', 'employee_not_found', user.id)
        continue
      }

      // Already has account
      if (emp.user_id) {
        results.push({ employee_id: empId, result: 'ALREADY_EXISTS', email: emp.email })
        await recordInvite(admin, empId, emp.email, intended_role || 'staff', 'ALREADY_EXISTS', null, user.id)
        continue
      }

      // No email on record
      if (!emp.email) {
        results.push({ employee_id: empId, result: 'INVALID_EMAIL', email: null })
        await recordInvite(admin, empId, null, intended_role || 'staff', 'INVALID_EMAIL', 'No email on employee record', user.id)
        continue
      }

      // Check if a profile already exists for this email
      const { data: existingProfile } = await admin
        .from('profiles')
        .select('id, email')
        .eq('email', emp.email)
        .maybeSingle()

      if (existingProfile) {
        results.push({ employee_id: empId, result: 'ALREADY_EXISTS', email: emp.email })
        await recordInvite(admin, empId, emp.email, intended_role || 'staff', 'ALREADY_EXISTS', null, user.id)
        continue
      }

      // Resolve intended role (caller-provided only; no guessing)
      const safeRole = intended_role || 'staff'

      // Enforce role assignment permissions
      if (safeRole === 'super_admin' && actorRole !== 'super_admin') {
        results.push({ employee_id: empId, result: 'FAILED', error: 'cannot_assign_super_admin' })
        await recordInvite(admin, empId, emp.email, safeRole, 'FAILED', 'Only super_admin can assign super_admin role', user.id)
        continue
      }
      if (['admin', 'area_manager', 'head_of_business'].includes(safeRole) && !['super_admin', 'admin'].includes(actorRole)) {
        results.push({ employee_id: empId, result: 'FAILED', error: 'insufficient_role_permissions' })
        await recordInvite(admin, empId, emp.email, safeRole, 'FAILED', 'Insufficient permissions for this role', user.id)
        continue
      }

      // Invite via Supabase Auth
      const { data: authData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(emp.email, {
        data: { full_name: emp.full_name || '' },
      })

      if (inviteError) {
        results.push({ employee_id: empId, result: 'FAILED', error: inviteError.message })
        await recordInvite(admin, empId, emp.email, safeRole, 'FAILED', inviteError.message, user.id)
        continue
      }

      // Write profile as pending (Users page wizard completes approval)
      await admin.from('profiles').update({
        role: safeRole,
        full_name: emp.full_name || '',
        user_type: 'staff',
        status: 'pending',
        approved: false,
      }).eq('id', authData.user.id)

      // Link employee record to auth account
      await admin.from('employees').update({ user_id: authData.user.id, updated_at: new Date().toISOString() }).eq('id', empId)

      await admin.from('audit_logs').insert({
        action: 'EMPLOYEE_INVITED',
        entity_type: 'Employee',
        entity_id: empId,
        user_name: profile?.full_name || user.email,
        details: `Employee ${emp.full_name} (${emp.email}) invited with role ${safeRole}. ${reason || ''}`.trim(),
        severity: 'warning',
      })

      results.push({ employee_id: empId, result: 'SUCCESS', email: emp.email, auth_user_id: authData.user.id })
      await recordInvite(admin, empId, emp.email, safeRole, 'SUCCESS', null, user.id, authData.user.id)
    } catch (e) {
      results.push({ employee_id: empId, result: 'FAILED', error: String(e.message || e) })
      await recordInvite(admin, empId, null, intended_role || 'staff', 'FAILED', String(e.message || e), user.id)
    }
  }

  return json({ ok: true, results })
})

async function recordInvite(admin, employeeId, email, role, result, error, invitedBy, authUserId) {
  try {
    await admin.from('employee_account_invites').insert({
      employee_id: employeeId,
      invited_email: email || '',
      intended_role: role,
      result,
      error,
      auth_user_id: authUserId || null,
      invited_by: invitedBy,
    })
  } catch {
    // Don't fail the batch for invite-record errors; they're non-critical audit rows
  }
}