const KEY = 'infcore_onboarding_dismiss_until'
const DEFAULT_MINUTES = 30

// Returns true while a previous "remind me later" dismissal is still active.
export function isOnboardingDismissed() {
  const until = Number(localStorage.getItem(KEY))
  if (!until) return false
  return Date.now() < until
}

// Persists a "remind me later" window (default 30 minutes).
export function dismissOnboarding(minutes = DEFAULT_MINUTES) {
  localStorage.setItem(KEY, String(Date.now() + minutes * 60 * 1000))
}

export function clearOnboardingDismiss() {
  localStorage.removeItem(KEY)
}