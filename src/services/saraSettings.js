import { useEffect, useRef, useState } from 'react'

// ------------------------------------------------------------------
// SARA client-side settings — persisted in localStorage only. Nothing
// here is sensitive; the browser never holds server secrets.
// ------------------------------------------------------------------

const SETTINGS_KEY = 'sara_settings_v1'
// Legacy single-toggle key kept so existing users keep their choice.
const LEGACY_VOICE_KEY = 'sara_voice_enabled'

export const DEFAULT_SETTINGS = {
  voiceOn: true,          // master voice mode (wake word + spoken replies)
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

function safeRead() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const stored = raw ? JSON.parse(raw) : {}
    return { ...DEFAULT_SETTINGS, ...stored }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function loadSettings() {
  const s = safeRead()
  // Back-compat: respect the old master voice toggle if present.
  try {
    if (localStorage.getItem(LEGACY_VOICE_KEY) === 'off') s.voiceOn = false
  } catch { /* no-op */ }
  return s
}

export function persistSettings(next) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    // Keep writing the legacy key so nothing that reads it drifts.
    try { localStorage.setItem(LEGACY_VOICE_KEY, next.voiceOn ? 'on' : 'off') } catch { /* no-op */ }
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

export function useSaraSettings() {
  const [settings, setSettings] = useState(loadSettings)
  useEffect(() => { persistSettings(settings) }, [settings])
  const update = (patch) => setSettings((prev) => ({ ...prev, ...patch }))
  return { settings, update }
}