/* MULTBOT service worker: makes the terminal installable as an app and keeps the shell available.
   Live data (/api, /ws) always comes from the network. */
const SHELL = "multbot-shell-v1";
const ASSETS = ["/", "/static/style.css", "/static/charts.js", "/static/app.js", "/static/icon-192.png",
  "/static/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname === "/ws") return;
  // network first (always the newest terminal), cache as fallback when the bot is not running
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(SHELL).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
