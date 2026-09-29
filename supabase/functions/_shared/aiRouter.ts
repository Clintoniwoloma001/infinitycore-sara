// ============================================================================
// SARA AI PROVIDER ROUTER
// ============================================================================
// One entry point for every SARA AI capability. It walks the configured
// provider chain, fails over on any error, records each attempt, and never
// reports an outage to a caller: the chain always terminates in the
// internal rules engine, which answers deterministically with no network.
//
//   1. Gemini    2. Groq    3. rules (internal)    4. OpenAI    5. NVIDIA
//
// Responsibilities, all of them deliberately in ONE module so the four SARA
// edge functions cannot drift apart:
//   * read the chain + per-feature model pins from the platform settings
//   * pick the model for (provider, feature)
//   * call a remote provider (Gemini / Groq / OpenAI / NVIDIA) or the
//     in-process rules engine
//   * measure latency, classify failures, trip/recover the circuit breaker
//   * persist provider_health, provider_latency and provider_usage_logs
//   * return a value, or throw a single honest `AiRouterExhausted` code
//
// Keys are read from function secrets and never returned or logged:
//   GEMINI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, NVIDIA_API_KEY
//
// The rules engine is a real provider, not a stub: it produces a correct
// deterministic answer for every SARA feature from the data it is given, so a
// total provider outage degrades quality instead of breaking the product.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { deterministicAnswer } from './rulesEngine.ts'

// ---------------------------------------------------------------------------
// Canonical feature list — mirrors public.ai_features()
// ---------------------------------------------------------------------------

export const AI_FEATURES = [
  { id: 'chat', label: 'SARA conversation' },
  { id: 'summary', label: 'Operational insight summaries' },
  { id: 'intent', label: 'Intent recognition' },
  { id: 'candidate_screening', label: 'Candidate screening' },
  { id: 'candidate_ranking', label: 'Candidate ranking' },
  { id: 'candidate_scorecard', label: 'Candidate scorecard analysis' },
  { id: 'assessment_generation', label: 'Assessment generation' },
  { id: 'assessment_analysis', label: 'Assessment scoring' },
  { id: 'interview_analysis', label: 'Interview analysis' },
  { id: 'recruitment_recommendation', label: 'HR recommendations' },
  { id: 'attendance_summary', label: 'Attendance summaries' },
  { id: 'leave_analysis', label: 'Leave analysis' },
  { id: 'performance_review', label: 'Performance reviews' },
  { id: 'mpr_summary', label: 'MPR summaries' },
  { id: 'bankone_analytics', label: 'BankOne analytics' },
  { id: 'training_questions', label: 'Training question generation' },
] as const

export type AiFeature = string

// ---------------------------------------------------------------------------
// Provider catalog — the static mirror of the `ai_providers` seed. The DB is
// the source of truth; this is the last-resort shape used before the migration
// has been applied, so a fresh environment still fails over correctly.
// ---------------------------------------------------------------------------

export interface ProviderDescriptor {
  id: string
  name: string
  kind: 'remote' | 'internal'
  defaultModel: string
}

export const PROVIDER_CATALOG: Record<string, ProviderDescriptor> = {
  gemini: { id: 'gemini', name: 'Google Gemini', kind: 'remote', defaultModel: 'gemini-2.0-flash' },
  groq: { id: 'groq', name: 'Groq', kind: 'remote', defaultModel: 'llama-3.3-70b-versatile' },
  rules: { id: 'rules', name: 'Internal Rules Engine', kind: 'internal', defaultModel: 'deterministic-v1' },
  openai: { id: 'openai', name: 'OpenAI', kind: 'remote', defaultModel: 'gpt-4o-mini' },
  // Clean APIs is an OpenAI-compatible gateway. Adding it here rather than
  // building a parallel service is what keeps SARA identical on Web and Flutter:
  // both keep calling the same router, so failover, rate limiting, usage
  // accounting and audit all continue to work unchanged.
  cleanapis: { id: 'cleanapis', name: 'Clean APIs', kind: 'remote', defaultModel: 'gpt-5.6-luna' },
  nvidia: { id: 'nvidia', name: 'NVIDIA NIM', kind: 'remote', defaultModel: 'meta/llama-3.3-70b-instruct' },
}

