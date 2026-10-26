// Supabase Edge Function: leave-approval-final-pdf
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import jsPDF from 'https://esm.sh/jspdf@2.5.1'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
function json(b, s=200){ return new Response(JSON.stringify(b), {status:s, headers:{'Content-Type':'application/json',...cors}}) }
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ ok: false, code: 'UNAUTHORIZED', message: 'Your session has expired. Please sign in again.' }, 401)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ ok: false, code: 'UNAUTHORIZED', message: 'Your session has expired. Please sign in again.' }, 401)
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const body = await req.json().catch(() => ({}))
  const requestId = body?.requestId
  if (!requestId) return json({ ok: false, code: 'BAD_REQUEST', message: 'A leave request id is required.' }, 400)

  const { data: lr } = await admin.from('leave_requests').select('*').eq('id', requestId).maybeSingle()
  if (!lr) return json({ ok: false, code: 'NOT_FOUND', message: 'That leave request could not be found.' }, 404)
  const { data: approvals } = await admin.from('leave_approvals').select('*').eq('leave_request_id', requestId).order('created_at', { ascending: true })

  const doc = new jsPDF()
  doc.setFontSize(16); doc.text('Leave Approval', 14, 20)
  doc.setFontSize(10)
  let y = 30
  const line = (k, v) => { doc.text(`${k}: ${v ?? '—'}`, 14, y); y += 6 }
  line('Reference', lr.id)
  line('Requester', lr.employee_name || lr.requester_name)
  line('Leave type', lr.leave_type)
  line('Original dates', `${lr.start_date} to ${lr.end_date}`)
  line('Days', lr.days_requested)
  y += 4
  doc.text('Approver chain:', 14, y); y += 6
  for (const a of (approvals || [])) {
    doc.text(`- ${a.approver_name || a.approver_id} | ${a.decision} | ${a.created_at}`, 14, y); y += 6
    if (a.comment) { doc.text(`  Comment: ${a.comment}`, 14, y); y += 6 }
  }
  const pdfBytes = doc.output('arraybuffer')
  const path = `leave-final/${requestId}/v1.pdf`
  await admin.storage.from('leave-final-pdfs').upload(path, pdfBytes, { contentType: 'application/pdf', upsert: true })
  const { data: signed } = await admin.storage.from('leave-final-pdfs').createSignedUrl(path, 300)
  return json({ ok: true, code: 'OK', message: 'The final approval PDF has been generated.', data: { url: signed?.signedUrl, path } })
})
