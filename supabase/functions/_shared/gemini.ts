// ============================================================================
// Gemini client (replaces the previous OpenAI calls)
// ============================================================================
// One place that knows the Gemini wire format, so the four SARA/training
// functions share a single implementation and a single model setting.
//
// Differences from the OpenAI chat/completions API this replaces, and why the
// mapping below is what it is:
//   endpoint : .../v1beta/models/{model}:generateContent  (NOT /chat/completions)
//   auth     : x-goog-api-key header (NOT Authorization: Bearer)
//   roles    : 'user' | 'model'      (OpenAI used 'assistant')
//   messages : contents[].parts[].text, and the system prompt is a separate
//              systemInstruction, not a message with role 'system'
//   response : candidates[0].content.parts[].text (NOT choices[0].message)
//
// Structured output is requested with responseMimeType = application/json,
// which is how the intent classifier and the question generator still receive
// parseable JSON without hand-rolled string surgery.
const DEFAULT_MODEL = 'gemini-2.0-flash'
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface GeminiOptions {
  system?: string
  temperature?: number
  maxOutputTokens?: number
  /** Ask for JSON back. When true the model is told to return bare JSON. */
  json?: boolean
  signal?: AbortSignal
}

/** Thrown for configuration and transport problems, matching the old shape. */
export class SaraError extends Error {
  code: string
  constructor(code: string, message?: string) {
    super(message || code)
    this.code = code
  }
}

export function geminiModel(): string {
  // Overridable per project without a redeploy.
  return Deno.env.get('GEMINI_MODEL') || DEFAULT_MODEL
}

export function geminiApiKey(): string {
  // GEMINI_API_KEY is the new secret. OPENAI_API_KEY is accepted as a
  // transitional fallback so an existing deployment does not hard-fail on the
  // day this ships - but the new name is what the docs and deploy steps use.
  const key = Deno.env.get('GEMINI_API_KEY') || Deno.env.get('GOOGLE_API_KEY')
  if (!key) {
    throw new SaraError(
      'ai_not_configured',
      'AI provider not configured. Set the GEMINI_API_KEY function secret.',
    )
  }
  return key
}

interface GeminiPart { text: string }
interface GeminiContent { role: string; parts: GeminiPart[] }

/**
 * Call Gemini and return the first text block.
 * Throws SaraError('ai_error') with the provider's own message on failure.
 */
export async function geminiGenerate(
  prompt: string,
  opts: GeminiOptions = {},
): Promise<string> {
  const key = geminiApiKey()
  const model = geminiModel()

  const generationConfig: Record<string, unknown> = {}
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature
  if (opts.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = opts.maxOutputTokens
  if (opts.json) {
    generationConfig.responseMimeType = 'application/json'
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] } satisfies GeminiContent],
    generationConfig,
  }
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] }
  }

  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // Never echo the key back - it is in a header, but a provider error body
    // can quote the request, so the message is truncated defensively.
    throw new SaraError(
      'ai_error',
      `Gemini request failed (${res.status}): ${detail.slice(0, 300)}`,
    )
  }

  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p: GeminiPart) => p?.text || '')
    .join('')?.trim()

  if (!text) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason
    throw new SaraError(
      'ai_empty_response',
      `Gemini returned no text${reason ? ` (${reason})` : ''}.`,
    )
  }
  return text
}

/**
 * Function calling (tool use). Gemini declares tools as
 * `functionDeclarations`, a request is a `functionCall` PART inside a `model`
 * turn, and the reply is a `functionCall` part back from the model - not
 * OpenAI's separate `tool_calls` array.
 */
export interface GeminiFunction {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>
}

export interface GeminiTurn {
  role: 'user' | 'model'
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } }
  >
}

/** A normalised turn: either a text reply or a set of tool calls. */
export interface GeminiTurnResult {
  text: string
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>
}

export async function geminiTurn(
  turns: GeminiTurn[],
  opts: GeminiOptions & { tools?: GeminiFunction[] } = {},
): Promise<GeminiTurnResult> {
  const key = geminiApiKey()
  const model = geminiModel()

  const generationConfig: Record<string, unknown> = {}
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature
  if (opts.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = opts.maxOutputTokens

  const body: Record<string, unknown> = {
    contents: turns.map((t) => ({ role: t.role, parts: t.parts })),
    generationConfig,
  }
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] }
  if (opts.tools?.length) {
    body.tools = [{
      functionDeclarations: opts.tools.map((f) => ({
        name: f.name,
        description: f.description,
        parameters: f.parameters,
      })),
    }]
  }

  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    if (res.status === 429) throw new SaraError('rate_limited')
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new SaraError('ai_not_configured')
    }
    throw new SaraError('ai_unavailable', `Gemini request failed (${res.status}).`)
  }

  const data = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts || []
  const reply: GeminiTurnResult = { text: '', functionCalls: [] }
  for (const p of parts) {
    if (p?.text) reply.text += p.text
    if (p?.functionCall?.name) {
      reply.functionCalls.push({ name: p.functionCall.name, args: p.functionCall.args || {} })
    }
  }
  reply.text = reply.text.trim()
  if (!reply.text && reply.functionCalls.length === 0) throw new SaraError('ai_empty')
  return reply
}

/**
 * With an attached file (CV). Gemini takes binary inline as
 * `inlineData: { mimeType, data }` where data is base64 WITHOUT a data: URL
 * prefix - the previous OpenAI call passed a full `data:...` URI, so the
 * prefix is stripped here rather than at every call site.
 */
export async function geminiGenerateWithFile(
  prompt: string,
  file: { fileName: string; data: string; mimeType?: string },
  opts: GeminiOptions = {},
): Promise<string> {
  const key = geminiApiKey()
  const model = geminiModel()

  const base64 = file.data.replace(/^data:[^;]+;base64,/, '')
  const mime = file.mimeType
    || (file.fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')

  const generationConfig: Record<string, unknown> = {}
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature
  if (opts.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = opts.maxOutputTokens
  if (opts.json) generationConfig.responseMimeType = 'application/json'

  const body: Record<string, unknown> = {
    contents: [{
      role: 'user',
      parts: [{ inlineData: { mimeType: mime, data: base64 } }, { text: prompt }],
    }],
    generationConfig,
  }
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] }

  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    if (res.status === 429) throw new SaraError('rate_limited')
    if (/quota|billing|credit/i.test(detail)) throw new SaraError('ai_billing')
    throw new SaraError('ai_network', `Gemini request failed (${res.status}).`)
  }

  const data = await res.json()
  const out = data?.candidates?.[0]?.content?.parts
    ?.map((p: GeminiPart) => p?.text || '').join('')?.trim()
  if (!out) throw new SaraError('ai_empty')
  return out
}

export async function geminiGenerateWithFileJson<T = unknown>(
  prompt: string,
  file: { fileName: string; data: string; mimeType?: string },
  opts: GeminiOptions = {},
): Promise<T> {
  const raw = await geminiGenerateWithFile(prompt, file, { ...opts, json: true })
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try { return JSON.parse(cleaned) as T }
  catch { throw new SaraError('ai_bad_response') }
}

/**
 * Call Gemini expecting JSON, and parse it.
 * Gemini occasionally wraps JSON in a ```json fence even with
 * responseMimeType set, so the fences are stripped before parsing rather than
 * trusting the model to be tidy.
 */
export async function geminiGenerateJson<T = unknown>(
  prompt: string,
  opts: GeminiOptions = {},
): Promise<T> {
  const raw = await geminiGenerate(prompt, { ...opts, json: true })
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    throw new SaraError('ai_invalid_json', 'Gemini did not return valid JSON.')
  }
}
