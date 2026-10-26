// ============================================================================
// Supabase Edge Function: audit-reminder-sweep
// Phase 4 - Audit reminder sweep + send pipeline.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  ZOHO_TOKEN_URL,
  ZOHO_MAIL_API_BASE,
  PROVIDER,
  ENVIRONMENT,
  buildRefreshBody,
  normalizeTokenResponse,
  decryptSecret,
  decodeKey,
  extractAccountInfo,
} from '../_shared/zoho-mail.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

const SEND_ROLES = ['super_admin', 'admin', 'head_of_audit'];
const DEFAULT_DAILY_CAP = 100;
const MAX_RETRIES = 3;
const ZOHO_MAX_RECIPIENTS = 100;

// ---------------- Zoho send primitives (existing audit mailbox) -------------
async function getAuditMailbox(admin) {
  const { data: conn, error } = await admin
    .from('integration_connections')
    .select('encrypted_secret, token_expires_at, provider_account_id, enabled')
    .eq('provider', PROVIDER).eq('environment', ENVIRONMENT).eq('enabled', true)
    .maybeSingle();
  if (error || !conn || !conn.encrypted_secret) {
    return { ok: conn ? 'no_encrypted_secret' : 'no_connection' };
  }
  return { ok: true, conn };
}

async function refreshTokens(admin, conn) {
  const encryptionKey = Deno.env.get('ZOHO_TOKEN_ENCRYPTION_KEY');
  if (!encryptionKey) return { ok: false, error: 'encryption_key_missing' };
  let refreshToken;
  try { refreshToken = await decryptSecret(conn.encrypted_secret, decodeKey(encryptionKey)); }
  catch (e) { return { ok: false, error: 'decrypt_failed' }; }
  const tokenRes = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildRefreshBody({
      refreshToken, clientId: Deno.env.get('ZOHO_CLIENT_ID'),
      clientSecret: Deno.env.get('ZOHO_CLIENT_SECRET'),
    }),
  });
  if (!tokenRes.ok) return { ok: false, error: `token_refresh_${tokenRes.status}` };
  const tokens = normalizeTokenResponse(await tokenRes.json());
  if (!tokens.accessToken) return { ok: false, error: 'no_access_token' };
  return { ok: true, accessToken: tokens.accessToken };
}

async function getSenderAddress(admin, accessToken) {
  const accountsRes = await fetch(`${ZOHO_MAIL_API_BASE}accounts`, {
    method: 'GET',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' },
  });
  if (!accountsRes.ok) return { ok: false, error: `accounts_${accountsRes.status}` };
  const { extractAccountInfo } = await import('../_shared/zoho-mail.mjs');
  const info = extractAccountInfo(await accountsRes.json());
  if (!info.ok || !info.primaryAccount) return { ok: false, error: 'no_accounts' };
  return { ok: true, senderEmail: info.primaryAccount.primaryEmail };
}

