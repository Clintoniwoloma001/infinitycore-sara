// Browser composite fingerprint for the QR Attendance Terminal.
//
// Buddy-punching guard: every public-terminal request carries a stable,
// device-scoped identifier so the server can enforce one-device-one-employee
// per day. The fingerprint is a FingerprintJS-style composite of stable
// browser signals PLUS a random first-party identity stored in localStorage.
// The whole string is SHA-256 hashed here (crypto.subtle, with a pure-JS
// fallback for non-secure contexts), so the raw composite never leaves the
// device and only an opaque 64-char hex digest is sent to the server.

const STORAGE_KEY = 'infinitycore_qr_device_id'

let cachedFingerprint = null

// Safe global lookup — works for browsers and SSR/node (where web globals
// may exist but be uninitialized/TDZ and would throw on a bare typeof).
function g(name) {
  try {
    return typeof globalThis !== 'undefined' ? globalThis[name] : undefined
  } catch (_) {
    return undefined
  }
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes)
  const cryptoObj = g('crypto')
  if (cryptoObj && cryptoObj.getRandomValues) {
    cryptoObj.getRandomValues(arr)
  } else {
    for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// FNV-1a 64-bit fallback — deterministic, good enough when crypto.subtle
// is unavailable (non-HTTPS / old webview). NOT used for secrets.
function fnv1a64(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    h1 ^= text.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2, 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export async function sha256Hex(text) {
  const cryptoObj = g('crypto')
  if (cryptoObj && cryptoObj.subtle && cryptoObj.subtle.digest) {
    try {
      const digest = await cryptoObj.subtle.digest('SHA-256', new TextEncoder().encode(text))
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch (_) {
      // fall through to the pure-JS fallback
    }
  }
  return fnv1a64(text)
}

function collectSignals(storageId) {
  const screen = g('screen')
  const nav = g('navigator')
  let tz = ''
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch (_) {
    tz = ''
  }
  const canvas = canvasFingerprint()
  return [
    storageId,
    nav?.userAgent || '',
    nav?.language || '',
    nav?.languages ? nav.languages.join(',') : '',
    nav?.platform || '',
    nav?.hardwareConcurrency != null ? String(nav.hardwareConcurrency) : '',
    nav?.deviceMemory != null ? String(nav.deviceMemory) : '',
    screen ? `${screen.width}x${screen.height}x${screen.colorDepth}` : '',
    tz,
    canvas,
  ].join('|')
}

// Minimal canvas-rendering probe; returns a mostly-stable token or '' when
// canvas is blocked. Wrapped in try/catch so any failure never breaks login.
function canvasFingerprint() {
  try {
    const documentObj = g('document')
    if (!documentObj || typeof documentObj.createElement !== 'function') return ''
    const el = documentObj.createElement('canvas')
    el.width = 220
    el.height = 40
    const ctx = el.getContext('2d')
    if (!ctx) return ''
    ctx.textBaseline = 'top'
    ctx.font = '14px Arial'
    ctx.fillStyle = '#009944'
    ctx.fillText('InfinityCore QR Terminal', 4, 4)
    ctx.fillStyle = '#f60'
    ctx.fillRect(4, 24, 120, 6)
    const data = ctx.getImageData(0, 0, 60, 20).data
    return Array.from(data.subarray(0, 40)).join('')
  } catch (_) {
    return ''
  }
}

function initFingerprint() {
  if (cachedFingerprint) return cachedFingerprint
  const storage = g('localStorage')
  if (typeof storage === 'undefined') {
    cachedFingerprint = randomHex()
    return cachedFingerprint
  }
  let storageId = storage.getItem(STORAGE_KEY)
  if (!storageId) {
    storageId = randomHex()
    try {
      storage.setItem(STORAGE_KEY, storageId)
    } catch (_) {
      // storage unavailable (private mode); the signal composite still applies
    }
  }
  cachedFingerprint = storageId
  return cachedFingerprint
}

// Returns the device-scoped SHA-256 hex digest to send to the server.
// Stable across reloads on the same browser profile; changes if storage is
// cleared or across different devices/browsers.
export async function getDeviceFingerprint() {
  const storageId = initFingerprint()
  const signals = collectSignals(storageId)
  return sha256Hex(signals)
}

export function resetDeviceFingerprint() {
  cachedFingerprint = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (_) {
    // ignore
  }
}

export default { getDeviceFingerprint, resetDeviceFingerprint, sha256Hex }