// Shared RPC helper: PostgREST returns PGRST202 when a function is missing
// from its schema cache (common right after a migration is applied). Retry
// once, then rethrow so callers can surface a "run the migration" message.

function isMissing(err) {
  const msg = ((err && (err.message || err.error?.message)) || '').toLowerCase()
  return msg.includes('pgrst202') || msg.includes('schema cache') || msg.includes('could not find the function')
}

export async function rpcWithRetry(fn) {
  try {
    const out = await fn()
    if (out?.error && isMissing(out.error)) {
      const retried = await fn()
      if (retried?.error) throw retried.error
      return retried?.data ?? retried
    }
    if (out?.error) throw out.error
    return out?.data ?? out
  } catch (err) {
    if (isMissing(err)) {
      const retried = await fn()
      if (retried?.error && isMissing(retried.error)) throw renamed(retried.error)
      if (retried?.error) throw retried.error
      return retried?.data ?? retried
    }
    throw err
  }
}

function renamed(err) {
  const e = new Error(err?.message || 'Database function unavailable')
  e.code = 'PGRST202'
  return e
}