// ---------------- Email body builders (HTML + text, token link) -------------
function buildEmailText(first, ref, due, statusLabel, link, interval) {
  const dueLabel = due ? new Date(due + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '—';
  return [
    `SARA audit obligation reminder - ${ref}`, '', `Dear ${first || 'there'},`,
    '', `This is an automated reminder for your audit obligation "${ref}".`,
    `Due date: ${dueLabel}`, `Status: ${statusLabel}`, '',
    `Please review and act here:`, link,
    '', `Periodic: a new reminder is sent every ${interval} day(s).`,
    '', 'Contact the Head of Audit for questions.',
  ].join('\n');
}

function buildEmailHtml(first, ref, due, statusLabel, link, interval) {
  const dueLabel = due ? new Date(due + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '—';
  return `
<p>SARA audit obligation reminder &mdash; ${ref}</p>
<p>Dear ${first || 'there'},</p>
<p>This is an automated reminder for your audit obligation &ldquo;${ref}&rdquo;.</p>
<p><b>Due date:</b> ${dueLabel}</p>
<p><b>Status:</b> ${statusLabel}</p>
<p>Please review and act here:</p>
<p><a href="${link}">${link}</a></p>
<p>Periodic: a new reminder is sent every ${interval} day(s).</p>
<p>Contact the Head of Audit for questions.</p>`.trim();
}

function statusLabelFor(due, leadDays) {
  const d = new Date(due + 'T00:00:00');
  const today = new Date();
  const diff = Math.ceil((d - today) / 86400000);
  if (diff < 0) return `${Math.abs(diff)} days overdue`;
  if (diff === 0) return 'Due today';
  if (diff <= leadDays) return `${leadDays - diff} days before lead window`;
  return `${diff} days remaining`;
}

function tokenLink(userId, obligationId) {
  const base = Deno.env.get('VITE_SARA_BASE_URL') || 'https://infinitymfbcore.vercel.app';
  return `${base}/audit/obligation/dummy`;
}

// ---------------- Main handler ---------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const zohoClientId = Deno.env.get('ZOHO_CLIENT_ID');
  const zohoClientSecret = Deno.env.get('ZOHO_CLIENT_SECRET');
  const encryptionKey = Deno.env.get('ZOHO_TOKEN_ENCRYPTION_KEY');
  const sweepApiKey = Deno.env.get('AUDIT_SWEEP_API_KEY') || '';

  if (!supabaseUrl || !serviceRoleKey) return json({ error: 'env_missing' }, 500);
  if (!zohoClientId || !zohoClientSecret || !encryptionKey) {
    return json({ error: 'zoho_not_configured' }, 500);
  }

  const isSweepCall = sweepApiKey.length > 0
    && authHeader.startsWith('Bearer ')
    && authHeader.slice('Bearer '.length) === sweepApiKey;
  const needsSession = !isSweepCall;

  let user;
  if (needsSession) {
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!anonKey) return json({ error: 'env_missing' }, 500);
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
    });
    const { data: u, error: au } = await anonClient.auth.getUser();
    if (au || !u) return json({ error: 'unauthorized' }, 401);
    user = u;
  }

  let requestData;
  try { requestData = await req.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }
  const { mode = 'run', reason, limit } = requestData ?? {};
  if (typeof mode !== 'string' || !['preview', 'run'].includes(mode)) {
    return json({ error: 'invalid_mode' }, 400);
  }
  if (mode === 'run' && needsSession && !reason) {
    return json({ error: 'reason_required' }, 400);
  }

  if (needsSession) {
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: profile } = await admin
      .from('profiles').select('role, status, full_name').eq('id', user.user.id).maybeSingle();
    if (!profile || !SEND_ROLES.includes(profile.role)) {
      return json({ error: 'forbidden', message: 'Only super_admin/admin/head_of_audit may run the sweep.' }, 403);
    }
    if (profile.status && !['active', 'approved'].includes(profile.status)) {
      return json({ error: 'forbidden', message: 'Your account is not active.' }, 403);
    }
  }

  const dailyCap = Math.max(1, Number(limit) || DEFAULT_DAILY_CAP);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const runId = 'audit-sweep-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  await ensureRunRecord(admin, runId, mode, reason, dailyCap, isSweepCall);
  const candidates = await computeCandidates(admin, dailyCap);

  let result;
  if (mode === 'preview') {
    result = {
      ok: true, mode: 'preview', run_id: runId,
      recipients: candidates.map((c) => ({
        recipient_id: c.assigned_user_id, recipient_email: c.recipient_email,
        obligation_reference: c.reference, obligation_title: c.title,
        due: c.submission_deadline,
        status_label: statusLabelFor(c.submission_deadline, c.obligation.reminder_lead_days),
        token_link: tokenLink(c.assigned_user_id, c.obligation_id),
        text_body: buildEmailText(c.first_name, c.reference, c.submission_deadline,
          statusLabelFor(c.submission_deadline, c.obligation.reminder_lead_days),
          tokenLink(c.assigned_user_id, c.obligation_id), c.obligation.reminder_interval_days),
        html_body: buildEmailHtml(c.first_name, c.reference, c.submission_deadline,
          statusLabelFor(c.submission_deadline, c.obligation.reminder_lead_days),
          tokenLink(c.assigned_user_id, c.obligation_id), c.obligation.reminder_interval_days),
      })),
    };
    return json(result, 200);
  }

  result = await executeSweepDispatch(admin, candidates, runId, dailyCap, isSweepCall);
  return json(result, 200);
});

