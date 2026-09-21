// Supabase Edge Function: generate-training-questions
//
// AI-assisted KSS (Knowledge Sharing Session) question drafting for the
// Training & Development page.
//
// The HR user uploads a .txt / .pdf / .docx training document (base64 in the
// request body). This function:
//   1. extracts text SERVER-SIDE (TXT direct, PDF via unpdf, DOCX via mammoth)
//   2. refuses to call the AI when no meaningful text was extracted
//   3. asks OpenAI (gpt-4o-mini) for EXACTLY three multiple-choice questions
//      grounded in the supplied material, in the existing KSS question-bank
//      format (Question | Correct answer | Option 1, Option 2, Option 3)
//   4. validates the response strictly (count, non-empty fields, correct
//      answer present among the options, no duplicates)
//   5. writes an audit entry (metadata only — never the document text)
//
// The function NEVER writes to the question bank, never creates a training
// session and never assigns participants. HR reviews/edits the generated
// drafts in the existing KSS question-bank editor before "Create and assign".
// The existing rotation pipeline (buildQuestionSets ->
// generate_kss_question_sets) keeps operating unchanged on the bank.
//
// Secrets needed: OPENAI_API_KEY (shared project secret, already used by
// sara-chat / sara-intent / sara-candidate-analysis).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { validateGeneratedQuestions, formatQuestionLines, KSS_QUESTION_VALIDATION_COPY } from '../_shared/kssQuestionValidator.js'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const MODEL = 'gpt-4o-mini'
const DAILY_LIMIT = 30
const MIN_INTERVAL_SECONDS = 2
const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MB
const MAX_TEXT_CHARS = 14000
const MIN_TEXT_CHARS = 40

// Who may draft KSS questions: union of training management (super_admin,
// admin, branch_manager — mirror send-training-invites) and training HR roles.
const ALLOWED_ROLES = ['super_admin', 'admin', 'branch_manager', 'hr_manager', 'hr_officer']

// Exact user-facing copy required by the feature brief.
const EXTRACTION_FAILED = 'Unable to extract readable text from this document. Please upload a text-based PDF/DOCX/TXT file or enter the questions manually.'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } })
}

function sanitize(value, limit = 2000) {
  return String(value || '').trim().slice(0, limit)
}

function base64ToBytes(base64) {
  const clean = String(base64 || '').replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

// ---- Server-side text extraction (best-effort, graceful) ----

async function extractTxt(bytes) {
  return new TextDecoder('utf-8').decode(bytes)
}

async function extractPdf(bytes) {
  const mod = await import('npm:unpdf@1.8.1')
  const unpdf = mod?.default || mod
  const { extractText } = unpdf
  const result = await extractText(bytes.buffer, { mergePages: true })
  return String(result?.text || '')
}

async function extractDocx(bytes) {
  const mod = await import('npm:mammoth@1.12.3')
  const mammoth = mod?.default || mod
  const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer })
  return String(result?.value || '')
}

async function extractTextFromFile(fileName, bytes) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase()
  if (ext === 'txt') return extractTxt(bytes)
  if (ext === 'pdf') return extractPdf(bytes)
  if (ext === 'docx') return extractDocx(bytes)
  throw new Error('unsupported_file_type')
}

