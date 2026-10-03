// Service worker minimal: cache tampilan dasar agar bisa dibuka offline.
const CACHE = "dua-hati-v1";
const SHELL = ["/", "/index.html", "/manifest.json", "/icon.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return; // API selalu ke jaringan
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then(r => { caches.open(CACHE).then(c => c.put("/index.html", r.clone())); return r; })
      .catch(() => caches.match("/index.html")));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