// ---------------- Helper: ensure run record -----------------------------
async function ensureRunRecord(admin, runId, mode, reason, dailyCap, isSweep) {
  try {
    await admin.from('audit_sweep_log').insert({
      run_id: runId, mode, reason: reason || null,
      daily_cap: dailyCap, is_sweep_call: isSweep,
      started_at: new Date().toISOString(),
    });
  } catch (e) { /* ignore */ }
}

// ---------------- Helper: compute candidates ----------------------------
async function computeCandidates(admin, dailyCap) {
  const candidates = [];
  const today = new Date().toISOString().slice(0, 10);
  const { data: obligations } = await admin.from('audit_obligations')
    .select('*').eq('is_active', true).limit(500);
  if (!obligations) return candidates;
  for (const ob of obligations) {
    const lead = ob.reminder_lead_days || 7;
    const interval = ob.reminder_interval_days || 3;
    const esc = ob.escalation_days || 0;
    const { data: subs } = await admin.from('audit_obligation_submissions')
      .select('*').eq('obligation_id', ob.id).limit(500);
    if (!subs) continue;
    for (const sub of subs) {
      const due = sub.submission_deadline;
      const assigned = sub.assigned_user_id;
      if (!assigned || !due) continue;
      const dueDate = new Date(due + 'T00:00:00');
      const todayDate = new Date(today + 'T00:00:00');
      const diff = Math.ceil((dueDate - todayDate) / 86400000);
      const inLead = diff >= 0 && diff <= lead;
      const overdue = diff < 0;
      const escalationDue = esc > 0 && diff <= -esc;
      if (!inLead && !overdue && !escalationDue) continue;
      const { data: lastLog } = await admin.from('audit_reminder_log')
        .select('sent_at').eq('obligation_id', ob.id).eq('recipient_id', assigned)
        .order('sent_at', { ascending: false }).limit(1).maybeSingle();
      if (lastLog && lastLog.sent_at) {
        const last = new Date(lastLog.sent_at);
        const now = new Date();
        const daysSince = Math.floor((now - last) / 86400000);
        if (daysSince < interval) continue;
      }
      if (candidates.length >= dailyCap) break;
      const { data: prof } = await admin.from('profiles')
        .select('email, full_name').eq('id', assigned).maybeSingle();
      const email = prof?.email;
      if (!email || !isValidEmail(email)) continue;
      candidates.push({
        obligation_id: ob.id, obligation: ob, assigned_user_id: assigned,
        recipient_email: email, first_name: (prof?.full_name || '').split(' ')[0],
        reference: ob.reference || ob.title, title: ob.title,
        submission_deadline: due, status: sub.status,
      });
    }
    if (candidates.length >= dailyCap) break;
  }
  return candidates;
}

