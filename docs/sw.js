// Offline app shell: serve cached files first, refresh them in the background.
const CACHE = 'planner-v1';
const SHELL = ['./', 'index.html', 'app.js', 'ai.js', 'parse.js', 'year.js', 'ics.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res.ok) c.put(req, res.clone());
        return res;
      });
      return hit || net.catch(() => c.match('index.html'));
    }),
  );
});
