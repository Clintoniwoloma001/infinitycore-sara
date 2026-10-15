// Supabase Edge Function: employee-id-signup
//
// Employee-ID SIGN-UP takes NO password. The user enters only the Employee ID.
// The server resolves the employee (exactly one active, non-archived employee
// matching the normalized ID), sends an invitation to the email ON RECORD, and
// the user sets their password on the existing `/#/activate-account` page.
//
// Uniform response (security decision 3): every sign-up ID returns the same
// generic 200 body whether or not the ID exists / is claimed / has email.

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

// Same tolerant normalization as the server-side public.normalize_employee_id()
// so the browser and the database can never disagree about what an ID means.
function normalizeEmployeeId(input) {
  if (typeof input !== 'string') return ''
  return input
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .toUpperCase()
}

function clientIp(req) {
  const header = req.headers.get('x-forwarded-for')
  if (header) {
    const first = header.split(',')[0]?.trim()
    if (first) return first
  }
  return 'unknown'
}

const EVENT = 'employee-id-signup'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const body = await req.json().catch(() => ({})) as { employeeId?: unknown }
  const employeeId = text(body?.employeeId)
  if (!employeeId) {
    return json({ error: 'employee_id_required', message: 'An Employee ID is required.' }, 400)
  }

  const normalized = normalizeEmployeeId(employeeId)
  if (!normalized) {
    return json({ error: 'employee_id_required', message: 'Please enter a valid Employee ID.' }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({ error: 'env_missing' }, 500)

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // --- rate limiting (security decision 5) ---
  const rateKey = `${clientIp(req)}:${normalized}`
  const { data: rateData, error: rateError } = await admin.rpc('auth_rate_limit_hit', {
    p_key: rateKey,
    p_max: 10,
    p_window: 15 * 60,
  })
  if (rateError) {
    console.error(`[${EVENT}] rate-limit probe failed:`, rateError)
  } else if (rateData === false) {
    return json(
      { error: 'rate_limit_hit', message: 'Too many sign-up attempts. Please try again later.' },
      429,
    )
  }

  // Privileged resolver: exactly one active, non-archived employee per normalized
  // ID. Server-side only — the browser never sees the resolved email.
  const { data: matches, error: resolveError } = await admin.rpc('resolve_employee_for_auth', {
    p_norm_id: normalized,
  })
  const rows = Array.isArray(matches) ? matches : matches ? [matches] : []

  // Decision 3: identical generic 200 no matter the outcome.
  const message =
    'If an account exists for this employee, an invitation has been sent. Check your inbox (and spam) for the email, and set your password on the activation page.'

  if (resolveError || rows.length === 0) {
    return json({ ok: true, employeeId: normalized, message })
  }

  const emp = rows[0]

  // Claimed (user_id already set) — nothing further to do for the invite.
  if (emp.user_id) {
    return json({ ok: true, employeeId: normalized, message })
  }

  // Unclaimed: invite the employee on record. The employee_id token links the
  // new auth account to this employee record when the invite is accepted.
  const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(emp.auth_email, {
    data: {
      full_name: emp.full_name,
      employee_id: normalized,
    },
    redirectTo: getAuthRedirectUrl(),
  })
  if (inviteError) {
    console.error(`[${EVENT}] invite failed for ${emp.auth_email}:`, inviteError)
  }

  return json({ ok: true, employeeId: normalized, message })
})
