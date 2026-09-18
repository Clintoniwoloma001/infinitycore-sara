// Pure BankOne transaction input validation shared by the Edge Function and
// the browser service. This module must never contain credentials or request
// construction code.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

export function isDateValidYYYYMMDD(value) {
  if (typeof value !== 'string') return false
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function isAmountKoboString(value) {
  if (typeof value !== 'string') return false
  return AMOUNT_RE.test(value)
}
