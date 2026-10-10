import { supabase } from '../supabaseClient'

const MAX_HISTORY_TURNS = 8
const MAX_TEXT_LENGTH = 1200
const SUMMARY_CACHE_MS = 5 * 60 * 1000

// SARA resolves to an answer in almost every case, so a code reaching the
// client means either a genuine failure OR a refusal. Those are very different
// things to a user, so they are no longer collapsed into one sentence.
//
// The old map sent `ai_not_configured`, `rate_limited` and `timeout` to the same
// string, and let every other code fall through to it — including
// `unauthorized` and `forbidden`. The operator therefore saw "SARA could not
// answer that just now" when the real reason was an invalid provider credential
// or no credit, and had no way to tell that from "she is broken".
//
// WHY THIS MATTERS HERE
// Routing is a chain (primary -> internal rules -> ...). When the primary
// provider fails the server DOES compute a precise reason and sends it back as
// `notice` — "NVIDIA NIM rejected the server credential." — which the client
// used to discard. `degraded`/`notice` are now surfaced by the caller.
//
// `UNKNOWN` stays deliberately absent on purpose: it is what `saraErrorMessage`
// returns only when NOTHING better is known, i.e. SARA is genuinely broken.
const GENERIC_FAILURE =
  'Something went wrong on our side and SARA could not answer that just now. Your commands and reports are unaffected — please try again.'

const ERROR_MESSAGES = {
  // ---- The operator's own standing / permissions ------------------------
  unauthorized: 'Please sign in again — SARA could not verify your session.',
  forbidden: 'You do not have access to that information. Ask an administrator to grant it in Access Control.',

  // ---- Genuine service problems ----------------------------------------
  rate_limited: 'SARA is handling a lot of requests right now. Wait a moment and try again.',
  timeout: 'SARA is taking too long to answer. Please try again in a moment.',
  ai_empty: 'SARA did not manage to put together an answer for that. Please try rephrasing it.',

  // ---- Provider configuration (an administrator can fix these) ---------
  ai_not_configured: 'SARA is not fully set up yet. An administrator needs to finish the configuration.',
  ai_invalid_key: 'SARA could not sign in to the AI service. An administrator needs to check the server credential.',
  ai_billing: 'SARA has run out of AI credit. An administrator needs to top it up or switch provider.',
  ai_rate_limited: 'The AI service is rate-limiting SARA. Please try again in a moment.',
  ai_timeout: 'The AI service took too long to answer. Please try again.',
  ai_network: 'SARA could not reach the AI service. Please check your connection and try again.',
  ai_unsupported: 'SARA cannot answer that kind of question yet.',
  ai_bad_response: 'SARA received a response she could not read. Please try again.',
  ai_invalid_json: 'SARA received a response she could not read. Please try again.',
  ai_provider_error: 'The AI service reported an error. Please try again.',

  // ---- Request shape ----------------------------------------------------
  invalid_request: 'That request could not be sent. Please try again.',
  method_not_allowed: 'That request could not be sent. Please try again.',
  env_missing: 'SARA is not configured on this deployment. An administrator needs to add the server credential.',
}

/** The one message shown when nothing better is known. */
const UNKNOWN = GENERIC_FAILURE

/**
 * Commands SARA understands, shown next to the input. The failure copy refers
 * to "typed commands below", so a list has to actually exist — previously it
 * did not, and the message pointed at nothing.
 */
export const SARA_COMMANDS = [
  { label: 'What is my leave balance?', example: 'what is my leave balance' },
  { label: 'How many employees do we have?', example: 'how many employees' },
  { label: 'Who is at work today?', example: 'who is present today' },
  { label: 'How many staff are on leave now?', example: 'staff on leave' },
  { label: 'Summarise attendance this week', example: 'attendance summary' },
]

export class SaraAiError extends Error {
  constructor(code = 'no_answer') {
    super(ERROR_MESSAGES[code] || UNKNOWN)
    this.name = 'SaraAiError'
    this.code = code
    this.userMessage = this.message
  }
}

function trimText(value, limit = MAX_TEXT_LENGTH) {
  return String(value || '').trim().slice(0, limit)
}

export function boundConversationHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item?.from === 'user' || item?.from === 'sara' || item?.role === 'user' || item?.role === 'assistant')
    .slice(-MAX_HISTORY_TURNS)
    .map((item) => ({
      role: item.role || (item.from === 'user' ? 'user' : 'assistant'),
      content: trimText(item.content || item.text),
    }))
    .filter((item) => item.content)
}

function errorCode(error, data) {
  const explicit = data?.error || error?.code
  if (explicit === 'ai_not_configured' || explicit === 'rate_limited' || explicit === 'timeout' || explicit === 'ai_empty') return explicit
  if (String(error?.message || '').toLowerCase().includes('timeout')) return 'timeout'
  return 'no_answer'
}

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('sara-chat', { body })
  if (error || data?.ok === false) throw new SaraAiError(errorCode(error, data))
  return data
}

/**
 * The server's own reason, when the chain DEGRADED rather than failed.
 *
 * `degraded` means SARA still answered — she fell back to the internal rules
 * engine after the primary provider could not be reached. That is worth saying
 * out loud: "NVIDIA NIM rejected the server credential" is actionable, whereas
 * a correct-looking answer with no explanation looks like everything is fine.
 */
export function degradedNotice(response) {
  if (!response) return null
  if (!response.degraded || !response.notice) return null
  // The router joins one sentence per failed provider, so the FIRST sentence is
  // the reason the primary provider did not answer — that is the useful one.
  // The rest are the fallbacks that also failed, which is noise to an operator.
  const first = String(response.notice).trim().split(/\.\s+|\.$/)[0]
  if (!first) return null
  const sentence = first.charAt(0).toUpperCase() + first.slice(1)
  return sentence.endsWith('.') ? sentence : `${sentence}.`
}

export async function requestSaraReply({ message, history = [], route = '' }) {
  const data = await invoke({
    mode: 'chat',
    message: trimText(message),
    history: boundConversationHistory(history),
    route: trimText(route, 120),
  })
  if (!data?.reply) throw new SaraAiError('ai_empty')
  return { reply: data.reply, degraded: data.degraded === true, notice: data.notice || null }
}

const summaryCache = new Map()
const summaryPending = new Map()

export async function requestSaraSummary({ userId, route = '', force = false } = {}) {
  const key = userId || 'session'
  const cached = summaryCache.get(key)
  if (!force && cached && Date.now() - cached.cachedAt < SUMMARY_CACHE_MS) return cached.value
  if (!force && summaryPending.has(key)) return summaryPending.get(key)

  const pending = invoke({ mode: 'summary', route: trimText(route, 120) })
    .then((data) => {
      if (!Array.isArray(data?.bullets) || !data.bullets.length) throw new SaraAiError('ai_empty')
      const value = {
        bullets: data.bullets.slice(0, 4).map((bullet) => trimText(bullet, 260)).filter(Boolean),
        generatedAt: data.generated_at || new Date().toISOString(),
        sourceMetrics: data.source_metrics || null,
      }
      summaryCache.set(key, { cachedAt: Date.now(), value })
      return value
    })
    .finally(() => summaryPending.delete(key))

  summaryPending.set(key, pending)
  return pending
}

export function saraErrorMessage(error) {
  if (error instanceof SaraAiError) return error.userMessage
  const code = error?.code || error?.name
  return (code && ERROR_MESSAGES[code]) || UNKNOWN
}
