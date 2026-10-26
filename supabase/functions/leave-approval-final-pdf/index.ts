// Supabase Edge Function: leave-approval-final-pdf
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
function json(b, s=200){ return new Response(JSON.stringify(b), {status:s, headers:{'Content-Type':'application/json',...cors}}) }
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const body = await req.json().catch(() => ({}))
  // TODO: full branded PDF generation with approver blocks + signatures; store in private bucket; return signed URL
  return json({ ok: true, code: 'STUB', message: 'Leave final PDF generation is a stub. Implement full PDF builder next.', data: { requestId: body?.requestId || null } })
})
