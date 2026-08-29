import { useRef } from 'react'
import { isQuietHours } from './saraSettings'

// ------------------------------------------------------------------
// SARA proactive notifications. Consumes the shared "what's in MY
// queue" dataset so it never duplicates the bell/dashboard read.
// Raises a spoken alert + optional browser notification exactly once
// per state change (deduped by fingerprint), honors quiet hours and
// per-category toggles, and never loops.
// ------------------------------------------------------------------

export function alertFingerprint({ count, oldest }) {
  return `${count}:${oldest?.id || 'none'}`
}

export function buildLeaveAlert({ count, oldest }) {
  if (count === 0) return null
  const base = `Hi boss. You have ${count} pending leave approval${count === 1 ? '' : 's'}.`
  return oldest ? `${base} The oldest has been pending since ${new Date(oldest.created_at).toLocaleDateString()}.` : base
}

export function requestBrowserPermission() {
  if (!('Notification' in window)) return false
  try {
    if (Notification.permission === 'granted') return true
    if (Notification.permission === 'denied') return false
    Notification.requestPermission().then((p) => p === 'granted')
    return true
  } catch {
    return false
  }
}

function pushBrowserNotification(title, body, link) {
  try {
    if (Notification.permission !== 'granted') return
    const n = new Notification(title, { body, tag: 'sara-alert' })
    if (link && n.addEventListener) n.addEventListener('click', () => { window.location.hash = link })
  } catch { /* notifications are optional */ }
}

// Returns { onChange } — wire its result into an effect that reacts to
// queue changes inside the SARA component.
export function useSaraAlerts({ settings, count, oldest }) {
  const lastRef = useRef({ fingerprint: null, spokenCount: 0 })

  function evaluate() {
    if (!settings?.voiceAlerts && !settings?.browserNotifs) return null
    if (isQuietHours(settings)) return null
    if (!settings?.alertCategories?.leave) return null
    const text = buildLeaveAlert({ count, oldest })
    if (!text) return null
    const fp = alertFingerprint({ count, oldest })
    if (lastRef.current.fingerprint === fp) return null
    const spoken = settings.voiceAlerts && settings.voiceOn
    lastRef.current = { fingerprint: fp, spokenCount: lastRef.current.spokenCount + (spoken ? 1 : 0) }
    return { text, browser: settings.browserNotifs }
  }

  return { evaluate }
}

export { pushBrowserNotification }