// ---------------- Helper: execute sweep dispatch -------------------------
async function executeSweepDispatch(admin, candidates, runId, dailyCap, isSweep) {
  const { data: conn } = await admin.from('integration_connections')
    .select('encrypted_secret, token_expires_at, provider_account_id, enabled')
    .eq('provider', 'zoho').eq('environment', 'production').eq('enabled', true).maybeSingle();
  if (!conn) {
    return { ok: false, error: 'no_zoho_connection', run_id: runId };
  }
  const encryptionKey = Deno.env.get('ZOHO_TOKEN_ENCRYPTION_KEY');
  const { data: decrypted } = await admin.rpc('decrypt_zoho_secret', { p_secret: conn.encrypted_secret });
  const refreshToken = decrypted || '';
  const tokenRes = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: Deno.env.get('ZOHO_CLIENT_ID') || '',
      client_secret: Deno.env.get('ZOHO_CLIENT_SECRET') || '',
    }).toString(),
  });
  if (!tokenRes.ok) return { ok: false, error: 'token_refresh_failed', run_id: runId };
  const tokens = await tokenRes.json();
  const accessToken = tokens.access_token;
  const accountsRes = await fetch('https://mail.zoho.com/api/accounts', {
    method: 'GET', headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' },
  });
  if (!accountsRes.ok) return { ok: false, error: 'accounts_failed', run_id: runId };
  const accountsJson = await accountsRes.json();
  const senderEmail = accountsJson?.data?.[0]?.primaryEmailAddress || '';
  if (!senderEmail) return { ok: false, error: 'no_sender', run_id: runId };

  let sent = 0, failed = 0, skipped = 0;
  const results = [];
  for (const c of candidates) {
    const { data: existing } = await admin.from('audit_reminder_log')
      .select('id').eq('obligation_id', c.obligation_id)
      .eq('recipient_id', c.assigned_user_id)
      .eq('reminder_type', 'lead').eq('scheduled_for', new Date().toISOString().slice(0,10)).maybeSingle();
    if (existing) { skipped++; continue; }
    try {
      const link = tokenLink(c.assigned_user_id, c.obligation_id);
      const today = new Date().toISOString().slice(0,10);
      const textBody = buildEmailText(c.first_name, c.reference, c.submission_deadline,
        statusLabelFor(c.submission_deadline, c.obligation.reminder_lead_days),
        link, c.obligation.reminder_interval_days);
      const htmlBody = buildEmailHtml(c.first_name, c.reference, c.submission_deadline,
        statusLabelFor(c.submission_deadline, c.obligation.reminder_lead_days),
        link, c.obligation.reminder_interval_days);
      const sendRes = await fetch(`https://mail.zoho.com/api/accounts/${senderEmail}/messages`, {
        method: 'POST',
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromAddress: senderEmail, toAddress: c.recipient_email,
          subject: `SARA audit reminder: ${c.reference}`,
          content: htmlBody, mailFormat: 'html',
        }),
      });
      if (sendRes.ok) {
        sent++;
        await admin.from('audit_reminder_log').upsert({
          obligation_id: c.obligation_id, recipient_id: c.assigned_user_id,
          reminder_type: 'lead', scheduled_for: today,
          sent_at: new Date().toISOString(), status: 'sent',
          recipient_email: c.recipient_email, run_id: runId,
        }, { onConflict: 'obligation_id,recipient_id,reminder_type,scheduled_for' });
      } else {
        failed++;
        await admin.from('audit_reminder_log').upsert({
          obligation_id: c.obligation_id, recipient_id: c.assigned_user_id,
          reminder_type: 'lead', scheduled_for: today,
          status: 'failed', recipient_email: c.recipient_email, run_id: runId,
          error: `zoho_${sendRes.status}`,
        }, { onConflict: 'obligation_id,recipient_id,reminder_type,scheduled_for' });
      }
    } catch (e) {
      failed++;
      results.push({ recipient: c.recipient_email, error: String(e) });
    }
  }
  try {
    await admin.from('audit_sweep_log').update({
      completed_at: new Date().toISOString(),
      sent_count: sent, failed_count: failed, skipped_count: skipped,
      candidate_count: candidates.length,
    }).eq('run_id', runId);
  } catch (e) { /* ignore */ }
  return { ok: true, run_id: runId, sent, failed, skipped, candidates: candidates.length };
}