// Clean APIs is tried EARLY (before the paid OpenAI tier) so a configured
// Clean APIs key is actually used; the rest of the chain remains as failover.
export const DEFAULT_CHAIN = ['cleanapis', 'gemini', 'groq', 'rules', 'openai', 'nvidia']

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Every failure the router can report. Never a raw provider body. */
export type AiFailureCode =
  | 'ai_not_configured'   // the provider's secret is absent on this deployment
  | 'ai_invalid_key'      // the provider rejected our credential
  | 'ai_rate_limited'     // provider-side throttling / quota window
  | 'ai_billing'          // credits exhausted
  | 'ai_timeout'          // we aborted the request
  | 'ai_network'          // transport failure
  | 'ai_empty'            // 2xx with no usable content
  | 'ai_bad_response'     // 2xx whose body is not the JSON we asked for
  | 'ai_invalid_json'     // 2xx with unparseable content
  | 'ai_provider_error'   // any other non-2xx
  | 'ai_unsupported'      // this provider cannot serve this capability

export class AiProviderError extends Error {
  code: AiFailureCode
  provider: string
  status?: number
  constructor(code: AiFailureCode, provider: string, message?: string, status?: number) {
    super(message || `${provider}: ${code}`)
    this.name = 'AiProviderError'
    this.code = code
    this.provider = provider
    this.status = status
  }
}

/**
 * Thrown only when the whole chain failed, which the rules tier prevents.
 * The message is an operational one for logs, never a user-facing string.
 */
export class AiRouterExhausted extends Error {
  code: AiFailureCode
  attempts: RouterAttempt[]
  constructor(attempts: RouterAttempt[], code: AiFailureCode = 'ai_provider_error') {
    super('every configured provider failed; the internal rules tier was unavailable')
    this.name = 'AiRouterExhausted'
    this.code = code
    this.attempts = attempts
  }
}

export interface RouterAttempt {
  provider: string
  outcome: 'success' | 'failure'
  code?: string
  ms: number
}

/** Human-readable, user-safe text per failure. Never a provider raw body. */
export function describeFailure(code: string, provider: string): string {
  switch (code) {
    case 'ai_not_configured':
      return `${provider} is not set up on this deployment.`
    case 'ai_invalid_key':
      return `${provider} rejected the server credential.`
    case 'ai_rate_limited':
      return `${provider} is rate-limiting requests right now.`
    case 'ai_billing':
      return `${provider} has no available credit.`
    case 'ai_timeout':
      return `${provider} took too long to respond.`
    case 'ai_network':
      return `${provider} could not be reached.`
    case 'ai_empty':
      return `${provider} returned an empty response.`
    case 'ai_bad_response':
      return `${provider} returned a response SARA could not read.`
    case 'ai_invalid_json':
      return `${provider} returned a response SARA could not read.`
    case 'ai_unsupported':
      return `${provider} does not support this capability.`
    default:
      return `${provider} returned an error.`
  }
}

// ---------------------------------------------------------------------------
// Router configuration
// ---------------------------------------------------------------------------

export interface RouterConfig {
  chain: Array<{
    id: string
    name: string
    kind: 'remote' | 'internal'
    default_model: string
    status: string
    circuit: string
    cooling_down: boolean
  }>
  models: Record<string, string>
  timeout_ms: number
  failover_enabled: boolean
  primary: string
}

const FALLBACK_CONFIG: RouterConfig = {
  chain: DEFAULT_CHAIN.map((id) => ({
    id,
    name: PROVIDER_CATALOG[id].name,
    kind: PROVIDER_CATALOG[id].kind,
    default_model: PROVIDER_CATALOG[id].defaultModel,
    status: 'unknown',
    circuit: 'closed',
    cooling_down: false,
  })),
  models: {},
  timeout_ms: 20000,
  failover_enabled: true,
  primary: 'gemini',
}

function coerceChain(raw: unknown): RouterConfig['chain'] {
  if (!Array.isArray(raw)) return FALLBACK_CONFIG.chain
  const seen = new Set<string>()
  const chain = []
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : String(entry?.id || '')
    if (!id || seen.has(id)) continue
    const catalog = PROVIDER_CATALOG[id]
    // The internal tier is the guaranteed terminal provider: a mis-configured
    // chain that dropped it gets it appended here, so failover always lands.
    chain.push({
      id,
      name: String(entry?.name || catalog?.name || id),
      kind: entry?.kind === 'internal' ? 'internal' : (catalog?.kind || 'remote'),
      default_model: String(entry?.default_model || catalog?.defaultModel || ''),
      status: String(entry?.status || 'unknown'),
      circuit: String(entry?.circuit || 'closed'),
      cooling_down: entry?.cooling_down === true,
    })
    seen.add(id)
  }
  for (const id of DEFAULT_CHAIN) {
    if (!seen.has(id) && PROVIDER_CATALOG[id].kind === 'internal') {
      chain.push({
        id,
        name: PROVIDER_CATALOG[id].name,
        kind: 'internal',
        default_model: PROVIDER_CATALOG[id].defaultModel,
        status: 'unknown',
        circuit: 'closed',
        cooling_down: false,
      })
    }
  }
  return chain.length ? chain : FALLBACK_CONFIG.chain
}

