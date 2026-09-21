// Shared meeting-link helpers for the Training & Development page's manual
// Google Meet fallback. Kept framework-free so node tests can import them.

// Any well-formed http(s) URL is acceptable for the create-form manual paste
// (facilitators sometimes supply Zoom/Teams join URLs). One shared source so
// the session meeting panel and the create form behave identically.
export function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// The manual Google Meet fallback only needs a plausible Meet URL. We do not
// over-validate Google's exact format — a normal
// https://meet.google.com/xxx-xxxx-xxx style link is accepted as-is.
export function isValidMeetingUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    return ['meet.google.com', 'www.meet.google.com'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}