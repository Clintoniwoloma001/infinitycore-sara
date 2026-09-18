const INITIAL_PREFIX = 'infcore_onboarding_initial_dismissed:'
const BANNER_PREFIX = 'infcore_onboarding_banner_dismissed:'

function key(prefix, userId) {
  return `${prefix}${userId || 'anonymous'}`
}

export function isInitialOnboardingDismissed(userId) {
  return localStorage.getItem(key(INITIAL_PREFIX, userId)) === '1'
}

export function dismissInitialOnboarding(userId) {
  if (userId) localStorage.setItem(key(INITIAL_PREFIX, userId), '1')
}

export function isOnboardingBannerDismissed(userId) {
  return sessionStorage.getItem(key(BANNER_PREFIX, userId)) === '1'
}

export function dismissOnboardingBanner(userId) {
  if (userId) sessionStorage.setItem(key(BANNER_PREFIX, userId), '1')
}

export function clearOnboardingDismiss(userId) {
  if (!userId) return
  localStorage.removeItem(key(INITIAL_PREFIX, userId))
  sessionStorage.removeItem(key(BANNER_PREFIX, userId))
}
