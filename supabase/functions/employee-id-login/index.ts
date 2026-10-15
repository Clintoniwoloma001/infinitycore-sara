// Supabase Edge Function: employee-id-login
//
// Employee-ID / email SIGN-IN resolves the identity SERVER-SIDE and signs the
// user in through Supabase Auth. The resolved email is never returned to the
// browser; only session tokens.
//
// - Employee-ID path: privileged resolver (`resolve_employee_for_auth`) maps the
//   normalized ID to exactly one active, non-archived employee and returns the
//   login email only inside the function.
// - Email path: falls back to a server-side on-record lookup (active, non-
//   archived employees only).
//
// Uniform response (security decision 3): every sign-in failure returns the
// same 401 body with similar timing. Success sends a magic-link email — the
// session is only created after the user clicks the emailed link, so no
// session tokens (and never the resolved email) are exposed here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getAppUrl } from '../_shared/appUrl.ts'

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
// (resolve_employee_for_auth compares against normalize_employee_id(stored_id),
// so the argument it receives must be normalized the same way here.)
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

const EVENT = 'employee-id-login'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const body = await req.json().catch(() => ({})) as { identifier?: unknown }
  const raw = text(body?.identifier)
  if (!raw) {
    return json({ error: 'invalid_credentials', message: 'Invalid Employee ID or email.' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !serviceRoleKey || !anonKey) return json({ error: 'env_missing' }, 500)

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // --- rate limiting (security decision 5) ---
  const rateKey = clientIp(req)
  const { data: rateData, error: rateError } = await admin.rpc('auth_rate_limit_hit', {
    p_key: rateKey,
    p_max: 30,
    p_window: 15 * 60,
  })
  if (rateError) {
    console.error(`[${EVENT}] rate-limit probe failed:`, rateError)
  } else if (rateData === false) {
    // Same 401 shape as a bad login so callers cannot distinguish them.
    return json({ error: 'invalid_credentials', message: 'Invalid Employee ID or email.' }, 401)
  }

  // Normalize: employee IDs are case/space-insensitive on the server
  // (public.normalize_employee_id); emails keep their shape and are compared
  // lowercased in the fallback lookup below.
  const normalized = normalizeEmployeeId(raw)

  // 1) Employee-ID path: privileged resolver, exactly one active non-archived
  //    employee per normalized ID. Ambiguous matches are rejected safely.
  let employee = null
  {
    const { data: matches, error: resolveError } = await admin.rpc('resolve_employee_for_auth', {
      p_norm_id: normalized,
    })
    if (resolveError) {
      console.error(`[${EVENT}] resolve_employee_for_auth failed:`, resolveError)
    } else if (matches && matches.length > 0) {
      employee = Array.isArray(matches) ? matches[0] : matches
    }
  }

  // 2) Email path: fall back to a direct on-record lookup when the identifier
  //    was an email and the resolver found nothing.
  if (!employee) {
    const lowered = raw.toLowerCase()
    const { data: rows, error: emailError } = await admin
      .from('employees')
      .select('id, user_id, full_name, email, work_email, personal_email')
      .or(`email.eq.${lowered},work_email.eq.${lowered},personal_email.eq.${lowered}`)
      .eq('employment_status', 'active')
      .neq('is_archived', true)
    if (emailError) {
      console.error(`[${EVENT}] employee email lookup failed:`, emailError)
    } else if (rows && rows.length > 0) {
      employee = rows[0]
    }
  }

  const message = 'Invalid Employee ID or email.'

  // The account must exist AND be linked to an auth user (claimed) before we
  // can sign anyone in. This keeps rejected/non-existent accounts from
  // revealing which email belongs to an employee.
  if (!employee || !employee.user_id) {
    return json({ error: 'invalid_credentials', message }, 401)
  }

  // Server-side login email (first non-empty of work/email/personal on record).
  const authEmail =
    (employee.auth_email && employee.auth_email !== '') || employee.work_email || employee.email || employee.personal_email
  if (!authEmail) {
    return json({ error: 'invalid_credentials', message }, 401)
  }

  // Passwordless sign-in: magic-link email issued through the PUBLIC auth
  // endpoint (the admin namespace has no signInWithOtp). `shouldCreateUser:
  // false` refuses accounts that never claimed an invite. The OTP endpoint
  // does NOT return a session — the session is created when the user clicks
  // the emailed link — so success here means "magic link sent".
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: otpError } = await authClient.auth.signInWithOtp({
    email: authEmail,
    options: {
      emailRedirectTo: getAppUrl(),
      shouldCreateUser: false,
    },
  })
  if (otpError) {
    console.error(`[${EVENT}] sign-in OTP failed for ${authEmail}:`, otpError)
    return json({ error: 'invalid_credentials', message }, 401)
  }

  return json({ ok: true, magicLink: true })
})
