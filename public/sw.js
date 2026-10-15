// Halide service worker — one for the launcher, Process and Edit.
// - Offline: pages network-first (updates arrive), everything else
//   cache-first (hashed build assets, vendor cores, icons, fonts).
// - Cross-origin isolation: GitHub Pages can't send COOP/COEP, so same-origin
//   responses get them here (Edit's multi-thread ffmpeg needs SharedArrayBuffer).
const CACHE = 'halide-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('halide-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function isolated(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const put = (req, res) => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)); } return res; };

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.headers.has('range')) return;   // media byte ranges: straight to the network
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => put(req, r)).catch(() => caches.match(req)).then(isolated));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => put(req, r))).then(isolated));
});