/** Read the effective chain once per cold start, then reuse it briefly. */
let cachedConfig: { config: RouterConfig; at: number } | null = null
const CONFIG_TTL_MS = 15000

export async function loadRouterConfig(admin: SupabaseLike): Promise<RouterConfig> {
  if (cachedConfig && Date.now() - cachedConfig.at < CONFIG_TTL_MS) return cachedConfig.config
  try {
    const { data, error } = await admin.rpc('get_ai_provider_config')
    if (!error && data) {
      const config: RouterConfig = {
        chain: coerceChain(data.chain),
        models: (data.models && typeof data.models === 'object') ? data.models : {},
        timeout_ms: Number(data.timeout_ms) || FALLBACK_CONFIG.timeout_ms,
        failover_enabled: data.failover_enabled !== false,
        primary: String(data.primary || 'gemini'),
      }
      cachedConfig = { config, at: Date.now() }
      return config
    }
  } catch { /* migration not applied yet — use the static mirror */ }
  cachedConfig = { config: FALLBACK_CONFIG, at: Date.now() }
  return FALLBACK_CONFIG
}

export function clearRouterConfigCache() {
  cachedConfig = null
}

/**
 * Resolve the model for one provider on one feature.
 * Model selection accepts "<feature>" -> "<provider>/<model>" pins and
 * "<provider>" -> "<model>" defaults, both validated server-side.
 */
export function resolveModel(config: RouterConfig, providerId: string, feature: AiFeature): string {
  const pinned = config.models?.[feature]
  if (typeof pinned === 'string' && pinned.includes('/')) {
    const [provider, ...rest] = pinned.split('/')
    if (provider === providerId) return rest.join('/')
  }
  const perProvider = config.models?.[providerId]
  if (typeof perProvider === 'string' && perProvider.trim()) return perProvider.trim()
  const descriptor = config.chain.find((c) => c.id === providerId)
  return descriptor?.default_model || PROVIDER_CATALOG[providerId]?.defaultModel || ''
}

// ---------------------------------------------------------------------------
// Service-role Supabase client (for settings reads and telemetry writes)
// ---------------------------------------------------------------------------

export interface SupabaseLike {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: any }>
  from?: (table: string) => any
}

let adminClient: SupabaseLike | null = null

