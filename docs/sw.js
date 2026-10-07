// Offline app shell: online -> always fetch the newest files (and refresh the cache); offline -> serve the cache.
const PREFIX = 'planner-';
const CACHE = PREFIX + 'v5';
const SHELL = ['./', 'index.html', 'app.js', 'ai.js', 'parse.js', 'recur.js', 'year.js', 'ics.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  // 'reload' skips the browser's HTTP cache so a new version never installs from stale copies
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // only touch this app's own caches: on GitHub Pages other sites share this origin
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' }) // revalidate with the server instead of trusting the HTTP cache
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) || caches.match('index.html')),
  );
});
