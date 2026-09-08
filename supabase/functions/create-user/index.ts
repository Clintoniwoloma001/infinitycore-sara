// Supabase Edge Function: create-user
//
// Creates a new user account via the Supabase admin API.
// Only authenticated super_admin/admin/hr_manager can call this.
// The new user gets a pending profile with the specified role.
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

  // Check caller's role
  const { data: profile } = await userClient
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()

  const actorRole = profile?.role || 'customer'
  if (!['super_admin', 'admin', 'hr_manager'].includes(actorRole)) {
    return json({ error: 'forbidden', message: 'Not authorized to create users' }, 403)
  }

  const body = await req.json()
  const { email, fullName, phone, role, department, branch, userType, sendInvite = true } = body

  if (!email) return json({ error: 'email_required' }, 400)

  // Validate role assignment permissions
  const safeRole = role || 'staff'
  if (safeRole === 'super_admin' && actorRole !== 'super_admin') {
    return json({ error: 'forbidden', message: 'Only super_admin can assign super_admin role' }, 403)
  }
  if (['admin', 'area_manager', 'head_of_business'].includes(safeRole) && !['super_admin', 'admin'].includes(actorRole)) {
    return json({ error: 'forbidden', message: 'Not authorized to assign this role' }, 403)
  }

  // Use admin client to create user
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // Check if user already exists
    const { data: existing } = await admin
      .from('profiles')
      .select('id, email, status')
      .eq('email', email)
      .maybeSingle()

    if (existing) {
      return json({ error: 'duplicate', message: 'A user with this email already exists', existingId: existing.id }, 200)
    }

    // Create the user via admin invite
    const { data: authData, error: createError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName || '' },
    })

    if (createError) {
      // If invite fails (e.g. email rate limit), try createUser
      const { data: createData, error: createErr2 } = await admin.auth.admin.createUser({
        email,
        emailConfirm: true,
        userMetadata: { full_name: fullName || '' },
      })

      if (createErr2) {
        return json({ error: 'create_failed', message: createErr2.message }, 200)
      }

      // Update profile with role/department/branch
      await admin.from('profiles').update({
        role: safeRole,
        full_name: fullName || '',
        phone: phone || null,
        department: department || null,
        branch: branch || null,
        user_type: userType || 'staff',
        status: 'active',
        approved: true,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      }).eq('id', createData.user.id)

      await admin.from('audit_logs').insert({
        action: 'USER_CREATED',
        entity_type: 'User',
        entity_id: createData.user.id,
        user_name: profile?.full_name || user.email,
        details: `User ${email} created by ${actorRole} with role ${safeRole}`,
        severity: 'warning',
      })

      return json({ ok: true, userId: createData.user.id, method: 'create' }, 200)
    }

    // Update profile with role/department/branch
    await admin.from('profiles').update({
      role: safeRole,
      full_name: fullName || '',
      phone: phone || null,
      department: department || null,
      branch: branch || null,
      user_type: userType || 'staff',
      status: 'active',
      approved: true,
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    }).eq('id', authData.user.id)

    await admin.from('audit_logs').insert({
      action: 'USER_CREATED',
      entity_type: 'User',
      entity_id: authData.user.id,
      user_name: profile?.full_name || user.email,
      details: `User ${email} invited by ${actorRole} with role ${safeRole}`,
      severity: 'warning',
    })

    return json({ ok: true, userId: authData.user.id, method: 'invite' }, 200)
  } catch (e) {
    return json({ error: 'exception', message: String(e.message || e) }, 200)
  }
})