export function routerAdmin(): SupabaseLike | null {
  if (adminClient) return adminClient
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return null
  adminClient = createClient(url, key, {
    global: { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseLike
  return adminClient
}

// ---------------------------------------------------------------------------
// Provider credentials — server-side only, never returned to a caller
// ---------------------------------------------------------------------------

const SECRET_ENV: Record<string, string[]> = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  // Supabase function secret, set with:
  //   node scripts/set-supabase-secret.mjs --name CLEAN_APIS_KEY
  // It is read ONLY here, server-side, and never returned to a caller.
  cleanapis: ['CLEAN_APIS_KEY'],
  nvidia: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
}

export function providerSecret(providerId: string): string | null {
  for (const name of SECRET_ENV[providerId] || []) {
    const value = Deno.env.get(name)
    if (value && value.trim()) return value.trim()
  }
  return null
}

export function hasProviderSecret(providerId: string): boolean {
  return providerSecret(providerId) !== null
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** OpenAI-compatible chat/completions wire format (Groq, OpenAI, NVIDIA). */
interface OpenAiMessage { role: string; content: string }
interface OpenAiTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

const OPENAI_COMPATIBLE: Record<string, { base: string; authHeader: string; authPrefix: string }> = {
  groq: { base: 'https://api.groq.com/openai/v1', authHeader: 'Authorization', authPrefix: 'Bearer ' },
  openai: { base: 'https://api.openai.com/v1', authHeader: 'Authorization', authPrefix: 'Bearer ' },
  // Clean APIs speaks the OpenAI chat/completions wire format, so it reuses the
  // exact same request/response path as OpenAI and Groq. If the account's
  // gateway base path differs, change it HERE and nowhere else.
  cleanapis: { base: 'https://cleanapis.com/v1', authHeader: 'Authorization', authPrefix: 'Bearer ' },
  nvidia: { base: 'https://integrate.api.nvidia.com/v1', authHeader: 'Authorization', authPrefix: 'Bearer ' },
}

function statusToFailure(provider: string, status: number, body: string): AiProviderError {
  if (status === 429) {
    if (/insufficient_quota|credit_balance_exhausted|quota exceeded|billing/i.test(body)) {
      return new AiProviderError('ai_billing', provider, undefined, status)
    }
    return new AiProviderError('ai_rate_limited', provider, undefined, status)
  }
  if (status === 401 || status === 403) return new AiProviderError('ai_invalid_key', provider, undefined, status)
  if (status === 404) return new AiProviderError('ai_not_configured', provider, undefined, status)
  if (status >= 500) return new AiProviderError('ai_provider_error', provider, undefined, status)
  if (status === 408) return new AiProviderError('ai_timeout', provider, undefined, status)
  return new AiProviderError('ai_provider_error', provider, undefined, status)
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError' || (error as { name?: string })?.name === 'TimeoutError'
}

/** Truncate a provider error body so a hostile echo can never reach a log. */
function safeDetail(body: string, limit = 300): string {
  const scrubbed = body
    .replace(/(sk|gsk|nvapi|AQ)[-_A-Za-z0-9]{12,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  return scrubbed.slice(0, limit)
}

async function readErrorDetail(res: Response): Promise<string> {
  try { return await res.text() } catch { return '' }
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  prompt: string
  system?: string
  temperature?: number
  maxOutputTokens?: number
  json?: boolean
  /**
   * Structured input for the deterministic rules tier. Remote providers never
   * see it — the prompt is the model contract — but it is what makes the
   * internal answers correct instead of generic.
   */
  rulesData?: Record<string, unknown>
  signal?: AbortSignal
}

export interface TurnRequest extends GenerateRequest {
  turns: Array<{ role: 'user' | 'model' | 'assistant'; parts: Array<Record<string, unknown>> }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}

export interface TurnResult {
  text: string
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>
  promptTokens?: number
  completionTokens?: number
}

export interface ProviderResult {
  text: string
  promptTokens?: number
  completionTokens?: number
  model: string
  provider: string
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

async function geminiGenerate(model: string, req: GenerateRequest): Promise<ProviderResult> {
  const key = providerSecret('gemini')!
  const generationConfig: Record<string, unknown> = {}
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature
  if (req.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = req.maxOutputTokens
  if (req.json) generationConfig.responseMimeType = 'application/json'

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    generationConfig,
  }
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }

  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) throw statusToFailure('gemini', res.status, await readErrorDetail(res))
  const data = await res.json().catch(() => { throw new AiProviderError('ai_bad_response' as AiFailureCode, 'gemini') })
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: { text?: string }) => p?.text || '')
    .join('')
    .trim()
  if (!text) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason
    throw new AiProviderError('ai_empty', 'gemini', `Gemini returned no text${reason ? ` (${reason})` : ''}`)
  }
  return {
    text,
    promptTokens: data?.usageMetadata?.promptTokenCount,
    completionTokens: data?.usageMetadata?.candidatesTokenCount,
    model,
    provider: 'gemini',
  }
}

async function geminiTurn(model: string, req: TurnRequest): Promise<TurnResult> {
  const key = providerSecret('gemini')!
  const generationConfig: Record<string, unknown> = {}
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature
  if (req.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = req.maxOutputTokens

  const body: Record<string, unknown> = {
    contents: req.turns.map((t) => ({
      role: t.role === 'model' || t.role === 'assistant' ? 'model' : 'user',
      parts: t.parts,
    })),
    generationConfig,
  }
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }
  if (req.tools?.length) {
    body.tools = [{
      functionDeclarations: req.tools.map((f) => ({
        name: f.name,
        description: f.description,
        parameters: f.parameters,
      })),
    }]
  }

  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) throw statusToFailure('gemini', res.status, await readErrorDetail(res))
  const data = await res.json().catch(() => { throw new AiProviderError('ai_bad_response' as AiFailureCode, 'gemini') })
  const parts = data?.candidates?.[0]?.content?.parts || []
  const reply: TurnResult = { text: '', functionCalls: [] }
  for (const p of parts) {
    if (p?.text) reply.text += p.text
    if (p?.functionCall?.name) reply.functionCalls.push({ name: p.functionCall.name, args: p.functionCall.args || {} })
  }
  reply.text = reply.text.trim()
  if (!reply.text && reply.functionCalls.length === 0) throw new AiProviderError('ai_empty', 'gemini')
  reply.promptTokens = data?.usageMetadata?.promptTokenCount
  reply.completionTokens = data?.usageMetadata?.candidatesTokenCount
  return reply
}

