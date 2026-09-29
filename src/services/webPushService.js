import { supabase } from '../supabaseClient'

// ============================================================================
// WEB PUSH (PWA) — Important/Urgent message delivery
//
// Point 9/18: a real push subscription, delivered by a service worker while the
// page is closed or the device is locked. This is deliberately NOT an in-app
// toast — NotificationService and the shell banner remain for the foreground
// case; this layer exists so a message still lands when the app is not open.
// Point 11: one row per endpoint, so several devices hold independent
// subscriptions.
//
// WHAT IS NOT HERE, AND WHY
// Sending the payload needs a server holding the VAPID private key plus each
// recipient's p256dh/auth keys. That is a Supabase Edge Function (service_role
// only) and is DEPLOYED SEPARATELY — no VAPID key or edge function is committed
// here. This module owns the CLIENT half, which is the part the browser
// controls: permission, subscription, key exchange, registration, unsubscribe.
//
// The VAPID public key is supplied at deploy time via VITE_VAPID_PUBLIC_KEY.
// When absent, isSupported() reports false and everything no-ops, so the app
// never throws on a deployment not yet configured for push.
// ============================================================================

const VAPID_PUBLIC_KEY = import.meta.env?.VITE_VAPID_PUBLIC_KEY || ''

/** Base64url -> Uint8Array, as required by `pushManager.subscribe`. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

/** True when this browser can take a push subscription and a key is present. */
export function isSupported() {
  if (!VAPID_PUBLIC_KEY) return false
  return (
    typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  )
}

/** Whether the user has granted notification permission. */
export function permissionState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

/**
 * Ask for permission. Never throws.
 *
 * Permission may only be requested from a user gesture in most browsers, so
 * this must be called from a click handler (the bell's "Enable" control) and
 * never on mount.
 */
export async function requestPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

/**
 * Subscribe this browser and register the subscription with the backend.
 *
 * Idempotent: an existing subscription is reused and re-registered, so calling
 * this on every load does not create a row per visit. Returns the endpoint, or
 * null when push is unavailable or permission was refused.
 */
export async function subscribeAndRegister() {
  if (!isSupported()) return null
  if (Notification.permission !== 'granted') {
    const result = await requestPermission()
    if (result !== 'granted') return null
  }

  try {
    const registration = await navigator.serviceWorker.ready
    // An existing subscription is the norm after the first visit; subscribing
    // again would produce a second, redundant push subscription.
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
    }
    if (!subscription) return null

    const json = subscription.toJSON()
    const { error } = await supabase.rpc('register_push_subscription', {
      p_endpoint: subscription.endpoint,
      p_p256dh: json.keys?.p256dh || '',
      p_auth: json.keys?.auth || '',
      p_user_agent: navigator.userAgent,
      p_device_kind: 'web',
    })
    if (error) throw error
    return subscription.endpoint
  } catch {
    // A failed subscription must never break sign-in or the shell.
    return null
  }
}

/** Remove this browser's subscription and its backend row. */
export async function unsubscribe() {
  if (!isSupported()) return false
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return false
    const { endpoint } = subscription.toJSON()
    await supabase.rpc('unregister_push_subscription', { p_endpoint: endpoint })
    await subscription.unsubscribe()
    return true
  } catch {
    return false
  }
}

/** How many devices this user currently has push enabled on (point 11). */
export async function listMySubscriptions() {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, device_kind, created_at, user_agent')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

/**
 * The copy shown for a message requiring acknowledgment (point 10).
 *
 * Kept here so the web client, the service worker and the mobile client all
 * produce the same sentence.
 */
export function pushCopy({ priority, senderName }) {
  const who = senderName || 'Someone'
  if (String(priority).toLowerCase() === 'urgent') {
    return {
      title: 'URGENT MESSAGE',
      body: `${who} sent you an urgent message. Acknowledgement required.`,
    }
  }
  return {
    title: 'IMPORTANT MESSAGE',
    body: `${who} sent you an important message. Acknowledgement required.`,
  }
}

