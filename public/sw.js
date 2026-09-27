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
const VERSION = 'infinitycore-v1'
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