// ---- Strict server-side validation of the AI response (shared module) ----

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ ok: false, error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return json({ ok: false, error: 'env_missing' }, 500)

  let body = {}
  try { body = await req.json() } catch { return json({ ok: false, error: 'invalid_request' }, 400) }

  const title = sanitize(body.title, 300)
  const description = sanitize(body.description, 2000)
  const fileName = sanitize(body.fileName, 260)
  const fileBase64 = String(body.fileBase64 || '').replace(/\s+/g, '')
  const sessionId = String(body.sessionId || '').trim() || null

  if (!title) return json({ ok: false, error: 'training_title_required' }, 400)
  if (!fileName || !fileBase64) return json({ ok: false, error: 'document_required' }, 400)
  if (!/\.(txt|pdf|docx)$/i.test(fileName)) {
    return json({ ok: false, error: 'Invalid file type. Only .txt, .pdf and .docx training documents are supported.' }, 400)
  }

  const fileSizeBytes = Math.floor((fileBase64.length * 3) / 4)
  if (fileSizeBytes > MAX_FILE_BYTES) {
    return json({ ok: false, error: `This document is ${Math.round(fileSizeBytes / 1024 / 1024)} MB. The limit is 2 MB per document.` }, 413)
  }

  // Authenticate the caller.
  const db = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: authError } = await db.auth.getUser()
  if (authError || !user) return json({ ok: false, error: 'unauthorized' }, 401)
  const { data: profile } = await db.from('profiles').select('role, status').eq('id', user.id).maybeSingle()
  if (!ALLOWED_ROLES.includes(profile?.role)) return json({ ok: false, error: 'forbidden' }, 403)
  if (profile?.status && profile.status !== 'active') return json({ ok: false, error: 'forbidden' }, 403)

  // Reuse the SARA per-user usage limiter.
  const limit = await db.rpc('consume_sara_ai_usage', {
    p_daily_limit: DAILY_LIMIT,
    p_min_interval_seconds: MIN_INTERVAL_SECONDS,
  }).catch(() => ({ data: null }))
  if (limit.data?.allowed === false) {
    return json({ ok: false, error: 'AI generation is temporarily rate-limited. Please retry in a few minutes.' }, 429)
  }

  // ---- Server-side extraction (no raw file ever reaches the LLM) ----
  let extractedText = ''
  let extractionError = ''
  try {
    const bytes = base64ToBytes(fileBase64)
    extractedText = await extractTextFromFile(fileName, bytes)
  } catch (error) {
    extractionError = error?.message || 'extraction_failed'
  }
  const meaningful = sanitize(extractedText, MAX_TEXT_CHARS)
  if (!meaningful || meaningful.length < MIN_TEXT_CHARS || extractionError) {
    await db.from('audit_logs').insert({
      action: 'AI_QUESTION_GENERATION',
      entity_type: 'TrainingSession',
      entity_id: sessionId,
      user_name: user.email || user.id,
      details: `Generation failed: no readable text (${sanitize(fileName, 120)}, ${fileSizeBytes} bytes, ${extractionError || 'empty_text'})`,
      severity: 'warning',
    }).catch(() => {})
    return json({ ok: false, error: EXTRACTION_FAILED }, 422)
  }

  const openaiKey = Deno.env.get('OPENAI_API_KEY')
  if (!openaiKey) return json({ ok: false, error: 'ai_not_configured' }, 501)

  const systemPrompt =
    'You are the KSS (Knowledge Sharing Session) assessment drafter inside Infinity Bank HR. ' +
    'Produce multiple-choice assessment questions that are grounded ONLY in the supplied training material. ' +
    'Do not invent facts, policies or figures that are not present in the material. ' +
    'Return ONLY JSON matching this shape: ' +
    '{"questions":[{"question":"...","correct_answer":"...","options":["a","b","c"]}]} ' +
    'with EXACTLY three questions. For each question: a clear single-sentence question, ' +
    'exactly three non-empty options, and correct_answer must be present verbatim among the options.'

  const userPrompt = [
    `Training title: ${title}`,
    description ? `Training description: ${description}` : '',
    'Training material (extracted document text):',
    meaningful,
    '',
    'Generate exactly three multiple-choice questions in the required JSON shape.',
  ].filter(Boolean).join('\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let completion
  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return json({ ok: false, error: 'ai_not_configured' }, 501)
      if (response.status === 429) return json({ ok: false, error: 'AI generation is temporarily rate-limited. Please retry in a few minutes.' }, 429)
      return json({ ok: false, error: 'ai_unavailable' }, 502)
    }
    completion = await response.json()
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return json({ ok: false, error: aborted ? 'ai_timeout' : 'ai_unavailable' }, 502)
  } finally {
    clearTimeout(timeout)
  }

  const rawContent = String(completion?.choices?.[0]?.message?.content || '').trim()
  let parsed = null
  try { parsed = JSON.parse(rawContent) } catch { parsed = null }

  const questions = validateGeneratedQuestions(parsed)

  if (!questions) {
    await db.from('audit_logs').insert({
      action: 'AI_QUESTION_GENERATION',
      entity_type: 'TrainingSession',
      entity_id: sessionId,
      user_name: user.email || user.id,
      details: `Generation failed: unvalidated AI output rejected (${sanitize(fileName, 120)}, ${fileSizeBytes} bytes)`,
      severity: 'warning',
    }).catch(() => {})
    return json({ ok: false, error: KSS_QUESTION_VALIDATION_COPY }, 422)
  }

  // Compose the EXACT existing KSS question-bank line format:
  //   Question | Correct answer | Option 1, Option 2, Option 3
  const lines = formatQuestionLines(questions)

  await db.from('audit_logs').insert({
    action: 'AI_QUESTION_GENERATION',
    entity_type: 'TrainingSession',
    entity_id: sessionId,
    user_name: user.email || user.id,
    details: `Generation succeeded: 3 questions drafted from ${sanitize(fileName, 120)} (${fileSizeBytes} bytes). Awaiting HR review.`,
    severity: 'info',
  }).catch(() => {})

  return json({ ok: true, questions: lines, count: lines.length, provider: 'openai', model: MODEL })
})