async function openAiCompatibleGenerate(
  provider: string,
  model: string,
  req: GenerateRequest,
): Promise<ProviderResult> {
  const cfg = OPENAI_COMPATIBLE[provider]
  if (!cfg) throw new AiProviderError('ai_unsupported', provider)
  const key = providerSecret(provider)
  if (!key) throw new AiProviderError('ai_not_configured', provider)

  const messages: OpenAiMessage[] = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  messages.push({ role: 'user', content: req.prompt })

  const payload: Record<string, unknown> = {
    model,
    messages,
    // Low temperature for classification/extraction, provider default otherwise.
    temperature: req.temperature ?? 0.3,
  }
  if (req.maxOutputTokens !== undefined) payload.max_tokens = req.maxOutputTokens
  if (req.json) payload.response_format = { type: 'json_object' }

  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [cfg.authHeader]: `${cfg.authPrefix}${key}` },
    body: JSON.stringify(payload),
    signal: req.signal,
  })
  if (!res.ok) throw statusToFailure(provider, res.status, await readErrorDetail(res))
  const data = await res.json().catch(() => { throw new AiProviderError('ai_bad_response' as AiFailureCode, provider) })
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new AiProviderError('ai_empty', provider)
  return {
    text: text.trim(),
    promptTokens: data?.usage?.prompt_tokens,
    completionTokens: data?.usage?.completion_tokens,
    model,
    provider,
  }
}

