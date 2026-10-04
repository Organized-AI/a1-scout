// A1 phone app: keep the shell available offline so it opens instantly; never cache /api (always live).
const SHELL = "a1-shell-v1";
const FILES = ["/m/", "/m/manifest.webmanifest", "/brand/app-192.png", "/brand/favicon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  // network first, so a deploy shows up on the next open; the cached copy is only the fallback
  e.respondWith(fetch(e.request).then(r => { if (r.ok && FILES.includes(u.pathname)) { const c = r.clone(); caches.open(SHELL).then(s => s.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request)));
});
