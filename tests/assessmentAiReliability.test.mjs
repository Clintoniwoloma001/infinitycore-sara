import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const edge = read('supabase/functions/sara-candidate-analysis/index.ts')
const assessments = read('src/pages/Assessments.jsx')
const builder = read('src/pages/AssessmentBuilder.jsx')
const service = read('src/services/assessmentService.js')

// --- 1. Classified errors: failure stages must NOT all collapse into ai_unavailable ---
assert.match(edge, /class SaraError extends Error/, 'edge function must define a structured SaraError')
for (const code of ['ai_not_configured', 'ai_invalid_key', 'ai_billing', 'ai_rate_limited',
  'ai_provider_error', 'ai_network', 'ai_bad_response', 'ai_empty']) {
  assert.ok(edge.includes(`SaraError('${code}')`) || edge.includes(`'${code}'`),
    `edge function must produce the '${code}' failure classification`)
}

// Top-level handler must preserve structured codes, never blanket ai_unavailable.
assert.match(edge, /const code = e instanceof SaraError \? e\.code : 'ai_error'/,
  'top-level catch must pass through SaraError codes')
assert.ok(!/\{\s*ok: false, error: 'ai_unavailable', detail: String\(e\?\.message \|\| e\)\s*\}/.test(edge),
  'must not return the raw internal message to the client')
assert.ok(!/ai_unavailable/.test(edge), 'the outage code no longer exists in the function')

// Bounded retries only for transient provider failures; nothing is written before retrying.
assert.match(edge, /const AI_RETRYABLE_STATUS = new Set\(\[429, 500, 502, 503, 504\]\)/,
  'retryable statuses must be bounded (429 + 5xx only)')
assert.match(edge, /retries = 2/, 'retries must be bounded')
// A missing key is no longer this function's concern: the router skips any tier
// whose secret is absent and resolves through the rest of the chain.
assert.match(edge, /hasProviderSecret\('openai'\)/, 'the CV pre-step is only attempted when OpenAI is configured')
// The only direct key read left is inside the CV file pre-step, which needs the
// Responses API and so cannot be routed. No other action touches a key.
assert.equal(
  (edge.match(/Deno\.env\.get\('OPENAI_API_KEY'\)/g) || []).length, 1,
  'the key is read in exactly one place')
assert.match(edge, /async function postOpenAI\(/, 'and that place is the CV transport')
assert.match(edge, /throw new SaraError\('ai_not_configured'\)/, 'which still classifies a missing key')
assert.match(edge, /if \(resp\.ok\) return resp/, 'success returns immediately')
assert.match(edge, /insufficient_quota\|credit_balance_exhausted/,
  'quota exhaustion (also surfaced as 429) must classify as ai_billing, not ai_rate_limited')
assert.match(edge, /throw new SaraError\('ai_billing'\)/, 'quota exhaustion must map to ai_billing')

// generate_questions resolves through the router, so there is no provider
// failure path left to classify; the only rejection is an unusable answer shape.
assert.match(edge, /feature: 'assessment_generation'/, 'generate_questions routes through the shared router')
assert.match(edge, /signal: AbortSignal\.timeout\(45000\)/, 'generation stays bounded')
assert.ok(!/runOpenAIWithTimeout/.test(edge), 'the single-provider timeout wrapper is gone')

// Malformed AI output in generate_assessment becomes the existing ai_bad_shape code.
assert.match(edge, /sanitizeQuestions\(parsed && Array\.isArray\(parsed\.questions\) \? parsed\.questions : \[\], job\.job_title\)/,
  'generate_assessment must guard malformed AI output')

// --- 2. Client error UX: safe stage-specific messages instead of raw `SARA: <code>` ---
assert.match(assessments, /const AI_GENERATION_STAGES = \[/, 'Assessments.jsx must show staged progress')
assert.match(assessments, /const AI_ERROR_MESSAGES = \{/, 'Assessments.jsx must map failure codes to safe messages')
// Every generation-stage code maps to the same provider-neutral, actionable
// copy: the router always resolves, so a code means "no usable question set".
assert.match(assessments, /ai_not_configured: GENERATION_UNSATISFIED/, 'ai_not_configured maps to the safe message')
for (const code of ['ai_invalid_key', 'ai_billing', 'ai_rate_limited', 'ai_provider_error',
  'ai_network', 'ai_timeout', 'ai_empty', 'ai_bad_response', 'ai_bad_shape', 'rate_limited']) {
  assert.match(assessments, new RegExp(`${code}: GENERATION_UNSATISFIED`), `${code} maps to the safe message`)
}
assert.match(assessments, /const GENERATION_UNSATISFIED = 'SARA could not produce a complete, valid question set this time, so nothing was saved\./, 'the safe copy states the outcome')
assert.ok(!/temporarily unavailable|ai_unavailable|not configured/.test(assessments), 'no outage or configuration wording in Assessments.jsx')
assert.ok(!/\`SARA: \$\{res\.error\}\`/.test(assessments), 'client must not render the raw server error code')
assert.match(assessments, /aiGenerationErrorMessage\(res\?\.error\)/, 'generateAI uses the safe error mapper')
assert.match(assessments, /Generating assessment/, 'modal shows generation progress')
assert.match(assessments, /aiStage/, 'staged progress state is wired')
assert.match(assessments, /disabled=\{busy\}/, 'Generate runs cannot double-fire')
assert.ok(assessments.includes('export function aiGenerationErrorMessage(error)'),
  'error mapper is exported for reuse/tests')

// --- 2b. No provider names or outage wording anywhere in the client ---
for (const path of ['src/pages/Assessments.jsx', 'src/services/saraChatService.js',
  'src/services/screeningService.js', 'src/services/saraNlu.js', 'src/components/sara/Sara.jsx']) {
  const source = read(path)
  assert.ok(!/OpenAI|openai|Gemini|gemini|Groq|GROQ|NVIDIA|Nvidia/.test(source),
    `${path} must not name a provider to the user`)
  assert.ok(!/temporarily unavailable/i.test(source), `${path} must not claim an outage`)
}

// --- 3. Client question bank (AssessmentBuilder) keeps working + anti-cheat ---
assert.match(builder, /DEFAULT_ANTI_CHEAT/, 'AssessmentBuilder reuses the shared anti-cheat default')
assert.match(builder, /AntiCheatBlock/, 'create/settings modals both render AntiCheatBlock')
assert.match(builder, /Settings/, 'existing templates can have settings edited')
assert.match(service, /export const DEFAULT_ANTI_CHEAT/, 'service still owns the anti-cheat default')
assert.match(service, /async generateWithSara/, 'Assessments AI flow still uses generateWithSara')
assert.match(service, /async generateQuestions\(/, 'draft-mode generation is wired through the service')
for (const key of ["action: 'generate_questions'", 'samplesMode', 'jdFileBase64', 'samplesFileBase64']) {
  assert.ok(service.includes(key), `assessmentService.generateQuestions must send ${key}`)
}

console.log('assessment-ai-reliability tests passed.')