/* Study Atlas service worker: lets the Home Screen app open fast and show the last
   loaded version when offline. Pages and notes always try the network first,
   so updates show up right away. PDFs and other sites are not touched. */
const CACHE = "study-atlas-v4";
const SHELL = ["./", "index.html", "data.js", "firebase-config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.endsWith(".pdf")) return;
  if (url.pathname.endsWith("/dashboard.html")) return; // owner dashboard: always live, never cached
  const isPage = req.mode === "navigate" || /\/(index\.html)?$/.test(url.pathname);
  const isLive = isPage || /\/(data|firebase-config)\.js$/.test(url.pathname);
  if (isLive) {
    const key = isPage ? "index.html" : url.pathname.replace(/^.*\//, "");
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key, { ignoreSearch: true }).then(r => r || caches.match("./"))));
    return;
  }
  if (/\.(png|jpg|jpeg|webp|svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
