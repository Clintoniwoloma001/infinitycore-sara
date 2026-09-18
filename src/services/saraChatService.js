import { supabase } from '../supabaseClient'

const MAX_HISTORY_TURNS = 8
const MAX_TEXT_LENGTH = 1200
const SUMMARY_CACHE_MS = 5 * 60 * 1000

const ERROR_MESSAGES = {
  ai_not_configured: 'SARA AI is not configured yet. An administrator needs to add the server-side OpenAI key.',
  rate_limited: 'SARA has reached its usage limit for now. Please wait a little and try again.',
  timeout: 'SARA took too long to respond. Please try again.',
  ai_unavailable: 'SARA is temporarily unavailable. You can still use the existing typed commands.',
  ai_empty: 'SARA returned an empty response. Please try asking in a different way.',
}

export class SaraAiError extends Error {
  constructor(code = 'ai_unavailable') {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.ai_unavailable)
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
  return 'ai_unavailable'
}

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('sara-chat', { body })
  if (error || data?.ok === false) throw new SaraAiError(errorCode(error, data))
  return data
}

export async function requestSaraReply({ message, history = [], route = '' }) {
  const data = await invoke({
    mode: 'chat',
    message: trimText(message),
    history: boundConversationHistory(history),
    route: trimText(route, 120),
  })
  if (!data?.reply) throw new SaraAiError('ai_empty')
  return data
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
  return error?.userMessage || (error?.code && ERROR_MESSAGES[error.code]) || ERROR_MESSAGES.ai_unavailable
}
