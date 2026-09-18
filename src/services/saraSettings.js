import { useEffect, useState } from 'react'

// ------------------------------------------------------------------
// SARA client-side settings — persisted in per-user localStorage only.
// Nothing here is sensitive; the browser never holds server secrets.
// ------------------------------------------------------------------

const SETTINGS_KEY = 'sara_settings_v2'

export const DEFAULT_SETTINGS = {
  voiceOn: false,         // explicit opt-in: wake word + spoken replies
  micMuted: false,        // blocks mic capture, spoken replies still on
  volume: 1,              // 0..1 TTS volume
  voiceAlerts: true,      // speak proactive alerts
  browserNotifs: false,   // browser notification alerts
  aiNlu: true,            // use the sara-intent Edge Function when local parsing fails
  quietHours: false,
  quietStart: '22:00',
  quietEnd: '07:00',
  alertCategories: { leave: true, loan: true, attendance: false, payroll: false, system: true },
}

function settingsKey(userId) {
  return userId ? `${SETTINGS_KEY}:${userId}` : SETTINGS_KEY
}

function safeRead(userId) {
  try {
    const key = settingsKey(userId)
    const raw = localStorage.getItem(key)
    const stored = raw ? JSON.parse(raw) : {}
    return { ...DEFAULT_SETTINGS, ...stored }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function loadSettings(userId = null) {
  return safeRead(userId)
}

export function persistSettings(next, userId = null) {
  try {
    localStorage.setItem(settingsKey(userId), JSON.stringify(next))
  } catch { /* quota/private-mode safe */ }
}

// Local-time quiet-hours check. Returns true when alerts should stay silent.
export function isQuietHours(settings, now = new Date()) {
  if (!settings?.quietHours) return false
  const toMin = (t) => {
    const [h, m] = String(t || '00:00').split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = toMin(settings.quietStart)
  const end = toMin(settings.quietEnd)
  if (start === end) return false
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

export function useSaraSettings(userId = null) {
  const [settings, setSettings] = useState(() => loadSettings(userId))
  useEffect(() => { setSettings(loadSettings(userId)) }, [userId])
  useEffect(() => {
    if (userId) persistSettings(settings, userId)
  }, [settings, userId])
  const update = (patch) => setSettings((prev) => ({ ...prev, ...patch }))
  return { settings, update }
}
