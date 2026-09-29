// ============================================================================
// InfinityCore service worker — app-shell offline support
// ============================================================================
// Deliberately conservative. It caches the APPLICATION SHELL (the HTML document
// and the built static assets) so the app opens and renders offline. It does NOT
// cache API traffic: Supabase responses are authenticated, frequently changing
// and privacy-sensitive, and serving a stale roster or leave balance from cache
// would be worse than showing "offline".
//
// Strategy
//   navigation  -> network first, fall back to the cached shell (offline start)
//   static asset-> cache first, refreshed in the background
//   /rest/v1, auth, edge functions -> never cached, always the network
const VERSION = 'infinitycore-v2'
const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-assets`

// sw.js lives at the app's base path, so its own directory IS the scope root.
const BASE = new URL('./', self.location).pathname

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.add(new URL('index.html', BASE).href))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  )
})

/** Never cache authenticated or real-time API traffic. */
function isApiRequest(url) {
  return url.pathname.includes('/rest/v1/')
    || url.pathname.includes('/auth/v1/')
    || url.pathname.includes('/functions/v1/')
    || url.hostname.endsWith('supabase.co')
    || url.pathname.startsWith('/api/')
}

function isAsset(url) {
  return url.pathname.startsWith(new URL('assets/', BASE).pathname)
    || /\.(?:js|css|png|jpg|jpeg|svg|webp|woff2?|ico)$/i.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (isApiRequest(url)) return // straight to the network, never stored

  // App-shell navigation: fresh when online, usable when not.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((c) => c.put('index.html', copy))
          return response
        })
        .catch(() => caches.match('index.html')
          .then((cached) => cached || caches.match(new URL('index.html', BASE).href))),
    )
    return
  }

  if (isAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.status === 200) {
              const copy = response.clone()
              caches.open(ASSET_CACHE).then((c) => c.put(request, copy))
            }
            return response
          })
          .catch(() => cached)
        return cached || network
      }),
    )
  }
})

// ============================================================================
// PUSH (points 9/10/18)
// A real system notification for an Important/Urgent message, delivered while
// the page is closed or the device is locked. This is the mechanism that makes
// a message land outside the active tab; the in-app banner is explicitly not a
// substitute for it.
//
// The payload is produced server-side by a Supabase Edge Function holding the
// VAPID private key, shaped as { title, body, url, tag, priority }.
// `url` deep-links to the conversation, group or channel and focuses the
// message, so the acknowledgement action is exposed on arrival.
// ============================================================================
self.addEventListener('push', (event) => {
  // A missing payload is legitimate (a liveness ping). Never throw here: an
  // exception would silently drop the notification.
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { body: event.data ? event.data.text() : '' }
  }

  const urgent = String(payload.priority).toLowerCase() === 'urgent'
  const options = {
    body: payload.body || '',
    // A stable tag per message collapses a resend onto the same notification
    // instead of stacking duplicates in the shade.
    tag: payload.tag || 'infinitycore-message',
    renotify: Boolean(payload.tag),
    icon: payload.icon || new URL('icons/icon-192.png', BASE).href,
    badge: payload.badge || new URL('icons/icon-96.png', BASE).href,
    data: { url: payload.url || '/' },
    visibility: 'visible',
    // Urgent must persist until dealt with; an important message may go to the
    // shade, which is the visible difference between the two levels (point 12).
    requireInteraction: urgent,
  }

  event.waitUntil(self.registration.showNotification(payload.title || 'InfinityCore', options))
})

// Point 10: a tap opens InfinityCore at the right conversation, focused on the
// message. Focus an already-open tab rather than piling up new ones.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          // Hand the route to the page so it can navigate and focus the
          // message, rather than forcing a full reload.
          client.postMessage({ type: 'infinitycore-navigate', url: target })
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})

// The page can ask the worker to display a notification it composed itself.
// Used as the foreground fallback while the push service is still being wired
// up, so an Important/Urgent alert is a real system notification either way.
self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type !== 'show-notification') return
  event.waitUntil(
    self.registration.showNotification(data.title || 'InfinityCore', {
      body: data.body || '',
      tag: data.tag || 'infinitycore-message',
      data: { url: data.url || '/' },
      requireInteraction: String(data.priority).toLowerCase() === 'urgent',
    }),
  )
})

