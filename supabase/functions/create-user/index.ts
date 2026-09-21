// Supabase Edge Function: create-user
//
// Keeps the legacy manual Create User modal working, but uses the same
// invitation destination and password activation flow as employee accounts.
// Employee-backed calls must provide employeeId so the source record remains
// authoritative.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAuthRedirectUrl } from '../_shared/appUrl.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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

  const { data: actor } = await userClient.from('profiles').select('role, full_name').eq('id', user.id).single()
  const actorRole = actor?.role || 'customer'
  if (!['super_admin', 'admin', 'head_of_human_resources'].includes(actorRole)) {
    return json({ error: 'forbidden', message: 'Not authorized to create users' }, 403)
  }

  const body = await req.json().catch(() => ({}))
  const email = text(body?.email)
  const fullName = text(body?.fullName)
  const phone = text(body?.phone) || null
  const safeRole = text(body?.role) || 'staff'
  const department = text(body?.department) || null
  const branch = text(body?.branch) || null
  const userType = text(body?.userType) || 'staff'
  const employeeId = body?.employeeId || null
  if (!validEmail(email)) return json({ error: 'email_required', message: 'A valid email address is required.' }, 400)
  if (safeRole === 'super_admin' && actorRole !== 'super_admin') return json({ error: 'forbidden', message: 'Only super_admin can assign super_admin' }, 403)
  if (['admin', 'area_manager', 'head_of_business'].includes(safeRole) && !['super_admin', 'admin'].includes(actorRole)) {
    return json({ error: 'forbidden', message: 'Not authorized to assign this role' }, 403)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  let authUserId = null
  try {
    let employee = null
    if (employeeId) {
      const { data, error: employeeError } = await admin.from('employees').select('*').eq('id', employeeId).single()
      if (employeeError || !data) return json({ error: 'employee_not_found', message: 'Employee record not found.' }, 200)
      employee = data
      if (text(employee.email).toLowerCase() !== email.toLowerCase()) {
        return json({ error: 'email_mismatch', message: 'The account email must exactly match the employee email.' }, 200)
      }
      if (!validEmail(employee.email)) {
        return json({ error: 'invalid_employee_email', message: 'This employee does not have a valid email address. Update the employee record before creating the user account.' }, 200)
      }
    }

    const { data: existing } = await admin.from('profiles').select('id, email, status').ilike('email', email).maybeSingle()
    if (existing) return json({ error: 'duplicate', message: 'A user with this email already exists', existingId: existing.id }, 200)

    const redirectTo = getAuthRedirectUrl()
    const { data: authData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo,
    })
    if (inviteError || !authData?.user?.id) throw inviteError || new Error('Supabase did not return the invited auth user')
    authUserId = authData.user.id

    let configured
    if (employeeId) {
      const { data, error } = await userClient.rpc('provision_employee_account', {
        p_employee_id: employeeId,
        p_auth_user_id: authUserId,
        p_role: safeRole,
        p_user_type: 'staff',
        p_reason: 'Employee account created from the employee record',
      })
      if (error) throw error
      configured = data
    } else {
      const { data, error } = await userClient.rpc('configure_invited_user', {
        p_user_id: authUserId,
        p_role: safeRole,
        p_full_name: fullName || null,
        p_phone: phone,
        p_department: department,
        p_branch: branch,
        p_user_type: userType,
      })
      if (error) throw error
      configured = data
    }

    return json({ ok: true, userId: authUserId, employeeId, redirect_to: redirectTo, configuration: configured })
  } catch (e) {
    if (authUserId) {
      const { error: cleanupError } = await admin.auth.admin.deleteUser(authUserId)
      if (cleanupError) console.warn('Failed to clean up incomplete auth user:', cleanupError.message)
    }
    return json({ error: 'create_failed', message: String(e?.message || e) }, 200)
  }
})