async function openAiCompatibleTurn(
  provider: string,
  model: string,
  req: TurnRequest,
): Promise<TurnResult> {
  const cfg = OPENAI_COMPATIBLE[provider]
  if (!cfg) throw new AiProviderError('ai_unsupported', provider)
  const key = providerSecret(provider)
  if (!key) throw new AiProviderError('ai_not_configured', provider)

  // Gemini turn parts -> OpenAI messages. functionCall parts are replayed as a
  // tool_calls assistant message; functionResponse parts as tool messages.
  const messages: unknown[] = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  for (const turn of req.turns) {
    const isModel = turn.role === 'model' || turn.role === 'assistant'
    const texts: string[] = []
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const responses: Array<{ name: string; response: Record<string, unknown> }> = []
    for (const part of turn.parts as Array<Record<string, any>>) {
      if (part?.text) texts.push(part.text)
      if (part?.functionCall?.name) calls.push({ name: part.functionCall.name, args: part.functionCall.args || {} })
      if (part?.functionResponse?.name) {
        responses.push({ name: part.functionResponse.name, response: part.functionResponse.response || {} })
      }
    }
    for (const response of responses) {
      messages.push({
        role: 'tool',
        tool_call_id: `call_${response.name}`,
        content: JSON.stringify(response.response).slice(0, 12000),
      })
    }
    if (isModel && calls.length) {
      messages.push({
        role: 'assistant',
        content: texts.join('') || null,
        tool_calls: calls.map((c, i) => ({
          id: `call_${c.name}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        })),
      })
    } else if (texts.length) {
      messages.push({ role: isModel ? 'assistant' : 'user', content: texts.join('') })
    }
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature: req.temperature ?? 0.2,
  }
  if (req.maxOutputTokens !== undefined) payload.max_tokens = req.maxOutputTokens
  if (req.tools?.length) {
    payload.tools = req.tools.map((f) => ({
      type: 'function',
      function: { name: f.name, description: f.description, parameters: f.parameters },
    }))
  }

  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [cfg.authHeader]: `${cfg.authPrefix}${key}` },
    body: JSON.stringify(payload),
    signal: req.signal,
  })
  if (!res.ok) throw statusToFailure(provider, res.status, await readErrorDetail(res))
  const data = await res.json().catch(() => { throw new AiProviderError('ai_bad_response' as AiFailureCode, provider) })
  const message = data?.choices?.[0]?.message
  const text = typeof message?.content === 'string' ? message.content.trim() : ''
  const functionCalls = (message?.tool_calls || []).map((call: any) => {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(call?.function?.arguments || '{}') } catch { args = {} }
    return { name: call?.function?.name || '', args }
  }).filter((c: { name: string }) => c.name)
  if (!text && functionCalls.length === 0) throw new AiProviderError('ai_empty', provider)
  return {
    text,
    functionCalls,
    promptTokens: data?.usage?.prompt_tokens,
    completionTokens: data?.usage?.completion_tokens,
  }
}

/** Map a rules-tier feature onto the deterministic responder. */
function rulesResult(feature: AiFeature, request: GenerateRequest | TurnRequest, model: string): ProviderResult {
  const payload = deterministicAnswer(feature, request as GenerateRequest)
  return { text: payload.text, model, provider: 'rules' }
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

interface TelemetryContext {
  feature: AiFeature
  actorUserId?: string | null
  requestId?: string | null
  /**
   * When true the failure is a normal outcome (e.g. a rules-tier "I don't
   * have enough data") and must not open a circuit.
   */
  soft?: boolean
}

async function recordOutcome(
  admin: SupabaseLike | null,
  provider: string,
  attempt: { model: string; outcome: 'success' | 'failure'; code?: string; ms: number },
  ctx: TelemetryContext,
  extra: { promptTokens?: number; completionTokens?: number } = {},
): Promise<void> {
  if (!admin) return
  try {
    await admin.rpc('record_ai_provider_outcome', {
      p_provider_id: provider,
      p_model: attempt.model,
      p_feature: ctx.feature,
      p_outcome: attempt.outcome,
      p_latency_ms: attempt.ms,
      p_error_code: attempt.outcome === 'failure' ? (attempt.code || 'ai_provider_error') : null,
      p_error_source: attempt.outcome === 'failure' ? provider : null,
      p_prompt_tokens: extra.promptTokens ?? null,
      p_completion_tokens: extra.completionTokens ?? null,
      p_total_tokens: (extra.promptTokens ?? 0) + (extra.completionTokens ?? 0) || null,
      p_actor_user_id: ctx.actorUserId ?? null,
      p_request_id: ctx.requestId ?? null,
    })
  } catch { /* telemetry must never break the AI call it is describing */ }
}

async function recordCall(
  admin: SupabaseLike | null,
  attempts: RouterAttempt[],
  servedBy: string,
  ctx: TelemetryContext,
  detail: { model?: string; outcome: 'success' | 'failure'; code?: string; ms: number; promptTokens?: number; completionTokens?: number },
): Promise<void> {
  if (!admin) return
  try {
    await admin.rpc('record_ai_provider_call', {
      p_attempts: attempts,
      p_feature: ctx.feature,
      p_model: detail.model ?? null,
      p_served_by: servedBy,
      p_outcome: detail.outcome,
      p_error_code: detail.code ?? null,
      p_error_source: detail.code ? servedBy : null,
      p_latency_ms: detail.ms,
      p_prompt_tokens: detail.promptTokens ?? null,
      p_completion_tokens: detail.completionTokens ?? null,
      p_total_tokens: (detail.promptTokens ?? 0) + (detail.completionTokens ?? 0) || null,
      p_actor_user_id: ctx.actorUserId ?? null,
      p_request_id: ctx.requestId ?? null,
    })
  } catch { /* never break the call */ }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export interface RouteResult {
  text: string
  /** Which provider actually answered. */
  provider: string
  /** 'remote' | 'internal' — an internal answer is a degraded-but-correct reply. */
  kind: 'remote' | 'internal'
  model: string
  attempts: RouterAttempt[]
  /** True when a provider failed and a later tier served the request. */
  failedOver: boolean
  /** Safe, user-facing description of what failed (empty when nothing did). */
  notice: string
  degraded: boolean
}

interface RunOptions {
  feature: AiFeature
  actorUserId?: string | null
  requestId?: string | null
  admin?: SupabaseLike | null
  /** Providers that were tried before this one (for resume/caching callers). */
  attempts?: RouterAttempt[]
}

function timeoutSignal(config: RouterConfig, outer?: AbortSignal): AbortSignal {
  const inner = AbortSignal.timeout(Math.max(1000, config.timeout_ms))
  if (!outer) return inner
  // Honour both: whichever fires first aborts the request.
  const controller = new AbortController()
  const abort = () => controller.abort()
  inner.addEventListener('abort', abort, { once: true })
  outer.addEventListener('abort', abort, { once: true })
  return controller.signal
}

/**
 * Order the chain for this call: healthy providers first, cooling-down ones
 * demoted (but kept, so a total outage still retries them before the internal
 * tier), and failover disabled means "primary only".
 */
export function orderChain(config: RouterConfig): RouterConfig['chain'] {
  const chain = [...config.chain]
  if (!config.failover_enabled) return chain.slice(0, 1)
  return chain.sort((a, b) => Number(a.cooling_down) - Number(b.cooling_down))
}

async function runProvider(
  providerId: string,
  kind: 'remote' | 'internal',
  model: string,
  invoke: () => Promise<ProviderResult>,
  feature: AiFeature,
  signal: AbortSignal,
): Promise<{ result: ProviderResult; ms: number }> {
  const started = Date.now()
  const result = await invoke()
  void signal
  return { result, ms: Date.now() - started }
}

/**
 * Build the success return value once. Every serving path (four providers, two
 * request modes) shares this so telemetry, the failure notice and the degraded
 * flag can never drift apart.
 */
function successValue(
  entry: RouterConfig['chain'][number],
  model: string,
  result: ProviderResult,
  ms: number,
  attempts: RouterAttempt[],
  build: (text: string) => unknown,
): RouteResult & { value: any } {
  attempts.push({ provider: entry.id, outcome: 'success', ms })
  const failedOver = attempts.some((a) => a.outcome === 'failure')
  const notice = failedOver
    ? attempts.filter((a) => a.outcome === 'failure').map((a) => describeFailure(a.code || 'ai_provider_error', a.provider)).join(' ')
    : ''
  return {
    text: result.text,
    value: build(result.text),
    provider: entry.id,
    kind: entry.kind,
    model,
    attempts,
    failedOver,
    notice,
    degraded: entry.kind === 'internal',
  }
}

function logSuccess(
  admin: SupabaseLike | null,
  entry: RouterConfig['chain'][number],
  model: string,
  result: ProviderResult,
  ms: number,
  attempts: RouterAttempt[],
  options: RunOptions,
): Promise<unknown> {
  const tokens = { promptTokens: result.promptTokens, completionTokens: result.completionTokens }
  return Promise.all([
    recordOutcome(admin, entry.id, { model, outcome: 'success', ms }, options, tokens),
    recordCall(admin, attempts, entry.id, options, { model, outcome: 'success', ms, ...tokens }),
  ])
}

/**
 * Run one request through the provider chain with failover.
 * Always resolves. The internal rules tier guarantees a value.
 */
export async function route<T = string>(
  request: GenerateRequest | TurnRequest,
  options: RunOptions & { mode: 'generate' | 'turn' | 'json' },
): Promise<RouteResult & { value: T | string }> {
  const admin = options.admin ?? routerAdmin()
  const config = await loadRouterConfig(admin as SupabaseLike)
  const chain = orderChain(config)
  const attempts: RouterAttempt[] = [...(options.attempts || [])]
  const signal = timeoutSignal(config, request.signal)
  const started = Date.now()

  for (const entry of chain) {
    const model = resolveModel(config, entry.id, options.feature)
    const isTurn = options.mode === 'turn'

    if (entry.kind === 'internal') {
      // The deterministic tier has no transport to fail. It is the guaranteed
      // termination point of every chain.
      try {
        const { result, ms } = await runProvider(entry.id, 'internal', model, async () => (
          rulesResult(options.feature, request, model)
        ), options.feature, signal)
        const served = successValue(
          entry, model, result, ms, attempts,
          (text) => (isTurn ? { text, functionCalls: [] } : (options.mode === 'json' ? parseLooseJson(text) ?? {} : text)),
        )
        await logSuccess(admin, entry, model, result, ms, attempts, options)
        return served
      } catch (error) {
        // The rules tier is pure code; a throw here is a real bug, but it must
        // still not surface as a user-facing outage message.
        attempts.push({ provider: entry.id, outcome: 'failure', code: 'ai_provider_error', ms: 0 })
        await recordOutcome(admin, entry.id, { model, outcome: 'failure', code: 'ai_provider_error', ms: 0 }, options)
        continue
      }
    }

    // Remote provider.
    if (!hasProviderSecret(entry.id)) {
      const attempt: RouterAttempt = { provider: entry.id, outcome: 'failure', code: 'ai_not_configured', ms: 0 }
      attempts.push(attempt)
      await recordOutcome(admin, entry.id, { model, outcome: 'failure', code: 'ai_not_configured', ms: 0 }, options)
      continue
    }

    const attemptStarted = Date.now()
    try {
      let result: ProviderResult
      if (isTurn) {
        const turn = await (entry.id === 'gemini'
          ? geminiTurn(model, request as TurnRequest)
          : openAiCompatibleTurn(entry.id, model, request as TurnRequest))
        if (!turn.text && turn.functionCalls.length === 0) throw new AiProviderError('ai_empty', entry.id)
        result = { text: turn.text, model, provider: entry.id, promptTokens: turn.promptTokens, completionTokens: turn.completionTokens }
        const ms = Date.now() - attemptStarted
        const served = successValue(entry, model, result, ms, attempts, () => ({
          text: turn.text,
          functionCalls: turn.functionCalls,
        }))
        await logSuccess(admin, entry, model, result, ms, attempts, options)
        return served
      }

      result = entry.id === 'gemini'
        ? await geminiGenerate(model, request as GenerateRequest)
        : await openAiCompatibleGenerate(entry.id, model, request as GenerateRequest)

      const ms = Date.now() - attemptStarted

      if (options.mode === 'json') {
        // A provider that cannot produce parseable JSON is a failure for this
        // feature, so the router keeps going instead of surfacing a parse error.
        const parsed = parseLooseJson(result.text)
        if (parsed === undefined) throw new AiProviderError('ai_invalid_json', entry.id)
        const served = successValue(entry, model, result, ms, attempts, () => parsed)
        await logSuccess(admin, entry, model, result, ms, attempts, options)
        return served
      }

      const served = successValue(entry, model, result, ms, attempts, (text) => text)
      await logSuccess(admin, entry, model, result, ms, attempts, options)
      return served
    } catch (error) {
      const code = classifyError(error)
      const ms = Date.now() - attemptStarted
      attempts.push({ provider: entry.id, outcome: 'failure', code, ms })
      await recordOutcome(admin, entry.id, { model, outcome: 'failure', code, ms }, options)
      // Keep going: the next tier is the whole point of the router.
    }
  }

  // Unreachable in practice (the internal tier is always appended), but if a
  // deployment somehow has no internal provider we still return a usable
  // message rather than surfacing a hard error.
  const ms = Date.now() - started
  const notice = attempts.map((a) => describeFailure(a.code || 'ai_provider_error', a.provider)).join(' ')
  await recordCall(admin, attempts, attempts[0]?.provider || 'rules', options, { outcome: 'failure', code: 'ai_provider_error', ms })
  const text = "I could not process that right now. Your existing commands and reports are unaffected — please rephrase, or use the typed commands below."
  return {
    text,
    value: text as unknown as T | string,
    provider: 'rules',
    kind: 'internal',
    model: 'deterministic-v1',
    attempts,
    failedOver: true,
    notice,
    degraded: true,
  }
}

export function classifyError(error: unknown): AiFailureCode {
  if (error instanceof AiProviderError) return error.code
  if (isAbort(error)) return 'ai_timeout'
  const message = String((error as Error)?.message || '').toLowerCase()
  if (message.includes('abort') || message.includes('timeout')) return 'ai_timeout'
  if (message.includes('fetch failed') || message.includes('network') || message.includes('dns') || message.includes('econn')) return 'ai_network'
  return 'ai_provider_error'
}

/**
 * Models wrap JSON in a ```json fence even when asked not to. Strip it, and
 * also recover the outermost object when a model adds prose around it.
 * Returns undefined (never throws) so the router can treat it as a provider
 * failure and fail over.
 */
export function parseLooseJson(raw: string): any {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!trimmed) return undefined
  try { return JSON.parse(trimmed) } catch { /* try the outermost object/array below */ }
  const firstObject = trimmed.indexOf('{')
  const lastObject = trimmed.lastIndexOf('}')
  if (firstObject !== -1 && lastObject > firstObject) {
    try { return JSON.parse(trimmed.slice(firstObject, lastObject + 1)) } catch { /* fall through */ }
  }
  const firstArray = trimmed.indexOf('[')
  const lastArray = trimmed.lastIndexOf(']')
  if (firstArray !== -1 && lastArray > firstArray) {
    try { return JSON.parse(trimmed.slice(firstArray, lastArray + 1)) } catch { /* fall through */ }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Convenience wrappers used by the SARA edge functions
// ---------------------------------------------------------------------------

export async function aiGenerate(
  request: GenerateRequest,
  options: Omit<RunOptions, 'attempts'>,
): Promise<RouteResult> {
  const routed = await route(request, { ...options, mode: 'generate' })
  return routed
}

export async function aiGenerateJson<T = unknown>(
  request: GenerateRequest,
  options: Omit<RunOptions, 'attempts'>,
): Promise<RouteResult & { value: T }> {
  const routed = await route<T>(request, { ...options, mode: 'json' })
  return routed as RouteResult & { value: T }
}

export async function aiTurn<T extends TurnResult = TurnResult>(
  request: TurnRequest,
  options: Omit<RunOptions, 'attempts'>,
): Promise<RouteResult & { value: T }> {
  const routed = await route<T>(request, { ...options, mode: 'turn' })
  return routed as RouteResult & { value: T }
}

/** Which providers are actually usable right now (secret present, not cooling). */
export async function providerAvailability(): Promise<Array<{
  id: string
  name: string
  kind: string
  configured: boolean
  status: string
  circuit: string
  cooling_down: boolean
}>> {
  const admin = routerAdmin()
  const config = await loadRouterConfig(admin as SupabaseLike)
  return config.chain.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    configured: entry.kind === 'internal' ? true : hasProviderSecret(entry.id),
    status: entry.status,
    circuit: entry.circuit,
    cooling_down: entry.cooling_down,
  }))
}

export { safeDetail }
