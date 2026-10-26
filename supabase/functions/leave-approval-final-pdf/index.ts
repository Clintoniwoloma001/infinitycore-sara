// Supabase Edge Function: leave-approval-final-pdf (skeleton)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }
function json(b, s=200){ return new Response(JSON.stringify(b), {status:s, headers:{'Content-Type':'application/json',...cors}}) }
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  // TODO: generate immutable PDF server-side, store in private bucket, return signed URL
  return json({ ok: true, code: 'NOT_IMPLEMENTED', message: 'Leave final PDF skeleton deployed.', data: {} })
})
